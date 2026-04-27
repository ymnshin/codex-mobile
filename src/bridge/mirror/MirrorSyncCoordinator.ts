import type { CodexItem } from "../../domain.js";
import type { SessionBackfillEvent } from "../../codex/CodexSessionEventTailer.js";
import { shortThreadId } from "../../util/formatting.js";
import {
  formatStartupTimingMs,
  isStartupTimingEnabled,
  startupTimingNow
} from "../../util/startupTiming.js";
import {
  buildStartupCandidateDisplayEntries,
  buildStartupSessionBackfillDisplayEntries,
  type StartupBackfillGapNotice,
  type StartupCandidateDisplayEntry,
  type StartupSessionBackfillDisplayEntry
} from "../startupSelection.js";
import {
  MESSAGE_SYNC_DEBOUNCE_MS,
  type BridgeRuntimeContext
} from "../runtime/BridgeRuntimeContext.js";
import type { BridgeRuntimeState, MirrorCandidate } from "../runtime/BridgeRuntimeState.js";
import type { StartupTransportContext } from "../startupTransport.js";

interface MirrorSyncCoordinatorDependencies {
  buildSessionTurnCursor(turnId: string | null | undefined): string | null;
  buildSessionEventCursor(sourceOrder: string | null | undefined, eventKey: string | null | undefined): string | null;
  collectMirrorCandidates(threadId: string, turns: unknown[]): MirrorCandidate[];
  buildMirrorCandidateCursor(turn: unknown, item: CodexItem, itemOrder: number): string | null;
  compareItemCursor(left: string, right: string): number;
  ensureMirrorStateHydrated(threadId: string): void;
  extractTurnStatus(turn: unknown): string | null;
  extractTurnItems(turn: unknown): CodexItem[];
  hasMirroredUserAnchorForTurn(
    threadId: string,
    turnId: string | null | undefined,
    turnCursor: string | null | undefined
  ): boolean;
  handleSessionEvent(event: SessionBackfillEvent): Promise<void>;
  mirrorCandidates(
    threadId: string,
    candidates: MirrorCandidate[],
    options?: { compactStartupReplay?: boolean }
  ): Promise<number>;
  mirroredItemKey(threadId: string, itemId: string): string;
  printProgress(message: string): void;
  publishStartupBackfillNotice(
    threadId: string,
    itemId: string,
    text: string,
    turnId: string | null,
    turnCursor: string | null
  ): Promise<number>;
  rememberThreadMirrorCursor(
    threadId: string,
    timestampMs: number | null,
    cursor: string,
    turnCursor: string | null
  ): void;
  selectInitialContextTurns(threadId: string, turns: unknown[] | undefined): unknown[];
  selectRecentCompletedTurns(turns: unknown[] | undefined): unknown[];
  selectRecentSyncableTurns(threadId: string, turns: unknown[] | undefined): unknown[];
  shouldStop(): boolean;
  shouldPreferSessionStreamForThread(threadId: string): boolean;
  trimInitialContextCandidatesToConversationAnchor(
    threadId: string,
    candidates: MirrorCandidate[]
  ): MirrorCandidate[];
  trimSessionBackfillEventsToConversationAnchor(
    threadId: string,
    events: SessionBackfillEvent[]
  ): SessionBackfillEvent[];
}

type SessionStartupMatchMode = "strict" | "anchor-text" | "none";

