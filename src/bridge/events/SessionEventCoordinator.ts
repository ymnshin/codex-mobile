import type {
  ChildThreadAnchorRecord,
  PendingApprovalRecord,
  ThreadRuntimeState
} from "../../domain.js";
import type {
  CodexSessionEvent,
  SessionSubagentSpawnedEvent,
  SessionThreadFrontier
} from "../../codex/CodexSessionEventTailer.js";
import { shortThreadId } from "../../util/formatting.js";
import { redactSensitiveText, truncateForDiscord } from "../../util/redaction.js";
import { createPendingApprovalRecord } from "../approval/approvalModel.js";
import { persistEffectiveApprovalRecord } from "../approval/approvalPersistence.js";
import {
  isPendingReadOnlySessionLogApprovalPlaceholder,
  isRestartEnabledPendingReadOnlySessionLogApprovalPlaceholder
} from "../approval/approvalPlaceholders.js";
import {
  canApplyResolvedApprovalStatus
} from "../approval/approvalState.js";
import { formatNativeApprovalResolution } from "../approval/nativeApprovalInterop.js";
import { parseUserEnvelope } from "./eventParsing.js";
import {
  attachPreparedSubagentThread,
  prepareSubagentAttachment
} from "./subagentAttachment.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import type {
  BridgeRuntimeState,
  FileActivityCounts,
  ResolvedThreadMetadata
} from "../runtime/BridgeRuntimeState.js";
import {
  markThreadTurnCompleted,
  markThreadTurnInProgress
} from "../runtime/BridgeRuntimeState.js";
import { shouldIgnoreLiveE2eHelperCommand } from "../../util/liveE2e.js";

const NATIVE_SHELL_PLACEHOLDER_MAX_AGE_MS = 2 * 60 * 1000;
const LIVE_SUBAGENT_SPAWN_EAGER_ATTACH_GRACE_MS = 5_000;

interface SessionEventCoordinatorDependencies {
  finishDiscordInputTurn(threadId: string, turnId: string): Promise<void>;
  appendCanonicalEvent(input: {
    threadId: string;
    source: "session" | "desktop-ipc";
    eventKind:
      | "content"
      | "childAnchor"
      | "approvalUpsert"
      | "approvalResolved"
      | "approvalHold"
      | "approvalRelease";
    itemKind?: string | null;
    turnId?: string | null;
    turnCursor?: string | null;
    itemId?: string | null;
    requestId?: string | null;
    summary?: string | null;
    detail?: string | null;
    createdAt?: string | null;
  }): void;
  buildApprovalCardView(approval: PendingApprovalRecord): import("../../domain.js").ApprovalCardView;
  buildMirrorCursor(timestampMs: number | null, itemId: string, orderKey?: number | null): string | null;
  buildSessionEventCursor(sourceOrder: string | null | undefined, eventKey: string | null | undefined): string | null;
  buildSessionEventDevDetail(
    threadId: string,
    itemId: string,
    kind: "user" | "agentCommentary" | "agentAnswer" | "command" | "fileChange",
    timestampMs: number | null,
    cursor: string | null,
    turnId: string | null,
    status: string | null,
    rawEvent: unknown
  ): string;
  buildSessionEventItemId(
    kind: "command" | "user" | "turn-aborted" | "agent" | "apply-patch",
    baseId: string,
    eventKey?: string | null,
    sourceOrder?: string | null
  ): string;
  buildSessionTurnCursor(turnId: string | null | undefined): string | null;
  buildShellDecisionPayloads(details: string): Record<string, unknown>;
  canMirrorNonUserActivity(
    threadId: string,
    turnId?: string | null,
    turnCursor?: string | null
  ): boolean;
  classifyNativeResolutionStatus(method: string, response: unknown): PendingApprovalRecord["status"];
  drainWriteBackQueue(threadId: string): Promise<void>;
  enqueueThreadEvent(threadId: string, work: () => Promise<void>): Promise<void>;
  enforceTurnRetention(threadId: string): Promise<void>;
  ensureThreadStateForRequest(threadId: string, preferredName: string): Promise<ThreadRuntimeState>;
  extractSessionSourceFrontier(event: { filePath?: string; sourceOffset?: number; eventKey?: string }): import("../runtime/BridgeRuntimeState.js").ThreadSourceFrontier | null;
  flushMessageSync(threadId: string): Promise<void>;
  flushStatusUpdate(threadId: string): Promise<void>;
  hydrateThread(
    threadId: string,
    summary: import("../../domain.js").CodexThreadSummary,
    attachMode: "auto" | "manual",
    hydrateOptions?: import("../runtime/BridgeRuntimeState.js").HydrateThreadOptions
  ): Promise<import("../runtime/BridgeRuntimeState.js").HydratedThreadResult>;
  isCommentaryPhase(phase: string | null | undefined): boolean;
  mirrorApprovalCard(
    approvalRecord: PendingApprovalRecord,
    options: {
      timestampMs: number | null;
      drainSessionBacklog: boolean;
      existingMessageId: string | null;
    }
  ): Promise<void>;
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
    summary: string,
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
  queueThreadSessionPollHint(threadId: string): void;
  queueStatusUpdate(threadId: string): void;
  rememberRetainedTurn(input: {
    threadId: string;
    turnId: string | null;
    turnCursor: string | null;
    anchorItemId: string | null;
    anchorText: string | null;
    source: "session" | "codex-read";
  }): void;
  rememberChildThreadParent(childThreadId: string, parentThreadId: string): void;
  rememberSuppressedSyntheticSessionTurn(threadId: string, turnId: string): void;
  rememberThreadMirrorCursor(
    threadId: string,
    timestampMs: number | null,
    cursor: string,
    turnCursor: string | null,
    sourceFrontier?: import("../runtime/BridgeRuntimeState.js").ThreadSourceFrontier | null
  ): void;
  renderCommandDetail(
    preview: string,
    status: string | null,
    timestampMs: number | null,
    timestampIsApproximate?: boolean
  ): string | null;
  resolveThreadIdForDesktopEvent(
    event: Extract<CodexSessionEvent, { type: "nativeApprovalResolved" }>
  ): string | null;
  resolveThreadMetadata(
    threadId: string,
    preferred?: ResolvedThreadMetadata | null,
    options?: {
      allowFilesystemScan?: boolean;
    }
  ): Promise<ResolvedThreadMetadata>;
  resolveStoredChildThreadAnchor(childThreadId: string): ChildThreadAnchorRecord | null;
  retryDeferredCommandApprovalRequest(callId: string): Promise<void>;
  retryDeferredApprovalRequest(requestId: string): Promise<void>;
  scheduleDetachedSessionEvent(event: CodexSessionEvent): void;
  scheduleThreadSessionEvent(threadId: string, event: CodexSessionEvent): void;
  shouldMirrorLiveCursor(threadId: string, cursor: string | null): boolean;
  shouldHoldNonUserActivityUntilTurnAnchor(
    threadId: string,
    turnId: string | null | undefined,
    turnCursor: string | null | undefined,
    cursor: string | null | undefined
  ): boolean;
  shouldSuppressSyntheticSessionTurn(threadId: string, turnId: string | null): boolean;
  shouldSuppressSyntheticSessionUserEvent(
    threadId: string,
    event: Extract<CodexSessionEvent, { type: "sessionUserMessage" }>
  ): boolean;
  syntheticSummary(
    threadId: string,
    preferredName: string,
    status: import("../../domain.js").CodexThreadStatus | null
  ): import("../../domain.js").CodexThreadSummary;
  tryReadThread(threadId: string): Promise<import("../../domain.js").CodexThreadSummary | null>;
  upsertChildThreadAnchor(record: Omit<ChildThreadAnchorRecord, "updatedAt">): ChildThreadAnchorRecord;
  updateStateLastActivityAt(
    state: ThreadRuntimeState,
    timestampMs: number | null | undefined
  ): void;
}

