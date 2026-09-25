import type {
  ApprovalCardView,
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexItem,
  CodexNotification,
  CodexThreadStatus,
  CodexThreadSummary,
  ThreadRuntimeState
} from "../../domain.js";
import { redactSensitiveText, truncateForDiscord } from "../../util/redaction.js";
import { shouldIgnoreLiveE2eHelperCommand } from "../../util/liveE2e.js";
import { extractCollabToolCall, parseUserEnvelope, type ParsedSubagentNotificationEnvelope } from "./eventParsing.js";
import {
  attachPreparedSubagentThread,
  prepareSubagentAttachment
} from "./subagentAttachment.js";
import { canApplyResolvedApprovalStatus } from "../approval/approvalState.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import type {
  BridgeRuntimeState,
  CommandPreviewInfo,
  FileActivityCounts,
  ResolvedThreadMetadata
} from "../runtime/BridgeRuntimeState.js";
import {
  markThreadTurnCompleted,
  markThreadTurnInProgress
} from "../runtime/BridgeRuntimeState.js";

interface NotificationRouterDependencies {
  appendCanonicalEvent(input: {
    threadId: string;
    source: "app-server" | "desktop-ipc";
    eventKind:
      | "content"
      | "childAnchor"
      | "approvalUpsert"
      | "approvalResolved"
      | "status"
      | "ignoredHint";
    itemKind?: string | null;
    turnId?: string | null;
    turnCursor?: string | null;
    itemId?: string | null;
    requestId?: string | null;
    summary?: string | null;
    detail?: string | null;
    createdAt?: string | null;
  }): void;
  buildApprovalCardView(approval: import("../../domain.js").PendingApprovalRecord): ApprovalCardView;
  clearDeferredApprovalRequest(requestId: string): void;
  initializeSpawnedSubagentThread(childThreadId: string): void;
  buildLifecycleDevDetail(
    threadId: string,
    turnId: string,
    item: CodexItem,
    kind: "user" | "agentCommentary" | "agentAnswer" | "command" | "fileChange",
    timestampMs: number | null,
    cursor: string | null,
    phase: string | null,
    status: string | null
  ): string;
  buildMirrorCursor(timestampMs: number | null, itemId: string, orderKey?: number | null): string | null;
  buildNotificationCursor(turnId: string, itemId: string): string | null;
  buildTurnCursor(turn: unknown, turnOrder: number): string | null;
  canMirrorNonUserActivity(
    threadId: string,
    turnId?: string | null,
    turnCursor?: string | null
  ): boolean;
  drainWriteBackQueue(threadId: string): Promise<void>;
  finishDiscordInputTurn(threadId: string, turnId: string): Promise<void>;
  enforceTurnRetention(threadId: string): Promise<void>;
  enqueueThreadEvent(threadId: string, work: () => Promise<void>): Promise<void>;
  extractAssistantMessage(item: CodexItem): { text: string; phase: string | null } | null;
  extractCommandDetail(item: CodexCommandExecutionItem): string | null;
  extractCommandPreviewInfo(item: CodexCommandExecutionItem): CommandPreviewInfo;
  extractFileActivityCounts(item: CodexFileChangeItem): FileActivityCounts | null;
  extractFileChangeSummary(item: CodexFileChangeItem): string | null;
  extractStableTimestampMs(input: unknown): number | null;
  extractUserMessageText(item: CodexItem, threadId?: string): string | null;
  extractUuidV7TimestampMs(identifier: string): number | null;
  flushStatusUpdate(threadId: string): Promise<void>;
  handleSubagentNotificationEnvelope(
    parentThreadId: string,
    envelope: ParsedSubagentNotificationEnvelope,
    parentTurnId?: string | null,
    parentTurnCursor?: string | null,
    parentTimestampMs?: number | null
  ): Promise<void>;
  hydrateThread(
    threadId: string,
    summary: CodexThreadSummary,
    attachMode: "auto" | "manual",
    hydrateOptions?: import("../runtime/BridgeRuntimeState.js").HydrateThreadOptions
  ): Promise<import("../runtime/BridgeRuntimeState.js").HydratedThreadResult>;
  isCommentaryPhase(phase: string | null | undefined): boolean;
  persistThreadState(state: ThreadRuntimeState): void;
  printProgress(message: string): void;
  publishCommentaryAgentMessage(
    threadId: string,
    itemId: string,
    text: string,
    phase?: string | null,
    timestampMs?: number | null,
    timestampIsApproximate?: boolean,
    sortCursor?: string | null,
    turnId?: string | null,
    turnCursor?: string | null,
    devDetail?: string | null
  ): Promise<void>;
  publishCompletedAgentMessage(
    threadId: string,
    itemId: string,
    text: string,
    phase?: string | null,
    timestampMs?: number | null,
    timestampIsApproximate?: boolean,
    cursor?: string | null,
    turnId?: string | null,
    turnCursor?: string | null,
    devDetail?: string | null
  ): Promise<void>;
  publishCompletedCommandMessage(
    threadId: string,
    itemId: string,
    preview: string | null,
    detail: string | null,
    status: string | null,
    timestampMs?: number | null,
    timestampIsApproximate?: boolean,
    previewWasTruncated?: boolean,
    sortCursor?: string | null,
    turnId?: string | null,
    turnCursor?: string | null,
    devDetail?: string | null
  ): Promise<void>;
  publishCompletedFileChangeMessage(
    threadId: string,
    itemId: string,
    summary: string | null,
    status: string | null,
    timestampMs?: number | null,
    timestampIsApproximate?: boolean,
    sortCursor?: string | null,
    turnId?: string | null,
    turnCursor?: string | null,
    devDetail?: string | null,
    fileCounts?: FileActivityCounts | null
  ): Promise<void>;
  publishCompletedUserMessage(
    threadId: string,
    itemId: string,
    text: string,
    timestampMs?: number | null,
    timestampIsApproximate?: boolean,
    cursor?: string | null,
    turnId?: string | null,
    turnCursor?: string | null,
    devDetail?: string | null
  ): Promise<void>;
  publishLiveAgentDelta(
    threadId: string,
    delta: string,
    timestampMs?: number | null,
    itemId?: string | null,
    cursor?: string | null,
    turnId?: string | null,
    turnCursor?: string | null
  ): Promise<void>;
  queueMessageSync(threadId: string): void;
  queueStatusUpdate(threadId: string): void;
  queueThreadSessionPollHint(threadId: string): void;
  rememberSessionTurnHint(threadId: string, turnId: string): void;
  recordIgnoredHint(input: {
    threadId: string;
    source: "app-server";
    itemKind?: string | null;
    turnId?: string | null;
    turnCursor?: string | null;
    itemId?: string | null;
    summary: string;
    reason: string;
  }): void;
  rememberChildThreadParent(childThreadId: string, parentThreadId: string): void;
  rememberThreadMirrorCursor(
    threadId: string,
    timestampMs: number | null,
    cursor: string,
    turnCursor: string | null
  ): void;
  resolveThreadMetadata(
    threadId: string,
    preferred?: ResolvedThreadMetadata | null,
    options?: {
      allowFilesystemScan?: boolean;
    }
  ): Promise<ResolvedThreadMetadata>;
  shouldHoldNonUserActivityUntilTurnAnchor(
    threadId: string,
    turnId: string | null | undefined,
    turnCursor: string | null | undefined,
    cursor: string | null | undefined
  ): boolean;
  shouldMirrorLiveCursor(threadId: string, cursor: string | null): boolean;
  shouldPreferSessionStreamForThread(threadId: string): boolean;
  syntheticSummary(
    threadId: string,
    preferredName: string,
    status: CodexThreadStatus | null
  ): CodexThreadSummary;
  syncRecentTurnMessages(threadId: string): Promise<{ candidateItemIds: Set<string> | null }>;
  tryReadThread(threadId: string): Promise<CodexThreadSummary | null>;
  updateStateLastActivityAt(state: ThreadRuntimeState, timestampMs: number | null | undefined): void;
}

