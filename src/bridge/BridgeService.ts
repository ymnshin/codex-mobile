import type {
  ApprovalDecision,
  CodexServerRequest,
  CodexThreadSummary,
  DiscordCommandResult,
  ProjectBridgeRecord,
  ThreadRuntimeState
} from "../domain.js";
import { createBridgeConfigFromPreset, type BridgeRuntimeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { CodexAdapter } from "../codex/CodexAdapter.js";
import type { CodexDesktopIpcClient } from "../codex/CodexDesktopIpcClient.js";
import type {
  CodexSessionEventTailer,
  CodexSessionEvent
} from "../codex/CodexSessionEventTailer.js";
import type { Policy } from "../policy/Policy.js";
import type {
  BridgeProvider,
  ProviderActorContext
} from "../providers/types.js";
import type { StateStore } from "../store/StateStore.js";
import {
  createBridgeCoordinatorGraph,
  type BridgeCoordinatorGraph
} from "./BridgeCoordinatorGraph.js";
import {
  deserializeStatus as deserializeThreadStatus
} from "./statusCards.js";
import {
  MAX_CONVERSATION_CHANNELS_PER_CATEGORY,
  type BridgeRuntimeContext
} from "./runtime/BridgeRuntimeContext.js";
import {
  BridgeRuntimeState,
  type BridgeCleanOptions,
  type BridgeStartOptions,
  type CleanProgressReporter,
  type DiscoveryCandidate,
  type HydratedThreadResult,
  type HydrateThreadOptions
} from "./runtime/BridgeRuntimeState.js";

interface BridgeServiceOptions {
  codexAdapter: CodexAdapter;
  provider: BridgeProvider;
  stateStore: StateStore;
  policy: Policy;
  logger: Logger;
  discoveryPollSeconds: number;
  sourceKinds: string[];
  runtimeConfig?: BridgeRuntimeConfig;
  sessionEventTailer?: CodexSessionEventTailer;
  desktopIpcClient?: CodexDesktopIpcClient;
}

interface ResolvedBridgeServiceOptions
  extends Omit<BridgeServiceOptions, "runtimeConfig" | "sessionEventTailer"> {
  runtimeConfig: BridgeRuntimeConfig;
  sessionEventTailer: CodexSessionEventTailer;
}

const NOOP_SESSION_EVENT_TAILER = {
  async pollThread() {
    return [];
  },
  async pollDesktop() {
    return [];
  },
  async fastForwardThread() {
    return false;
  },
  async fastForwardDesktop() {
    return 0;
  },
  async listRecentCliThreads() {
    return [];
  },
  async listRecentLocalThreads() {
    return [];
  },
  async readLatestTurnBackfillEvents() {
    return [];
  },
  async readRecentTurnBackfillEvents() {
    return [];
  },
  async readBackfillEventsSince() {
    return [];
  },
  async captureThreadFrontier() {
    return null;
  },
  async markThreadFrontier() {
    return false;
  },
  async replayThreadFromFrontier() {
    return [];
  },
  rememberTurnHint() {
    return;
  },
  async resolveParentThreadId() {
    return null;
  }
} as unknown as CodexSessionEventTailer;

const BRIDGE_STARTUP_READY_META_KEY = "bridge_startup_ready_at";

export class BridgeService {
  private readonly options: ResolvedBridgeServiceOptions;
  private readonly runtime: BridgeRuntimeState;
  private stopping = false;
  private readonly coordinators: BridgeCoordinatorGraph;
  private sessionPollTimer: NodeJS.Timeout | null = null;
  private sessionPollPromise: Promise<void> | null = null;
  private queueWatchdogTimer: NodeJS.Timeout | null = null;
  private queueWatchdogPromise: Promise<void> | null = null;

  constructor(options: BridgeServiceOptions) {
    this.options = {
      ...options,
      sessionEventTailer: options.sessionEventTailer ?? NOOP_SESSION_EVENT_TAILER,
      runtimeConfig:
        options.runtimeConfig ??
        createBridgeConfigFromPreset("basic", {
          allowFromDiscord: false,
          allowedUserIds: []
        })
    };
    this.runtime = new BridgeRuntimeState(Boolean(options.sessionEventTailer));
    const runtimeContext = this.options as unknown as BridgeRuntimeContext;
    this.coordinators = createBridgeCoordinatorGraph(runtimeContext, this.runtime, {
      deleteMappedThread: (threadId, reason) => this.deleteMappedThread(threadId, reason),
      drainThreadEventQueue: (threadIds) => this.drainThreadEventQueue(threadIds),
      enforceConversationChannelLimit: (projectBridge, projectKey, threadId) =>
        this.enforceConversationChannelLimit(projectBridge, projectKey, threadId),
      enqueueThreadEvent: (threadId, work) => this.enqueueThreadEvent(threadId, work),
      flushStatusUpdate: (threadId) => this.flushStatusUpdate(threadId),
      isUnknownDiscordChannelError: (error) => this.isUnknownDiscordChannelError(error),
      persistThreadState: (state) => this.persistThreadState(state),
      queueMessageSync: (threadId) => this.queueMessageSync(threadId),
      queueStatusUpdate: (threadId) => this.queueStatusUpdate(threadId),
      readLatestTurnBackfillTurnId: (threadId) => this.readLatestTurnBackfillTurnId(threadId),
      shouldStop: () => this.stopping,
      stopPolling: () => this.stopPolling()
    });
    this.coordinators.mirrorStateCoordinator.traceMirror("bridge.startup", {
      runtimeConfig: {
        preset: this.options.runtimeConfig.preset,
        diagnostics: this.options.runtimeConfig.diagnostics
      }
    });
    this.options.codexAdapter.on("notification", (notification) => {
      void this.coordinators.notificationRouter.handleNotification(notification);
    });
    this.options.codexAdapter.on("serverRequest", (request) => {
      void this.handleServerRequest(request);
    });
    this.options.codexAdapter.on("exited", () => {
      // The queue watchdog stays alive and reconnects via the read-only health gate.
      this.options.logger.warn({ category: "connection" }, "App-server disconnected; queued input remains durable.");
    });
    this.options.desktopIpcClient?.on("requestUpserted", (snapshot) => {
      void this.coordinators.approvalCoordinator.handleDesktopIpcRequestUpserted(snapshot);
    });
    this.options.desktopIpcClient?.on("requestRemoved", (snapshot) => {
      void this.coordinators.approvalCoordinator.handleDesktopIpcRequestRemoved(snapshot);
    });
  }

  async start(startOptions: BridgeStartOptions = {}): Promise<void> {
    this.stopping = false;
    this.runtime.isColdStart = this.options.stateStore.listThreadBridges().length === 0;
    const isLocalStoreProvider = this.options.provider.constructor.name === "LocalStoreProvider";
    const providerLabel = isLocalStoreProvider ? "local store provider" : "Discord bot connection";
    this.coordinators.mirrorStateCoordinator.printProgress(`Starting ${providerLabel}...`);
    await this.options.provider.start({
      onStatusCommand: async (actor) => this.coordinators.providerCommandCoordinator.handleStatusCommand(actor),
      onRetryCommand: async (actor, channelId) => this.coordinators.providerCommandCoordinator.handleRetryCommand(actor, channelId),
      onSendCommand: async (actor, channelId, text, mode, sourceDiscordMessageId) =>
        this.coordinators.providerCommandCoordinator.handleSendCommand(actor, channelId, text, mode, sourceDiscordMessageId),
      onRetractCommand: async (actor, channelId) =>
        this.coordinators.providerCommandCoordinator.handleRetractCommand(actor, channelId),
      onWriteBackButton: async (actor, action, queueItemId) =>
        this.coordinators.providerCommandCoordinator.handleWriteBackButton(actor, action, queueItemId),
      onAttachCommand: async (actor, threadId) => this.coordinators.providerCommandCoordinator.handleAttachCommand(actor, threadId),
      onDetachCommand: async (actor, threadId) => this.coordinators.providerCommandCoordinator.handleDetachCommand(actor, threadId),
      onCleanIdCommand: async (actor, threadId) => this.coordinators.providerCommandCoordinator.handleCleanIdCommand(actor, threadId),
      onCleanAllCommand: async (actor) => this.coordinators.providerCommandCoordinator.handleCleanAllCommand(actor),
      onHelpCommand: async (actor) => this.coordinators.providerCommandCoordinator.handleHelpCommand(actor),
      onApprovalDetails: async (actor, token) => this.handleApprovalDetails(actor, token),
      onApprovalAction: async (actor, token, decision) =>
        this.handleApprovalAction(actor, token, decision),
      onToolInputOption: async (actor, token, questionIndex, optionIndex) =>
        this.handleToolInputOption(actor, token, questionIndex, optionIndex),
      onToolInputOther: async (actor, token, questionIndex, answer) =>
        this.handleToolInputOther(actor, token, questionIndex, answer),
      onApprovalFeedback: async (actor, token, feedback) =>
        this.handleApprovalFeedback(actor, token, feedback),
      onMessageDetails: async (actor, token) => this.handleMessageDetails(actor, token),
      onProposedPlanAction: async (actor, token, action) =>
        this.coordinators.providerCommandCoordinator.handleProposedPlanAction(actor, token, action),
      onProposedPlanFeedback: async (actor, token, feedback) =>
        this.coordinators.providerCommandCoordinator.handleProposedPlanFeedback(actor, token, feedback)
    });
    this.coordinators.mirrorStateCoordinator.printProgress(
      isLocalStoreProvider ? "Local store provider ready." : "Discord bot connected."
    );
    if (startOptions.providerOnly) {
      return;
    }
    this.coordinators.mirrorStateCoordinator.printProgress("Starting Codex app-server...");
    await this.options.codexAdapter.start();
    this.coordinators.mirrorStateCoordinator.printProgress("Codex app-server connected.");
    if (this.options.desktopIpcClient) {
      this.coordinators.mirrorStateCoordinator.printProgress("Connecting to Codex Desktop IPC...");
      try {
        await this.options.desktopIpcClient.start();
        this.coordinators.mirrorStateCoordinator.printProgress("Codex Desktop IPC connected.");
      } catch (error) {
        this.options.logger.warn({ error }, "Codex Desktop IPC is unavailable. Desktop approvals will stay local.");
        const detail = error instanceof Error ? error.message : "Desktop approvals will stay local.";
        this.coordinators.mirrorStateCoordinator.printProgress(`Codex Desktop IPC is unavailable. ${detail}`);
      }
    }
    if (!startOptions.skipRehydrate) {
      await this.rehydrateState();
      if (!this.runtime.isColdStart && !startOptions.skipStartupLogFastForward) {
        await this.fastForwardExistingLocalLogs();
      }
    }
    if (!startOptions.skipDiscovery) {
      this.coordinators.mirrorStateCoordinator.printProgress(
        this.runtime.isColdStart
          ? "Cold start detected. Initial import is limited to 25 threads active in the last 12 hours."
          : "Bridge state found. The bridge will refresh mapped threads first, then continue discovery polling."
      );
      await this.refreshMappedThreadsOnStartup();
      await this.runDiscoveryCycle(true);
      this.runtime.discoveryTimer = setInterval(() => void this.runDiscoveryCycle(false), this.options.discoveryPollSeconds * 1000);
      this.coordinators.mirrorStateCoordinator.printProgress(
        `Discovery polling scheduled every ${this.options.discoveryPollSeconds} seconds.`
      );
    }
    this.startSessionPolling();
    this.queueWatchdogTimer = setInterval(() => {
      if (this.stopping || this.queueWatchdogPromise) return;
      this.queueWatchdogPromise = this.coordinators.providerCommandCoordinator.runQueueWatchdog()
        .catch(() => this.options.logger.warn({ category: "queue_watchdog" }, "Queue watchdog could not finish; will recheck."))
        .finally(() => { this.queueWatchdogPromise = null; });
    }, 10_000);
    this.queueWatchdogTimer.unref();
    this.options.stateStore.setBridgeMetaValue(BRIDGE_STARTUP_READY_META_KEY, new Date().toISOString());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopPolling();
    await this.options.desktopIpcClient?.stop();
    await this.options.codexAdapter.stop();
    for (const timer of this.runtime.statusUpdateTimers.values()) {
      clearTimeout(timer);
    }
    this.runtime.statusUpdateTimers.clear();
    for (const timer of this.runtime.messageSyncTimers.values()) {
      clearTimeout(timer);
    }
    this.runtime.messageSyncTimers.clear();

    await this.waitForRuntimeQuiescence(5_000);

    this.runtime.clearTransientState();
    await this.options.provider.stop();
    this.options.stateStore.close();
  }

  async cleanBridgeState(
    progressReporter?: CleanProgressReporter,
    options: BridgeCleanOptions = {}
  ): Promise<{ deletedCategories: number; deletedLocations: number }> {
    return this.coordinators.cleanupCoordinator.resetDiscordBridgeState(progressReporter, options);
  }

  private stopPolling(): void {
    if (this.queueWatchdogTimer) { clearInterval(this.queueWatchdogTimer); this.queueWatchdogTimer = null; }
    if (this.runtime.discoveryTimer) {
      clearInterval(this.runtime.discoveryTimer);
      this.runtime.discoveryTimer = null;
    }
    if (this.sessionPollTimer) {
      clearInterval(this.sessionPollTimer);
      this.sessionPollTimer = null;
    }
  }

  private startSessionPolling(): void {
    if (!this.runtime.sessionEventTailerEnabled || this.sessionPollTimer) {
      return;
    }

    this.sessionPollTimer = setInterval(
      () => void this.runSessionPollCycle(),
      this.options.discoveryPollSeconds * 1000
    );
  }

  private runSessionPollCycle(): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }
    if (this.sessionPollPromise) {
      return this.sessionPollPromise;
    }

    const poll = (async () => {
      const affectedThreadIds = await this.coordinators.sessionEventCoordinator.pollLocalSessionEvents();
      for (const threadId of await this.coordinators.sessionEventCoordinator.pollDesktopApprovalEvents()) {
        affectedThreadIds.add(threadId);
      }
      if (affectedThreadIds.size > 0) {
        await this.drainThreadEventQueue(affectedThreadIds);
      }
    })()
      .catch((error) => {
        this.options.logger.debug({ error }, "Periodic session event poll failed.");
      })
      .finally(() => {
        if (this.sessionPollPromise === poll) {
          this.sessionPollPromise = null;
        }
      });
    this.sessionPollPromise = poll;
    return poll;
  }

  private collectPendingRuntimePromises(): Promise<void>[] {
    const pending = [
      this.runtime.discoveryCyclePromise,
      this.sessionPollPromise,
      this.queueWatchdogPromise,
      ...this.runtime.statusUpdateChains.values(),
      ...this.runtime.messageSyncChains.values(),
      ...this.runtime.threadEventChains.values(),
      ...[...this.runtime.projectBridgePromises.values()].map((promise) => promise.then(() => undefined)),
      ...[...this.runtime.threadHydrationPromises.values()].map((promise) => promise.then(() => undefined)),
      this.runtime.mirrorTraceWriteChain
    ].filter((promise): promise is Promise<void> => Boolean(promise));
    return [...new Set(pending)];
  }

  private async waitForRuntimeQuiescence(timeoutMs: number): Promise<void> {
    const pendingWork = this.collectPendingRuntimePromises();
    if (pendingWork.length === 0) {
      return;
    }
    const boundedTimeoutMs = Math.max(0, timeoutMs);
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      const didTimeout = await Promise.race([
        Promise.allSettled(pendingWork).then(() => false),
        new Promise<boolean>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(true), boundedTimeoutMs);
        })
      ]);
      if (!didTimeout) {
        return;
      }
      this.options.logger.debug(
        {
          pendingDiscovery: Boolean(this.runtime.discoveryCyclePromise),
          pendingStatusUpdates: this.runtime.statusUpdateChains.size,
          pendingMessageSyncs: this.runtime.messageSyncChains.size,
          pendingThreadEvents: this.runtime.threadEventChains.size,
          pendingProjectBridges: this.runtime.projectBridgePromises.size
        },
        "Bridge stop timed out while waiting for runtime work to settle."
      );
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async rehydrateState(): Promise<void> {
    const threadBridges = this.options.stateStore.listThreadBridges();
    const pendingApprovals = this.options.stateStore.listPendingApprovals();
    const actionableApprovals = pendingApprovals.filter(
      (approval) => approval.status === "pending" || approval.status === "decisionSent"
    );
    const historicalApprovalCount = pendingApprovals.length - actionableApprovals.length;
    this.coordinators.mirrorStateCoordinator.printProgress(
      `Rehydrating ${threadBridges.length} saved Discord mapping(s), ${actionableApprovals.length} active approval(s), and ${historicalApprovalCount} historical approval record(s).`
    );
    for (const record of threadBridges) {
      if (record.latestMirroredCursor) {
        this.runtime.latestMirroredCursorByThread.set(record.codexThreadId, record.latestMirroredCursor);
      }
      if (record.latestMirroredTurnCursor) {
        this.runtime.latestMirroredTurnCursorByThread.set(record.codexThreadId, record.latestMirroredTurnCursor);
      }
      if (record.latestMirroredTimestampMs !== null && record.latestMirroredTimestampMs !== undefined) {
        this.runtime.latestMirroredTimestampMsByThread.set(record.codexThreadId, record.latestMirroredTimestampMs);
      }
      if (
        record.latestMirroredSourceFilePath &&
        typeof record.latestMirroredSourceOffset === "number" &&
        record.latestMirroredSourceEventKey
      ) {
        this.runtime.latestSourceFrontierByThread.set(record.codexThreadId, {
          filePath: record.latestMirroredSourceFilePath,
          offset: record.latestMirroredSourceOffset,
          eventKey: record.latestMirroredSourceEventKey
        });
      }
      this.runtime.threadState.set(record.codexThreadId, {
        threadId: record.codexThreadId,
        parentThreadId: record.parentCodexThreadId,
        projectKey: record.projectKey,
        projectName: record.projectName,
        channelKind: record.channelKind,
        sourceKind: record.sourceKind ?? "app-server",
        name: record.threadName,
        actorName: record.actorName ?? null,
        preview: null,
        cwd: record.cwd,
        repoName: record.repoName,
        status: deserializeThreadStatus(record.lastStatusType),
        lastActivityAt: record.lastSeenAt ? new Date(record.lastSeenAt).getTime() : null,
        latestCommandPreview: null,
        latestAgentMessage: null,
        lastTurnId: record.lastTurnId ?? null,
        lastTurnStatus: record.lastTurnStatus ?? null
      });
      this.runtime.resolvedMetadataByThread.set(record.codexThreadId, {
        cwd: record.cwd ?? null,
        repoName: record.repoName ?? null,
        threadName: record.threadName ?? null,
        actorName: record.actorName ?? null,
        parentThreadId: record.parentCodexThreadId ?? null,
        sourceSubagentOther: null
      });
    }
    for (const approval of pendingApprovals) {
      if (approval.status !== "pending" && approval.status !== "decisionSent") {
        continue;
      }
      const restartDisabledAt = new Date().toISOString();
      this.options.stateStore.setPendingApprovalRestartDisabled(approval.token, restartDisabledAt);
      const bridge = this.options.stateStore.getThreadBridge(approval.threadId);
      if (bridge && approval.discordMessageId) {
        try {
          await this.options.provider.markApprovalCardStale(
            bridge.discordChannelId,
            approval.discordMessageId,
            this.coordinators.approvalCoordinator.buildApprovalCardView({
              ...approval,
              restartDisabledAt
            })
          );
        } catch (error) {
          this.options.logger.warn({ error, approval }, "Failed to mark stale approval message.");
        }
      }
    }
  }

  private async fastForwardExistingLocalLogs(): Promise<void> {
    await this.coordinators.discoveryCoordinator.fastForwardExistingLocalLogs();
  }

  private async refreshMappedThreadsOnStartup(): Promise<void> {
    await this.coordinators.discoveryCoordinator.refreshMappedThreadsOnStartup();
  }

  private async runDiscoveryCycle(isStartup: boolean): Promise<void> {
    if (this.stopping) {
      return;
    }
    await this.coordinators.discoveryCoordinator.runDiscoveryCycle(isStartup);
  }

  private async drainThreadEventQueue(threadIds?: Iterable<string>): Promise<void> {
    const scopedThreadIds = threadIds ? [...new Set(threadIds)] : null;
    if (scopedThreadIds && scopedThreadIds.length === 0) {
      return;
    }

    for (;;) {
      const pending = scopedThreadIds
        ? scopedThreadIds
            .map((threadId) => this.runtime.threadEventChains.get(threadId))
            .filter((promise): promise is Promise<void> => Boolean(promise))
        : [...this.runtime.threadEventChains.values()];
      if (pending.length === 0) {
        return;
      }
      await Promise.allSettled(pending);
    }
  }

  private async enforceConversationChannelLimit(
    projectBridge: ProjectBridgeRecord,
    projectKey: string,
    incomingThreadId: string
  ): Promise<void> {
    let channelCount = await this.options.provider.countConversationChannelsInCategory(
      projectBridge.discordCategoryId
    );

    while (channelCount >= MAX_CONVERSATION_CHANNELS_PER_CATEGORY) {
      const oldest = this.options.stateStore
        .listThreadBridgesByKind("conversation")
        .filter(
          (bridge) =>
            bridge.projectKey === projectKey &&
            bridge.codexThreadId !== incomingThreadId
        )
        .sort(
          (left, right) =>
            new Date(left.lastSeenAt).getTime() - new Date(right.lastSeenAt).getTime()
        )[0];

      if (!oldest) {
        this.options.logger.warn(
          { projectKey, categoryId: projectBridge.discordCategoryId, channelCount },
          "Project category reached the conversation cap, but no mapped channel could be evicted."
        );
        break;
      }

      await this.deleteMappedThread(
        oldest.codexThreadId,
        `Cap Codex project categories at ${MAX_CONVERSATION_CHANNELS_PER_CATEGORY} conversation channels`
      );
      channelCount = await this.options.provider.countConversationChannelsInCategory(
        projectBridge.discordCategoryId
      );
    }

    if (channelCount >= MAX_CONVERSATION_CHANNELS_PER_CATEGORY) {
      throw new Error(
        `Discord project category "${projectBridge.projectName}" already has ${channelCount} conversation channels. Run /codex clean confirm:true or remove some channels before bridging more conversations.`
      );
    }
  }

  private async enqueueThreadEvent(threadId: string, work: () => Promise<void>): Promise<void> {
    if (this.stopping) {
      return;
    }
    const previous = this.runtime.threadEventChains.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work);
    this.runtime.threadEventChains.set(threadId, next);
    try {
      await next;
    } finally {
      if (this.runtime.threadEventChains.get(threadId) === next) {
        this.runtime.threadEventChains.delete(threadId);
      }
    }
  }

  async handleServerRequest(request: CodexServerRequest): Promise<void> {
    await this.coordinators.approvalCoordinator.handleServerRequest(request);
  }

  async handleApprovalAction(
    actor: ProviderActorContext | string,
    token: string,
    decision: ApprovalDecision
  ): Promise<DiscordCommandResult> {
    return this.coordinators.approvalCoordinator.handleApprovalAction(actor, token, decision);
  }

  async handleToolInputOption(
    actor: ProviderActorContext | string,
    token: string,
    questionIndex: number,
    optionIndex: number
  ): Promise<DiscordCommandResult> {
    return this.coordinators.approvalCoordinator.handleToolInputOption(actor, token, questionIndex, optionIndex);
  }

  async handleToolInputOther(
    actor: ProviderActorContext | string,
    token: string,
    questionIndex: number,
    answer: string
  ): Promise<DiscordCommandResult> {
    return this.coordinators.approvalCoordinator.handleToolInputOther(actor, token, questionIndex, answer);
  }

  async handleApprovalFeedback(
    actor: ProviderActorContext | string,
    token: string,
    feedback: string
  ): Promise<DiscordCommandResult> {
    return this.coordinators.approvalCoordinator.handleApprovalFeedback(actor, token, feedback);
  }

  async handleApprovalDetails(actor: ProviderActorContext | string, token: string): Promise<DiscordCommandResult> {
    return this.coordinators.approvalCoordinator.handleApprovalDetails(actor, token);
  }

  async handleMessageDetails(actor: ProviderActorContext | string, token: string): Promise<DiscordCommandResult> {
    return this.coordinators.approvalCoordinator.handleMessageDetails(actor, token);
  }

  async steerActiveTurnInternally(text: string, threadId: string): Promise<DiscordCommandResult> {
    return this.coordinators.providerCommandCoordinator.steerActiveTurnInternally(text, threadId);
  }

  async readLatestTurnBackfillTurnId(threadId: string): Promise<string | null> {
    const events = await this.options.sessionEventTailer.readLatestTurnBackfillEvents(threadId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.turnId) {
        return event.turnId;
      }
    }
    return null;
  }

  // Test seams retained so integration tests can drive the refactored coordinators
  // through BridgeService without depending on coordinator internals directly.
  async handleSessionEvent(event: CodexSessionEvent): Promise<void> {
    await this.coordinators.sessionEventCoordinator.handleSessionEvent(event);
  }

  async pollLocalSessionEvents(): Promise<Set<string>> {
    return this.coordinators.sessionEventCoordinator.pollLocalSessionEvents();
  }

  async pollDesktopApprovalEvents(): Promise<Set<string>> {
    return this.coordinators.sessionEventCoordinator.pollDesktopApprovalEvents();
  }

  async handleDesktopIpcRequestUpserted(
    snapshot: Parameters<BridgeCoordinatorGraph["approvalCoordinator"]["handleDesktopIpcRequestUpserted"]>[0]
  ): Promise<void> {
    await this.coordinators.approvalCoordinator.handleDesktopIpcRequestUpserted(snapshot);
  }

  async handleDesktopIpcRequestRemoved(
    snapshot: Parameters<BridgeCoordinatorGraph["approvalCoordinator"]["handleDesktopIpcRequestRemoved"]>[0]
  ): Promise<void> {
    await this.coordinators.approvalCoordinator.handleDesktopIpcRequestRemoved(snapshot);
  }

  async maybeAttachThread(
    candidate: DiscoveryCandidate,
    isStartup: boolean,
    forceAttach = false
  ): Promise<void> {
    await this.coordinators.discoveryCoordinator.maybeAttachThread(candidate, isStartup, forceAttach);
  }

  async runDiscoveryCycleInternal(isStartup: boolean): Promise<void> {
    await this.coordinators.discoveryCoordinator.runDiscoveryCycleInternal(isStartup);
  }

  async hydrateThread(
    threadId: string,
    summary: CodexThreadSummary,
    attachMode: "auto" | "manual",
    hydrateOptions: HydrateThreadOptions = {}
  ): Promise<HydratedThreadResult> {
    return this.coordinators.threadHydrator.hydrateThread(threadId, summary, attachMode, hydrateOptions);
  }

  async handleLocalSessionUserMessage(
    event: Extract<CodexSessionEvent, { type: "sessionUserMessage" }>
  ): Promise<void> {
    await this.coordinators.sessionEventCoordinator.handleSessionEvent(event);
  }

  async handleLocalSessionAgentMessage(
    event: Extract<CodexSessionEvent, { type: "sessionAgentMessage" }>
  ): Promise<void> {
    await this.coordinators.sessionEventCoordinator.handleSessionEvent(event);
  }

  async handleLocalShellCommandCompleted(
    event: Extract<CodexSessionEvent, { type: "shellCommandCompleted" }>
  ): Promise<void> {
    await this.coordinators.sessionEventCoordinator.handleSessionEvent(event);
  }

  async enforceTurnRetention(threadId: string): Promise<void> {
    await this.coordinators.mirrorStateCoordinator.enforceTurnRetention(threadId);
  }

  private queueStatusUpdate(threadId: string): void {
    if (this.stopping) {
      return;
    }
    this.coordinators.statusCoordinator.queueStatusUpdate(threadId);
  }

  private async flushStatusUpdate(threadId: string): Promise<void> {
    if (this.stopping) {
      return;
    }
    await this.coordinators.statusCoordinator.flushStatusUpdate(threadId);
  }

  private persistThreadState(state: ThreadRuntimeState): void {
    if (this.stopping) {
      return;
    }
    this.coordinators.statusCoordinator.persistThreadState(state);
  }

  private queueMessageSync(threadId: string): void {
    if (this.stopping) {
      return;
    }
    this.coordinators.mirrorSyncCoordinator.queueMessageSync(threadId);
  }

  private async deleteMappedThread(
    threadId: string,
    reason: string,
    progressReporter?: CleanProgressReporter,
    progressState?: { current: number; total: number }
  ): Promise<number> {
    return this.coordinators.cleanupCoordinator.deleteMappedThread(threadId, reason, progressReporter, progressState);
  }

  private isUnknownDiscordChannelError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      Number((error as { code?: unknown }).code) === 10003
    );
  }
}
