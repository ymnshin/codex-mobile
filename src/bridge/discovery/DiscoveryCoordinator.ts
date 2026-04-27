import type {
  ChildThreadAnchorRecord,
  CodexThreadSummary,
  RetainedTurnRecord,
  ThreadBridgeRecord,
  ThreadRuntimeState
} from "../../domain.js";
import type {
  CodexSessionEventTailer,
  DiscoveredLocalSessionThread,
  SessionThreadFrontier
} from "../../codex/CodexSessionEventTailer.js";
import { shortThreadId } from "../../util/formatting.js";
import {
  formatStartupTimingMs,
  isStartupTimingEnabled,
  startupTimingNow
} from "../../util/startupTiming.js";
import { withLogScope } from "../../util/terminalLogging.js";
import type {
  BridgeRuntimeContext
} from "../runtime/BridgeRuntimeContext.js";
import {
  isCodexAutoReviewThread,
  resolveAuthoritativeThreadName
} from "../threadMetadata.js";
import {
  CURRENT_UPDATE_WINDOW_MS,
  DEFAULT_DISCOVERY_LIMIT,
  DISCOVERY_ATTACH_CONCURRENCY,
  DISCOVERY_RESUME_THROTTLE_MS,
  DISCOVERY_RESUME_TIMEOUT_MS,
  INITIAL_DISCOVERY_FETCH_LIMIT,
  INITIAL_IMPORT_FULL_HISTORY_THREAD_LIMIT,
  INITIAL_IMPORT_LIMIT,
  INITIAL_IMPORT_MAX_AGE_MS
} from "../runtime/BridgeRuntimeContext.js";
import type {
  BridgeRuntimeState,
  DiscoveryCandidate,
  ResolvedThreadMetadata,
  HydrateThreadOptions
} from "../runtime/BridgeRuntimeState.js";
import {
  createStartupTransportContext,
  type StartupTransportContext
} from "../startupTransport.js";

interface DiscoveryCoordinatorDependencies {
  backfillLatestTurnMessages(
    threadId: string,
    options?: {
      allowCodexFallback?: boolean;
      sessionMatchMode?: "strict" | "anchor-text" | "none";
      preferLocalSessionTruth?: boolean;
      startupContext?: StartupTransportContext | null;
    }
  ): Promise<number>;
  beginStartupAttachWindow(threadId: string): void;
  beginStartupMirrorBatch(threadId: string): void;
  buildStartupDeduplicationKey(
    thread: CodexThreadSummary,
    metadata: { cwd: string | null; repoName: string | null; threadName?: string | null }
  ): string;
  cleanupExpiredInteractiveArtifacts(): Promise<void>;
  closeGroupedMessages(threadId: string): void;
  captureThreadSessionFrontier(
    threadId: string,
    options?: {
      allowFilesystemScan?: boolean;
    }
  ): Promise<SessionThreadFrontier | null>;
  markThreadSessionFrontier(
    threadId: string,
    sourceFrontier: SessionThreadFrontier | null
  ): Promise<boolean>;
  describeStatusMix(threads: CodexThreadSummary[]): string;
  deleteMappedThread(threadId: string, reason: string): Promise<number>;
  drainThreadEventQueue(threadIds?: Iterable<string>): Promise<void>;
  endStartupAttachWindow(threadId: string): Promise<void>;
  endStartupMirrorBatch(threadId: string): Promise<void>;
  flushStatusUpdate(threadId: string, options?: { force?: boolean }): Promise<void>;
  fastForwardThread(threadId: string): Promise<boolean>;
  getChildThreadAnchor(childThreadId: string): ChildThreadAnchorRecord | null;
  hasPersistedConversationUserAnchor(threadId: string): boolean;
  hydrateThread(
    threadId: string,
    summary: CodexThreadSummary,
    attachMode: "auto" | "manual",
    hydrateOptions?: import("../runtime/BridgeRuntimeState.js").HydrateThreadOptions
  ): Promise<import("../runtime/BridgeRuntimeState.js").HydratedThreadResult>;
  printProgress(message: string): void;
  listRetainedTurns(threadId: string): RetainedTurnRecord[];
  pollDesktopApprovalEvents(): Promise<Set<string>>;
  pollLocalSessionEvents(): Promise<Set<string>>;
  queueMessageSync(threadId: string): void;
  queueStatusUpdate(threadId: string): void;
  replayThreadSessionEventsFromFrontier(
    threadId: string,
    sourceFrontier: SessionThreadFrontier | null,
    options?: {
      allowFilesystemScan?: boolean;
    }
  ): Promise<number>;
  resetThreadMirrorState(threadId: string): void;
  resolveParentThreadId(threadId: string, allowThreadScan?: boolean): Promise<string | null>;
  resolveProgressThreadName(
    candidate: DiscoveryCandidate,
    existing: ThreadBridgeRecord | null,
    current: ThreadRuntimeState | null
  ): string | null;
  resolveThreadMetadata(
    threadId: string,
    preferred?: ResolvedThreadMetadata | null,
    options?: {
      allowFilesystemScan?: boolean;
    }
  ): Promise<ResolvedThreadMetadata>;
  seedMirrorCursorFromStableFrontier(threadId: string): Promise<boolean>;
  shouldPreferSessionStreamForThread(threadId: string): boolean;
  tryReadThread(threadId: string): Promise<CodexThreadSummary | null>;
}

