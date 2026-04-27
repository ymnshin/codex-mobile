import type { CodexThreadStatus, StatusCardView, ThreadRuntimeState } from "../../domain.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import { STATUS_EDIT_DEBOUNCE_MS } from "../runtime/BridgeRuntimeContext.js";
import type { BridgeRuntimeState, HydrateThreadOptions } from "../runtime/BridgeRuntimeState.js";
import { createProviderOperationContext } from "../startupTransport.js";

interface StatusCoordinatorDependencies {
  buildStatusCardView(state: ThreadRuntimeState): StatusCardView;
  hydrateThread(
    threadId: string,
    details: import("../../domain.js").CodexThreadSummary,
    attachMode: "auto" | "manual",
    options?: HydrateThreadOptions
  ): Promise<unknown>;
  isUnknownDiscordChannelError(error: unknown): boolean;
  syntheticSummary(
    threadId: string,
    preferredName: string,
    status: CodexThreadStatus | null
  ): import("../../domain.js").CodexThreadSummary;
  shouldStop(): boolean;
  toPersistedLastSeenIso(lastActivityAt: number | null, fallbackIso: string | null): string;
  tryReadThread(threadId: string): Promise<import("../../domain.js").CodexThreadSummary | null>;
}

export class StatusCoordinator {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: StatusCoordinatorDependencies
  ) {}

  queueStatusUpdate(threadId: string): void {
    if (this.deps.shouldStop()) {
      return;
    }
    if (this.runtime.startupStatusSuppressedThreadIds.has(threadId)) {
      this.runtime.startupStatusDirtyThreadIds.add(threadId);
      return;
    }
    const existingTimer = this.runtime.statusUpdateTimers.get(threadId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => void this.flushStatusUpdate(threadId), STATUS_EDIT_DEBOUNCE_MS);
    this.runtime.statusUpdateTimers.set(threadId, timer);
  }

  clearQueuedStatusUpdate(threadId: string): void {
    const existingTimer = this.runtime.statusUpdateTimers.get(threadId);
    if (!existingTimer) {
      return;
    }
    clearTimeout(existingTimer);
    this.runtime.statusUpdateTimers.delete(threadId);
  }

  beginStartupAttachWindow(threadId: string): void {
    this.clearQueuedStatusUpdate(threadId);
    this.runtime.startupStatusSuppressedThreadIds.add(threadId);
    this.runtime.startupStatusDirtyThreadIds.delete(threadId);
  }

  async endStartupAttachWindow(threadId: string): Promise<void> {
    const shouldFlush = this.runtime.startupStatusDirtyThreadIds.has(threadId);
    this.runtime.startupStatusSuppressedThreadIds.delete(threadId);
    this.runtime.startupStatusDirtyThreadIds.delete(threadId);
    if (shouldFlush) {
      await this.flushStatusUpdate(threadId, { force: true });
    }
  }

  async flushStatusUpdate(threadId: string, options: { force?: boolean } = {}): Promise<void> {
    const pendingTimer = this.runtime.statusUpdateTimers.get(threadId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.runtime.statusUpdateTimers.delete(threadId);
    }
    if (this.deps.shouldStop()) {
      return;
    }
    if (!options.force && this.runtime.startupStatusSuppressedThreadIds.has(threadId)) {
      this.runtime.startupStatusDirtyThreadIds.add(threadId);
      return;
    }
    const prior = this.runtime.statusUpdateChains.get(threadId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(async () => {
        this.runtime.statusUpdateTimers.delete(threadId);
        if (this.deps.shouldStop()) {
          return;
        }
        if (!options.force && this.runtime.startupStatusSuppressedThreadIds.has(threadId)) {
          this.runtime.startupStatusDirtyThreadIds.add(threadId);
          return;
        }
        const state = this.runtime.threadState.get(threadId);
        const bridge = this.context.stateStore.getThreadBridge(threadId);
        if (!state || !bridge) {
          return;
        }
        const operationContext = createProviderOperationContext(
          threadId,
          this.runtime.startupTransportContextByThreadId.get(threadId) ?? null
        );
        try {
          const statusMessageId = await this.context.provider.upsertStatusCard(
            bridge.discordChannelId,
            bridge.statusMessageId,
            this.deps.buildStatusCardView(state),
            operationContext
          );
          this.context.stateStore.updateStatusMessageId(threadId, statusMessageId);
        } catch (error) {
          if (!this.deps.isUnknownDiscordChannelError(error)) {
            throw error;
          }

          this.context.logger.warn(
            { error, threadId, discordChannelId: bridge.discordChannelId },
            "Discord mapping points to a missing channel. Rebuilding the mapping."
          );
          const details =
            (await this.deps.tryReadThread(threadId)) ??
            this.deps.syntheticSummary(threadId, state.name ?? state.preview ?? "Codex conversation", state.status);
          await this.deps.hydrateThread(threadId, details, bridge.attachMode, {
            parentThreadId: bridge.parentCodexThreadId,
            preferredName: state.name ?? bridge.threadName
          });
          const repairedBridge = this.context.stateStore.getThreadBridge(threadId);
          if (!repairedBridge) {
            return;
          }
          const statusMessageId = await this.context.provider.upsertStatusCard(
            repairedBridge.discordChannelId,
            repairedBridge.statusMessageId,
            this.deps.buildStatusCardView(state),
            operationContext
          );
          this.context.stateStore.updateStatusMessageId(threadId, statusMessageId);
        }
      })
      .finally(() => {
        if (this.runtime.statusUpdateChains.get(threadId) === next) {
          this.runtime.statusUpdateChains.delete(threadId);
        }
      });
    this.runtime.statusUpdateChains.set(threadId, next);
    await next;
  }

  persistThreadState(state: ThreadRuntimeState): void {
    const existing = this.context.stateStore.getThreadBridge(state.threadId);
    if (!existing) {
      return;
    }
    this.context.stateStore.upsertThreadBridge({
      ...existing,
      parentCodexThreadId: state.parentThreadId,
      projectKey: state.projectKey,
      projectName: state.projectName,
      cwd: state.cwd,
      repoName: state.repoName,
      lastSeenAt: this.deps.toPersistedLastSeenIso(state.lastActivityAt, existing.lastSeenAt),
      threadName: state.name,
      actorName: state.actorName,
      lastStatusType: state.status.type,
      lastTurnId: state.lastTurnId,
      lastTurnStatus: state.lastTurnStatus,
      channelKind: state.channelKind,
      latestMirroredTimestampMs: existing.latestMirroredTimestampMs ?? null,
      latestMirroredCursor: existing.latestMirroredCursor ?? null,
      latestMirroredTurnCursor: existing.latestMirroredTurnCursor ?? null
    });
  }
}
