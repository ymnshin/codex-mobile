import type { ThreadBridgeRecord } from "../../domain.js";
import type {
  BridgeCleanOptions,
  CleanProgressReporter,
  BridgeRuntimeState
} from "../runtime/BridgeRuntimeState.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";

interface CleanupCoordinatorDependencies {
  clearQueuedStatusUpdate(threadId: string): void;
  clearUserTurnMirrorState(threadId: string): void;
  clearAllUserTurnMirrorState(): void;
  resetThreadMirrorState(threadId: string): void;
  stopPolling(): void;
}

export class CleanupCoordinator {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: CleanupCoordinatorDependencies
  ) {}

  async deleteMappedThread(
    threadId: string,
    reason: string,
    progressReporter?: CleanProgressReporter,
    progressState?: { current: number; total: number }
  ): Promise<number> {
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge) {
      return 0;
    }

    let deletedLocations = 0;
    const children = this.context.stateStore
      .listThreadBridges()
      .filter((record) => record.parentCodexThreadId === threadId);

    for (const child of children) {
      deletedLocations += await this.deleteMappedThread(child.codexThreadId, reason, progressReporter, progressState);
    }

    try {
      if (progressReporter && progressState) {
        progressState.current += 1;
        progressReporter(
          `Deleting mapped location ${progressState.current}/${progressState.total}: ${bridge.discordChannelId}`
        );
      }
      await this.context.provider.deleteDiscordLocation(bridge.discordChannelId, reason);
      deletedLocations += 1;
    } catch (error) {
      this.context.logger.warn(
        { error, threadId, discordChannelId: bridge.discordChannelId },
        "Failed to delete a bridge-managed Discord location."
      );
    }

    this.clearBridgeThreadState(threadId);
    return deletedLocations;
  }

  async resetDiscordBridgeState(
    progressReporter?: CleanProgressReporter,
    options: BridgeCleanOptions = {}
  ): Promise<{
    deletedCategories: number;
    deletedLocations: number;
  }> {
    this.deps.stopPolling();
    for (const threadId of this.runtime.statusUpdateTimers.keys()) {
      this.deps.clearQueuedStatusUpdate(threadId);
    }

    let deletedLocations = 0;
    const discoverOrphans = options.discoverOrphans ?? true;
    const requiredScope = discoverOrphans ? null : this.context.runtimeConfig.discovery.projectNamePrefix;
    const storedProjectCategories = this.context.stateStore
      .listProjectBridges()
      .filter((bridge) => bridge.createdByBridge)
      .map((bridge) => bridge.discordCategoryId);
    const storedThreadBridges = this.context.stateStore.listThreadBridges();
    const storedRootThreads = storedThreadBridges.filter((bridge) => bridge.parentCodexThreadId === null);
    if (progressReporter) {
      progressReporter(`Found ${storedThreadBridges.length} mapped Discord locations in local bridge state.`);
    }
    if (requiredScope) {
      progressReporter?.(
        `Skipping direct mapped-location deletion; scoped cleanup will delete only Discord channels tagged with scope "${requiredScope}".`
      );
    } else {
      const mappedProgressState = { current: 0, total: storedThreadBridges.length };
      for (const bridge of storedRootThreads) {
        deletedLocations += await this.deleteMappedThread(
          bridge.codexThreadId,
          "Clean Codex-to-Discord bridge structure",
          progressReporter,
          mappedProgressState
        );
      }
    }

    progressReporter?.(
      discoverOrphans
        ? "Scanning Discord for orphaned bridge-managed locations..."
        : requiredScope
          ? "Scanning Discord only inside locally recorded e2e categories for scoped bridge-managed locations..."
          : "Skipping global orphan scan; cleanup is limited to local bridge state."
    );
    const discovered = discoverOrphans
      ? await this.context.provider.discoverBridgeManagedLocations(storedProjectCategories)
      : requiredScope
        ? await this.context.provider.discoverBridgeManagedLocations(storedProjectCategories, {
            restrictToSeedCategories: true,
            requiredScope
          })
      : {
          channelIds: [],
          categoryIds: [...new Set(storedProjectCategories)]
        };
    if (progressReporter) {
      progressReporter(
        `Found ${discovered.channelIds.length} orphaned channels and ${discovered.categoryIds.length} categories to delete.`
      );
    }

    for (const [index, channelId] of discovered.channelIds.entries()) {
      try {
        progressReporter?.(
          `Deleting orphaned channel ${index + 1}/${discovered.channelIds.length}: ${channelId}`
        );
        await this.context.provider.deleteDiscordLocation(
          channelId,
          "Clean Codex-to-Discord bridge structure"
        );
        deletedLocations += 1;
      } catch (error) {
        this.context.logger.warn(
          { error, channelId },
          "Failed to delete a discovered bridge-managed Discord channel."
        );
      }
    }

    let deletedCategories = 0;
    for (const [index, categoryId] of discovered.categoryIds.entries()) {
      try {
        progressReporter?.(
          `Deleting category ${index + 1}/${discovered.categoryIds.length}: ${categoryId}`
        );
        await this.context.provider.deleteDiscordLocation(
          categoryId,
          "Clean Codex-to-Discord bridge structure"
        );
        deletedCategories += 1;
      } catch (error) {
        this.context.logger.warn(
          { error, categoryId },
          "Failed to delete a discovered bridge-managed Discord category."
        );
      }
    }

    progressReporter?.("Clearing local bridge state...");
    this.runtime.clearAllState();
    this.deps.clearAllUserTurnMirrorState();
    this.context.stateStore.clearBridgeState();
    progressReporter?.(
      `Done. Deleted ${deletedLocations} channels/threads and ${deletedCategories} categories.`
    );
    return { deletedCategories, deletedLocations };
  }

  detachMappedThread(threadId: string): ThreadBridgeRecord | null {
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge) {
      return null;
    }

    this.clearBridgeThreadState(threadId);
    return bridge;
  }

  async resetMappedThreadLocation(threadId: string, reason: string): Promise<ThreadBridgeRecord | null> {
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge) {
      return null;
    }

    try {
      await this.context.provider.deleteDiscordLocation(bridge.discordChannelId, reason);
    } catch (error) {
      this.context.logger.warn(
        { error, threadId, discordChannelId: bridge.discordChannelId },
        "Failed to delete a bridge-managed Discord location during thread-kind correction."
      );
    }

    this.clearThreadLocationState(threadId);
    return bridge;
  }

  private clearBridgeThreadState(threadId: string): void {
    this.deps.clearQueuedStatusUpdate(threadId);
    this.runtime.hydratedMirrorStateThreadIds.delete(threadId);
    this.deps.clearUserTurnMirrorState(threadId);
    this.runtime.threadState.delete(threadId);
    this.runtime.retainedTurnsByThread.delete(threadId);
    this.runtime.childThreadAnchors.delete(threadId);
    this.context.stateStore.deletePendingApprovalsByThread(threadId);
    this.context.stateStore.deleteCanonicalThreadEventsByThread(threadId);
    this.context.stateStore.deleteRetainedTurnsByThread(threadId);
    this.context.stateStore.deleteChildThreadAnchor(threadId);
    this.context.stateStore.deleteMirroredItemsByThread(threadId);
    this.context.stateStore.deleteThreadBridge(threadId);
  }

  private clearThreadLocationState(threadId: string): void {
    this.deps.clearQueuedStatusUpdate(threadId);
    this.deps.resetThreadMirrorState(threadId);
    this.runtime.threadState.delete(threadId);
    this.context.stateStore.clearPendingApprovalMessageIdsByThread(threadId);
    this.context.stateStore.deleteThreadBridge(threadId);
  }
}