export class DiscoveryCoordinator {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: DiscoveryCoordinatorDependencies
  ) {}

  private printScopedProgress(scope: "attach" | "discovery", message: string): void {
    this.deps.printProgress(withLogScope(scope, message));
  }

  async fastForwardExistingLocalLogs(): Promise<void> {
    const tailer = this.context.sessionEventTailer;
    const threadIds = this.context.stateStore.listThreadBridges().map((bridge) => bridge.codexThreadId);
    let advancedThreadCount = 0;

    for (const threadId of threadIds) {
      try {
        if (await tailer.fastForwardThread(threadId)) {
          advancedThreadCount += 1;
        }
      } catch (error) {
        this.context.logger.debug({ error, threadId }, "Failed to fast-forward a thread session log.");
      }
    }

    let advancedDesktopFileCount = 0;
    try {
      advancedDesktopFileCount = await tailer.fastForwardDesktop();
    } catch (error) {
      this.context.logger.debug({ error }, "Failed to fast-forward desktop approval logs.");
    }

    if (advancedThreadCount > 0 || advancedDesktopFileCount > 0) {
      this.deps.printProgress(
        `Fast-forwarded ${advancedThreadCount} mapped session log(s) and ${advancedDesktopFileCount} desktop log file(s) to current time.`
      );
    }
  }

  async refreshMappedThreadsOnStartup(): Promise<void> {
    const allowedThreadIds = this.discoveryAllowedThreadIds();
    const mapped = this.context.stateStore
      .listThreadBridges()
      .filter((bridge) => !allowedThreadIds || allowedThreadIds.has(bridge.codexThreadId));
    if (mapped.length === 0) {
      this.runtime.startupRefreshedThreadIds.clear();
      this.deps.printProgress("Startup phase A: no existing mapped threads to refresh.");
      return;
    }

    this.deps.printProgress(`Startup phase A: refreshing ${mapped.length} existing mapped thread(s).`);
    const candidates: DiscoveryCandidate[] = [];
    const prunedThreadIds = new Set<string>();

    for (const bridge of mapped) {
      const summary = await this.deps.tryReadThread(bridge.codexThreadId);
      if (!summary) {
        continue;
      }
      if (summary.archived) {
        this.deps.printProgress(
          `Skipping archived ${bridge.sourceKind === "cli-session" ? "CLI " : ""}${bridge.channelKind === "subagent" ? "sub-agent" : "thread"} ${shortThreadId(bridge.codexThreadId)} during startup refresh.`
        );
        continue;
      }
      if (bridge.parentCodexThreadId) {
        const existingHasParentAnchor = Boolean(
          bridge.parentAnchorTurnId?.trim() || bridge.parentAnchorTurnCursor?.trim()
        );
        const startupParentAnchor = existingHasParentAnchor
          ? null
          : await this.resolveStartupParentAnchorForSubagent(bridge.parentCodexThreadId, bridge.codexThreadId);
        if (
          this.shouldPruneStartupSubagentCandidate(
            bridge.parentCodexThreadId,
            summary,
            bridge,
            startupParentAnchor
          )
        ) {
          await this.deps.deleteMappedThread(
            bridge.codexThreadId,
            "Prune stale sub-agent thread on startup because its parent no longer retains the spawning turn"
          );
          prunedThreadIds.add(bridge.codexThreadId);
          this.deps.printProgress(
            `Pruned stale sub-agent ${shortThreadId(bridge.codexThreadId)} because its parent no longer retains the spawning turn.`
          );
          continue;
        }
      }
      candidates.push({
        summary,
        source: bridge.sourceKind ?? "app-server",
        hasLocalSessionSnapshot: false,
        resolvedMetadata: {
          cwd: bridge.cwd ?? null,
          repoName: bridge.repoName ?? null,
          threadName: bridge.threadName ?? null,
          actorName: bridge.actorName ?? null,
          parentThreadId: bridge.parentCodexThreadId ?? null,
          sourceSubagentOther: null,
          originator: null,
          source: null
        }
      });
    }

    if (candidates.length === 0) {
      this.runtime.startupRefreshedThreadIds.clear();
      this.deps.printProgress("Startup phase A: no mapped threads were available from Codex.");
      return;
    }

    this.runtime.startupRefreshedThreadIds = await this.runAttachesWithConcurrency(candidates, false, true, true);
    for (const threadId of prunedThreadIds) {
      this.runtime.startupRefreshedThreadIds.add(threadId);
    }
    await this.deps.pollLocalSessionEvents();
    await this.deps.pollDesktopApprovalEvents();
    this.deps.printProgress("Startup phase A refresh completed.");
  }

  async runDiscoveryCycle(isStartup: boolean): Promise<void> {
    if (this.runtime.discoveryCyclePromise) {
      if (!isStartup) {
        const runningForMs =
          this.runtime.discoveryCycleStartedAt === null ? null : startupTimingNow() - this.runtime.discoveryCycleStartedAt;
        this.printScopedProgress(
          "discovery",
          runningForMs === null
            ? "Skipping this discovery tick because the previous poll is still running."
            : `Skipping this discovery tick because the previous poll has been running for ${formatStartupTimingMs(runningForMs)}.`
        );
      }
      return this.runtime.discoveryCyclePromise;
    }

    this.runtime.discoveryCycleStartedAt = startupTimingNow();
    const cycle = this.runDiscoveryCycleInternal(isStartup).finally(() => {
      if (this.runtime.discoveryCyclePromise === cycle) {
        this.runtime.discoveryCyclePromise = null;
        this.runtime.discoveryCycleStartedAt = null;
      }
    });
    this.runtime.discoveryCyclePromise = cycle;
    return cycle;
  }

  async runDiscoveryCycleInternal(isStartup: boolean): Promise<void> {
    const cycleStartedAt = startupTimingNow();
    try {
      const limit = this.runtime.isColdStart && isStartup ? INITIAL_DISCOVERY_FETCH_LIMIT : DEFAULT_DISCOVERY_LIMIT;
      this.printScopedProgress(
        "discovery",
        isStartup
          ? `Running initial discovery (requesting up to ${limit} Codex thread(s))...`
          : `Polling Codex for updates (requesting up to ${limit} thread(s))...`
      );
      const listThreadsStartedAt = startupTimingNow();
      const appServerThreads = await this.context.codexAdapter.listThreads({
        limit,
        sortKey: "updated_at",
        archived: false,
        sourceKinds: this.context.sourceKinds
      });
      const listThreadsDurationMs = startupTimingNow() - listThreadsStartedAt;
      const listLocalThreadsStartedAt = startupTimingNow();
      const localThreads = await this.listLocalDiscoveryCandidates(limit, isStartup);
      const listLocalThreadsDurationMs = startupTimingNow() - listLocalThreadsStartedAt;
      const allowedThreadIds = this.discoveryAllowedThreadIds();
      const scopedAppServerThreads = allowedThreadIds
        ? appServerThreads.filter((thread) => allowedThreadIds.has(thread.id))
        : appServerThreads;
      const scopedLocalThreads = allowedThreadIds
        ? localThreads.filter((thread) => allowedThreadIds.has(thread.threadId))
        : localThreads;
      this.printScopedProgress(
        "discovery",
        allowedThreadIds
          ? `Codex returned ${appServerThreads.length} thread(s) from app-server; ${scopedAppServerThreads.length} matched the configured thread scope.`
          : `Codex returned ${appServerThreads.length} thread(s) from app-server.`
      );
      if (localThreads.length > 0) {
        const cliCount = scopedLocalThreads.filter((thread) => thread.sourceKind === "cli-session").length;
        const desktopCount = scopedLocalThreads.length - cliCount;
        this.printScopedProgress(
          "discovery",
          allowedThreadIds
            ? `Discovered ${localThreads.length} recent local thread(s) from session files; ${scopedLocalThreads.length} matched the configured thread scope (${desktopCount} Desktop, ${cliCount} CLI).`
            : `Discovered ${localThreads.length} recent local thread(s) from session files (${desktopCount} Desktop, ${cliCount} CLI).`
        );
      }

      const selectStartedAt = startupTimingNow();
      const discoveryCandidates = this.mergeDiscoveryCandidates(scopedAppServerThreads, scopedLocalThreads);
      this.printScopedProgress(
        "discovery",
        `Thread status mix: ${this.deps.describeStatusMix(discoveryCandidates.map((candidate) => candidate.summary))}.`
      );
      const selectedThreads = await this.selectDiscoveryThreads(discoveryCandidates, isStartup);
      const selectDurationMs = startupTimingNow() - selectStartedAt;
      this.printScopedProgress(
        "discovery",
        selectedThreads.length === 0
          ? this.runtime.isColdStart && isStartup
            ? "No recent eligible threads were found to import."
            : "No active or newly updated threads were selected in this poll."
          : `Selected ${selectedThreads.length} thread(s) for Discord attach/update.`
      );
      const prioritizedStartupHistoryThreadIds =
        this.runtime.isColdStart &&
        isStartup &&
        selectedThreads.length > INITIAL_IMPORT_FULL_HISTORY_THREAD_LIMIT
          ? new Set(
              selectedThreads
                .slice(0, INITIAL_IMPORT_FULL_HISTORY_THREAD_LIMIT)
                .map((thread) => thread.summary.id)
            )
          : null;
      if (prioritizedStartupHistoryThreadIds) {
        this.printScopedProgress(
          "discovery",
          `Cold start will backfill startup history for the ${prioritizedStartupHistoryThreadIds.size} newest thread(s) first; older imports attach live-only.`
        );
      }
      const startupContext =
        this.runtime.isColdStart && isStartup && selectedThreads.length > 0
          ? createStartupTransportContext()
          : null;
      const attachStartedAt = startupTimingNow();
      const attachedThreadIds = await this.runAttachesWithConcurrency(
        selectedThreads,
        isStartup,
        false,
        isStartup,
        prioritizedStartupHistoryThreadIds,
        startupContext
      );
      const attachDurationMs = startupTimingNow() - attachStartedAt;
      this.printScopedProgress(
        "discovery",
        `Finished attach/update phase in ${formatStartupTimingMs(attachDurationMs)}.`
      );
      const polledThreadIds = new Set<string>(attachedThreadIds);
      const postAttachStartedAt = startupTimingNow();
      this.mergeThreadIds(polledThreadIds, await this.deps.pollLocalSessionEvents());
      this.mergeThreadIds(polledThreadIds, await this.deps.pollDesktopApprovalEvents());
      if (isStartup) {
        await this.deps.drainThreadEventQueue(polledThreadIds);
      }
      await this.deps.cleanupExpiredInteractiveArtifacts();
      const postAttachDurationMs = startupTimingNow() - postAttachStartedAt;
      this.printScopedProgress(
        "discovery",
        `Discovery cycle completed in ${formatStartupTimingMs(startupTimingNow() - cycleStartedAt)}.`
      );
      this.logStartupTiming(
        `discovery cycle startup=${isStartup} cold=${this.runtime.isColdStart} listThreads=${formatStartupTimingMs(listThreadsDurationMs)} localThreads=${formatStartupTimingMs(listLocalThreadsDurationMs)} select=${formatStartupTimingMs(selectDurationMs)} attach=${formatStartupTimingMs(attachDurationMs)} postAttach=${formatStartupTimingMs(postAttachDurationMs)} total=${formatStartupTimingMs(startupTimingNow() - cycleStartedAt)} selected=${selectedThreads.length} attached=${attachedThreadIds.size} cacheSnapshotHits=${startupContext?.cacheStats.channelSnapshotHits ?? 0} cacheSnapshotMisses=${startupContext?.cacheStats.channelSnapshotMisses ?? 0} targetHits=${startupContext?.cacheStats.writableTargetHits ?? 0} targetMisses=${startupContext?.cacheStats.writableTargetMisses ?? 0} messageHits=${startupContext?.cacheStats.messageHits ?? 0} messageMisses=${startupContext?.cacheStats.messageMisses ?? 0} statusLookupHits=${startupContext?.cacheStats.statusCardLookupHits ?? 0} statusLookupMisses=${startupContext?.cacheStats.statusCardLookupMisses ?? 0}`
      );
    } finally {
      if (isStartup && !this.runtime.isColdStart) {
        this.runtime.startupRefreshedThreadIds.clear();
      }
    }
  }

  private async runAttachesWithConcurrency(
    threads: DiscoveryCandidate[],
    isStartup: boolean,
    forceAttach = false,
    prioritizeConversations = false,
    prioritizedStartupHistoryThreadIds: ReadonlySet<string> | null = null,
    startupContext: StartupTransportContext | null = null
  ): Promise<Set<string>> {
    if (threads.length === 0) {
      return new Set<string>();
    }

    if (prioritizeConversations) {
      const conversations: DiscoveryCandidate[] = [];
      const subagents: DiscoveryCandidate[] = [];
      for (const thread of threads) {
        if (await this.isSubagentCandidate(thread)) {
          subagents.push(thread);
        } else {
          conversations.push(thread);
        }
      }
      const successful = await this.runAttachBatchWithConcurrency(
        conversations,
        isStartup,
        forceAttach,
        prioritizedStartupHistoryThreadIds,
        startupContext
      );
      const subagentSuccesses = await this.runAttachBatchWithConcurrency(
        subagents,
        isStartup,
        forceAttach,
        prioritizedStartupHistoryThreadIds,
        startupContext
      );
      for (const threadId of subagentSuccesses) {
        successful.add(threadId);
      }
      return successful;
    }

    return this.runAttachBatchWithConcurrency(
      threads,
      isStartup,
      forceAttach,
      prioritizedStartupHistoryThreadIds,
      startupContext
    );
  }

  private async runAttachBatchWithConcurrency(
    threads: DiscoveryCandidate[],
    isStartup: boolean,
    forceAttach: boolean,
    prioritizedStartupHistoryThreadIds: ReadonlySet<string> | null,
    startupContext: StartupTransportContext | null
  ): Promise<Set<string>> {
    if (threads.length === 0) {
      return new Set<string>();
    }

    const successful = new Set<string>();
    const concurrency = Math.max(1, Math.min(DISCOVERY_ATTACH_CONCURRENCY, threads.length));
    let nextIndex = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (nextIndex < threads.length) {
        const index = nextIndex;
        nextIndex += 1;
        const thread = threads[index];
        if (!thread) {
          continue;
        }
        try {
          const skipStartupBackfill =
            prioritizedStartupHistoryThreadIds !== null &&
            !prioritizedStartupHistoryThreadIds.has(thread.summary.id);
          await this.maybeAttachThread(
            thread,
            isStartup,
            forceAttach,
            skipStartupBackfill,
            startupContext
          );
          successful.add(thread.summary.id);
        } catch (error) {
          this.context.logger.warn(
            { error, threadId: thread.summary.id, isStartup },
            "Attach/update failed for a discovery candidate. Continuing with remaining threads."
          );
          this.deps.printProgress(
            `Skipped ${shortThreadId(thread.summary.id)} after an attach/update error: ${this.formatErrorForProgress(error)}`
          );
        }
      }
    });
    await Promise.all(workers);
    return successful;
  }

  private mergeThreadIds(target: Set<string>, source: Iterable<string>): void {
    for (const threadId of source) {
      target.add(threadId);
    }
  }

  private async selectDiscoveryThreads(
    threads: DiscoveryCandidate[],
    isStartup: boolean
  ): Promise<DiscoveryCandidate[]> {
    if (!(this.runtime.isColdStart && isStartup)) {
      const selected: DiscoveryCandidate[] = [];
      for (const thread of threads) {
        if (isStartup && !this.runtime.isColdStart && this.runtime.startupRefreshedThreadIds.has(thread.summary.id)) {
          continue;
        }
        if (await this.shouldAttachCandidate(thread, isStartup)) {
          selected.push(thread);
        }
      }
      return selected;
    }

    const cutoff = Date.now() - INITIAL_IMPORT_MAX_AGE_MS;
    const deduped = new Map<string, { candidate: DiscoveryCandidate; activityAtMs: number | null; index: number }>();

    for (const [index, thread] of threads.entries()) {
      if (!(await this.shouldAttachCandidate(thread, true))) {
        continue;
      }

      const summaryActivityAtSeconds = thread.summary.updatedAt ?? thread.summary.createdAt ?? null;
      const activityAtMs =
        typeof summaryActivityAtSeconds === "number" && Number.isFinite(summaryActivityAtSeconds)
          ? summaryActivityAtSeconds * 1000
          : null;
      if (activityAtMs !== null && activityAtMs < cutoff) {
        continue;
      }

      const resolvedMetadata = await this.deps.resolveThreadMetadata(thread.summary.id, thread.resolvedMetadata ?? null);
      const key = this.deps.buildStartupDeduplicationKey(thread.summary, resolvedMetadata);
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, {
          candidate: {
            ...thread,
            resolvedMetadata
          },
          activityAtMs,
          index
        });
        continue;
      }

      const existingActivityAtMs = existing.activityAtMs;
      const shouldReplace =
        (activityAtMs ?? -1) > (existingActivityAtMs ?? -1) ||
        ((activityAtMs ?? -1) === (existingActivityAtMs ?? -1) && index < existing.index);
      if (shouldReplace) {
        deduped.set(key, {
          candidate: {
            ...thread,
            resolvedMetadata
          },
          activityAtMs,
          index
        });
      }
    }

    return [...deduped.values()]
      .sort((left, right) => {
        const leftActivity = left.activityAtMs;
        const rightActivity = right.activityAtMs;
        if (leftActivity !== null && rightActivity !== null && leftActivity !== rightActivity) {
          return rightActivity - leftActivity;
        }
        if (leftActivity !== null && rightActivity === null) {
          return -1;
        }
        if (leftActivity === null && rightActivity !== null) {
          return 1;
        }
        return left.index - right.index;
      })
      .slice(0, INITIAL_IMPORT_LIMIT)
      .map((entry) => entry.candidate);
  }

  private shouldAutoAttachByActivity(thread: CodexThreadSummary, isStartup: boolean): boolean {
    if (thread.ephemeral) return false;
    if (this.runtime.isColdStart && isStartup) return true;

    const existing = this.context.stateStore.getThreadBridge(thread.id);
    const updatedAtMs = (thread.updatedAt ?? thread.createdAt ?? 0) * 1000;

    if (thread.status.type === "active") {
      if (!existing || isStartup) return true;
      const current = this.runtime.threadState.get(thread.id);
      if (!current) return true;
      if (current.status.type !== "active" || existing.lastStatusType !== "active") return true;
      if (!updatedAtMs) return false;
      const latestKnownActivityMs = Math.max(
        existing.latestMirroredTimestampMs ?? 0,
        this.parseBridgeLastSeenAtMs(existing),
        current.lastActivityAt ?? 0
      );
      return updatedAtMs > latestKnownActivityMs + 1000;
    }

    if (!updatedAtMs) return false;

    if (existing) {
      const latestMirroredTimestampMs = existing.latestMirroredTimestampMs ?? 0;
      return updatedAtMs > latestMirroredTimestampMs + 1000;
    }

    return updatedAtMs >= Date.now() - CURRENT_UPDATE_WINDOW_MS;
  }

  private parseBridgeLastSeenAtMs(existing: ThreadBridgeRecord): number {
    if (!existing.lastSeenAt) {
      return 0;
    }
    const parsed = Date.parse(existing.lastSeenAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async shouldAttachCandidate(candidate: DiscoveryCandidate, isStartup: boolean): Promise<boolean> {
    const existing = this.context.stateStore.getThreadBridge(candidate.summary.id);
    const allowFilesystemScan = isStartup;
    const resolvedMetadata = await this.deps.resolveThreadMetadata(
      candidate.summary.id,
      candidate.resolvedMetadata ?? null,
      { allowFilesystemScan }
    );
    candidate.resolvedMetadata = resolvedMetadata;
    if (await this.skipCodexAutoReviewThread(candidate, resolvedMetadata, existing)) {
      return false;
    }
    const childAnchor = this.deps.getChildThreadAnchor(candidate.summary.id);
    const advisoryParentThreadId =
      resolvedMetadata.parentThreadId ??
      (await this.deps.resolveParentThreadId(candidate.summary.id, allowFilesystemScan));
    const resolvedParentThreadId =
      existing?.parentCodexThreadId ??
      childAnchor?.parentThreadId ??
      advisoryParentThreadId;
    const expectedChannelKind = resolvedParentThreadId ? "subagent" : "conversation";

    if (this.runtime.sessionEventTailerEnabled && !existing && !childAnchor && advisoryParentThreadId) {
      return false;
    }

    if (expectedChannelKind === "subagent" && !existing) {
      return Boolean(childAnchor && candidate.hasLocalSessionSnapshot);
    }

    if (this.shouldAutoAttachByActivity(candidate.summary, isStartup)) {
      return true;
    }

    if (!existing) {
      return false;
    }

    const effectiveSourceKind = candidate.source;
    if (effectiveSourceKind !== existing.sourceKind) {
      return true;
    }

    if ((existing.parentCodexThreadId ?? null) !== resolvedParentThreadId) {
      return true;
    }
    if (existing.channelKind !== expectedChannelKind) {
      return true;
    }

    const authoritativeName = resolveAuthoritativeThreadName(
      candidate.summary,
      resolvedMetadata,
      effectiveSourceKind
    );
    if (authoritativeName && authoritativeName !== existing.threadName) {
      return true;
    }

    const authoritativeActorName =
      expectedChannelKind === "subagent" ? resolvedMetadata.actorName?.trim() || null : null;
    if (authoritativeActorName && authoritativeActorName !== (existing.actorName ?? null)) {
      return true;
    }

    return false;
  }

  private async skipCodexAutoReviewThread(
    candidate: DiscoveryCandidate,
    resolvedMetadata: ResolvedThreadMetadata,
    existing: ThreadBridgeRecord | null | undefined
  ): Promise<boolean> {
    if (!isCodexAutoReviewThread(candidate.summary, resolvedMetadata)) {
      return false;
    }

    if (existing) {
      await this.deps.deleteMappedThread(
        candidate.summary.id,
        "Prune Codex auto-review guardian thread"
      );
      this.printScopedProgress(
        "discovery",
        `Pruned Codex auto-review guardian thread ${shortThreadId(candidate.summary.id)}.`
      );
    } else {
      this.printScopedProgress(
        "discovery",
        `Skipping Codex auto-review guardian thread ${shortThreadId(candidate.summary.id)}.`
      );
    }

    return true;
  }

  private async isSubagentCandidate(candidate: DiscoveryCandidate): Promise<boolean> {
    const threadId = candidate.summary.id;
    const existing = this.context.stateStore.getThreadBridge(threadId);
    if ((existing?.parentCodexThreadId ?? null) !== null || existing?.channelKind === "subagent") {
      return true;
    }

    const current = this.runtime.threadState.get(threadId);
    if ((current?.parentThreadId ?? null) !== null || current?.channelKind === "subagent") {
      return true;
    }

    const childAnchor = this.deps.getChildThreadAnchor(threadId);
    if (childAnchor?.parentThreadId) {
      return true;
    }

    return false;
  }

  async maybeAttachThread(
    candidate: DiscoveryCandidate,
    isStartup: boolean,
    forceAttach = false,
    skipStartupBackfill = false,
    startupContext: StartupTransportContext | null = null
  ): Promise<void> {
    const attachStartedAt = startupTimingNow();
    const thread = candidate.summary;
    const existing = this.context.stateStore.getThreadBridge(thread.id);
    if (!forceAttach && !(await this.shouldAttachCandidate(candidate, isStartup))) return;
    if (this.runtime.attachingThreadIds.has(thread.id)) {
      this.printScopedProgress("attach", `Skipping ${shortThreadId(thread.id)} because an attach/update is already in progress.`);
      return;
    }

    this.runtime.attachingThreadIds.add(thread.id);
    const startupOperationContext =
      this.runtime.isColdStart && isStartup && !existing ? startupContext : null;
    if (startupOperationContext) {
      this.runtime.startupTransportContextByThreadId.set(thread.id, startupOperationContext);
    }
    try {
      const metadataStartedAt = startupTimingNow();
      const current = this.runtime.threadState.get(thread.id);
      const resolvedMetadata = await this.deps.resolveThreadMetadata(
        thread.id,
        candidate.resolvedMetadata ?? null,
        { allowFilesystemScan: isStartup || forceAttach }
      );
      const resolveMetadataDurationMs = startupTimingNow() - metadataStartedAt;
      candidate.resolvedMetadata = resolvedMetadata;
      if (await this.skipCodexAutoReviewThread(candidate, resolvedMetadata, existing)) {
        return;
      }
      const childAnchor = this.deps.getChildThreadAnchor(thread.id);
      const advisoryParentThreadId = resolvedMetadata.parentThreadId ?? null;
      if (this.runtime.sessionEventTailerEnabled && !existing && !childAnchor && advisoryParentThreadId) {
        this.printScopedProgress(
          "attach",
          `Skipping hinted child ${shortThreadId(thread.id)} until session history provides an anchored parent turn.`
        );
        return;
      }
      const resolvedParentThreadId =
        (current?.parentThreadId ?? null) ??
        existing?.parentCodexThreadId ??
        childAnchor?.parentThreadId ??
        (await this.deps.resolveParentThreadId(thread.id, false));
      const reuseExistingDiscordLocation = this.shouldReuseStableDiscordLocation(
        existing ?? null,
        candidate,
        resolvedMetadata,
        resolvedParentThreadId,
        isStartup,
        forceAttach
      );
      const existingHasParentAnchor = Boolean(
        existing?.parentAnchorTurnId?.trim() || existing?.parentAnchorTurnCursor?.trim()
      );
      if (resolvedParentThreadId && existing?.channelKind === "subagent" && !existingHasParentAnchor) {
        await this.deps.deleteMappedThread(
          thread.id,
          "Prune inconsistent sub-agent thread because it lacks a retained parent-turn anchor"
        );
        this.printScopedProgress(
          "attach",
          `Pruned inconsistent sub-agent ${shortThreadId(thread.id)} because it lacks a retained parent-turn anchor.`
        );
        return;
      }
      let startupParentAnchor:
        | {
            turnId: string;
            turnCursor: string;
          }
        | null = null;
      if ((isStartup || forceAttach) && resolvedParentThreadId) {
        if (!existing || !existingHasParentAnchor) {
          startupParentAnchor = await this.resolveStartupParentAnchorForSubagent(
            resolvedParentThreadId,
            thread.id
          );
        }
        if (
          this.shouldPruneStartupSubagentCandidate(
            resolvedParentThreadId,
            thread,
            existing ?? null,
            startupParentAnchor
          )
        ) {
          if (existing) {
            await this.deps.deleteMappedThread(
              thread.id,
              "Prune stale sub-agent thread on startup because its parent no longer retains the spawning turn"
            );
            this.printScopedProgress(
              "attach",
              `Pruned stale sub-agent ${shortThreadId(thread.id)} because its parent no longer retains the spawning turn.`
            );
          } else {
            this.printScopedProgress(
              "attach",
              `Skipping stale sub-agent ${shortThreadId(thread.id)} because its parent no longer retains the spawning turn.`
            );
          }
          return;
        }
      }
      const displayThreadName = this.deps.resolveProgressThreadName(candidate, existing ?? null, current ?? null);
      this.printScopedProgress(
        "attach",
        `${existing ? "Refreshing" : "Attaching"} ${candidate.source === "cli-session" ? "CLI " : ""}${existing?.channelKind === "subagent" ? "sub-agent" : "thread"} ${shortThreadId(thread.id)}${displayThreadName ? ` (${displayThreadName})` : ""}.`
      );
      const hydrateStartedAt = startupTimingNow();
      const { runtime, createdDiscordLocation } = await this.deps.hydrateThread(
        thread.id,
        thread,
        existing?.attachMode ?? "auto",
        {
          ...(startupOperationContext ? ({ startupContext: startupOperationContext } satisfies HydrateThreadOptions) : {}),
          sourceKind: candidate.source,
          ...(resolvedParentThreadId !== null ? { parentThreadId: resolvedParentThreadId } : {}),
          ...(startupParentAnchor
            ? {
                parentAnchorTurnId: startupParentAnchor.turnId,
                parentAnchorTurnCursor: startupParentAnchor.turnCursor
              }
            : {}),
          allowFilesystemScan: isStartup || forceAttach,
          reuseExistingDiscordLocation,
          resolvedMetadata
        }
      );
      const hydrateDurationMs = startupTimingNow() - hydrateStartedAt;
      let seededExistingCursor = false;
      let repairedExistingHistoryCount = 0;
      const preferSessionStream = this.deps.shouldPreferSessionStreamForThread(runtime.threadId);
      const hydratedBridge = this.context.stateStore.getThreadBridge(thread.id);
      const didMoveDiscordLocation =
        existing !== undefined &&
        hydratedBridge?.discordChannelId !== undefined &&
        hydratedBridge.discordChannelId !== null &&
        existing.discordChannelId !== hydratedBridge.discordChannelId;
      const shouldReinitializeDiscordHistory = Boolean(createdDiscordLocation || didMoveDiscordLocation);
      const shouldRepairConversationAnchor =
        Boolean(existing) &&
        !shouldReinitializeDiscordHistory &&
        (isStartup || forceAttach) &&
        runtime.channelKind === "conversation" &&
        !this.deps.hasPersistedConversationUserAnchor(thread.id);
      const shouldRepairExistingStartupHistory =
        Boolean(existing) &&
        !shouldReinitializeDiscordHistory &&
        !shouldRepairConversationAnchor &&
        (isStartup || forceAttach);
      const shouldDeferColdStartHistory =
        skipStartupBackfill &&
        !existing &&
        this.runtime.isColdStart &&
        isStartup;
      const shouldInitializeThreadHistory = !existing || shouldReinitializeDiscordHistory || shouldRepairConversationAnchor;
      const shouldCaptureStartupSessionFrontier =
        preferSessionStream &&
        (shouldInitializeThreadHistory || shouldRepairExistingStartupHistory || shouldDeferColdStartHistory);
      const startupSessionFrontier = shouldCaptureStartupSessionFrontier
        ? await this.deps.captureThreadSessionFrontier(thread.id)
        : null;
      if (startupSessionFrontier) {
        await this.deps.markThreadSessionFrontier(thread.id, startupSessionFrontier);
      }
      if (existing && (shouldReinitializeDiscordHistory || shouldRepairConversationAnchor)) {
        this.deps.resetThreadMirrorState(thread.id);
      }
      let flushStatusDurationMs = 0;
      if (!existing) {
        if (startupOperationContext) {
          this.deps.beginStartupAttachWindow(runtime.threadId);
        }
        const flushStatusStartedAt = startupTimingNow();
        await this.deps.flushStatusUpdate(runtime.threadId, { force: true });
        flushStatusDurationMs = startupTimingNow() - flushStatusStartedAt;
      }
      const shouldCompactStartupReplay = Boolean(startupOperationContext?.compactStartupReplay && !existing);
      let startupHistoryDurationMs = 0;
      let replayFrontierDurationMs = 0;
      let resumeDurationMs = 0;
      if (shouldDeferColdStartHistory) {
        if (preferSessionStream) {
          const replayStartedAt = startupTimingNow();
          const replayedStartupSessionEvents = await this.deps.replayThreadSessionEventsFromFrontier(
            thread.id,
            startupSessionFrontier
          );
          replayFrontierDurationMs = startupTimingNow() - replayStartedAt;
          if (replayedStartupSessionEvents > 0) {
            this.printScopedProgress(
              "attach",
              `Recovered ${shortThreadId(thread.id)} with ${replayedStartupSessionEvents} startup-window live session event(s).`
            );
          }
        } else if (candidate.source !== "cli-session" && runtime.channelKind === "conversation") {
          const seedStartedAt = startupTimingNow();
          seededExistingCursor = await this.deps.seedMirrorCursorFromStableFrontier(thread.id);
          startupHistoryDurationMs = startupTimingNow() - seedStartedAt;
        } else if (candidate.source === "cli-session") {
          const fastForwardStartedAt = startupTimingNow();
          await this.deps.fastForwardThread(thread.id);
          startupHistoryDurationMs = startupTimingNow() - fastForwardStartedAt;
        }
        this.printScopedProgress(
          "attach",
          `Deferred startup history for ${shortThreadId(thread.id)} so newer threads can finish first. Live updates will continue.`
        );
      } else if (shouldInitializeThreadHistory) {
        if (shouldCompactStartupReplay) {
          this.deps.beginStartupMirrorBatch(thread.id);
        }
        const startupHistoryStartedAt = startupTimingNow();
        const sessionMatchMode =
          runtime.channelKind === "conversation"
            ? shouldRepairConversationAnchor
              ? "none"
              : shouldReinitializeDiscordHistory
                ? "anchor-text"
                : "strict"
            : "strict";
        const preferLocalSessionTruth =
          candidate.hasLocalSessionSnapshot &&
          preferSessionStream &&
          (isStartup || forceAttach) &&
          !existing;
        const backfilledCount = await this.deps.backfillLatestTurnMessages(thread.id, {
          allowCodexFallback: runtime.channelKind === "conversation" && !shouldRepairConversationAnchor,
          sessionMatchMode,
          ...(preferLocalSessionTruth ? { preferLocalSessionTruth: true } : {}),
          ...(startupOperationContext ? { startupContext: startupOperationContext } : {})
        });
        if (backfilledCount > 0) {
          this.printScopedProgress("attach", `Initialized ${shortThreadId(thread.id)} with ${backfilledCount} mirrored startup event(s).`);
        }
        startupHistoryDurationMs = startupTimingNow() - startupHistoryStartedAt;
        if (shouldCompactStartupReplay) {
          await this.deps.endStartupMirrorBatch(thread.id);
        }
      } else if (shouldRepairExistingStartupHistory) {
        const repairStartedAt = startupTimingNow();
        repairedExistingHistoryCount = await this.deps.backfillLatestTurnMessages(thread.id, {
          allowCodexFallback: runtime.channelKind === "conversation" && !preferSessionStream,
          sessionMatchMode: runtime.channelKind === "conversation" ? "anchor-text" : "strict",
          ...(preferSessionStream ? { preferLocalSessionTruth: true } : {}),
          ...(startupOperationContext ? { startupContext: startupOperationContext } : {})
        });
        startupHistoryDurationMs = startupTimingNow() - repairStartedAt;
        if (repairedExistingHistoryCount > 0) {
          this.printScopedProgress(
            "attach",
            `Recovered ${shortThreadId(thread.id)} with ${repairedExistingHistoryCount} mirrored startup event(s).`
          );
        }
      }
      if (shouldInitializeThreadHistory || shouldRepairExistingStartupHistory) {
        this.deps.closeGroupedMessages(thread.id);
      }
      if (startupSessionFrontier && !shouldDeferColdStartHistory) {
        const replayStartedAt = startupTimingNow();
        const replayedStartupSessionEvents = await this.deps.replayThreadSessionEventsFromFrontier(
          thread.id,
          startupSessionFrontier
        );
        replayFrontierDurationMs = startupTimingNow() - replayStartedAt;
        if (replayedStartupSessionEvents > 0) {
          this.printScopedProgress(
            "attach",
            `Recovered ${shortThreadId(thread.id)} with ${replayedStartupSessionEvents} startup-window live session event(s).`
          );
        }
      }
      if (
        existing &&
        !shouldReinitializeDiscordHistory &&
        !shouldRepairConversationAnchor &&
        repairedExistingHistoryCount === 0 &&
        !shouldRepairExistingStartupHistory &&
        !existing.latestMirroredCursor &&
        runtime.channelKind === "conversation" &&
        !preferSessionStream
      ) {
        seededExistingCursor = await this.deps.seedMirrorCursorFromStableFrontier(thread.id);
      }
      if (
        runtime.channelKind !== "subagent" &&
        this.shouldResumeAppServerThread(candidate, existing ?? null, isStartup, forceAttach)
      ) {
        const resumeStartedAt = startupTimingNow();
        try {
          this.runtime.lastAppServerResumeAttemptAtByThread.set(thread.id, resumeStartedAt);
          await this.context.codexAdapter.resumeThread(thread.id, {
            timeoutMs: DISCOVERY_RESUME_TIMEOUT_MS
          });
          resumeDurationMs = startupTimingNow() - resumeStartedAt;
        } catch (error) {
          if (this.isMissingRolloutError(error)) {
            this.context.logger.warn(
              { error, threadId: thread.id },
              "Skipping resume for thread because Codex app-server reported a missing rollout."
            );
            this.printScopedProgress(
              "attach",
              `Skipped resume for ${shortThreadId(thread.id)} because Codex reported a missing rollout.`
            );
          } else if (this.isRequestTimeoutError(error)) {
            resumeDurationMs = startupTimingNow() - resumeStartedAt;
            this.context.logger.warn(
              { error, threadId: thread.id, timeoutMs: DISCOVERY_RESUME_TIMEOUT_MS },
              "Timed out resuming thread during discovery. Continuing without blocking the poll."
            );
            this.printScopedProgress(
              "attach",
              `Skipped resume for ${shortThreadId(thread.id)} after ${formatStartupTimingMs(DISCOVERY_RESUME_TIMEOUT_MS)} timeout.`
            );
          } else {
            throw error;
          }
        }
      }
      const refreshedBridge = this.context.stateStore.getThreadBridge(thread.id);
      if (refreshedBridge) {
        this.printScopedProgress(
          "attach",
          `${existing ? "Updated" : "Mapped"} ${shortThreadId(thread.id)} -> Discord ${runtime.channelKind === "subagent" ? "thread" : "channel"} ${refreshedBridge.discordChannelId} in project ${runtime.projectName}.`
        );
      }
      if (existing) {
        this.deps.queueStatusUpdate(runtime.threadId);
        if (
          !preferSessionStream &&
          !shouldReinitializeDiscordHistory &&
          !shouldRepairConversationAnchor &&
          !shouldRepairExistingStartupHistory &&
          !seededExistingCursor &&
          candidate.source !== "cli-session"
        ) {
          this.deps.queueMessageSync(runtime.threadId);
        }
      } else if (startupOperationContext) {
        const finalStatusStartedAt = startupTimingNow();
        await this.deps.endStartupAttachWindow(runtime.threadId);
        flushStatusDurationMs += startupTimingNow() - finalStatusStartedAt;
      }
      const startupThreadStats = startupOperationContext?.threadWriteStats.get(thread.id) ?? null;
      this.logStartupTiming(
        `attach ${shortThreadId(thread.id)} source=${candidate.source} existing=${Boolean(existing)} deferred=${shouldDeferColdStartHistory} resolveMetadata=${formatStartupTimingMs(resolveMetadataDurationMs)} hydrate=${formatStartupTimingMs(hydrateDurationMs)} status=${formatStartupTimingMs(flushStatusDurationMs)} startupHistory=${formatStartupTimingMs(startupHistoryDurationMs)} replayFrontier=${formatStartupTimingMs(replayFrontierDurationMs)} resume=${formatStartupTimingMs(resumeDurationMs)} total=${formatStartupTimingMs(startupTimingNow() - attachStartedAt)} startupWrites=${startupThreadStats?.totalWrites ?? 0} statusWrites=${startupThreadStats?.statusCardWrites ?? 0} liveWrites=${startupThreadStats?.liveMessageWrites ?? 0} textWrites=${startupThreadStats?.textMessageWrites ?? 0}`
      );
    } finally {
      if (startupOperationContext) {
        if (this.runtime.startupMirrorBatchByThreadId.has(thread.id)) {
          await this.deps.endStartupMirrorBatch(thread.id).catch((error) => {
            this.context.logger.debug({ error, threadId: thread.id }, "Failed to flush startup mirror batch.");
          });
        }
        if (this.runtime.startupStatusSuppressedThreadIds.has(thread.id)) {
          await this.deps.endStartupAttachWindow(thread.id).catch((error) => {
            this.context.logger.debug({ error, threadId: thread.id }, "Failed to end startup status attach window.");
          });
        }
        this.runtime.startupTransportContextByThreadId.delete(thread.id);
      }
      this.runtime.attachingThreadIds.delete(thread.id);
    }
  }

  private logStartupTiming(message: string): void {
    if (!isStartupTimingEnabled()) {
      return;
    }
    this.deps.printProgress(`[startup-timing] ${message}`);
  }

  private shouldResumeAppServerThread(
    candidate: DiscoveryCandidate,
    existing: ThreadBridgeRecord | null,
    isStartup: boolean,
    forceAttach: boolean
  ): boolean {
    if (candidate.source === "cli-session") {
      return false;
    }
    if (!existing || isStartup || forceAttach) {
      return true;
    }
    const lastAttemptAt = this.runtime.lastAppServerResumeAttemptAtByThread.get(candidate.summary.id) ?? 0;
    return startupTimingNow() - lastAttemptAt >= DISCOVERY_RESUME_THROTTLE_MS;
  }

  private shouldReuseStableDiscordLocation(
    existing: ThreadBridgeRecord | null,
    candidate: DiscoveryCandidate,
    resolvedMetadata: ResolvedThreadMetadata,
    resolvedParentThreadId: string | null,
    isStartup: boolean,
    forceAttach: boolean
  ): boolean {
    if (!existing || isStartup || forceAttach || !existing.discordChannelId) {
      return false;
    }

    const expectedChannelKind = resolvedParentThreadId ? "subagent" : "conversation";
    if (existing.channelKind !== expectedChannelKind) {
      return false;
    }
    if (expectedChannelKind === "subagent" && !existing.discordParentChannelId) {
      return false;
    }
    if ((existing.parentCodexThreadId ?? null) !== resolvedParentThreadId) {
      return false;
    }

    const effectiveSourceKind = candidate.source;
    if (effectiveSourceKind !== existing.sourceKind) {
      return false;
    }

    const authoritativeName = resolveAuthoritativeThreadName(
      candidate.summary,
      resolvedMetadata,
      effectiveSourceKind
    );
    if (authoritativeName && authoritativeName !== existing.threadName) {
      return false;
    }

    const authoritativeActorName =
      expectedChannelKind === "subagent" ? resolvedMetadata.actorName?.trim() || null : null;
    if (authoritativeActorName && authoritativeActorName !== (existing.actorName ?? null)) {
      return false;
    }

    return true;
  }

  private isMissingRolloutError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    return error.message.toLowerCase().includes("no rollout found for thread id");
  }

  private isRequestTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.message.toLowerCase().includes("timed out after");
  }

  private formatErrorForProgress(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim();
    }
    return "unknown error";
  }

  private async listLocalDiscoveryCandidates(limit: number, isStartup: boolean): Promise<DiscoveredLocalSessionThread[]> {
    const tailer: CodexSessionEventTailer = this.context.sessionEventTailer;
    const maxAgeMs = this.runtime.isColdStart && isStartup ? INITIAL_IMPORT_MAX_AGE_MS : CURRENT_UPDATE_WINDOW_MS;
    try {
      return await tailer.listRecentLocalThreads(limit, maxAgeMs);
    } catch (error) {
      this.context.logger.debug({ error }, "Failed to discover recent local session threads.");
      return [];
    }
  }

  private discoveryAllowedThreadIds(): ReadonlySet<string> | null {
    const ids = this.context.runtimeConfig.discovery.allowedThreadIds;
    return ids.length > 0 ? new Set(ids) : null;
  }

  private async resolveStartupParentAnchorForSubagent(
    parentThreadId: string,
    childThreadId: string
  ): Promise<{ turnId: string; turnCursor: string } | null> {
    const retainedParentTurns = this.collectRetainedParentTurns(parentThreadId);
    const storedAnchor = this.deps.getChildThreadAnchor(childThreadId);
    if (storedAnchor?.parentThreadId === parentThreadId) {
      const storedKey =
        storedAnchor.parentTurnCursor?.trim()
          ? `cursor:${storedAnchor.parentTurnCursor.trim()}`
          : storedAnchor.parentTurnId?.trim()
            ? `turn:${storedAnchor.parentTurnId.trim().toLowerCase()}`
            : null;
      if (storedKey && retainedParentTurns.has(storedKey)) {
        return retainedParentTurns.get(storedKey) ?? null;
      }
    }

    const keepCount = Math.max(1, this.context.runtimeConfig.retention.maxTurnsPerThread);
    try {
      const parentEvents = await this.context.sessionEventTailer.readRecentTurnBackfillEvents(parentThreadId, keepCount);
      for (let index = parentEvents.length - 1; index >= 0; index -= 1) {
        const event = parentEvents[index];
        if (
          event?.type === "sessionSubagentSpawned" &&
          event.childThreadId === childThreadId &&
          typeof event.turnId === "string" &&
          event.turnId.trim()
        ) {
          const normalizedTurnId = event.turnId.trim().toLowerCase();
          return retainedParentTurns.get(`turn:${normalizedTurnId}`) ?? null;
        }
      }
    } catch (error) {
      this.context.logger.debug(
        { error, parentThreadId, childThreadId },
        "Failed to resolve a retained parent-turn anchor for a discovered sub-agent."
      );
    }

    return null;
  }

  private collectRetainedParentTurns(
    parentThreadId: string
  ): Map<string, { turnId: string; turnCursor: string }> {
    const retained = new Map<string, { turnId: string; turnCursor: string }>();
    for (const record of this.deps.listRetainedTurns(parentThreadId)) {
      const turnId = record.turnId?.trim() || "";
      const turnCursor =
        record.turnCursor?.trim() || (record.turnId ? `turn:${record.turnId.trim().toLowerCase()}` : "");
      const value = { turnId, turnCursor };
      retained.set(record.turnKey, value);
      if (turnId) {
        retained.set(`turn:${turnId.toLowerCase()}`, value);
      }
      if (turnCursor) {
        retained.set(`cursor:${turnCursor}`, value);
      }
    }
    return retained;
  }

  private shouldPruneStartupSubagentCandidate(
    parentThreadId: string,
    thread: CodexThreadSummary,
    existing: ThreadBridgeRecord | null,
    startupParentAnchor: { turnId: string; turnCursor: string } | null
  ): boolean {
    if (startupParentAnchor) {
      return false;
    }

    const retainedTurnIds = new Set(this.collectRetainedParentTurns(parentThreadId).keys());
    if (retainedTurnIds.size === 0) {
      return true;
    }

    const storedAnchor = this.deps.getChildThreadAnchor(thread.id);
    const effectiveAnchorTurnCursor =
      storedAnchor?.parentTurnCursor?.trim() ??
      existing?.parentAnchorTurnCursor?.trim() ??
      null;
    const normalizedAnchorTurnId =
      storedAnchor?.parentTurnId?.trim().toLowerCase() ??
      existing?.parentAnchorTurnId?.trim().toLowerCase() ??
      "";
    const anchorKey =
      effectiveAnchorTurnCursor !== null
        ? `cursor:${effectiveAnchorTurnCursor}`
        : normalizedAnchorTurnId
          ? `turn:${normalizedAnchorTurnId}`
          : null;
    if (!anchorKey) {
      return true;
    }

    return !retainedTurnIds.has(anchorKey);
  }

  private mergeDiscoveryCandidates(
    appServerThreads: CodexThreadSummary[],
    localThreads: DiscoveredLocalSessionThread[]
  ): DiscoveryCandidate[] {
    const merged = new Map<string, DiscoveryCandidate>();

    for (const thread of appServerThreads) {
      if (thread.archived) {
        continue;
      }
      const cachedMetadata = this.runtime.resolvedMetadataByThread.get(thread.id);
      merged.set(thread.id, {
        summary: thread,
        source: "app-server",
        hasLocalSessionSnapshot: false,
        ...(cachedMetadata ? { resolvedMetadata: cachedMetadata } : {})
      });
    }

    for (const thread of localThreads) {
      const localCandidate: DiscoveryCandidate = {
        summary: {
          id: thread.threadId,
          name: thread.name,
          preview: thread.preview,
          modelProvider: null,
          createdAt: thread.createdAtMs ? Math.floor(thread.createdAtMs / 1000) : null,
          updatedAt: thread.updatedAtMs ? Math.floor(thread.updatedAtMs / 1000) : null,
          ephemeral: false,
          archived: false,
          status: thread.status === "active" ? { type: "active", activeFlags: [] } : { type: "idle" }
        },
        source: thread.sourceKind,
        hasLocalSessionSnapshot: true,
        resolvedMetadata: {
          cwd: thread.cwd ?? null,
          repoName: thread.repoName ?? null,
          threadName: thread.sourceKind === "cli-session" ? thread.name ?? null : null,
          actorName: thread.actorName ?? null,
          parentThreadId: thread.parentThreadId ?? null,
          sourceSubagentOther: thread.sourceSubagentOther ?? null,
          originator: thread.originator ?? null,
          source: thread.source ?? null
        }
      };

      const existing = merged.get(thread.threadId);
      if (!existing) {
        merged.set(thread.threadId, localCandidate);
        continue;
      }

      const existingActivity = existing.summary.updatedAt ?? existing.summary.createdAt ?? 0;
      const cliActivity = localCandidate.summary.updatedAt ?? localCandidate.summary.createdAt ?? 0;
      const existingIsActive = existing.summary.status.type === "active";
      const cliIsActive = localCandidate.summary.status.type === "active";
      const localIsCli = localCandidate.source === "cli-session";
      const existingIsAppServer = existing.source === "app-server";
      const existingIsNotLoaded = existing.summary.status.type === "notLoaded";

      const shouldPreferCli =
        (localIsCli && existingIsAppServer) ||
        cliActivity > existingActivity ||
        (cliActivity === existingActivity && cliIsActive && !existingIsActive) ||
        (cliIsActive && existingIsNotLoaded);

      if (shouldPreferCli) {
        merged.set(thread.threadId, localCandidate);
      } else if (!existing.resolvedMetadata && localCandidate.resolvedMetadata) {
        merged.set(thread.threadId, {
          ...existing,
          hasLocalSessionSnapshot: true,
          resolvedMetadata: localCandidate.resolvedMetadata
        });
      } else if (
        localCandidate.resolvedMetadata?.sourceSubagentOther &&
        existing.resolvedMetadata?.sourceSubagentOther !== localCandidate.resolvedMetadata.sourceSubagentOther
      ) {
        merged.set(thread.threadId, {
          ...existing,
          hasLocalSessionSnapshot: true,
          resolvedMetadata: {
            ...(existing.resolvedMetadata ?? localCandidate.resolvedMetadata),
            sourceSubagentOther: localCandidate.resolvedMetadata.sourceSubagentOther
          }
        });
      } else if (!existing.hasLocalSessionSnapshot) {
        merged.set(thread.threadId, {
          ...existing,
          hasLocalSessionSnapshot: true
        });
      }
    }

    return [...merged.values()].sort((left, right) => {
      const leftUpdatedAt = left.summary.updatedAt ?? left.summary.createdAt ?? 0;
      const rightUpdatedAt = right.summary.updatedAt ?? right.summary.createdAt ?? 0;
      return rightUpdatedAt - leftUpdatedAt;
    });
  }
}
