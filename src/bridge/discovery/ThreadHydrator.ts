import type {
  CodexThreadSummary,
  ProjectBridgeRecord,
  ThreadBridgeRecord,
  ThreadRuntimeState
} from "../../domain.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import type {
  BridgeRuntimeState,
  HydrateThreadOptions,
  HydratedThreadResult,
  ResolvedThreadMetadata
} from "../runtime/BridgeRuntimeState.js";
import {
  projectKeyFromMetadata,
  projectNameFromMetadata
} from "../../util/formatting.js";
import {
  pickPreferredThreadName,
  resolveAuthoritativeThreadName,
  sanitizeThreadNameForDiscord
} from "../threadMetadata.js";
import { createProviderOperationContext } from "../startupTransport.js";

interface ThreadHydratorDependencies {
  deriveThreadLastActivityAt(
    summary: CodexThreadSummary,
    runtimeLastActivityAt: number | null,
    bridgeLastSeenAt: string | null
  ): number | null;
  enforceConversationChannelLimit(
    projectBridge: ProjectBridgeRecord,
    projectKey: string,
    threadId: string
  ): Promise<void>;
  ensureParentBridge(
    parentThreadId: string | null,
    attachMode: "auto" | "manual"
  ): Promise<ThreadBridgeRecord>;
  hasRetainedConversationTurn(threadId: string): boolean;
  lookupProjectContext(
    threadId: string
  ): { projectKey: string; projectName: string } | undefined;
  normalizeSubagentThreadName(name: string, threadId: string): string;
  printProgress(message: string): void;
  resetThreadBridgeLocation(threadId: string, reason: string): Promise<void>;
  toPersistedLastSeenIso(lastActivityAt: number | null, fallbackIso: string | null): string;
}

