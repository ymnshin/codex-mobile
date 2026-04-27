import type {
  ChildThreadAnchorRecord,
  CodexItem,
  CodexThreadStatus,
  CodexThreadSummary,
  MirroredItemRecord,
  RetainedTurnRecord,
  ThreadRuntimeState
} from "../../domain.js";
import path from "node:path";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import type {
  BridgeRuntimeState,
  MirrorCandidate,
  ThreadSourceFrontier,
  UserTurnMirrorState
} from "../runtime/BridgeRuntimeState.js";
import {
  compareItemCursor as compareMirrorItemCursor,
  compareTurnCursor as compareMirrorTurnCursor,
  parseItemCursor as parseMirrorItemCursor,
  parseTurnCursor as parseMirrorTurnCursor,
  type ParsedMirrorCursor,
  type ParsedTurnCursor
} from "../mirrorCursors.js";
import { deserializeStatus as deserializeThreadStatus } from "../statusCards.js";
import { truncateForDiscord, redactSensitiveText } from "../../util/redaction.js";
import { formatTerminalLogLine } from "../../util/terminalLogging.js";

interface MirrorStateCoordinatorDependencies {
  buildTurnCursor(turn: unknown, turnOrder: number): string | null;
  deleteMappedThread(threadId: string, reason: string): Promise<number>;
  extractUuidV7TimestampMs(value: string): number | null;
  renderMirroredPayload?(payload: unknown): string;
}