export class NotificationRouter {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: NotificationRouterDependencies
  ) {}

  async handleNotification(notification: CodexNotification): Promise<void> {
    switch (notification.method) {
      case "thread/status/changed": {
        const threadId = String(notification.params.threadId);
        await this.deps.enqueueThreadEvent(threadId, async () => {
          const state = this.runtime.threadState.get(threadId);
          if (!state) {
            if (this.deps.shouldPreferSessionStreamForThread(threadId)) {
              this.deps.queueThreadSessionPollHint(threadId);
            }
            return;
          }
          state.status = notification.params.status as CodexThreadStatus;
          this.deps.updateStateLastActivityAt(state, null);
          this.deps.persistThreadState(state);
          this.deps.queueStatusUpdate(state.threadId);
          this.deps.appendCanonicalEvent({
            threadId,
            source: "app-server",
            eventKind: "status",
            summary: `Status updated to ${state.status.type}.`,
            detail: this.deps.shouldPreferSessionStreamForThread(threadId)
              ? "App-server status notification only updates thread status and queues a session poll in session-backed mode."
              : "App-server status notification updates thread status and may trigger message sync."
          });
          if (this.deps.shouldPreferSessionStreamForThread(state.threadId)) {
            this.deps.queueThreadSessionPollHint(state.threadId);
          } else {
            this.deps.queueMessageSync(state.threadId);
          }
          if (state.status.type === "idle") {
            await this.deps.drainWriteBackQueue(state.threadId);
          }
        });
        break;
      }
      case "serverRequest/resolved": {
        this.deps.clearDeferredApprovalRequest(String(notification.params.requestId));
        const approval = this.context.stateStore.findPendingApprovalByRequestId(
          String(notification.params.requestId)
        );
        if (approval && canApplyResolvedApprovalStatus(approval.status, "approved")) {
          const previousStatus = approval.status;
          if (previousStatus !== "approved") {
            this.context.stateStore.setPendingApprovalStatusByRequestId(
              String(notification.params.requestId),
              "approved"
            );
          }
          const bridge = this.context.stateStore.getThreadBridge(approval.threadId);
          if (bridge && approval.discordMessageId && previousStatus !== "decisionSent" && previousStatus !== "approved") {
            try {
              await this.context.provider.disableApprovalCard(
                bridge.discordChannelId,
                approval.discordMessageId,
                "✅ Decision handled in Codex",
                this.deps.buildApprovalCardView(approval)
              );
            } catch (error) {
              this.context.logger.warn({ error, approval }, "Failed to disable resolved approval card.");
            }
          }
          const state = this.runtime.threadState.get(approval.threadId);
          if (state && state.status.type === "active") {
            state.status = {
              type: "active",
              activeFlags: (state.status.activeFlags ?? []).filter(
                (flag) => flag !== "waitingOnApproval"
              )
            };
            this.deps.updateStateLastActivityAt(state, null);
            this.deps.persistThreadState(state);
            this.deps.queueStatusUpdate(state.threadId);
          }
        }
        break;
      }
      case "item/started":
      case "item/completed":
        if (typeof notification.params.turnId === "string") {
          this.deps.rememberSessionTurnHint(
            String(notification.params.threadId),
            String(notification.params.turnId)
          );
        }
        await this.deps.enqueueThreadEvent(String(notification.params.threadId), async () => {
          await this.handleItemLifecycle(
            String(notification.params.threadId),
            String(notification.params.turnId),
            notification.params.item as CodexItem,
            notification.method === "item/completed"
          );
        });
        break;
      case "item/agentMessage/delta": {
        const threadId = String(notification.params.threadId);
        if (typeof notification.params.turnId === "string") {
          this.deps.rememberSessionTurnHint(threadId, notification.params.turnId);
        }
        if (this.deps.shouldPreferSessionStreamForThread(threadId)) {
          this.deps.queueThreadSessionPollHint(threadId);
          break;
        }
        await this.deps.enqueueThreadEvent(threadId, async () => {
          const state = this.runtime.threadState.get(threadId);
          if (!state) {
            return;
          }
          const turnId =
            typeof notification.params.turnId === "string" ? notification.params.turnId : state.lastTurnId;
          const itemId = typeof notification.params.itemId === "string" ? notification.params.itemId : null;
          const deltaTimestampMs =
            this.deps.extractStableTimestampMs(notification.params) ??
            (turnId ? this.deps.extractUuidV7TimestampMs(turnId) : null) ??
            (itemId ? this.deps.extractUuidV7TimestampMs(itemId) : null);
          const deltaCursor =
            turnId && itemId
              ? this.deps.buildNotificationCursor(turnId, itemId)
              : itemId
                ? this.deps.buildMirrorCursor(deltaTimestampMs, itemId)
                : null;
          const currentLive = this.runtime.liveAgentMessages.get(threadId);
          const isSameLiveItem =
            Boolean(itemId) && Boolean(currentLive?.itemId) && currentLive?.itemId === itemId;
          if (!isSameLiveItem && !this.deps.shouldMirrorLiveCursor(threadId, deltaCursor)) {
            return;
          }
          const liveTurnCursor = turnId ? this.deps.buildTurnCursor({ id: turnId }, 0) : null;
          if (turnId) {
            markThreadTurnInProgress(state, turnId);
          }
          if (this.deps.shouldHoldNonUserActivityUntilTurnAnchor(threadId, turnId, liveTurnCursor, deltaCursor)) {
            return;
          }
          const delta = redactSensitiveText(String(notification.params.delta ?? ""));
          state.latestAgentMessage = truncateForDiscord(`${state.latestAgentMessage ?? ""}${delta}`, 500);
          this.deps.updateStateLastActivityAt(state, null);
          this.deps.persistThreadState(state);
          this.deps.queueStatusUpdate(state.threadId);
          await this.deps.publishLiveAgentDelta(
            state.threadId,
            delta,
            deltaTimestampMs,
            itemId,
            deltaCursor,
            turnId,
            liveTurnCursor
          );
        });
        break;
      }
      case "turn/completed":
        if (typeof notification.params.threadId === "string") {
          await this.deps.finishDiscordInputTurn(notification.params.threadId, String(notification.params.turn.id));
        }
        await this.handleTurnCompleted(
          String(notification.params.turn.id),
          String(notification.params.turn.status)
        );
        break;
      default:
        break;
    }
  }

  async handleItemLifecycle(
    threadId: string,
    turnId: string,
    item: CodexItem,
    isCompleted: boolean
  ): Promise<void> {
    const liveTurnCursor = this.deps.buildTurnCursor({ id: turnId }, 0);
    await this.maybeAttachSubagentFromItem(threadId, item, turnId, liveTurnCursor);
    const state = this.runtime.threadState.get(threadId);
    if (!state) {
      if (this.deps.shouldPreferSessionStreamForThread(threadId)) {
        this.deps.queueThreadSessionPollHint(threadId);
      }
      return;
    }
    this.deps.updateStateLastActivityAt(state, null);
    markThreadTurnInProgress(state, turnId);
    const liveTimestampMs =
      this.deps.extractStableTimestampMs(item) ?? this.deps.extractUuidV7TimestampMs(turnId);
    const liveCursor = this.deps.buildNotificationCursor(turnId, item.id);
    const itemKey = `${threadId}:${item.id}`;
    const alreadyMirrored =
      this.runtime.mirroredChatItems.has(itemKey) ||
      this.runtime.mirroredAgentItems.has(itemKey) ||
      this.runtime.mirroredCommandItems.has(itemKey) ||
      this.runtime.mirroredFileChangeItems.has(itemKey);
    const assistantMessage = this.deps.extractAssistantMessage(item);
    let userMessageText = this.deps.extractUserMessageText(item, threadId);
    const userEnvelope = userMessageText ? parseUserEnvelope(userMessageText) : null;
    if (userEnvelope?.kind === "subagentNotification") {
      await this.handleSubagentNotificationEnvelope(
        threadId,
        userEnvelope,
        turnId,
        liveTurnCursor,
        liveTimestampMs
      );
      userMessageText = null;
    }
    const shouldHoldForTurnAnchor = Boolean(
      assistantMessage &&
        this.deps.isCommentaryPhase(assistantMessage.phase) &&
        this.deps.shouldHoldNonUserActivityUntilTurnAnchor(threadId, turnId, liveTurnCursor, liveCursor)
    );
    const canMirrorNonUserActivity =
      !shouldHoldForTurnAnchor && this.deps.canMirrorNonUserActivity(threadId, turnId, liveTurnCursor);
    const preferSessionStream = this.deps.shouldPreferSessionStreamForThread(threadId);
    if (preferSessionStream) {
      this.deps.appendCanonicalEvent({
        threadId,
        source: "app-server",
        eventKind: "content",
        itemKind: item.type,
        turnId,
        turnCursor: liveTurnCursor,
        itemId: item.id,
        summary: `Queued a session poll from app-server ${isCompleted ? "completion" : "start"} for ${item.type}.`,
        detail: "App-server lifecycle notifications are advisory in session-backed mode and do not mirror content directly."
      });
      this.deps.queueThreadSessionPollHint(threadId);
      this.deps.persistThreadState(state);
      this.deps.queueStatusUpdate(threadId);
      return;
    }
    const commandPreviewForFilter =
      item.type === "commandExecution"
        ? this.deps.extractCommandPreviewInfo(item as CodexCommandExecutionItem)
        : null;
    if (commandPreviewForFilter?.preview && shouldIgnoreLiveE2eHelperCommand(commandPreviewForFilter.preview)) {
      if (liveCursor) {
        this.deps.rememberThreadMirrorCursor(threadId, liveTimestampMs, liveCursor, liveTurnCursor);
      }
      this.deps.persistThreadState(state);
      this.deps.queueStatusUpdate(threadId);
      return;
    }
    let syncCandidateItemIds: Set<string> | null = null;
    if (
      !preferSessionStream &&
      isCompleted &&
      (item.type === "commandExecution" ||
        item.type === "fileChange" ||
        assistantMessage ||
        userMessageText)
    ) {
      const syncResult = await this.deps.syncRecentTurnMessages(threadId);
      syncCandidateItemIds = syncResult.candidateItemIds;
    }
    const syncCoveredCurrentItem = Boolean(syncCandidateItemIds?.has(item.id));
    if (!alreadyMirrored && !syncCoveredCurrentItem && !this.deps.shouldMirrorLiveCursor(threadId, liveCursor)) {
      this.deps.persistThreadState(state);
      this.deps.queueStatusUpdate(threadId);
      return;
    }

    if (item.type === "commandExecution") {
      const commandItem = item as CodexCommandExecutionItem;
      const commandPreview = commandPreviewForFilter ?? this.deps.extractCommandPreviewInfo(commandItem);
      state.latestCommandPreview = commandPreview.preview ?? "Command requested";
      if (!preferSessionStream && !syncCoveredCurrentItem) {
        await this.deps.publishCompletedCommandMessage(
          threadId,
          item.id,
          commandPreview.preview,
          this.deps.extractCommandDetail(commandItem),
          commandItem.status ?? (isCompleted ? null : "started"),
          liveTimestampMs,
          false,
          commandPreview.truncated,
          liveCursor,
          turnId,
          liveTurnCursor,
          this.deps.buildLifecycleDevDetail(
            threadId,
            turnId,
            item,
            "command",
            liveTimestampMs,
            liveCursor,
            null,
            commandItem.status ?? (isCompleted ? null : "started")
          )
        );
      }
      if (
        !preferSessionStream &&
        isCompleted &&
        (commandItem.status === "failed" || commandItem.status === "declined")
      ) {
        const bridge = this.context.stateStore.getThreadBridge(threadId);
        if (bridge) {
          await this.context.provider.postMilestone(
            bridge.discordChannelId,
            `Command ${commandItem.status}: \`${truncateForDiscord(state.latestCommandPreview, 180)}\``
          );
        }
      }
    }

    if (item.type === "fileChange" && isCompleted) {
      const fileChangeItem = item as CodexFileChangeItem;
      if (!preferSessionStream && !syncCoveredCurrentItem) {
        await this.deps.publishCompletedFileChangeMessage(
          threadId,
          fileChangeItem.id,
          this.deps.extractFileChangeSummary(fileChangeItem),
          fileChangeItem.status ?? null,
          liveTimestampMs,
          false,
          liveCursor,
          turnId,
          liveTurnCursor,
          this.deps.buildLifecycleDevDetail(
            threadId,
            turnId,
            item,
            "fileChange",
            liveTimestampMs,
            liveCursor,
            null,
            fileChangeItem.status ?? null
          ),
          this.deps.extractFileActivityCounts(fileChangeItem)
        );
      }
    }

    if (assistantMessage && isCompleted) {
      state.latestAgentMessage = truncateForDiscord(assistantMessage.text, 500);
      if (!syncCoveredCurrentItem && !preferSessionStream) {
        if (this.deps.isCommentaryPhase(assistantMessage.phase)) {
          await this.deps.publishCommentaryAgentMessage(
            threadId,
            item.id,
            assistantMessage.text,
            assistantMessage.phase,
            liveTimestampMs,
            false,
            liveCursor,
            turnId,
            liveTurnCursor,
            this.deps.buildLifecycleDevDetail(
              threadId,
              turnId,
              item,
              "agentCommentary",
              liveTimestampMs,
              liveCursor,
              assistantMessage.phase,
              null
            )
          );
        } else {
          await this.deps.publishCompletedAgentMessage(
            threadId,
            item.id,
            assistantMessage.text,
            assistantMessage.phase,
            liveTimestampMs,
            false,
            liveCursor,
            turnId,
            liveTurnCursor,
            this.deps.buildLifecycleDevDetail(
              threadId,
              turnId,
              item,
              "agentAnswer",
              liveTimestampMs,
              liveCursor,
              assistantMessage.phase,
              null
            )
          );
        }
      }
    }

    if (userMessageText && !preferSessionStream) {
      if (userEnvelope?.kind === "turnAborted") {
        const finalText = userEnvelope.message.trim() || "**Turn Aborted**";
        state.latestAgentMessage = truncateForDiscord(finalText, 500);
        await this.deps.publishCompletedAgentMessage(
          threadId,
          item.id,
          finalText,
          "final_answer",
          liveTimestampMs,
          false,
          liveCursor,
          turnId,
          liveTurnCursor,
          this.deps.buildLifecycleDevDetail(
            threadId,
            turnId,
            item,
            "agentAnswer",
            liveTimestampMs,
            liveCursor,
            "final_answer",
            null
          )
        );
      } else {
        await this.deps.publishCompletedUserMessage(
          threadId,
          item.id,
          userMessageText,
          liveTimestampMs,
          false,
          liveCursor,
          turnId,
          liveTurnCursor,
          this.deps.buildLifecycleDevDetail(
            threadId,
            turnId,
            item,
            "user",
            liveTimestampMs,
            liveCursor,
            null,
            null
          )
        );
      }
    }

    if (!preferSessionStream && item.type === "fileChange" && isCompleted && item.status === "declined") {
      const bridge = this.context.stateStore.getThreadBridge(threadId);
      if (bridge) {
        await this.context.provider.postMilestone(
          bridge.discordChannelId,
          "A proposed file change was declined."
        );
      }
    }
    if (liveCursor && !syncCoveredCurrentItem && (userMessageText !== null || canMirrorNonUserActivity)) {
      this.deps.rememberThreadMirrorCursor(threadId, liveTimestampMs, liveCursor, liveTurnCursor);
    }
    try {
      await this.deps.enforceTurnRetention(threadId);
    } catch (error) {
      this.context.logger.warn({ error, threadId }, "Failed to enforce mirrored turn retention.");
    }
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(threadId);
  }

  async handleSubagentNotificationEnvelope(
    parentThreadId: string,
    envelope: ParsedSubagentNotificationEnvelope,
    parentTurnId: string | null = null,
    parentTurnCursor: string | null = null,
    parentTimestampMs: number | null = null
  ): Promise<void> {
    const childThreadId = envelope.childThreadId;
    if (!childThreadId || childThreadId === parentThreadId) {
      return;
    }

    if (this.deps.shouldPreferSessionStreamForThread(parentThreadId)) {
      this.deps.recordIgnoredHint({
        threadId: parentThreadId,
        source: "app-server",
        itemKind: "subagentNotification",
        turnId: parentTurnId,
        turnCursor: parentTurnCursor,
        itemId: childThreadId,
        summary: `Ignored app-server subagent notification for child ${childThreadId}.`,
        reason:
          "Subagent notification envelopes are advisory in session-backed mode. Child ownership is created only from an anchored session spawn."
      });
      this.deps.queueThreadSessionPollHint(parentThreadId);
      return;
    }

    this.deps.rememberChildThreadParent(childThreadId, parentThreadId);
    this.queueAnchoredSubagentAttachment({
      parentThreadId,
      childThreadId,
      parentAnchorTurnId: parentTurnId,
      parentAnchorTurnCursor: parentTurnCursor,
      parentTimestampMs,
      statusText: envelope.statusText
        ? truncateForDiscord(redactSensitiveText(envelope.statusText), 220)
        : null,
      failureMessage: "Failed to resume sub-agent thread from notification envelope.",
      requireCurrentNotificationChild: true
    });
  }

  private shouldAttachSubagentFromNotificationEnvelope(
    prepared: Awaited<ReturnType<typeof prepareSubagentAttachment>>,
    parentTurnId: string | null,
    parentTimestampMs: number | null
  ): boolean {
    if (prepared.existingChild) {
      return true;
    }

    if (prepared.summaryWasSynthetic) {
      return false;
    }

    const childActivityMs = this.extractThreadActivityMs(prepared.summary);
    if (childActivityMs === null) {
      return false;
    }

    const effectiveParentTimestampMs =
      parentTimestampMs ??
      (parentTurnId ? this.deps.extractUuidV7TimestampMs(parentTurnId) : null);
    if (effectiveParentTimestampMs === null) {
      return false;
    }

    return childActivityMs + 2_000 >= effectiveParentTimestampMs;
  }

  private extractThreadActivityMs(summary: CodexThreadSummary): number | null {
    const seconds =
      typeof summary.updatedAt === "number" && Number.isFinite(summary.updatedAt)
        ? summary.updatedAt
        : typeof summary.createdAt === "number" && Number.isFinite(summary.createdAt)
          ? summary.createdAt
          : null;
    return seconds === null ? null : seconds * 1000;
  }

  async handleTurnCompleted(turnId: string, turnStatus: string): Promise<void> {
    const state = [...this.runtime.threadState.values()].find((entry) => entry.lastTurnId === turnId);
    if (!state) {
      return;
    }
    markThreadTurnCompleted(state, turnStatus);
    await this.deps.finishDiscordInputTurn(state.threadId, turnId);
    this.deps.updateStateLastActivityAt(state, null);
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(state.threadId);
    if (this.deps.shouldPreferSessionStreamForThread(state.threadId)) {
      this.deps.queueThreadSessionPollHint(state.threadId);
      await this.deps.drainWriteBackQueue(state.threadId);
      return;
    }
    this.deps.queueMessageSync(state.threadId);
    const bridge = this.context.stateStore.getThreadBridge(state.threadId);
    if (bridge) {
      await this.context.provider.postMilestone(
        bridge.discordChannelId,
        `Turn completed with status: \`${turnStatus}\`.`
      );
    }
    await this.deps.drainWriteBackQueue(state.threadId);
  }

  private async maybeAttachSubagentFromItem(
    threadId: string,
    item: CodexItem,
    turnId: string | null,
    turnCursor: string | null
  ): Promise<void> {
    const collab = extractCollabToolCall(item);
    if (!collab) {
      return;
    }
    const parentThreadId = collab.senderThreadId || threadId;
    const childThreadId = collab.newThreadId ?? collab.receiverThreadId ?? null;
    if (!childThreadId || childThreadId === parentThreadId) {
      return;
    }
    if (this.deps.shouldPreferSessionStreamForThread(parentThreadId)) {
      this.deps.recordIgnoredHint({
        threadId: parentThreadId,
        source: "app-server",
        itemKind: item.type,
        turnId,
        turnCursor,
        itemId: childThreadId,
        summary: `Ignored app-server child attach hint for ${childThreadId}.`,
        reason:
          "App-server collab hints cannot create or restore child ownership in session-backed mode."
      });
      this.deps.queueThreadSessionPollHint(parentThreadId);
      return;
    }

    this.deps.rememberChildThreadParent(childThreadId, parentThreadId);
    const prompt = collab.prompt ?? null;
    const actorNameHint = collab.agentNickname ?? null;
    const statusText = collab.agentStatus
      ? truncateForDiscord(redactSensitiveText(collab.agentStatus), 220)
      : null;
    this.queueAnchoredSubagentAttachment({
      parentThreadId,
      childThreadId,
      parentAnchorTurnId: turnId,
      parentAnchorTurnCursor: turnCursor,
      prompt,
      actorNameHint,
      statusText,
      failureMessage: "Failed to resume sub-agent thread."
    });
  }

  private queueSpawnedSubagentInitialization(childThreadId: string): void {
    if (this.deps.shouldPreferSessionStreamForThread(childThreadId)) {
      this.deps.initializeSpawnedSubagentThread(childThreadId);
      return;
    }

    this.runtime.initializingSubagentThreadIds.add(childThreadId);
    void this.deps.enqueueThreadEvent(childThreadId, async () => {
      try {
        await this.deps.syncRecentTurnMessages(childThreadId);
      } finally {
        this.runtime.initializingSubagentThreadIds.delete(childThreadId);
      }
    }).catch((error) => {
      this.runtime.initializingSubagentThreadIds.delete(childThreadId);
      this.context.logger.debug(
        { error, childThreadId },
        "Failed to initialize a spawned sub-agent thread from app-server notifications."
      );
    });
  }

  private queueAnchoredSubagentAttachment(input: {
    parentThreadId: string;
    childThreadId: string;
    parentAnchorTurnId: string | null;
    parentAnchorTurnCursor: string | null;
    prompt?: string | null;
    actorNameHint?: string | null;
    statusText?: string | null;
    parentTimestampMs?: number | null;
    failureMessage: string;
    requireCurrentNotificationChild?: boolean;
  }): void {
    const {
      parentThreadId,
      childThreadId,
      parentAnchorTurnId,
      parentAnchorTurnCursor,
      prompt,
      actorNameHint,
      statusText,
      parentTimestampMs,
      failureMessage,
      requireCurrentNotificationChild
    } = input;
    this.runtime.childThreadAnchorHints.set(childThreadId, {
      parentThreadId,
      parentAnchorTurnId,
      parentAnchorTurnCursor
    });
    void this.deps.enqueueThreadEvent(childThreadId, async () => {
      const normalizedPrompt = prompt ?? null;
      const normalizedActorNameHint = actorNameHint ?? null;
      const prepared = await prepareSubagentAttachment(this.context, this.runtime, this.deps, {
        parentThreadId,
        childThreadId,
        prompt: normalizedPrompt,
        actorNameHint: normalizedActorNameHint
      });
      if (
        requireCurrentNotificationChild &&
        !this.shouldAttachSubagentFromNotificationEnvelope(prepared, parentAnchorTurnId, parentTimestampMs ?? null)
      ) {
        this.context.logger.debug(
          {
            parentThreadId,
            childThreadId,
            parentAnchorTurnId,
            parentTimestampMs
          },
          "Skipping sub-agent notification envelope because the child thread is not current to the parent turn."
        );
        return;
      }

      await attachPreparedSubagentThread(this.context, this.runtime, this.deps, {
        childThreadId,
        prepared,
        parentAnchorTurnId,
        parentAnchorTurnCursor,
        statusText: statusText ?? null,
        failureMessage
      });
      this.queueSpawnedSubagentInitialization(childThreadId);
    }).catch((error) => {
      this.context.logger.debug(
        { error, parentThreadId, childThreadId },
        "Failed to queue an anchored sub-agent attachment."
      );
    });
  }
}