export class ThreadHydrator {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: ThreadHydratorDependencies
  ) {}

  async resolveThreadMetadata(
    threadId: string,
    preferred?: ResolvedThreadMetadata | null,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ): Promise<ResolvedThreadMetadata> {
    const cached = this.runtime.resolvedMetadataByThread.get(threadId);
    const resolved = await this.context.codexAdapter.resolveMetadata(threadId, options);
    const merged: ResolvedThreadMetadata = {
      cwd: resolved.cwd ?? preferred?.cwd ?? cached?.cwd ?? null,
      repoName: resolved.repoName ?? preferred?.repoName ?? cached?.repoName ?? null,
      threadName: resolved.threadName ?? preferred?.threadName ?? cached?.threadName ?? null,
      actorName: resolved.actorName ?? preferred?.actorName ?? cached?.actorName ?? null,
      parentThreadId:
        preferred?.parentThreadId !== undefined
          ? preferred.parentThreadId
          : resolved.parentThreadId !== undefined
            ? resolved.parentThreadId
            : cached?.parentThreadId ?? null,
      sourceSubagentOther:
        resolved.sourceSubagentOther ??
        preferred?.sourceSubagentOther ??
        cached?.sourceSubagentOther ??
        null
    };
    this.runtime.resolvedMetadataByThread.set(threadId, merged);
    return merged;
  }

  async ensureProjectBridge(
    projectKey: string,
    projectName: string,
    startupContext: HydrateThreadOptions["startupContext"] = null
  ): Promise<ProjectBridgeRecord> {
    const inFlight = this.runtime.projectBridgePromises.get(projectKey);
    if (inFlight) {
      return inFlight;
    }

    const task = (async () => {
      const existing = this.context.stateStore.getProjectBridge(projectKey);
      const category = await this.context.provider.ensureProjectCategory(
        projectKey,
        projectName,
        existing?.discordCategoryId ?? null,
        createProviderOperationContext(null, startupContext)
      );
      if (!existing) {
        this.deps.printProgress(`Using Discord category ${category.id} for project ${projectName}.`);
      }
      const record: ProjectBridgeRecord = {
        projectKey,
        projectName,
        discordCategoryId: category.id,
        createdByBridge: existing?.createdByBridge ?? category.created,
        updatedAt: new Date().toISOString()
      };
      try {
        this.context.stateStore.upsertProjectBridge(record);
      } catch (error) {
        const conflict =
          this.context.stateStore
            .listProjectBridges()
            .find((bridge) => bridge.discordCategoryId === category.id) ?? null;
        if (
          conflict &&
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
        ) {
          this.context.logger.warn(
            {
              projectKey,
              projectName,
              categoryId: category.id,
              conflictingProjectKey: conflict.projectKey
            },
            "Provider returned a Discord category already mapped to another project key. Reusing the existing category mapping."
          );
          return conflict;
        }
        throw error;
      }
      return record;
    })();

    this.runtime.projectBridgePromises.set(projectKey, task);
    try {
      return await task;
    } finally {
      this.runtime.projectBridgePromises.delete(projectKey);
    }
  }

  async hydrateThread(
    threadId: string,
    summary: CodexThreadSummary,
    attachMode: "auto" | "manual",
    hydrateOptions: HydrateThreadOptions = {}
  ): Promise<HydratedThreadResult> {
    while (true) {
      const inFlight = this.runtime.threadHydrationPromises.get(threadId);
      if (!inFlight) {
        break;
      }
      await inFlight.catch(() => undefined);
    }

    const task = this.hydrateThreadInternal(threadId, summary, attachMode, hydrateOptions);
    this.runtime.threadHydrationPromises.set(threadId, task);
    try {
      return await task;
    } finally {
      if (this.runtime.threadHydrationPromises.get(threadId) === task) {
        this.runtime.threadHydrationPromises.delete(threadId);
      }
    }
  }

  private async hydrateThreadInternal(
    threadId: string,
    summary: CodexThreadSummary,
    attachMode: "auto" | "manual",
    hydrateOptions: HydrateThreadOptions = {}
  ): Promise<HydratedThreadResult> {
    const metadata = await this.resolveThreadMetadata(
      threadId,
      hydrateOptions.resolvedMetadata ?? null,
      {
        allowFilesystemScan: hydrateOptions.allowFilesystemScan ?? true
      }
    );
    const existingBridge = this.context.stateStore.getThreadBridge(threadId);
    const current = this.runtime.threadState.get(threadId);
    const storedAnchor = this.context.stateStore.getChildThreadAnchor(threadId) ?? null;
    const hasExplicitParentThreadId = Object.prototype.hasOwnProperty.call(hydrateOptions, "parentThreadId");
    const effectiveParentThreadId = hasExplicitParentThreadId
      ? hydrateOptions.parentThreadId ?? null
      : storedAnchor?.parentThreadId ??
        current?.parentThreadId ??
        (this.runtime.sessionEventTailerEnabled
          ? existingBridge?.parentCodexThreadId ?? null
          : metadata.parentThreadId);
    const channelKind = effectiveParentThreadId ? "subagent" : "conversation";
    const persistedAnchor = channelKind === "subagent" ? storedAnchor : null;
    const parentAnchorTurnId =
      channelKind === "subagent"
        ? hydrateOptions.parentAnchorTurnId ??
          persistedAnchor?.parentTurnId ??
          existingBridge?.parentAnchorTurnId ??
          null
        : null;
    const parentAnchorTurnCursor =
      channelKind === "subagent"
        ? hydrateOptions.parentAnchorTurnCursor ??
          persistedAnchor?.parentTurnCursor ??
          existingBridge?.parentAnchorTurnCursor ??
          null
        : null;
    if (existingBridge && existingBridge.channelKind !== channelKind) {
      const childBridges = this.context.stateStore
        .listThreadBridges()
        .filter((record) => record.parentCodexThreadId === threadId && record.channelKind === "subagent");
      if (existingBridge.channelKind === "conversation" && channelKind === "subagent") {
        this.context.logger.warn(
          { threadId, previousChannelKind: existingBridge.channelKind, nextChannelKind: channelKind },
          "Re-attaching existing conversation mapping as a sub-agent Discord thread."
        );
      } else {
        this.context.logger.warn(
          { threadId, previousChannelKind: existingBridge.channelKind, nextChannelKind: channelKind },
          "Migrating an existing Discord mapping after thread kind changed."
        );
      }

      await this.deps.resetThreadBridgeLocation(
        threadId,
        existingBridge.channelKind === "conversation" && channelKind === "subagent"
          ? "Convert stale conversation mapping to sub-agent thread"
          : "Convert stale sub-agent mapping to conversation channel"
      );
      const hydrated = await this.hydrateThreadInternal(threadId, summary, attachMode, hydrateOptions);
      for (const childBridge of childBridges) {
        let childSummary: CodexThreadSummary | null = null;
        try {
          childSummary = await this.context.codexAdapter.readThread(childBridge.codexThreadId, false);
        } catch (error) {
          this.context.logger.warn(
            { error, childThreadId: childBridge.codexThreadId, parentThreadId: threadId },
            "Failed to read a direct child thread while correcting a parent thread kind."
          );
          continue;
        }
        if (!childSummary) {
          continue;
        }
        await this.deps.resetThreadBridgeLocation(
          childBridge.codexThreadId,
          "Reattach direct child mapping after parent thread kind correction"
        );
        await this.hydrateThread(childBridge.codexThreadId, childSummary, childBridge.attachMode, {
          parentThreadId: childBridge.parentCodexThreadId,
          parentAnchorTurnId: childBridge.parentAnchorTurnId ?? null,
          parentAnchorTurnCursor: childBridge.parentAnchorTurnCursor ?? null,
          preferredName: childBridge.threadName,
          sourceKind: childBridge.sourceKind ?? "app-server"
        });
      }
      return hydrated;
    }

    const inheritedProject = effectiveParentThreadId
      ? this.deps.lookupProjectContext(effectiveParentThreadId)
      : undefined;
    const cwd = metadata.cwd ?? current?.cwd ?? null;
    const repoName = metadata.repoName ?? current?.repoName ?? null;
    const baseProjectKey = projectKeyFromMetadata(cwd, repoName);
    const baseProjectName = projectNameFromMetadata(cwd, repoName);
    const projectNamePrefix = this.context.runtimeConfig.discovery.projectNamePrefix;
    const projectKey =
      inheritedProject?.projectKey ??
      (projectNamePrefix ? `${projectNamePrefix.trim().toLowerCase()}::${baseProjectKey}` : baseProjectKey);
    const projectName =
      inheritedProject?.projectName ??
      (projectNamePrefix ? `${projectNamePrefix.trim()} ${baseProjectName}` : baseProjectName);
    const preservedName = hydrateOptions.preferredName ?? existingBridge?.threadName ?? current?.name ?? null;
    const preservedActorName = existingBridge?.actorName ?? current?.actorName ?? null;
    const sourceKind = hydrateOptions.sourceKind ?? current?.sourceKind ?? existingBridge?.sourceKind ?? "app-server";
    const authoritativeName = resolveAuthoritativeThreadName(summary, metadata, sourceKind);
    const subagentPreferredName =
      channelKind === "subagent"
        ? metadata.actorName?.trim() || preservedActorName?.trim() || null
        : null;
    const proposedName =
      pickPreferredThreadName(
        subagentPreferredName,
        authoritativeName,
        preservedName,
        summary.name,
        summary.preview
      ) ??
      (channelKind === "subagent" ? "Codex sub-agent" : "Codex conversation");
    const displayName =
      channelKind === "subagent" ? this.deps.normalizeSubagentThreadName(proposedName, threadId) : proposedName;
    const normalizedName = sanitizeThreadNameForDiscord(displayName);
    const actorName =
      channelKind === "subagent" ? metadata.actorName ?? preservedActorName ?? normalizedName : "Codex";

    const state: ThreadRuntimeState = {
      threadId,
      parentThreadId: effectiveParentThreadId,
      projectKey,
      projectName,
      channelKind,
      sourceKind,
      name: normalizedName,
      actorName,
      preview: summary.preview ?? current?.preview ?? null,
      cwd,
      repoName,
      status: summary.status,
      lastActivityAt: this.deps.deriveThreadLastActivityAt(
        summary,
        current?.lastActivityAt ?? null,
        existingBridge?.lastSeenAt ?? null
      ),
      latestCommandPreview: current?.latestCommandPreview ?? null,
      latestAgentMessage: current?.latestAgentMessage ?? null,
      lastTurnId: current?.lastTurnId ?? null,
      lastTurnStatus: current?.lastTurnStatus ?? null
    };
    this.runtime.threadState.set(threadId, state);

    let discordChannelId = existingBridge?.discordChannelId ?? null;
    let discordParentChannelId = existingBridge?.discordParentChannelId ?? null;
    let createdDiscordLocation = false;
    const canReuseExistingDiscordLocation = Boolean(
      hydrateOptions.reuseExistingDiscordLocation &&
        existingBridge?.discordChannelId &&
        existingBridge.channelKind === channelKind &&
        (channelKind === "conversation" || existingBridge.discordParentChannelId)
    );
    if (canReuseExistingDiscordLocation) {
      if (channelKind === "conversation") {
        discordParentChannelId = null;
      }
    } else if (channelKind === "subagent") {
      const parentBridge = await this.deps.ensureParentBridge(effectiveParentThreadId, attachMode);
      const target = await this.context.provider.ensureSubagentThread(
        threadId,
        state.name ?? "Codex sub-agent",
        parentBridge.discordChannelId,
        existingBridge?.discordChannelId ?? null,
        createProviderOperationContext(threadId, hydrateOptions.startupContext ?? null)
      );
      discordChannelId = target.id;
      createdDiscordLocation = target.created;
      discordParentChannelId = parentBridge.discordChannelId;
    } else {
      const projectBridge = await this.ensureProjectBridge(
        projectKey,
        projectName,
        hydrateOptions.startupContext ?? null
      );
      if (!existingBridge) {
        await this.deps.enforceConversationChannelLimit(projectBridge, projectKey, threadId);
      }
      const target = await this.context.provider.ensureConversationChannel(
        threadId,
        state.name ?? "Codex conversation",
        projectBridge.discordCategoryId,
        existingBridge?.discordChannelId ?? null,
        createProviderOperationContext(threadId, hydrateOptions.startupContext ?? null, {
          isolateProjectCategory: Boolean(this.context.runtimeConfig.discovery.projectNamePrefix),
          projectScope: this.context.runtimeConfig.discovery.projectNamePrefix
        })
      );
      discordChannelId = target.id;
      createdDiscordLocation = target.created;
      discordParentChannelId = null;
    }
    if (!discordChannelId) {
      throw new Error(`Failed to determine Discord location for Codex thread ${threadId}.`);
    }

    this.context.stateStore.upsertThreadBridge({
      codexThreadId: threadId,
      parentCodexThreadId: effectiveParentThreadId,
      parentAnchorTurnId,
      parentAnchorTurnCursor,
      projectKey,
      projectName,
      discordChannelId,
      discordParentChannelId,
      statusMessageId:
        existingBridge?.discordChannelId === discordChannelId ? existingBridge?.statusMessageId ?? null : null,
      cwd: state.cwd,
      repoName: state.repoName,
      lastSeenAt: this.deps.toPersistedLastSeenIso(state.lastActivityAt, existingBridge?.lastSeenAt ?? null),
      attachMode,
      threadName: state.name,
      actorName: state.actorName,
      lastStatusType: state.status.type,
      lastTurnId: state.lastTurnId,
      lastTurnStatus: state.lastTurnStatus,
      channelKind,
      sourceKind: state.sourceKind,
      latestMirroredTimestampMs: existingBridge?.latestMirroredTimestampMs ?? null,
      latestMirroredCursor: existingBridge?.latestMirroredCursor ?? null,
      latestMirroredTurnCursor: existingBridge?.latestMirroredTurnCursor ?? null,
      latestMirroredSourceFilePath: existingBridge?.latestMirroredSourceFilePath ?? null,
      latestMirroredSourceOffset: existingBridge?.latestMirroredSourceOffset ?? null,
      latestMirroredSourceEventKey: existingBridge?.latestMirroredSourceEventKey ?? null
    });

    if (channelKind === "conversation") {
      if (this.shouldRequireConversationAnchor(existingBridge ?? null)) {
        this.runtime.pendingConversationAnchorThreadIds.add(threadId);
      } else {
        this.runtime.pendingConversationAnchorThreadIds.delete(threadId);
      }
    }

    return {
      runtime: state,
      createdDiscordLocation
    };
  }

  private shouldRequireConversationAnchor(existingBridge: ThreadBridgeRecord | null): boolean {
    return !this.deps.hasRetainedConversationTurn(existingBridge?.codexThreadId ?? "");
  }
}