export class MirrorStateCoordinator {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: MirrorStateCoordinatorDependencies
  ) {}

  ensureMirrorStateHydrated(threadId: string): void {
    if (this.runtime.hydratedMirrorStateThreadIds.has(threadId)) {
      return;
    }

    const records = this.context.stateStore.listMirroredItems(threadId);
    const userTurnStateByTurnKey = new Map<string, { firstItemId: string; firstCursor: string | null }>();
    for (const record of records) {
      const itemKey = this.mirroredItemKey(threadId, record.itemId);
      switch (record.kind) {
        case "user":
          this.runtime.mirroredChatItems.set(itemKey, record.contentSignature);
          this.runtime.mirroredUserMessages.set(itemKey, {
            messageId: record.discordMessageId,
            content: record.renderedContent
          });
          {
            const turnKey = this.mirroredTurnKey(record.turnId, record.turnCursor);
            if (turnKey) {
              const existing = userTurnStateByTurnKey.get(turnKey);
              if (!existing) {
                userTurnStateByTurnKey.set(turnKey, {
                  firstItemId: record.itemId,
                  firstCursor: record.cursor
                });
              } else {
                const left = record.cursor;
                const right = existing.firstCursor;
                if (left && right) {
                  if (this.compareItemCursor(left, right) < 0) {
                    userTurnStateByTurnKey.set(turnKey, {
                      firstItemId: record.itemId,
                      firstCursor: record.cursor
                    });
                  }
                } else if (left && !right) {
                  userTurnStateByTurnKey.set(turnKey, {
                    firstItemId: record.itemId,
                    firstCursor: record.cursor
                  });
                }
              }
            }
          }
          break;
        case "agentAnswer":
          this.runtime.mirroredAgentItems.set(itemKey, record.contentSignature);
          this.runtime.mirroredAnswerMessages.set(itemKey, {
            messageId: record.discordMessageId,
            content: record.renderedContent
          });
          break;
        case "agentCommentary":
          this.runtime.mirroredAgentItems.set(itemKey, record.contentSignature);
          break;
        case "command":
          this.runtime.mirroredCommandItems.set(itemKey, record.contentSignature);
          break;
        case "fileChange":
          this.runtime.mirroredFileChangeItems.set(itemKey, record.contentSignature);
          break;
      }
    }

    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const latestCursor =
      bridge?.latestMirroredCursor ??
      records
        .map((record) => record.cursor)
        .filter((cursor): cursor is string => Boolean(cursor))
        .sort((left, right) => this.compareItemCursor(left, right))
        .at(-1) ??
      null;
    if (latestCursor) {
      this.runtime.latestMirroredCursorByThread.set(threadId, latestCursor);
    }

    const latestTurnCursor =
      bridge?.latestMirroredTurnCursor ??
      records
        .map((record) => record.turnCursor)
        .filter((cursor): cursor is string => Boolean(cursor))
        .sort((left, right) => this.compareTurnCursor(left, right))
        .at(-1) ??
      null;
    if (latestTurnCursor) {
      this.runtime.latestMirroredTurnCursorByThread.set(threadId, latestTurnCursor);
    }

    this.runtime.mirroredUserTurnStateByThread.set(
      threadId,
      new Map<string, UserTurnMirrorState>(
        [...userTurnStateByTurnKey.entries()].map(([turnKey, value]) => [
          turnKey,
          {
            firstItemId: value.firstItemId,
            textFingerprints: new Set<string>()
          }
        ])
      )
    );
    this.runtime.hydratedMirrorStateThreadIds.add(threadId);
  }

  mirroredItemKey(threadId: string, itemId: string): string {
    return `${threadId}:${itemId}`;
  }

  resolveUserHeadingLevel(
    threadId: string,
    itemId: string,
    turnId: string | null,
    turnCursor: string | null
  ): 1 | 3 {
    const turnKey = this.mirroredTurnKey(turnId, turnCursor);
    if (!turnKey) {
      return 1;
    }
    const turnState = this.getOrCreateUserTurnState(threadId, turnKey, itemId);
    return turnState.firstItemId === itemId ? 1 : 3;
  }

  markUserTurnMirrored(
    threadId: string,
    itemId: string,
    turnId: string | null,
    turnCursor: string | null,
    text: string
  ): void {
    const turnKey = this.mirroredTurnKey(turnId, turnCursor);
    if (!turnKey) {
      return;
    }
    const turnState = this.getOrCreateUserTurnState(threadId, turnKey, itemId);
    if (!turnState.firstItemId) {
      turnState.firstItemId = itemId;
    }
    const fingerprint = this.userMessageFingerprint(text);
    if (fingerprint) {
      turnState.textFingerprints.add(fingerprint);
    }
    this.runtime.pendingConversationAnchorThreadIds.delete(threadId);
  }

  shouldSkipDuplicateUserText(
    threadId: string,
    itemId: string,
    turnId: string | null,
    turnCursor: string | null,
    text: string
  ): boolean {
    const turnKey = this.mirroredTurnKey(turnId, turnCursor);
    if (!turnKey) {
      return false;
    }
    let byTurn = this.runtime.mirroredUserTurnStateByThread.get(threadId);
    if (!byTurn) {
      byTurn = new Map<string, UserTurnMirrorState>();
      this.runtime.mirroredUserTurnStateByThread.set(threadId, byTurn);
    }
    const turnState = byTurn.get(turnKey);
    if (!turnState || turnState.firstItemId === itemId) {
      return false;
    }
    const fingerprint = this.userMessageFingerprint(text);
    return Boolean(fingerprint) && turnState.textFingerprints.has(fingerprint);
  }

  clearUserTurnMirrorState(threadId: string): void {
    this.runtime.mirroredUserTurnStateByThread.delete(threadId);
  }

  clearAllUserTurnMirrorState(): void {
    this.runtime.mirroredUserTurnStateByThread.clear();
  }

  resetThreadMirrorState(threadId: string): void {
    this.runtime.hydratedMirrorStateThreadIds.delete(threadId);
    this.runtime.liveAgentMessages.delete(threadId);
    this.runtime.latestMirroredCursorByThread.delete(threadId);
    this.runtime.latestMirroredTurnCursorByThread.delete(threadId);
    this.runtime.latestMirroredTimestampMsByThread.delete(threadId);
    this.runtime.latestSourceFrontierByThread.delete(threadId);
    this.runtime.suppressedSyntheticSessionTurnIdsByThread.delete(threadId);
    this.deleteMirroredEntriesByThread(this.runtime.mirroredChatItems, threadId);
    this.deleteMirroredEntriesByThread(this.runtime.mirroredAgentItems, threadId);
    this.deleteMirroredEntriesByThread(this.runtime.mirroredCommandItems, threadId);
    this.deleteMirroredEntriesByThread(this.runtime.mirroredFileChangeItems, threadId);
    this.deleteMirroredEntriesByThread(this.runtime.mirroredUserMessages, threadId);
    this.deleteMirroredEntriesByThread(this.runtime.mirroredAnswerMessages, threadId);
    this.closeGroupedMessages(threadId);
    this.clearUserTurnMirrorState(threadId);
    this.context.stateStore.deleteMirroredItemsByThread(threadId);
    this.context.stateStore.deleteMessageDetailsByThread(threadId);
    this.context.stateStore.deleteProposedPlanActionsByThread(threadId);
    this.context.stateStore.updateThreadMirrorCursor(threadId, null, null, null);

    const channelKind =
      this.runtime.threadState.get(threadId)?.channelKind ??
      this.context.stateStore.getThreadBridge(threadId)?.channelKind ??
      "conversation";
    if (channelKind === "conversation") {
      this.runtime.pendingConversationAnchorThreadIds.add(threadId);
    } else {
      this.runtime.pendingConversationAnchorThreadIds.delete(threadId);
    }

    this.traceMirror("mirror.thread.reset", {
      threadId,
      channelKind
    });
  }

  hasMirroredUserAnchorForTurn(
    threadId: string,
    turnId: string | null | undefined,
    turnCursor: string | null | undefined
  ): boolean {
    const turnCursorKey = this.mirroredTurnKey(null, turnCursor ?? null);
    const turnIdKey = this.mirroredTurnKey(turnId ?? null, null);
    if (!turnCursorKey && !turnIdKey) {
      return false;
    }

    this.ensureMirrorStateHydrated(threadId);
    const mirroredTurnState = this.runtime.mirroredUserTurnStateByThread.get(threadId);
    if (turnCursorKey && mirroredTurnState?.has(turnCursorKey)) {
      return true;
    }
    if (turnIdKey && mirroredTurnState?.has(turnIdKey)) {
      return true;
    }

    return this.context.stateStore.listMirroredItems(threadId).some((record) => {
      if (record.kind !== "user") {
        return false;
      }
      return (
        (turnCursorKey !== null && this.mirroredTurnKey(null, record.turnCursor) === turnCursorKey) ||
        (turnIdKey !== null && this.mirroredTurnKey(record.turnId, null) === turnIdKey)
      );
    });
  }

  canMirrorNonUserActivity(
    threadId: string,
    _turnId: string | null | undefined = null,
    _turnCursor: string | null | undefined = null
  ): boolean {
    const channelKind =
      this.runtime.threadState.get(threadId)?.channelKind ??
      this.context.stateStore.getThreadBridge(threadId)?.channelKind ??
      "conversation";
    if (channelKind === "subagent" || !this.context.runtimeConfig.visibility.userMessages) {
      return true;
    }

    if (!this.runtime.pendingConversationAnchorThreadIds.has(threadId)) {
      return true;
    }

    this.ensureMirrorStateHydrated(threadId);
    return (this.runtime.mirroredUserTurnStateByThread.get(threadId)?.size ?? 0) > 0;
  }

  shouldHoldNonUserActivityUntilTurnAnchor(
    threadId: string,
    turnId: string | null | undefined,
    turnCursor: string | null | undefined,
    cursor: string | null | undefined
  ): boolean {
    const channelKind =
      this.runtime.threadState.get(threadId)?.channelKind ??
      this.context.stateStore.getThreadBridge(threadId)?.channelKind ??
      "conversation";
    if (channelKind === "subagent" || !this.context.runtimeConfig.visibility.userMessages) {
      return false;
    }

    if (this.hasMirroredUserAnchorForTurn(threadId, turnId, turnCursor)) {
      return false;
    }

    const effectiveCursor = cursor?.trim() ?? "";
    if (!effectiveCursor) {
      return false;
    }
    const latestMirroredCursor =
      this.runtime.latestMirroredCursorByThread.get(threadId) ??
      this.context.stateStore.getThreadBridge(threadId)?.latestMirroredCursor ??
      null;
    if (!latestMirroredCursor || this.compareItemCursor(effectiveCursor, latestMirroredCursor) <= 0) {
      return false;
    }

    const latestTurnCursor =
      this.runtime.latestMirroredTurnCursorByThread.get(threadId) ??
      this.context.stateStore.getThreadBridge(threadId)?.latestMirroredTurnCursor ??
      null;
    if (latestTurnCursor && turnCursor && latestTurnCursor === turnCursor) {
      return false;
    }

    return true;
  }

  hasPersistedConversationUserAnchor(threadId: string): boolean {
    if (!threadId) {
      return false;
    }

    return this.listCanonicalRetainedTurns(threadId).length > 0;
  }

  deserializeStatus(statusType: string | null): CodexThreadStatus {
    return deserializeThreadStatus(statusType);
  }

  async tryReadThread(threadId: string): Promise<CodexThreadSummary | null> {
    try {
      return await this.context.codexAdapter.readThread(threadId, false);
    } catch (error) {
      this.context.logger.debug({ error, threadId }, "Failed to read thread from app-server.");
      return null;
    }
  }

  syntheticSummary(threadId: string, preferredName: string, status: CodexThreadStatus | null): CodexThreadSummary {
    return {
      id: threadId,
      name: preferredName,
      preview: preferredName,
      modelProvider: null,
      createdAt: null,
      updatedAt: null,
      ephemeral: false,
      status: status ?? { type: "active", activeFlags: [] }
    };
  }

  deriveThreadLastActivityAt(
    summary: CodexThreadSummary,
    currentLastActivityAt: number | null,
    persistedLastSeenAt: string | null
  ): number | null {
    const summaryUpdatedAt = summary.updatedAt ? summary.updatedAt * 1000 : null;
    if (summaryUpdatedAt !== null) {
      return summaryUpdatedAt;
    }
    if (currentLastActivityAt !== null) {
      return currentLastActivityAt;
    }
    if (persistedLastSeenAt) {
      const parsed = Date.parse(persistedLastSeenAt);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  toPersistedLastSeenIso(timestampMs: number | null, fallbackIso: string | null): string {
    if (timestampMs !== null && Number.isFinite(timestampMs)) {
      return new Date(timestampMs).toISOString();
    }
    if (fallbackIso) {
      return fallbackIso;
    }
    return new Date(0).toISOString();
  }

  updateStateLastActivityAt(state: ThreadRuntimeState, timestampMs: number | null | undefined): void {
    if (timestampMs === null || timestampMs === undefined || !Number.isFinite(timestampMs)) {
      return;
    }
    state.lastActivityAt = timestampMs;
  }

  shouldMirrorCandidate(threadId: string, cursor: string | null): boolean {
    const latest = this.runtime.latestMirroredCursorByThread.get(threadId);
    if (!latest) {
      return true;
    }
    if (!cursor) {
      return false;
    }
    return this.compareItemCursor(cursor, latest) > 0;
  }

  shouldMirrorLiveCursor(threadId: string, cursor: string | null): boolean {
    const latest = this.runtime.latestMirroredCursorByThread.get(threadId);
    if (!latest) {
      return true;
    }
    if (!cursor) {
      return false;
    }
    return this.compareItemCursor(cursor, latest) > 0;
  }

  shouldMirrorTurnCandidate(threadId: string, turnCursor: string | null): boolean {
    const latest = this.runtime.latestMirroredTurnCursorByThread.get(threadId);
    if (!latest) {
      return true;
    }
    if (!turnCursor) {
      return false;
    }
    return this.compareTurnCursor(turnCursor, latest) >= 0;
  }

  allowLateSameTurnCandidate(threadId: string, candidate: MirrorCandidate): boolean {
    const latestTurnCursor = this.runtime.latestMirroredTurnCursorByThread.get(threadId);
    if (!latestTurnCursor || !candidate.turnCursor || candidate.turnCursor !== latestTurnCursor) {
      return false;
    }
    return candidate.kind !== "user";
  }

  rememberMirroredItem(record: {
    threadId: string;
    itemId: string;
    turnId: string | null;
    kind: "user" | "agentCommentary" | "agentAnswer" | "command" | "fileChange";
    discordMessageId: string;
    discordMessageIds?: string[];
    groupKey: string | null;
    contentSignature: string;
    renderedContent: string;
    timestampMs: number | null;
    cursor: string | null;
    turnCursor: string | null;
  }): void {
    this.context.stateStore.upsertMirroredItem({
      ...record,
      updatedAt: new Date().toISOString()
    });
    if (record.kind === "user") {
      const threadBridge = this.context.stateStore.getThreadBridge(record.threadId);
      const channelKind =
        this.runtime.threadState.get(record.threadId)?.channelKind ??
        threadBridge?.channelKind ??
        "conversation";
      if (channelKind === "conversation") {
        const turnKey = this.buildCanonicalRetainedTurnKey(record.turnId, record.turnCursor);
        if (
          turnKey &&
          !this.listCanonicalRetainedTurns(record.threadId).some((entry) =>
            this.turnAliasesOverlap(
              this.buildTurnKeyAliases(entry.turnId, entry.turnCursor),
              this.buildTurnKeyAliases(record.turnId, record.turnCursor)
            )
          )
        ) {
          this.context.stateStore.upsertRetainedTurn({
            threadId: record.threadId,
            turnKey,
            turnId: record.turnId,
            turnCursor: record.turnCursor,
            anchorItemId: record.itemId,
            anchorText: record.renderedContent,
            source: "codex-read",
            updatedAt: new Date().toISOString()
          });
          const retainedByThread =
            this.runtime.retainedTurnsByThread.get(record.threadId) ?? new Map<string, import("../../domain.js").RetainedTurnRecord>();
          retainedByThread.set(turnKey, {
            threadId: record.threadId,
            turnKey,
            turnId: record.turnId,
            turnCursor: record.turnCursor,
            anchorItemId: record.itemId,
            anchorText: record.renderedContent,
            source: "codex-read",
            updatedAt: new Date().toISOString()
          });
          this.runtime.retainedTurnsByThread.set(record.threadId, retainedByThread);
        }
      }
    }
    this.traceMirror("mirror.item.remembered", {
      threadId: record.threadId,
      itemId: record.itemId,
      turnId: record.turnId,
      kind: record.kind,
      cursor: record.cursor,
      turnCursor: record.turnCursor,
      timestampMs: record.timestampMs,
      timestampIso: record.timestampMs !== null ? new Date(record.timestampMs).toISOString() : null,
      discordMessageId: record.discordMessageId,
      discordMessageIds: this.mirroredItemMessageIds(record),
      groupKey: record.groupKey,
      renderedPreview: truncateForDiscord(
        redactSensitiveText(record.renderedContent.replace(/\s+/g, " ").trim()),
        260
      ),
      contentSignature: record.contentSignature
    });
  }

  async enforceTurnRetention(threadId: string): Promise<void> {
    const maxTurnsPerThread = this.context.runtimeConfig.retention.maxTurnsPerThread;
    if (!Number.isFinite(maxTurnsPerThread) || maxTurnsPerThread < 1) {
      return;
    }

    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge) {
      return;
    }

    const records = this.context.stateStore.listMirroredItems(threadId);
    const retainedTurns = this.listCanonicalRetainedTurns(threadId);
    if (records.length === 0 && retainedTurns.length === 0) {
      return;
    }

    const sortedRetainedTurns = [...retainedTurns].sort((left, right) => {
      const leftCursor = left.turnCursor?.trim() || null;
      const rightCursor = right.turnCursor?.trim() || null;
      if (leftCursor && rightCursor) {
        return this.compareTurnCursor(leftCursor, rightCursor);
      }
      if (leftCursor && !rightCursor) {
        return 1;
      }
      if (!leftCursor && rightCursor) {
        return -1;
      }
      return left.turnKey.localeCompare(right.turnKey);
    });
    const keepTurns = sortedRetainedTurns.slice(-maxTurnsPerThread);
    const keepTurnKeys = new Set<string>();
    for (const turn of keepTurns) {
      for (const alias of this.buildTurnKeyAliases(turn.turnId, turn.turnCursor)) {
        keepTurnKeys.add(alias);
      }
    }
    const pruneTurns = sortedRetainedTurns.slice(0, Math.max(0, sortedRetainedTurns.length - maxTurnsPerThread));
    for (const turn of pruneTurns) {
      this.context.stateStore.deleteRetainedTurn(threadId, turn.turnKey);
      this.runtime.retainedTurnsByThread.get(threadId)?.delete(turn.turnKey);
    }

    await this.pruneStaleSubagentThreadsForRetainedTurns(
      threadId,
      keepTurnKeys,
      sortedRetainedTurns.length >= maxTurnsPerThread
    );
    await this.pruneResolvedApprovalCardsForRetainedTurns(
      threadId,
      bridge.discordChannelId,
      keepTurnKeys,
      maxTurnsPerThread
    );
    if (keepTurnKeys.size === 0 || records.length === 0) {
      return;
    }

    const prunableRecords = records.filter((record) => {
      const aliases = this.buildTurnKeyAliases(record.turnId, record.turnCursor);
      if (aliases.size === 0) {
        return false;
      }
      for (const alias of aliases) {
        if (keepTurnKeys.has(alias)) {
          return false;
        }
      }
      return true;
    });
    if (prunableRecords.length === 0) {
      return;
    }

    const allByMessage = new Map<string, MirroredItemRecord[]>();
    for (const record of records) {
      for (const messageId of this.mirroredItemMessageIds(record)) {
        const list = allByMessage.get(messageId) ?? [];
        list.push(record);
        allByMessage.set(messageId, list);
      }
    }

    const prunableItemIds = new Set(prunableRecords.map((record) => record.itemId));
    const initiallyDeletableMessageIds = new Set([...allByMessage.entries()]
      .filter(([, messageRecords]) => messageRecords.every((record) => prunableItemIds.has(record.itemId)))
      .map(([messageId]) => messageId));

    const recordsToDrop = prunableRecords.filter((record) =>
      this.mirroredItemMessageIds(record).every((messageId) => initiallyDeletableMessageIds.has(messageId))
    );
    if (recordsToDrop.length === 0) {
      return;
    }
    const recordsToDropItemIds = new Set(recordsToDrop.map((record) => record.itemId));
    const deletableMessageIds = [...allByMessage.entries()]
      .filter(([, messageRecords]) => messageRecords.every((record) => recordsToDropItemIds.has(record.itemId)))
      .map(([messageId]) => messageId);
    const deletableMessageSet = new Set(deletableMessageIds);

    await this.context.provider.deleteMessages(bridge.discordChannelId, deletableMessageIds);
    this.traceMirror("discord.messages.deleted", {
      threadId,
      channelId: bridge.discordChannelId,
      reason: "retention",
      deletedMessageIds: deletableMessageIds,
      deletedItemIds: recordsToDrop.map((record) => record.itemId),
      maxTurnsPerThread
    });
    for (const messageId of deletableMessageIds) {
      for (const detail of this.context.stateStore.listMessageDetailsByDiscordMessageId(messageId)) {
        this.context.stateStore.deleteMessageDetail(detail.token);
      }
    }
    for (const record of recordsToDrop) {
      this.context.stateStore.deleteMirroredItem(threadId, record.itemId);
      this.forgetMirroredItem(threadId, record.itemId, record.kind, record.turnId, record.turnCursor);
    }
    this.pruneGroupedStateByMessageIds(threadId, deletableMessageSet);
  }

  private async pruneResolvedApprovalCardsForRetainedTurns(
    threadId: string,
    discordChannelId: string,
    keepTurnKeys: Set<string>,
    maxTurnsPerThread: number
  ): Promise<void> {
    if (keepTurnKeys.size === 0) {
      return;
    }

    const prunableApprovals = this.context.stateStore
      .listPendingApprovals()
      .filter((approval) => {
        if (approval.threadId !== threadId || !approval.discordMessageId || approval.status === "pending") {
          return false;
        }
        const aliases = this.buildTurnKeyAliases(approval.turnId, null);
        if (aliases.size === 0) {
          return false;
        }
        for (const alias of aliases) {
          if (keepTurnKeys.has(alias)) {
            return false;
          }
        }
        return true;
      });
    if (prunableApprovals.length === 0) {
      return;
    }

    const messageIds = [
      ...new Set(
        prunableApprovals
          .map((approval) => approval.discordMessageId)
          .filter((messageId): messageId is string => typeof messageId === "string" && messageId.length > 0)
      )
    ];
    await this.context.provider.deleteMessages(discordChannelId, messageIds);
    this.traceMirror("discord.messages.deleted", {
      threadId,
      channelId: discordChannelId,
      reason: "approval-retention",
      deletedMessageIds: messageIds,
      deletedApprovalTokens: prunableApprovals.map((approval) => approval.token),
      maxTurnsPerThread
    });
    for (const approval of prunableApprovals) {
      this.context.stateStore.deletePendingApproval(approval.token);
    }
  }

  private async pruneStaleSubagentThreadsForRetainedTurns(
    parentThreadId: string,
    keepTurnKeys: Set<string>,
    retainedWindowIsFull: boolean
  ): Promise<void> {
    const parentBridge = this.context.stateStore.getThreadBridge(parentThreadId);
    if (!parentBridge || parentBridge.channelKind !== "conversation") {
      return;
    }

    const childAnchors = new Map(
      this.listCanonicalChildAnchorsForParent(parentThreadId).map((anchor) => [anchor.childThreadId, anchor] as const)
    );
    const childBridges = this.context.stateStore
      .listThreadBridges()
      .filter((bridge) => bridge.parentCodexThreadId === parentThreadId && bridge.channelKind === "subagent");
    for (const childBridge of childBridges) {
      const childAnchor = childAnchors.get(childBridge.codexThreadId) ?? null;
      const anchorAliases = childAnchor
        ? this.buildTurnKeyAliases(childAnchor.parentTurnId ?? null, childAnchor.parentTurnCursor ?? null)
        : new Set<string>();
      if (anchorAliases.size > 0) {
        let matchesRetainedTurn = false;
        for (const alias of anchorAliases) {
          if (keepTurnKeys.has(alias)) {
            matchesRetainedTurn = true;
            break;
          }
        }
        if (matchesRetainedTurn) {
          continue;
        }
      }
      if (anchorAliases.size > 0 && !retainedWindowIsFull) {
        continue;
      }

      await this.deps.deleteMappedThread(
        childBridge.codexThreadId,
        anchorAliases.size > 0
          ? "Prune stale sub-agent thread because its parent turn was retained out."
          : "Prune sub-agent thread because it no longer has a valid retained parent-turn anchor."
      );
      this.context.stateStore.deleteChildThreadAnchor(childBridge.codexThreadId);
      this.runtime.childThreadAnchors.delete(childBridge.codexThreadId);
    }
  }

  private listCanonicalRetainedTurns(threadId: string): RetainedTurnRecord[] {
    const cached = this.runtime.retainedTurnsByThread.get(threadId);
    if (cached && cached.size > 0) {
      return [...cached.values()];
    }

    const materialized = this.context.stateStore.listRetainedTurns(threadId);
    const byKey = new Map<string, RetainedTurnRecord>();
    for (const record of materialized) {
      byKey.set(record.turnKey, record);
    }
    this.runtime.retainedTurnsByThread.set(threadId, byKey);
    return [...byKey.values()];
  }

  private listCanonicalChildAnchorsForParent(parentThreadId: string): ChildThreadAnchorRecord[] {
    const persisted = this.context.stateStore.listChildThreadAnchorsForParent(parentThreadId);
    const byChildThreadId = new Map<string, ChildThreadAnchorRecord>();
    for (const anchor of persisted) {
      this.runtime.childThreadAnchors.set(anchor.childThreadId, anchor);
      byChildThreadId.set(anchor.childThreadId, anchor);
    }

    return [...byChildThreadId.values()];
  }

  private buildTurnKeyAliases(turnId: string | null | undefined, turnCursor: string | null | undefined): Set<string> {
    const aliases = new Set<string>();
    const primary = this.mirroredTurnKey(turnId ?? null, turnCursor ?? null);
    if (primary) {
      aliases.add(primary);
    }
    const normalizedTurnId = turnId?.trim() ?? "";
    if (normalizedTurnId) {
      aliases.add(`turn:${normalizedTurnId.toLowerCase()}`);
    }
    const normalizedTurnCursor = turnCursor?.trim() ?? "";
    if (normalizedTurnCursor) {
      aliases.add(`cursor:${normalizedTurnCursor}`);
    }
    return aliases;
  }

  private buildCanonicalRetainedTurnKey(
    turnId: string | null | undefined,
    turnCursor: string | null | undefined
  ): string | null {
    const normalizedTurnId = turnId?.trim() ?? "";
    if (normalizedTurnId) {
      return `turn:${normalizedTurnId.toLowerCase()}`;
    }
    const normalizedTurnCursor = turnCursor?.trim() ?? "";
    if (normalizedTurnCursor) {
      return `cursor:${normalizedTurnCursor}`;
    }
    return null;
  }

  private turnAliasesOverlap(left: Set<string>, right: Set<string>): boolean {
    for (const alias of left) {
      if (right.has(alias)) {
        return true;
      }
    }
    return false;
  }

  mirroredTurnKey(turnId: string | null, turnCursor: string | null): string | null {
    if (turnCursor && turnCursor.trim()) {
      return `cursor:${turnCursor.trim()}`;
    }
    if (turnId && turnId.trim()) {
      return `turn:${turnId.trim().toLowerCase()}`;
    }
    return null;
  }

  rememberThreadMirrorCursor(
    threadId: string,
    latestMirroredTimestampMs: number | null,
    latestMirroredCursor: string,
    latestMirroredTurnCursor: string | null,
    latestSourceFrontier: ThreadSourceFrontier | null = null
  ): void {
    const current = this.runtime.latestMirroredCursorByThread.get(threadId);
    if (current && this.compareItemCursor(current, latestMirroredCursor) >= 0) {
      let updatedSourceFrontier = false;
      if (latestSourceFrontier) {
        const existingSourceFrontier = this.runtime.latestSourceFrontierByThread.get(threadId);
        const shouldUpdateSourceFrontier =
          !existingSourceFrontier ||
          latestSourceFrontier.filePath !== existingSourceFrontier.filePath ||
          latestSourceFrontier.offset > existingSourceFrontier.offset ||
          (latestSourceFrontier.offset === existingSourceFrontier.offset &&
            latestSourceFrontier.eventKey.localeCompare(existingSourceFrontier.eventKey) > 0);
        if (shouldUpdateSourceFrontier) {
          this.runtime.latestSourceFrontierByThread.set(threadId, latestSourceFrontier);
          updatedSourceFrontier = true;
        }
      }
      let updatedTurnCursor = false;
      if (latestMirroredTurnCursor) {
        const currentTurnCursor = this.runtime.latestMirroredTurnCursorByThread.get(threadId);
        if (!currentTurnCursor || this.compareTurnCursor(latestMirroredTurnCursor, currentTurnCursor) > 0) {
          this.runtime.latestMirroredTurnCursorByThread.set(threadId, latestMirroredTurnCursor);
          updatedTurnCursor = true;
        }
      }
      if (updatedSourceFrontier || updatedTurnCursor) {
        this.context.stateStore.updateThreadMirrorCursor(
          threadId,
          this.runtime.latestMirroredTimestampMsByThread.get(threadId) ?? null,
          current,
          this.runtime.latestMirroredTurnCursorByThread.get(threadId) ?? null,
          this.runtime.latestSourceFrontierByThread.get(threadId) ?? undefined
        );
        this.traceMirror("mirror.cursor.refresh", {
          threadId,
          latestMirroredTimestampMs: this.runtime.latestMirroredTimestampMsByThread.get(threadId) ?? null,
          latestMirroredCursor: current,
          latestMirroredTurnCursor: this.runtime.latestMirroredTurnCursorByThread.get(threadId) ?? null,
          latestSourceFrontier: this.runtime.latestSourceFrontierByThread.get(threadId) ?? null
        });
      }
      return;
    }

    this.runtime.latestMirroredCursorByThread.set(threadId, latestMirroredCursor);
    if (latestMirroredTurnCursor) {
      this.runtime.latestMirroredTurnCursorByThread.set(threadId, latestMirroredTurnCursor);
    }
    if (latestMirroredTimestampMs !== null && latestMirroredTimestampMs !== undefined) {
      this.runtime.latestMirroredTimestampMsByThread.set(threadId, latestMirroredTimestampMs);
    }
    if (latestSourceFrontier) {
      this.runtime.latestSourceFrontierByThread.set(threadId, latestSourceFrontier);
    }
    this.context.stateStore.updateThreadMirrorCursor(
      threadId,
      latestMirroredTimestampMs,
      latestMirroredCursor,
      latestMirroredTurnCursor,
      this.runtime.latestSourceFrontierByThread.get(threadId) ?? undefined
    );
    this.traceMirror("mirror.cursor.advance", {
      threadId,
      latestMirroredTimestampMs,
      latestMirroredCursor,
      latestMirroredTurnCursor,
      latestSourceFrontier: this.runtime.latestSourceFrontierByThread.get(threadId) ?? null
    });
  }

  parseItemCursor(cursor: string): ParsedMirrorCursor {
    return parseMirrorItemCursor(cursor, {
      extractUuidV7TimestampMs: (value) => this.deps.extractUuidV7TimestampMs(value)
    });
  }

  parseTurnCursor(cursor: string): ParsedTurnCursor {
    return parseMirrorTurnCursor(cursor, {
      extractUuidV7TimestampMs: (value) => this.deps.extractUuidV7TimestampMs(value)
    });
  }

  compareItemCursor(left: string, right: string): number {
    return compareMirrorItemCursor(left, right, {
      extractUuidV7TimestampMs: (value) => this.deps.extractUuidV7TimestampMs(value)
    });
  }

  compareTurnCursor(left: string, right: string): number {
    return compareMirrorTurnCursor(left, right, {
      extractUuidV7TimestampMs: (value) => this.deps.extractUuidV7TimestampMs(value)
    });
  }

  closeCommentaryGroup(threadId: string): void {
    this.runtime.groupedCommentaryMessages.delete(threadId);
  }

  closeCommandGroup(threadId: string): void {
    this.runtime.groupedCommandMessages.delete(threadId);
  }

  closeFileChangeGroup(threadId: string): void {
    this.runtime.groupedFileChangeMessages.delete(threadId);
  }

  closeGroupedMessages(threadId: string): void {
    this.closeCommentaryGroup(threadId);
    this.closeCommandGroup(threadId);
    this.closeFileChangeGroup(threadId);
  }

  buildCandidateDevDetail(threadId: string, candidate: MirrorCandidate): string {
    return this.buildSingleMessageDevDetail(
      threadId,
      candidate.itemId,
      candidate.kind,
      candidate.timestampMs,
      candidate.timestampIsApproximate,
      candidate.cursor,
      candidate.turnId,
      candidate.turnCursor,
      candidate.phase,
      candidate.status,
      candidate.rawItem,
      candidate.rawTurn,
      "thread-read"
    );
  }

  buildLifecycleDevDetail(
    threadId: string,
    turnId: string,
    item: CodexItem,
    kind: MirrorCandidate["kind"],
    timestampMs: number | null,
    cursor: string | null,
    phase: string | null,
    status: string | null
  ): string {
    return this.buildSingleMessageDevDetail(
      threadId,
      item.id,
      kind,
      timestampMs,
      false,
      cursor,
      turnId,
      this.deps.buildTurnCursor({ id: turnId }, 0),
      phase,
      status,
      item,
      { id: turnId },
      "lifecycle"
    );
  }

  buildSessionEventDevDetail(
    threadId: string,
    itemId: string,
    kind: MirrorCandidate["kind"],
    timestampMs: number | null,
    cursor: string | null,
    turnId: string | null,
    status: string | null,
    rawEvent: unknown
  ): string {
    return this.buildSingleMessageDevDetail(
      threadId,
      itemId,
      kind,
      timestampMs,
      false,
      cursor,
      turnId,
      turnId ? this.deps.buildTurnCursor({ id: turnId }, 0) : null,
      null,
      status,
      rawEvent,
      null,
      "session-log"
    );
  }

  traceMirror(event: string, payload: Record<string, unknown>): void {
    if (!this.context.runtimeConfig.diagnostics.mirrorTraceEnabled) {
      return;
    }

    const entry = {
      at: new Date().toISOString(),
      pid: process.pid,
      event,
      ...payload
    };

    let serialized: string;
    try {
      serialized = JSON.stringify(entry);
    } catch {
      serialized = JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        event: "trace.serialization_error",
        reason: "Failed to serialize mirror trace entry."
      });
    }

    this.runtime.mirrorTraceWriteChain = this.runtime.mirrorTraceWriteChain
      .catch(() => undefined)
      .then(() => this.appendMirrorTraceLine(serialized));
  }

  printProgress(message: string): void {
    const limit = 220;
    const normalized =
      message.length > limit ? `${message.slice(0, Math.max(0, limit - 3)).trimEnd()}...` : message;
    // eslint-disable-next-line no-console
    console.log(formatTerminalLogLine("bridge", normalized));
  }

  private getOrCreateUserTurnState(
    threadId: string,
    turnKey: string,
    itemId: string
  ): UserTurnMirrorState {
    let byTurn = this.runtime.mirroredUserTurnStateByThread.get(threadId);
    if (!byTurn) {
      byTurn = new Map<string, UserTurnMirrorState>();
      this.runtime.mirroredUserTurnStateByThread.set(threadId, byTurn);
    }
    let turnState = byTurn.get(turnKey);
    if (!turnState) {
      turnState = {
        firstItemId: itemId,
        textFingerprints: new Set<string>()
      };
      byTurn.set(turnKey, turnState);
    }
    return turnState;
  }

  private userMessageFingerprint(text: string): string {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
  }

  private deleteMirroredEntriesByThread<T>(target: Map<string, T>, threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of target.keys()) {
      if (key.startsWith(prefix)) {
        target.delete(key);
      }
    }
  }

  private mirroredItemMessageIds(record: Pick<MirroredItemRecord, "discordMessageId" | "discordMessageIds">): string[] {
    const candidates = [
      ...(Array.isArray(record.discordMessageIds) ? record.discordMessageIds : []),
      record.discordMessageId
    ];
    const messageIds: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const trimmed = candidate.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      messageIds.push(trimmed);
    }
    return messageIds;
  }

  private forgetUserTurnStateForItem(
    threadId: string,
    itemId: string,
    turnId: string | null,
    turnCursor: string | null
  ): void {
    const turnKey = this.mirroredTurnKey(turnId, turnCursor);
    if (!turnKey) {
      return;
    }
    const byTurn = this.runtime.mirroredUserTurnStateByThread.get(threadId);
    if (!byTurn) {
      return;
    }
    const turnState = byTurn.get(turnKey);
    if (!turnState) {
      return;
    }
    if (turnState.firstItemId === itemId) {
      byTurn.delete(turnKey);
    }
    if (byTurn.size === 0) {
      this.runtime.mirroredUserTurnStateByThread.delete(threadId);
    }
  }

  forgetMirroredItem(
    threadId: string,
    itemId: string,
    kind: MirroredItemRecord["kind"],
    turnId: string | null = null,
    turnCursor: string | null = null
  ): void {
    const itemKey = this.mirroredItemKey(threadId, itemId);
    switch (kind) {
      case "user":
        this.runtime.mirroredChatItems.delete(itemKey);
        this.runtime.mirroredUserMessages.delete(itemKey);
        this.forgetUserTurnStateForItem(threadId, itemId, turnId, turnCursor);
        break;
      case "agentAnswer":
        this.runtime.mirroredAgentItems.delete(itemKey);
        this.runtime.mirroredAnswerMessages.delete(itemKey);
        break;
      case "agentCommentary":
        this.runtime.mirroredAgentItems.delete(itemKey);
        break;
      case "command":
        this.runtime.mirroredCommandItems.delete(itemKey);
        break;
      case "fileChange":
        this.runtime.mirroredFileChangeItems.delete(itemKey);
        break;
    }
  }

  pruneGroupedStateByMessageIds(threadId: string, messageIds: Set<string>): void {
    const groupedCollections = [
      this.runtime.groupedCommentaryMessages,
      this.runtime.groupedCommandMessages,
      this.runtime.groupedFileChangeMessages
    ] as const;
    for (const collection of groupedCollections) {
      const state = collection.get(threadId);
      if (!state?.messageId || !messageIds.has(state.messageId)) {
        continue;
      }
      collection.delete(threadId);
    }
    const summaryState = this.runtime.commandActivitySummaries.get(threadId);
    if (summaryState?.messageId && messageIds.has(summaryState.messageId)) {
      this.runtime.commandActivitySummaries.delete(threadId);
    }
  }

  private buildSingleMessageDevDetail(
    threadId: string,
    itemId: string,
    kind: MirrorCandidate["kind"],
    timestampMs: number | null,
    timestampIsApproximate: boolean,
    cursor: string | null,
    turnId: string | null,
    turnCursor: string | null,
    phase: string | null,
    status: string | null,
    rawItem: unknown,
    rawTurn: unknown,
    source: "thread-read" | "lifecycle" | "session-log"
  ): string {
    const payload = {
      threadId,
      itemId,
      kind,
      timestampMs,
      timestampIso: timestampMs !== null ? new Date(timestampMs).toISOString() : null,
      timestampIsApproximate,
      cursor,
      turnId,
      turnCursor,
      phase,
      status,
      latestMirroredCursor: this.runtime.latestMirroredCursorByThread.get(threadId) ?? null,
      latestMirroredTurnCursor: this.runtime.latestMirroredTurnCursorByThread.get(threadId) ?? null,
      latestMirroredSourceFrontier: this.runtime.latestSourceFrontierByThread.get(threadId) ?? null,
      source,
      rawItem,
      rawTurn
    };
    return this.renderDevDetailPayload(payload);
  }

  private renderDevDetailPayload(payload: unknown): string {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload, null, 2) ?? "{}";
    } catch {
      serialized = String(payload);
    }
    const truncated = truncateForDiscord(serialized, 1700);
    return `Debug snapshot:\n\`\`\`json\n${truncated}\n\`\`\``;
  }

  private async appendMirrorTraceLine(line: string): Promise<void> {
    const diagnostics = this.context.runtimeConfig.diagnostics;
    const tracePath = diagnostics.mirrorTracePath;
    await mkdir(path.dirname(tracePath), { recursive: true });

    const maxBytes = diagnostics.mirrorTraceMaxBytes;
    if (Number.isFinite(maxBytes) && maxBytes > 0) {
      try {
        const existing = await stat(tracePath);
        if (existing.size + Buffer.byteLength(line, "utf8") > maxBytes) {
          await writeFile(tracePath, `${line}\n`, "utf8");
          return;
        }
      } catch {
        // File may not exist yet; fall through to append.
      }
    }

    await appendFile(tracePath, `${line}\n`, "utf8");
  }
}