export class SessionEventCoordinator {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: SessionEventCoordinatorDependencies
  ) {}

  async pollLocalSessionEvents(): Promise<Set<string>> {
    const tailer = this.context.sessionEventTailer;

    const mappedThreadIds: string[] = [];
    for (const bridge of this.context.stateStore.listThreadBridges()) {
      if (bridge.channelKind === "subagent" && !bridge.actorName) {
        await this.ensureMappedSubagentActorName(bridge.codexThreadId);
      }
      mappedThreadIds.push(bridge.codexThreadId);
    }
    const affectedThreadIds = new Set<string>();
    let enqueuedEvents = 0;
    for (const threadId of mappedThreadIds) {
      const queued = this.queuePolledSessionEvents(
        await tailer.pollThread(threadId, {
          allowFilesystemScan: false
        })
      );
      enqueuedEvents += queued.enqueuedEvents;
      this.mergeAffectedThreadIds(affectedThreadIds, queued.affectedThreadIds);
    }

    if (enqueuedEvents > 0) {
      this.deps.printProgress(`Queued ${enqueuedEvents} local session event(s) for background processing.`);
    }
    return affectedThreadIds;
  }

  async pollDesktopApprovalEvents(): Promise<Set<string>> {
    const tailer = this.context.sessionEventTailer;
    const queued = this.queuePolledSessionEvents(await tailer.pollDesktop());

    if (queued.enqueuedEvents > 0) {
      this.deps.printProgress(`Queued ${queued.enqueuedEvents} desktop approval event(s) for background processing.`);
    }
    return queued.affectedThreadIds;
  }

  async pollThreadSessionEvents(
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ): Promise<Set<string>> {
    const queued = this.queuePolledSessionEvents(
      await this.context.sessionEventTailer.pollThread(threadId, options)
    );
    return queued.affectedThreadIds;
  }

  async captureThreadSessionFrontier(
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ): Promise<SessionThreadFrontier | null> {
    return this.context.sessionEventTailer.captureThreadFrontier(threadId, options);
  }

  async replayThreadSessionEventsFromFrontier(
    threadId: string,
    sourceFrontier: SessionThreadFrontier | null,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ): Promise<number> {
    const queued = this.queuePolledSessionEvents(
      await this.context.sessionEventTailer.replayThreadFromFrontier(threadId, sourceFrontier, options)
    );
    if (queued.enqueuedEvents > 0) {
      this.deps.printProgress(
        `Queued ${queued.enqueuedEvents} startup-window local session event(s) for ${shortThreadId(threadId)}.`
      );
    }
    return queued.enqueuedEvents;
  }

  queueThreadSessionPollHint(threadId: string): void {
    if (this.runtime.hintedSessionPollThreadIds.has(threadId)) {
      this.runtime.pendingHintedSessionRepollThreadIds.add(threadId);
      return;
    }

    this.runtime.hintedSessionPollThreadIds.add(threadId);
    void this.deps.enqueueThreadEvent(threadId, async () => {
      try {
        let shouldRepoll = false;
        do {
          await this.pollThreadSessionEvents(threadId, {
            allowFilesystemScan: false
          });
          shouldRepoll = this.runtime.pendingHintedSessionRepollThreadIds.delete(threadId);
        } while (shouldRepoll);
      } finally {
        this.runtime.hintedSessionPollThreadIds.delete(threadId);
        this.runtime.pendingHintedSessionRepollThreadIds.delete(threadId);
      }
    }).catch((error) => {
      this.runtime.hintedSessionPollThreadIds.delete(threadId);
      this.runtime.pendingHintedSessionRepollThreadIds.delete(threadId);
      this.context.logger.debug({ error, threadId }, "Failed to poll a hinted session-preferred thread.");
    });
  }

  initializeSpawnedSubagentThread(childThreadId: string): void {
    if (this.runtime.initializingSubagentThreadIds.has(childThreadId)) {
      return;
    }

    this.runtime.initializingSubagentThreadIds.add(childThreadId);
    void this.deps.enqueueThreadEvent(childThreadId, async () => {
      try {
        await this.deps.flushMessageSync(childThreadId);
        await this.pollThreadSessionEvents(childThreadId, {
          allowFilesystemScan: false
        });
      } finally {
        this.runtime.initializingSubagentThreadIds.delete(childThreadId);
      }
    }).catch((error) => {
      this.runtime.initializingSubagentThreadIds.delete(childThreadId);
      this.context.logger.debug(
        { error, childThreadId },
        "Failed to initialize a spawned sub-agent thread."
      );
    });
  }

  async handleSessionEvent(event: CodexSessionEvent): Promise<void> {
    if ("threadId" in event && event.threadId && this.runtime.unseededNoHistoryThreads.has(event.threadId)) return;
    if (event.type === "shellApprovalRequested") {
      await this.handleLocalShellApprovalRequested(event);
      return;
    }

    if (event.type === "shellCommandCompleted") {
      await this.handleLocalShellCommandCompleted(event);
      return;
    }

    if (event.type === "sessionUserMessage") {
      await this.handleLocalSessionUserMessage(event);
      return;
    }

    if (event.type === "sessionAgentMessage") {
      await this.handleLocalSessionAgentMessage(event);
      return;
    }

    if (event.type === "sessionSubagentSpawned") {
      await this.handleLocalSessionSubagentSpawned(event);
      return;
    }

    if (event.type === "sessionApplyPatchCompleted") {
      await this.handleLocalSessionApplyPatchCompleted(event);
      return;
    }

    if (event.type === "nativeCommandApprovalRequested") {
      await this.handleNativeCommandApprovalRequested(event);
      return;
    }

    if (event.type === "nativeQuestionRequested") {
      await this.handleNativeQuestionRequested(event);
      return;
    }

    if (event.type === "nativeApprovalResolved") {
      await this.handleNativeApprovalResolved(event);
    }
  }

  scheduleDetachedSessionEvent(event: CodexSessionEvent): void {
    void Promise.resolve()
      .then(() => this.handleSessionEvent(event))
      .catch((error) => {
        this.context.logger.warn({ error, eventType: event.type }, "Detached session event processing failed.");
      });
  }

  scheduleThreadSessionEvent(threadId: string, event: CodexSessionEvent): void {
    void this.deps.enqueueThreadEvent(threadId, async () => {
      await this.handleSessionEvent(event);
    }).catch((error) => {
      this.context.logger.warn({ error, threadId, eventType: event.type }, "Thread session event processing failed.");
    });
  }

  private async ensureMappedSubagentActorName(threadId: string): Promise<void> {
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge || bridge.channelKind !== "subagent" || bridge.actorName) {
      return;
    }

    const metadata = await this.deps.resolveThreadMetadata(threadId);
    const actorName = metadata.actorName?.trim() ?? "";
    if (!actorName) {
      return;
    }

    const state = this.runtime.threadState.get(threadId);
    if (state) {
      state.actorName = actorName;
      this.deps.persistThreadState(state);
      return;
    }

    this.context.stateStore.upsertThreadBridge({
      ...bridge,
      actorName
    });
  }

  private queuePolledSessionEvents(events: CodexSessionEvent[]): {
    enqueuedEvents: number;
    affectedThreadIds: Set<string>;
  } {
    const affectedThreadIds = new Set<string>();
    let enqueuedEvents = 0;
    for (const event of events) {
      const threadId =
        event.type === "nativeApprovalResolved"
          ? this.deps.resolveThreadIdForDesktopEvent(event)
          : event.threadId;
      if (!threadId) {
        this.scheduleDetachedSessionEvent(event);
        enqueuedEvents += 1;
        continue;
      }
      affectedThreadIds.add(threadId);
      this.scheduleThreadSessionEvent(threadId, event);
      enqueuedEvents += 1;
    }
    return {
      enqueuedEvents,
      affectedThreadIds
    };
  }

  private mergeAffectedThreadIds(target: Set<string>, source: Set<string>): void {
    for (const threadId of source) {
      target.add(threadId);
    }
  }

  private async handleLocalShellApprovalRequested(
    event: Extract<CodexSessionEvent, { type: "shellApprovalRequested" }>
  ): Promise<void> {
    const channelKind =
      this.runtime.threadState.get(event.threadId)?.channelKind ??
      this.context.stateStore.getThreadBridge(event.threadId)?.channelKind ??
      "conversation";
    const sourceKind =
      this.runtime.threadState.get(event.threadId)?.sourceKind ??
      this.context.stateStore.getThreadBridge(event.threadId)?.sourceKind ??
      "app-server";

    if (
      this.context.desktopIpcClient?.isReady() &&
      sourceKind !== "cli-session" &&
      channelKind !== "subagent"
    ) {
      this.context.logger.debug(
        { threadId: event.threadId, callId: event.callId, sourceKind, channelKind },
        "Skipping session-log shell approval placeholder because Desktop IPC will surface the interactive approval."
      );
      return;
    }

    const preview = event.command?.trim() || "Command approval requested";
    const existing = this.context.stateStore.findPendingApprovalByItem(
      event.threadId,
      event.callId,
      "commandExecution"
    );
    const approvalRecord = createPendingApprovalRecord(this.context.policy, {
      requestId: `session-log:${event.callId}`,
      threadId: event.threadId,
      turnId: event.turnId ?? event.callId,
      feedbackTurnId: event.turnId ?? null,
      itemId: event.callId,
      kind: "commandExecution",
      preview,
      cwd: event.cwd,
      reason: event.justification ? redactSensitiveText(event.justification) : "Approve in Codex Desktop.",
      availableDecisions: [],
      decisionPayloads: {},
      details: redactSensitiveText(event.details),
      createdAtMs: event.timestampMs,
      discordMessageId: existing?.discordMessageId ?? null
    });

    const effectiveApprovalRecord = persistEffectiveApprovalRecord(
      this.context.stateStore,
      approvalRecord,
      existing
    );
    this.deps.appendCanonicalEvent({
      threadId: event.threadId,
      source: "session",
      eventKind: "approvalUpsert",
      itemKind: "commandExecution",
      turnId: event.turnId ?? event.callId,
      turnCursor: this.deps.buildSessionTurnCursor(event.turnId),
      itemId: event.callId,
      requestId: effectiveApprovalRecord.requestId,
      summary: `Session shell approval requested for ${event.callId}.`,
      detail: preview,
      createdAt:
        event.timestampMs !== null ? new Date(event.timestampMs).toISOString() : new Date().toISOString()
    });

    await this.deps.mirrorApprovalCard(effectiveApprovalRecord, {
      timestampMs: event.timestampMs,
      drainSessionBacklog: false,
      existingMessageId: effectiveApprovalRecord.discordMessageId
    });
    await this.deps.retryDeferredCommandApprovalRequest(event.callId);
  }

  private async handleNativeCommandApprovalRequested(
    event: Extract<CodexSessionEvent, { type: "nativeCommandApprovalRequested" }>
  ): Promise<void> {
    this.runtime.desktopRequestThreadHints.set(event.requestId, event.threadId);
    void this.deps.retryDeferredApprovalRequest(event.requestId);
    this.deps.appendCanonicalEvent({
      threadId: event.threadId,
      source: "desktop-ipc",
      eventKind: "approvalUpsert",
      itemKind: "commandExecution",
      requestId: event.requestId,
      summary: `Desktop IPC command approval requested for ${event.requestId}.`,
      createdAt:
        event.timestampMs !== null ? new Date(event.timestampMs).toISOString() : new Date().toISOString()
    });
    if (this.context.desktopIpcClient?.isReady()) {
      return;
    }
    const existingByRequest = this.context.stateStore.findPendingApprovalByRequestId(event.requestId);
    if (existingByRequest) {
      if (!existingByRequest.restartDisabledAt) {
        return;
      }
      const reactivatedRecord: PendingApprovalRecord = {
        ...existingByRequest,
        restartDisabledAt: null
      };
      this.context.stateStore.refreshPendingApprovalRecord(existingByRequest.token, reactivatedRecord);
      await this.deps.mirrorApprovalCard(reactivatedRecord, {
        timestampMs: event.timestampMs,
        drainSessionBacklog: true,
        existingMessageId: reactivatedRecord.discordMessageId
      });
      return;
    }
    const placeholders = this.findPendingShellPlaceholders(event.threadId, event.timestampMs);
    const placeholder = placeholders.length === 1 ? placeholders[0] : null;
    const decisionPayloads = this.deps.buildShellDecisionPayloads(placeholder?.details ?? "");
    const availableDecisions = Object.keys(decisionPayloads);

    if (placeholder) {
      const updatedRecord: PendingApprovalRecord = {
        ...placeholder,
        requestId: event.requestId,
        availableDecisions,
        decisionPayloads,
        status: "pending",
        expiresAt: this.context.policy.expiresAt(event.timestampMs ?? Date.now()).toISOString(),
        restartDisabledAt: null
      };
      this.context.stateStore.refreshPendingApprovalRecord(placeholder.token, updatedRecord);
      await this.deps.mirrorApprovalCard(updatedRecord, {
        timestampMs: event.timestampMs,
        drainSessionBacklog: true,
        existingMessageId: updatedRecord.discordMessageId
      });
      return;
    }

    const record = createPendingApprovalRecord(this.context.policy, {
      requestId: event.requestId,
      threadId: event.threadId,
      turnId: `native-command:${event.requestId}`,
      feedbackTurnId: null,
      itemId: `native-command:${event.requestId}`,
      kind: "commandExecution",
      preview: "Command approval requested",
      cwd: null,
      reason: null,
      availableDecisions,
      decisionPayloads,
      details: redactSensitiveText(JSON.stringify({ requestId: event.requestId, source: "desktop-native" }, null, 2)),
      createdAtMs: event.timestampMs,
      discordMessageId: null
    });
    this.context.stateStore.upsertPendingApproval(record);
    await this.deps.mirrorApprovalCard(record, {
      timestampMs: event.timestampMs,
      drainSessionBacklog: true,
      existingMessageId: null
    });
  }

  private async handleNativeQuestionRequested(
    event: Extract<CodexSessionEvent, { type: "nativeQuestionRequested" }>
  ): Promise<void> {
    this.runtime.desktopRequestThreadHints.set(event.requestId, event.threadId);
    void this.deps.retryDeferredApprovalRequest(event.requestId);
    this.deps.appendCanonicalEvent({
      threadId: event.threadId,
      source: "desktop-ipc",
      eventKind: "approvalHold",
      itemKind: "toolUserInput",
      requestId: event.requestId,
      summary: `Desktop IPC tool question requested (${event.questionCount}).`,
      createdAt:
        event.timestampMs !== null ? new Date(event.timestampMs).toISOString() : new Date().toISOString()
    });
    if (this.context.desktopIpcClient?.isReady()) {
      return;
    }
    const existing = this.context.stateStore.findPendingApprovalByRequestId(event.requestId);
    if (existing) {
      return;
    }

    const state = await this.deps.ensureThreadStateForRequest(
      event.threadId,
      event.questionCount > 0 ? `Tool prompt (${event.questionCount} questions)` : "Tool prompt requested"
    );
    this.deps.updateStateLastActivityAt(state, event.timestampMs);
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(state.threadId);
  }

  private async handleNativeApprovalResolved(
    event: Extract<CodexSessionEvent, { type: "nativeApprovalResolved" }>
  ): Promise<void> {
    this.runtime.desktopRequestThreadHints.delete(event.requestId);
    const approval = this.context.stateStore.findPendingApprovalByRequestId(event.requestId);
    if (!approval) {
      return;
    }

    const previousStatus = approval.status;
    const status = this.deps.classifyNativeResolutionStatus(event.method, event.response);
    if (!canApplyResolvedApprovalStatus(previousStatus, status)) {
      return;
    }
    this.deps.appendCanonicalEvent({
      threadId: approval.threadId,
      source: "desktop-ipc",
      eventKind: "approvalResolved",
      itemKind: approval.kind,
      turnId: approval.turnId,
      requestId: event.requestId,
      summary: `Desktop IPC approval resolved as ${status}.`,
      detail: event.method,
      createdAt:
        event.timestampMs !== null ? new Date(event.timestampMs).toISOString() : new Date().toISOString()
    });

    if (previousStatus !== status) {
      this.context.stateStore.setPendingApprovalStatus(approval.token, status);
    }
    const bridge = this.context.stateStore.getThreadBridge(approval.threadId);
    if (bridge && approval.discordMessageId && previousStatus !== "decisionSent" && previousStatus !== status) {
      await this.context.provider.disableApprovalCard(
        bridge.discordChannelId,
        approval.discordMessageId,
        formatNativeApprovalResolution(event.method, event.response, "Codex Desktop"),
        this.deps.buildApprovalCardView(approval)
      );
    }

    const state = this.runtime.threadState.get(approval.threadId);
    if (state && state.status.type === "active") {
      state.status = {
        type: "active",
        activeFlags: (state.status.activeFlags ?? []).filter((flag) => flag !== "waitingOnApproval")
      };
      this.deps.updateStateLastActivityAt(state, event.timestampMs);
      this.deps.persistThreadState(state);
      this.deps.queueStatusUpdate(state.threadId);
    }
  }

  private findPendingShellPlaceholders(
    threadId: string,
    nativeTimestampMs: number | null
  ): PendingApprovalRecord[] {
    const referenceTimestampMs = nativeTimestampMs ?? Date.now();
    return this.context.stateStore
      .listPendingApprovals()
      .filter(
        (record) =>
          record.threadId === threadId &&
          record.kind === "commandExecution" &&
          isRestartEnabledPendingReadOnlySessionLogApprovalPlaceholder(record) &&
          this.isFreshPendingShellPlaceholder(record, referenceTimestampMs)
      )
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  private isFreshPendingShellPlaceholder(
    record: PendingApprovalRecord,
    referenceTimestampMs: number
  ): boolean {
    const createdAtMs = Date.parse(record.createdAt);
    return Number.isFinite(createdAtMs) && referenceTimestampMs - createdAtMs <= NATIVE_SHELL_PLACEHOLDER_MAX_AGE_MS;
  }

  private async handleLocalShellCommandCompleted(
    event: Extract<CodexSessionEvent, { type: "shellCommandCompleted" }>
  ): Promise<void> {
    if (this.shouldSuppressReplayedParentAnchorTurn(event.threadId, event.turnId ?? null)) {
      return;
    }
    if (this.deps.shouldSuppressSyntheticSessionTurn(event.threadId, event.turnId ?? null)) {
      return;
    }
    const preview = event.command?.trim() || `shell_command ${event.callId}`;
    const mirroredTimestampMs = event.timestampMs ?? Date.now();
    const timestampIsApproximate = event.timestampMs === null;
    const itemId = this.deps.buildSessionEventItemId(
      "command",
      event.callId,
      event.eventKey ?? null,
      event.sourceOrder ?? null
    );
    const sessionCursor =
      this.deps.buildSessionEventCursor(event.sourceOrder ?? null, event.eventKey ?? null) ??
      this.deps.buildMirrorCursor(event.timestampMs, itemId, event.streamOrder ?? 0);
    const turnCursor = this.deps.buildSessionTurnCursor(event.turnId);
    if (shouldIgnoreLiveE2eHelperCommand(preview)) {
      if (sessionCursor) {
        this.deps.rememberThreadMirrorCursor(
          event.threadId,
          mirroredTimestampMs,
          sessionCursor,
          turnCursor,
          this.deps.extractSessionSourceFrontier(event)
        );
      }
      return;
    }

    const state = await this.deps.ensureThreadStateForRequest(event.threadId, preview);
    const effectiveTurnId = event.turnId ?? state.lastTurnId;
    const effectiveTurnCursor = event.turnId ? turnCursor : this.deps.buildSessionTurnCursor(effectiveTurnId);
    markThreadTurnInProgress(state, effectiveTurnId);
    state.latestCommandPreview = truncateForDiscord(
      redactSensitiveText(preview),
      this.context.runtimeConfig.ui.commandPreviewMaxLength
    );
    this.deps.updateStateLastActivityAt(state, mirroredTimestampMs);
    state.status =
      state.status.type === "active"
        ? {
            type: "active",
            activeFlags: (state.status.activeFlags ?? []).filter((flag) => flag !== "waitingOnApproval")
          }
        : state.status;
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(state.threadId);
    this.deps.appendCanonicalEvent({
      threadId: event.threadId,
      source: "session",
      eventKind: "content",
      itemKind: "command",
      turnId: effectiveTurnId,
      turnCursor: effectiveTurnCursor,
      itemId,
      summary: truncateForDiscord(redactSensitiveText(preview), 120),
      detail: event.status,
      createdAt:
        mirroredTimestampMs !== null ? new Date(mirroredTimestampMs).toISOString() : new Date().toISOString()
    });
    if (!this.deps.shouldMirrorLiveCursor(event.threadId, sessionCursor)) {
      return;
    }
    const canMirror = this.deps.canMirrorNonUserActivity(
      event.threadId,
      effectiveTurnId,
      effectiveTurnCursor
    );
    if (canMirror) {
      await this.deps.publishCompletedCommandMessage(
        event.threadId,
        itemId,
        truncateForDiscord(redactSensitiveText(preview), this.context.runtimeConfig.ui.commandPreviewMaxLength),
        this.deps.renderCommandDetail(preview, event.status, mirroredTimestampMs),
        event.status,
        mirroredTimestampMs,
        timestampIsApproximate,
        redactSensitiveText(preview).length > this.context.runtimeConfig.ui.commandPreviewMaxLength,
        sessionCursor,
        effectiveTurnId,
        effectiveTurnCursor,
        this.deps.buildSessionEventDevDetail(
          event.threadId,
          itemId,
          "command",
          mirroredTimestampMs,
          sessionCursor,
          effectiveTurnId,
          event.status,
          event
        )
      );
    }
    if (sessionCursor && canMirror) {
      this.deps.rememberThreadMirrorCursor(
        event.threadId,
        mirroredTimestampMs,
        sessionCursor,
        effectiveTurnCursor,
        this.deps.extractSessionSourceFrontier(event)
      );
    }
    if (canMirror) {
      try {
        await this.deps.enforceTurnRetention(event.threadId);
      } catch (error) {
        this.context.logger.warn({ error, threadId: event.threadId }, "Failed to enforce mirrored turn retention.");
      }
    }

    const approval = this.context.stateStore.findPendingApprovalByItem(
      event.threadId,
      event.callId,
      "commandExecution"
    );
    if (!approval) {
      return;
    }

    const previousStatus = approval.status;
    const shouldAutoApproveFromShellCompletion = previousStatus === "pending";
    if (
      shouldAutoApproveFromShellCompletion &&
      isPendingReadOnlySessionLogApprovalPlaceholder(approval)
    ) {
      this.context.stateStore.setPendingApprovalStatus(approval.token, "approved");
    }
    const bridge = this.context.stateStore.getThreadBridge(event.threadId);
    if (bridge && approval.discordMessageId && shouldAutoApproveFromShellCompletion) {
      await this.context.provider.disableApprovalCard(
        bridge.discordChannelId,
        approval.discordMessageId,
        "✅ Approved in Codex",
        this.deps.buildApprovalCardView(approval)
      );
    }
  }

  private async handleLocalSessionUserMessage(
    event: Extract<CodexSessionEvent, { type: "sessionUserMessage" }>
  ): Promise<void> {
    if (this.shouldSuppressReplayedParentAnchorTurn(event.threadId, event.turnId ?? null)) {
      return;
    }
    if (this.deps.shouldSuppressSyntheticSessionUserEvent(event.threadId, event)) {
      if (event.turnId) {
        this.deps.rememberSuppressedSyntheticSessionTurn(event.threadId, event.turnId);
      }
      return;
    }

    const text = event.text.trim();
    if (!text) {
      return;
    }
    const envelope = parseUserEnvelope(text);
    if (envelope?.kind === "subagentNotification") {
      this.deps.appendCanonicalEvent({
        threadId: event.threadId,
        source: "session",
        eventKind: "content",
        itemKind: "subagentNotification",
        turnId: event.turnId,
        turnCursor: this.deps.buildSessionTurnCursor(event.turnId),
        itemId: envelope.childThreadId,
        summary: `Ignored advisory subagent notification for ${envelope.childThreadId}.`,
        detail: "Session subagent notification envelopes do not create child ownership. Anchored session spawn events do."
      });
      return;
    }
    const mirroredTimestampMs = event.timestampMs ?? Date.now();
    const timestampIsApproximate = event.timestampMs === null;

    const state = await this.deps.ensureThreadStateForRequest(event.threadId, text);
    markThreadTurnInProgress(state, event.turnId ?? state.lastTurnId);
    this.deps.updateStateLastActivityAt(state, mirroredTimestampMs);
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(state.threadId);

    const turnCursor = this.deps.buildSessionTurnCursor(event.turnId);
    const itemId = this.deps.buildSessionEventItemId(
      envelope?.kind === "turnAborted" ? "turn-aborted" : "user",
      event.turnId ?? shortThreadId(event.threadId),
      event.eventKey ?? null,
      event.sourceOrder ?? null
    );
    const cursor =
      this.deps.buildSessionEventCursor(event.sourceOrder ?? null, event.eventKey ?? null) ??
      this.deps.buildMirrorCursor(event.timestampMs, itemId, event.streamOrder);
    this.deps.appendCanonicalEvent({
      threadId: event.threadId,
      source: "session",
      eventKind: "content",
      itemKind: envelope?.kind === "turnAborted" ? "agentAnswer" : "user",
      turnId: event.turnId,
      turnCursor,
      itemId,
      summary: truncateForDiscord(text, 120),
      detail: envelope?.kind === "turnAborted" ? "turnAborted" : null,
      createdAt:
        mirroredTimestampMs !== null ? new Date(mirroredTimestampMs).toISOString() : new Date().toISOString()
    });
    if (envelope?.kind !== "turnAborted" && state.channelKind === "conversation") {
      this.deps.rememberRetainedTurn({
        threadId: event.threadId,
        turnId: event.turnId,
        turnCursor,
        anchorItemId: itemId,
        anchorText: text,
        source: "session"
      });
    }
    if (!this.deps.shouldMirrorLiveCursor(event.threadId, cursor)) {
      if (envelope?.kind === "turnAborted") {
        await this.completeSessionTurn(state, "aborted", event.turnId);
      }
      return;
    }

    if (envelope?.kind === "turnAborted") {
      const finalText = envelope.message.trim() || "**Turn Aborted**";
      state.latestAgentMessage = truncateForDiscord(finalText, 500);
      this.deps.persistThreadState(state);
      await this.deps.publishCompletedAgentMessage(
        event.threadId,
        itemId,
        finalText,
        "final_answer",
        mirroredTimestampMs,
        timestampIsApproximate,
        cursor,
        event.turnId,
        turnCursor,
        this.deps.buildSessionEventDevDetail(
          event.threadId,
          itemId,
          "agentAnswer",
          mirroredTimestampMs,
          cursor,
          event.turnId,
          null,
          event
        )
      );
      await this.completeSessionTurn(state, "aborted", event.turnId);
    } else {
      await this.deps.publishCompletedUserMessage(
        event.threadId,
        itemId,
        text,
        mirroredTimestampMs,
        timestampIsApproximate,
        cursor,
        event.turnId,
        turnCursor,
        this.deps.buildSessionEventDevDetail(
          event.threadId,
          itemId,
          "user",
          mirroredTimestampMs,
          cursor,
          event.turnId,
          null,
          event
        )
      );
    }
    if (cursor) {
      this.deps.rememberThreadMirrorCursor(
        event.threadId,
        mirroredTimestampMs,
        cursor,
        turnCursor,
        this.deps.extractSessionSourceFrontier(event)
      );
    }
    await this.deps.enforceTurnRetention(event.threadId);
  }

  private async handleLocalSessionAgentMessage(
    event: Extract<CodexSessionEvent, { type: "sessionAgentMessage" }>
  ): Promise<void> {
    if (this.shouldSuppressReplayedParentAnchorTurn(event.threadId, event.turnId ?? null)) {
      return;
    }
    if (this.deps.shouldSuppressSyntheticSessionTurn(event.threadId, event.turnId ?? null)) {
      return;
    }
    const text = event.text.trim();
    if (!text) {
      return;
    }
    const mirroredTimestampMs = event.timestampMs ?? Date.now();
    const timestampIsApproximate = event.timestampMs === null;

    const state = await this.deps.ensureThreadStateForRequest(event.threadId, text);
    markThreadTurnInProgress(state, event.turnId ?? state.lastTurnId);
    state.latestAgentMessage = truncateForDiscord(text, 500);
    this.deps.updateStateLastActivityAt(state, mirroredTimestampMs);
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(state.threadId);

    const kind = this.deps.isCommentaryPhase(event.phase) ? "agentCommentary" : "agentAnswer";
    const itemId = this.deps.buildSessionEventItemId(
      "agent",
      event.turnId ?? shortThreadId(event.threadId),
      event.eventKey ?? null,
      event.sourceOrder ?? null
    );
    const cursor =
      this.deps.buildSessionEventCursor(event.sourceOrder ?? null, event.eventKey ?? null) ??
      this.deps.buildMirrorCursor(event.timestampMs, itemId, event.streamOrder);
    const turnCursor = this.deps.buildSessionTurnCursor(event.turnId);
    this.deps.appendCanonicalEvent({
      threadId: event.threadId,
      source: "session",
      eventKind: "content",
      itemKind: kind,
      turnId: event.turnId,
      turnCursor,
      itemId,
      summary: truncateForDiscord(text, 120),
      detail: event.phase,
      createdAt:
        mirroredTimestampMs !== null ? new Date(mirroredTimestampMs).toISOString() : new Date().toISOString()
    });
    if (!this.deps.shouldMirrorLiveCursor(event.threadId, cursor)) {
      if (kind === "agentAnswer") {
        await this.completeSessionTurn(state, "completed", event.turnId);
      }
      return;
    }
    const shouldHoldForTurnAnchor =
      kind === "agentCommentary" &&
      this.deps.shouldHoldNonUserActivityUntilTurnAnchor(
        event.threadId,
        event.turnId,
        turnCursor,
        cursor
      );
    const canMirror = !shouldHoldForTurnAnchor && this.deps.canMirrorNonUserActivity(event.threadId, event.turnId, turnCursor);
    if (canMirror) {
      if (kind === "agentCommentary") {
        await this.deps.publishCommentaryAgentMessage(
          event.threadId,
          itemId,
          text,
          event.phase,
          mirroredTimestampMs,
          timestampIsApproximate,
          cursor,
          event.turnId,
          turnCursor,
          this.deps.buildSessionEventDevDetail(
            event.threadId,
            itemId,
            "agentCommentary",
            mirroredTimestampMs,
            cursor,
            event.turnId,
            null,
            event
          )
        );
      } else {
        await this.deps.publishCompletedAgentMessage(
          event.threadId,
          itemId,
          text,
          event.phase,
          mirroredTimestampMs,
          timestampIsApproximate,
          cursor,
          event.turnId,
          turnCursor,
          this.deps.buildSessionEventDevDetail(
            event.threadId,
            itemId,
            "agentAnswer",
            mirroredTimestampMs,
            cursor,
            event.turnId,
            null,
            event
          )
        );
      }
    }

    if (cursor && canMirror) {
      this.deps.rememberThreadMirrorCursor(
        event.threadId,
        mirroredTimestampMs,
        cursor,
        turnCursor,
        this.deps.extractSessionSourceFrontier(event)
      );
    }
    if (canMirror) {
      await this.deps.enforceTurnRetention(event.threadId);
    }
    if (kind === "agentAnswer") {
      await this.completeSessionTurn(state, "completed", event.turnId);
    }
  }

  private async completeSessionTurn(state: ThreadRuntimeState, status: string, exactTurnId: string | null): Promise<void> {
    markThreadTurnCompleted(state, status);
    if (exactTurnId) await this.deps.finishDiscordInputTurn(state.threadId, exactTurnId);
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(state.threadId);
    await this.deps.drainWriteBackQueue(state.threadId);
  }

  private async handleLocalSessionApplyPatchCompleted(
    event: Extract<CodexSessionEvent, { type: "sessionApplyPatchCompleted" }>
  ): Promise<void> {
    if (this.shouldSuppressReplayedParentAnchorTurn(event.threadId, event.turnId ?? null)) {
      return;
    }
    if (this.deps.shouldSuppressSyntheticSessionTurn(event.threadId, event.turnId ?? null)) {
      return;
    }
    const summary = event.summary.trim();
    if (!summary) {
      return;
    }
    const mirroredTimestampMs = event.timestampMs ?? Date.now();
    const timestampIsApproximate = event.timestampMs === null;

    const state = await this.deps.ensureThreadStateForRequest(event.threadId, "apply_patch");
    markThreadTurnInProgress(state, event.turnId ?? state.lastTurnId);
    this.deps.updateStateLastActivityAt(state, mirroredTimestampMs);
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(state.threadId);

    const itemId = this.deps.buildSessionEventItemId(
      "apply-patch",
      event.callId,
      event.eventKey ?? null,
      event.sourceOrder ?? null
    );
    const cursor =
      this.deps.buildSessionEventCursor(event.sourceOrder ?? null, event.eventKey ?? null) ??
      this.deps.buildMirrorCursor(event.timestampMs, itemId, event.streamOrder);
    const turnCursor = this.deps.buildSessionTurnCursor(event.turnId);
    this.deps.appendCanonicalEvent({
      threadId: event.threadId,
      source: "session",
      eventKind: "content",
      itemKind: "fileChange",
      turnId: event.turnId,
      turnCursor,
      itemId,
      summary: truncateForDiscord(summary, 120),
      createdAt:
        mirroredTimestampMs !== null ? new Date(mirroredTimestampMs).toISOString() : new Date().toISOString()
    });
    if (!this.deps.shouldMirrorLiveCursor(event.threadId, cursor)) {
      return;
    }
    const canMirror = this.deps.canMirrorNonUserActivity(event.threadId, event.turnId, turnCursor);
    if (canMirror) {
      await this.deps.publishCompletedFileChangeMessage(
        event.threadId,
        itemId,
        summary,
        null,
        mirroredTimestampMs,
        timestampIsApproximate,
        cursor,
        event.turnId,
        turnCursor,
        this.deps.buildSessionEventDevDetail(
          event.threadId,
          itemId,
          "fileChange",
          mirroredTimestampMs,
          cursor,
          event.turnId,
          null,
          event
        ),
        event.fileCounts
      );
    }
    if (cursor) {
      this.deps.rememberThreadMirrorCursor(
        event.threadId,
        mirroredTimestampMs,
        cursor,
        turnCursor,
        this.deps.extractSessionSourceFrontier(event)
      );
    }
    if (canMirror) {
      await this.deps.enforceTurnRetention(event.threadId);
    }
  }

  private async handleLocalSessionSubagentSpawned(event: SessionSubagentSpawnedEvent): Promise<void> {
    const parentThreadId = event.threadId;
    const childThreadId = event.childThreadId;
    const parentAnchorTurnCursor = this.deps.buildSessionTurnCursor(event.turnId);
    if (!childThreadId || childThreadId === parentThreadId) {
      return;
    }

    this.deps.rememberChildThreadParent(childThreadId, parentThreadId);
    this.runtime.childThreadAnchorHints.set(childThreadId, {
      parentThreadId,
      parentAnchorTurnId: event.turnId,
      parentAnchorTurnCursor
    });
    this.deps.upsertChildThreadAnchor({
      childThreadId,
      parentThreadId,
      parentTurnId: event.turnId,
      parentTurnCursor: parentAnchorTurnCursor,
      source: "session"
    });
    this.deps.appendCanonicalEvent({
      threadId: childThreadId,
      source: "session",
      eventKind: "childAnchor",
      itemKind: "subagentSpawn",
      turnId: event.turnId,
      turnCursor: parentAnchorTurnCursor,
      itemId: childThreadId,
      summary: `Anchored child ${childThreadId} to parent ${parentThreadId}.`,
      detail: event.prompt ?? event.childAgentName ?? null,
      createdAt:
        event.timestampMs !== null ? new Date(event.timestampMs).toISOString() : new Date().toISOString()
    });
    if (this.shouldEagerlyAttachSessionSubagent(event)) {
      this.queueAnchoredSessionSubagentAttachment({
        parentThreadId,
        childThreadId,
        parentAnchorTurnId: event.turnId,
        parentAnchorTurnCursor,
        prompt: event.prompt ?? null,
        actorNameHint: event.childAgentName ?? null,
        failureMessage: "Failed to resume session-anchored sub-agent thread."
      });
    }
    this.deps.queueThreadSessionPollHint(childThreadId);
  }

  private shouldEagerlyAttachSessionSubagent(event: SessionSubagentSpawnedEvent): boolean {
    if (event.timestampMs === null) {
      return false;
    }
    return event.timestampMs + LIVE_SUBAGENT_SPAWN_EAGER_ATTACH_GRACE_MS >= this.runtime.bridgeStartedAtMs;
  }

  private queueAnchoredSessionSubagentAttachment(input: {
    parentThreadId: string;
    childThreadId: string;
    parentAnchorTurnId: string | null;
    parentAnchorTurnCursor: string | null;
    prompt?: string | null;
    actorNameHint?: string | null;
    statusText?: string | null;
    failureMessage: string;
  }): void {
    const {
      parentThreadId,
      childThreadId,
      parentAnchorTurnId,
      parentAnchorTurnCursor,
      prompt,
      actorNameHint,
      statusText,
      failureMessage
    } = input;
    void this.deps.enqueueThreadEvent(childThreadId, async () => {
      if (this.context.stateStore.getThreadBridge(childThreadId)) {
        return;
      }
      const prepared = await prepareSubagentAttachment(this.context, this.runtime, this.deps, {
        parentThreadId,
        childThreadId,
        prompt: prompt ?? null,
        actorNameHint: actorNameHint ?? null
      });
      await attachPreparedSubagentThread(this.context, this.runtime, this.deps, {
        childThreadId,
        prepared,
        parentAnchorTurnId,
        parentAnchorTurnCursor,
        statusText: statusText ?? null,
        failureMessage
      });
    }).catch((error) => {
      this.context.logger.debug(
        { error, parentThreadId, childThreadId },
        "Failed to queue a session-anchored sub-agent attachment."
      );
    });
  }

  private shouldSuppressReplayedParentAnchorTurn(
    threadId: string,
    turnId: string | null | undefined
  ): boolean {
    const normalizedTurnId = turnId?.trim().toLowerCase() ?? "";
    if (!normalizedTurnId) {
      return false;
    }

    const state = this.runtime.threadState.get(threadId);
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const pendingAnchor = this.runtime.childThreadAnchorHints.get(threadId) ?? null;
    const storedAnchor = this.deps.resolveStoredChildThreadAnchor(threadId);
    const channelKind =
      state?.channelKind ??
      bridge?.channelKind ??
      (pendingAnchor || storedAnchor ? "subagent" : "conversation");
    if (channelKind !== "subagent") {
      return false;
    }

    const anchorTurnId =
      bridge?.parentAnchorTurnId?.trim().toLowerCase() ??
      storedAnchor?.parentTurnId?.trim().toLowerCase() ??
      pendingAnchor?.parentAnchorTurnId?.trim().toLowerCase() ??
      "";
    return Boolean(anchorTurnId && normalizedTurnId === anchorTurnId);
  }
}