export class MirrorSyncCoordinator {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: MirrorSyncCoordinatorDependencies
  ) {}

  queueMessageSync(threadId: string): void {
    if (this.deps.shouldStop()) {
      return;
    }
    const existingTimer = this.runtime.messageSyncTimers.get(threadId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => void this.flushMessageSync(threadId), MESSAGE_SYNC_DEBOUNCE_MS);
    this.runtime.messageSyncTimers.set(threadId, timer);
  }

  async flushMessageSync(threadId: string): Promise<void> {
    const pendingTimer = this.runtime.messageSyncTimers.get(threadId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.runtime.messageSyncTimers.delete(threadId);
    }
    if (this.deps.shouldStop()) {
      return;
    }
    if (this.deps.shouldPreferSessionStreamForThread(threadId)) {
      return;
    }
    const prior = this.runtime.messageSyncChains.get(threadId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(async () => {
        if (this.deps.shouldStop()) {
          return;
        }
        await this.syncRecentTurnMessages(threadId);
      })
      .finally(() => {
        if (this.runtime.messageSyncChains.get(threadId) === next) {
          this.runtime.messageSyncChains.delete(threadId);
        }
      });
    this.runtime.messageSyncChains.set(threadId, next);
    await next;
  }

  async flushPendingCommentaryBeforeApproval(threadId: string): Promise<void> {
    if (this.deps.shouldStop()) {
      return;
    }
    try {
      await this.flushMessageSync(threadId);
    } catch (error) {
      this.context.logger.debug({ error, threadId }, "Failed to flush pending commentary before posting approval card.");
    }
  }

  async backfillLatestTurnMessages(
    threadId: string,
    options: {
      allowCodexFallback?: boolean;
      sessionMatchMode?: SessionStartupMatchMode;
      preferLocalSessionTruth?: boolean;
      startupContext?: StartupTransportContext | null;
    } = {}
  ): Promise<number> {
    const totalStartedAt = startupTimingNow();
    try {
      const allowCodexFallback = options.allowCodexFallback ?? true;
      const sessionMatchMode = options.sessionMatchMode ?? "strict";
      const preferLocalSessionTruth = options.preferLocalSessionTruth ?? false;
      const compactStartupReplay = options.startupContext?.compactStartupReplay ?? false;
      let frontierBackfillDurationMs = 0;
      let sessionBackfillDurationMs = 0;
      let codexReadDurationMs = 0;
      let fallbackMirrorDurationMs = 0;
      this.deps.ensureMirrorStateHydrated(threadId);
      if (preferLocalSessionTruth) {
        const frontierStartedAt = startupTimingNow();
        const frontierBackfill = await this.backfillFromMirroredSessionFrontier(threadId, compactStartupReplay);
        frontierBackfillDurationMs = startupTimingNow() - frontierStartedAt;
        if (frontierBackfill > 0) {
          this.deps.printProgress(`Backfilled recent messages for ${shortThreadId(threadId)}.`);
          this.logStartupTiming(
            `backfill ${shortThreadId(threadId)} source=session-frontier frontier=${formatStartupTimingMs(frontierBackfillDurationMs)} total=${formatStartupTimingMs(startupTimingNow() - totalStartedAt)} mirrored=${frontierBackfill}`
          );
          return frontierBackfill;
        }
        const sessionBackfillStartedAt = startupTimingNow();
        const sessionBackfillMirrored = await this.backfillRecentTurnsFromSessionLog(
          threadId,
          [],
          null,
          null,
          "none",
          compactStartupReplay
        );
        sessionBackfillDurationMs = startupTimingNow() - sessionBackfillStartedAt;
        if (sessionBackfillMirrored > 0) {
          this.deps.printProgress(`Backfilled recent messages for ${shortThreadId(threadId)}.`);
          this.logStartupTiming(
            `backfill ${shortThreadId(threadId)} source=session-log frontier=${formatStartupTimingMs(frontierBackfillDurationMs)} sessionLog=${formatStartupTimingMs(sessionBackfillDurationMs)} total=${formatStartupTimingMs(startupTimingNow() - totalStartedAt)} mirrored=${sessionBackfillMirrored}`
          );
          return sessionBackfillMirrored;
        }
      }
      const codexReadStartedAt = startupTimingNow();
      const details = await this.context.codexAdapter.readThread(threadId, true);
      codexReadDurationMs = startupTimingNow() - codexReadStartedAt;
      const initialTurns = this.deps.selectInitialContextTurns(threadId, details.turns);
      const anchoredCandidates = this.deps.trimInitialContextCandidatesToConversationAnchor(
        threadId,
        this.trimSubagentCandidatesBeforeParentAnchor(
          threadId,
          this.deps.collectMirrorCandidates(threadId, initialTurns)
        )
      );
      const startupCandidateEntries = buildStartupCandidateDisplayEntries(anchoredCandidates, {
        leadingEventBudget: this.context.runtimeConfig.startupBackfill.leadingEventBudget,
        trailingEventBudget: this.context.runtimeConfig.startupBackfill.trailingEventBudget
      });
      const expectedStartupTurnIds = [
        ...new Set(
          anchoredCandidates
            .map((candidate) => candidate.turnId)
            .filter((turnId): turnId is string => typeof turnId === "string" && turnId.length > 0)
        )
      ];
      const expectedAnchorTurnId = anchoredCandidates[0]?.turnId ?? null;
      const expectedAnchorUserText = this.extractAnchorUserTextFromCandidates(anchoredCandidates);
      let mirrored = 0;
      const sessionBackfillStartedAt = startupTimingNow();
      const sessionBackfillMirrored = await this.backfillRecentTurnsFromSessionLog(
        threadId,
        expectedStartupTurnIds,
        expectedAnchorTurnId,
        expectedAnchorUserText,
        sessionMatchMode,
        compactStartupReplay
      );
      sessionBackfillDurationMs = startupTimingNow() - sessionBackfillStartedAt;
      mirrored += sessionBackfillMirrored;
      if (sessionBackfillMirrored === 0 && allowCodexFallback) {
        const fallbackMirrorStartedAt = startupTimingNow();
        mirrored += await this.mirrorStartupCandidateDisplayEntries(
          threadId,
          startupCandidateEntries,
          compactStartupReplay
        );
        fallbackMirrorDurationMs = startupTimingNow() - fallbackMirrorStartedAt;
      }
      if (mirrored > 0) {
        this.deps.printProgress(`Backfilled recent messages for ${shortThreadId(threadId)}.`);
      }
      this.logStartupTiming(
        `backfill ${shortThreadId(threadId)} source=${sessionBackfillMirrored > 0 ? "session-log" : allowCodexFallback ? "thread-read-fallback" : "thread-read"} codexRead=${formatStartupTimingMs(codexReadDurationMs)} sessionLog=${formatStartupTimingMs(sessionBackfillDurationMs)} fallbackMirror=${formatStartupTimingMs(fallbackMirrorDurationMs)} total=${formatStartupTimingMs(startupTimingNow() - totalStartedAt)} mirrored=${mirrored}`
      );
      return mirrored;
    } catch (error) {
      this.context.logger.debug({ error, threadId }, "Failed to backfill recent thread messages.");
      return 0;
    }
  }

  private logStartupTiming(message: string): void {
    if (!isStartupTimingEnabled()) {
      return;
    }
    this.context.logger.info({ startupTiming: true }, message);
  }

  async seedMirrorCursorFromStableFrontier(threadId: string): Promise<boolean> {
    try {
      const details = await this.context.codexAdapter.readThread(threadId, true);
      const turns = Array.isArray(details.turns) ? details.turns : [];
      const syncableTurns = this.deps.selectRecentSyncableTurns(threadId, turns);
      const latestTurn = syncableTurns.at(-1);
      const latestTurnInProgress = latestTurn ? this.deps.extractTurnStatus(latestTurn) === "inProgress" : false;
      const seedTurns = latestTurnInProgress ? this.deps.selectRecentCompletedTurns(turns) : syncableTurns;
      const seedSourceTurns = seedTurns.length > 0 ? [seedTurns[seedTurns.length - 1]!] : turns;
      const seedCandidates = this.deps.collectMirrorCandidates(threadId, seedSourceTurns);
      const latestCandidate = seedCandidates.at(-1);
      if (!latestCandidate?.cursor) {
        return false;
      }
      this.deps.rememberThreadMirrorCursor(
        threadId,
        latestCandidate.timestampMs,
        latestCandidate.cursor,
        latestCandidate.turnCursor
      );
      this.deps.printProgress(`Seeded mirror cursor for ${shortThreadId(threadId)} from a stable Codex frontier.`);
      return true;
    } catch (error) {
      this.context.logger.debug({ error, threadId }, "Failed to seed mirror cursor from a stable thread frontier.");
      return false;
    }
  }

  async syncRecentTurnMessages(
    threadId: string
  ): Promise<{ mirroredCount: number; candidateItemIds: Set<string> }> {
    if (this.deps.shouldPreferSessionStreamForThread(threadId)) {
      return { mirroredCount: 0, candidateItemIds: new Set() };
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge) {
      return { mirroredCount: 0, candidateItemIds: new Set() };
    }

    try {
      this.deps.ensureMirrorStateHydrated(threadId);
      const details = await this.context.codexAdapter.readThread(threadId, true);
      const candidates = this.suppressUnanchoredCommentary(
        threadId,
        this.trimCandidatesBeforeLatestNewUser(
          threadId,
          this.trimSubagentCandidatesBeforeParentAnchor(
            threadId,
            this.deps.collectMirrorCandidates(
              threadId,
              this.deps.selectRecentSyncableTurns(threadId, details.turns)
            )
          )
        )
      );
      const candidateItemIds = new Set(candidates.map((candidate) => candidate.itemId));
      const mirrored = await this.deps.mirrorCandidates(threadId, candidates);
      if (mirrored > 0) {
        this.deps.printProgress(`Mirrored ${mirrored} new message(s) for ${shortThreadId(threadId)}.`);
      }
      return { mirroredCount: mirrored, candidateItemIds };
    } catch (error) {
      this.context.logger.debug({ error, threadId }, "Failed to sync recent thread messages.");
      return { mirroredCount: 0, candidateItemIds: new Set() };
    }
  }

  trimCandidatesBeforeLatestNewUser(
    threadId: string,
    candidates: MirrorCandidate[]
  ): MirrorCandidate[] {
    const latestCursor = this.runtime.latestMirroredCursorByThread.get(threadId);
    if (!latestCursor || candidates.length === 0) {
      return candidates;
    }

    const firstNewUserIndex = candidates.findIndex(
      (candidate) =>
        candidate.kind === "user" &&
        candidate.cursor !== null &&
        this.deps.compareItemCursor(candidate.cursor, latestCursor) > 0
    );
    if (firstNewUserIndex <= 0) {
      return candidates;
    }

    return candidates.slice(firstNewUserIndex);
  }

  trimSubagentCandidatesBeforeParentAnchor(
    threadId: string,
    candidates: MirrorCandidate[]
  ): MirrorCandidate[] {
    if (candidates.length === 0) {
      return candidates;
    }

    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge || bridge.channelKind !== "subagent") {
      return candidates;
    }

    const anchorTurnCursor = bridge.parentAnchorTurnCursor?.trim() ?? "";
    const anchorTurnId = bridge.parentAnchorTurnId?.trim().toLowerCase() ?? "";
    if (!anchorTurnCursor && !anchorTurnId) {
      return candidates;
    }

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (!candidate) {
        continue;
      }
      const matchesCursor = Boolean(anchorTurnCursor && candidate.turnCursor === anchorTurnCursor);
      const matchesTurnId = Boolean(
        anchorTurnId &&
          typeof candidate.turnId === "string" &&
          candidate.turnId.trim().toLowerCase() === anchorTurnId
      );
      if (matchesCursor || matchesTurnId) {
        return candidates.slice(index + 1);
      }
    }

    return candidates;
  }

  suppressUnanchoredCommentary(
    threadId: string,
    candidates: MirrorCandidate[]
  ): MirrorCandidate[] {
    const latestCursor = this.runtime.latestMirroredCursorByThread.get(threadId);
    const latestTurnCursor = this.runtime.latestMirroredTurnCursorByThread.get(threadId) ?? null;
    if (!latestCursor || candidates.length === 0) {
      return candidates;
    }

    const hasNewUserAnchor = candidates.some(
      (candidate) =>
        candidate.kind === "user" &&
        candidate.cursor !== null &&
        this.deps.compareItemCursor(candidate.cursor, latestCursor) > 0
    );
    if (hasNewUserAnchor) {
      return candidates;
    }

    return candidates.filter((candidate) => {
      if (candidate.kind !== "agentCommentary") {
        return true;
      }

      const itemKey = this.deps.mirroredItemKey(threadId, candidate.itemId);
      if (this.runtime.mirroredChatItems.has(itemKey)) {
        return true;
      }

      return latestTurnCursor !== null && candidate.turnCursor === latestTurnCursor;
    });
  }

  private async backfillRecentTurnsFromSessionLog(
    threadId: string,
    expectedTurnIds: string[],
    expectedAnchorTurnId: string | null,
    expectedAnchorUserText: string | null,
    sessionMatchMode: SessionStartupMatchMode,
    compactStartupReplay = false
  ): Promise<number> {
    const keepCount = Math.max(1, this.context.runtimeConfig.retention.maxTurnsPerThread);
    const isSubagent =
      (this.runtime.threadState.get(threadId)?.channelKind ??
        this.context.stateStore.getThreadBridge(threadId)?.channelKind ??
        "conversation") === "subagent";
    const events = this.deps.trimSessionBackfillEventsToConversationAnchor(
      threadId,
      await this.context.sessionEventTailer.readRecentTurnBackfillEvents(threadId, keepCount)
    );
    if (events.length === 0) {
      return 0;
    }

    if (events[0]?.type !== "sessionUserMessage") {
      this.context.logger.debug(
        { threadId, firstEventType: events[0]?.type ?? null },
        "Skipping session-log startup backfill because it does not begin at a conversation anchor."
      );
      return 0;
    }

    const eventTurnIds = [
      ...new Set(
        events
          .map((event) => event.turnId)
          .filter((turnId): turnId is string => typeof turnId === "string" && turnId.length > 0)
      )
    ];
    const requiresStrictTurnMatch = sessionMatchMode === "strict";
    const requiresAnchorTextMatch = sessionMatchMode !== "none";
    if (
      requiresStrictTurnMatch &&
      !isSubagent &&
      expectedAnchorTurnId &&
      events[0]?.turnId &&
      events[0].turnId !== expectedAnchorTurnId
    ) {
      this.context.logger.debug(
        {
          threadId,
          expectedAnchorTurnId,
          sessionAnchorTurnId: events[0]?.turnId ?? null
        },
        "Skipping session-log startup backfill because its anchor turn does not match the retained startup turn."
      );
      return 0;
    }
    const sessionAnchorUserText = this.extractAnchorUserTextFromSessionEvents(events);
    if (
      requiresAnchorTextMatch &&
      !isSubagent &&
      expectedAnchorUserText &&
      sessionAnchorUserText &&
      this.normalizeStartupAnchorText(sessionAnchorUserText) !==
        this.normalizeStartupAnchorText(expectedAnchorUserText)
    ) {
      this.context.logger.debug(
        {
          threadId,
          expectedAnchorUserText,
          sessionAnchorUserText
        },
        "Skipping session-log startup backfill because its anchor user message does not match the retained startup turn."
      );
      return 0;
    }
    if (
      requiresStrictTurnMatch &&
      !isSubagent &&
      expectedTurnIds.length > 0 &&
      (eventTurnIds.length !== expectedTurnIds.length ||
        eventTurnIds.some((turnId, index) => turnId !== expectedTurnIds[index]))
    ) {
      this.context.logger.debug(
        {
          threadId,
          expectedTurnIds,
          sessionTurnIds: eventTurnIds
        },
        "Skipping session-log startup backfill because it does not match the retained startup turn set."
      );
      return 0;
    }

    return await this.mirrorSessionBackfillEvents(threadId, events, {
      compactStartupReplay
    });
  }

  private async backfillFromMirroredSessionFrontier(
    threadId: string,
    compactStartupReplay = false
  ): Promise<number> {
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const latestCursor = this.runtime.latestMirroredCursorByThread.get(threadId) ?? bridge?.latestMirroredCursor ?? null;
    if (
      !bridge?.latestMirroredSourceFilePath ||
      typeof bridge.latestMirroredSourceOffset !== "number" ||
      !Number.isFinite(bridge.latestMirroredSourceOffset) ||
      !latestCursor
    ) {
      return 0;
    }

    const events = await this.context.sessionEventTailer.readBackfillEventsSince(threadId, {
      filePath: bridge.latestMirroredSourceFilePath,
      offset: bridge.latestMirroredSourceOffset
    });
    if (events.length === 0) {
      return 0;
    }
    if (!this.isUsableConversationFrontierBackfill(threadId, events)) {
      this.context.logger.debug(
        { threadId },
        "Skipping frontier session-log startup backfill because it would begin a retained conversation turn without its user anchor."
      );
      return 0;
    }

    return this.mirrorSessionBackfillEvents(threadId, events, {
      minCursorExclusive: latestCursor,
      compactStartupReplay
    });
  }

  private isUsableConversationFrontierBackfill(
    threadId: string,
    events: SessionBackfillEvent[]
  ): boolean {
    const channelKind =
      this.runtime.threadState.get(threadId)?.channelKind ??
      this.context.stateStore.getThreadBridge(threadId)?.channelKind ??
      "conversation";
    if (channelKind === "subagent") {
      return true;
    }

    const seenTurnKeys = new Set<string>();
    for (const event of events) {
      const turnId = event.turnId?.trim() ?? "";
      if (!turnId) {
        continue;
      }
      const normalizedTurnId = turnId.toLowerCase();
      if (seenTurnKeys.has(normalizedTurnId)) {
        continue;
      }
      seenTurnKeys.add(normalizedTurnId);

      const turnCursor = this.deps.buildSessionTurnCursor(turnId);
      if (this.deps.hasMirroredUserAnchorForTurn(threadId, turnId, turnCursor)) {
        continue;
      }
      if (event.type === "sessionUserMessage" && !event.isSyntheticSubagentInstruction) {
        continue;
      }
      return false;
    }

    return true;
  }

  private async mirrorSessionBackfillEvents(
    threadId: string,
    events: SessionBackfillEvent[],
    options: {
      minCursorExclusive?: string | null;
      compactStartupReplay?: boolean;
    } = {}
  ): Promise<number> {
    const minCursorExclusive = options.minCursorExclusive ?? null;
    const filteredEvents = events.filter((event) => {
      if (!minCursorExclusive) {
        return true;
      }
      const eventCursor = this.deps.buildSessionEventCursor(event.sourceOrder ?? null, event.eventKey ?? null);
      return Boolean(eventCursor && this.deps.compareItemCursor(eventCursor, minCursorExclusive) > 0);
    });
    const displayEntries: StartupSessionBackfillDisplayEntry[] = buildStartupSessionBackfillDisplayEntries(filteredEvents, {
      leadingEventBudget: this.context.runtimeConfig.startupBackfill.leadingEventBudget,
      trailingEventBudget: this.context.runtimeConfig.startupBackfill.trailingEventBudget
    });
    let mirrored = 0;
    for (const entry of displayEntries) {
      if (entry.kind === "notice") {
        mirrored += await this.publishStartupBackfillNotice(threadId, entry.notice);
        continue;
      }

      const event = entry.event;
      if (event.type === "sessionUserMessage") {
        const before = this.runtime.mirroredChatItems.size;
        await this.deps.handleSessionEvent(event);
        if (this.runtime.mirroredChatItems.size > before) {
          mirrored += 1;
        }
        continue;
      }

      if (event.type === "sessionAgentMessage") {
        const before = this.runtime.mirroredAgentItems.size;
        await this.deps.handleSessionEvent(event);
        if (this.runtime.mirroredAgentItems.size > before) {
          mirrored += 1;
        }
        continue;
      }

      if (event.type === "shellCommandCompleted") {
        const before = this.runtime.mirroredCommandItems.size;
        await this.deps.handleSessionEvent(event);
        if (this.runtime.mirroredCommandItems.size > before) {
          mirrored += 1;
        }
        continue;
      }

      if (event.type === "shellApprovalRequested" || event.type === "sessionSubagentSpawned") {
        await this.deps.handleSessionEvent(event);
        mirrored += 1;
        continue;
      }

      const before = this.runtime.mirroredFileChangeItems.size;
      await this.deps.handleSessionEvent(event);
      if (this.runtime.mirroredFileChangeItems.size > before) {
        mirrored += 1;
      }
    }

    return mirrored;
  }

  private async mirrorStartupCandidateDisplayEntries(
    threadId: string,
    entries: StartupCandidateDisplayEntry<MirrorCandidate>[],
    compactStartupReplay = false
  ): Promise<number> {
    let mirrored = 0;
    let bufferedCandidates: MirrorCandidate[] = [];

    const flushBufferedCandidates = async (): Promise<void> => {
      if (bufferedCandidates.length === 0) {
        return;
      }
      mirrored += await this.deps.mirrorCandidates(threadId, bufferedCandidates, {
        compactStartupReplay
      });
      bufferedCandidates = [];
    };

    for (const entry of entries) {
      if (entry.kind === "candidate") {
        bufferedCandidates.push(entry.candidate);
        continue;
      }
      await flushBufferedCandidates();
      mirrored += await this.publishStartupBackfillNotice(threadId, entry.notice);
    }

    await flushBufferedCandidates();
    return mirrored;
  }

  private async publishStartupBackfillNotice(
    threadId: string,
    notice: StartupBackfillGapNotice
  ): Promise<number> {
    const effectiveTurnCursor = notice.turnCursor ?? this.deps.buildSessionTurnCursor(notice.turnId);
    const itemId = this.buildStartupBackfillNoticeItemId(threadId, notice.turnId, effectiveTurnCursor);
    const eventLabel = notice.skippedCount === 1 ? "event" : "events";
    const noticeText = notice.hasTrailingRetainedEvents
      ? `Startup backfill skipped about ${notice.skippedCount} intermediate ${eventLabel} in this turn. Live updates continue below.`
      : `Startup backfill omitted about ${notice.skippedCount} remaining ${eventLabel} in this turn. Live updates continue below.`;
    return this.deps.publishStartupBackfillNotice(
      threadId,
      itemId,
      noticeText,
      notice.turnId,
      effectiveTurnCursor
    );
  }

  private buildStartupBackfillNoticeItemId(
    threadId: string,
    turnId: string | null,
    turnCursor: string | null
  ): string {
    const normalizedKey =
      turnCursor?.trim() ??
      turnId?.trim() ??
      `thread:${threadId}`;
    return `startup-backfill-gap:${normalizedKey}`;
  }

  private extractAnchorUserTextFromCandidates(candidates: MirrorCandidate[]): string | null {
    for (const candidate of candidates) {
      if (candidate.kind !== "user") {
        continue;
      }
      const text = candidate.text?.trim() ?? "";
      if (text) {
        return text;
      }
    }
    return null;
  }

  private extractAnchorUserTextFromSessionEvents(events: SessionBackfillEvent[]): string | null {
    for (const event of events) {
      if (event.type !== "sessionUserMessage") {
        continue;
      }
      const text = event.text?.trim() ?? "";
      if (text) {
        return text;
      }
    }
    return null;
  }

  private normalizeStartupAnchorText(text: string): string {
    return text.trim().replace(/\s+/g, " ");
  }
}
