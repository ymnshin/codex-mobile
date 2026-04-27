import type {
  ChildThreadAnchorRecord,
  CodexThreadStatus,
  CodexThreadSummary,
  ThreadBridgeRecord,
  ThreadRuntimeState
} from "../../domain.js";
import type { CodexSessionEvent } from "../../codex/CodexSessionEventTailer.js";
import { shortThreadId } from "../../util/formatting.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import type {
  BridgeRuntimeState,
  HydrateThreadOptions,
  HydratedThreadResult,
  ResolvedThreadMetadata
} from "../runtime/BridgeRuntimeState.js";

interface ThreadContextCoordinatorDependencies {
  getChildThreadAnchor(childThreadId: string): ChildThreadAnchorRecord | null;
  hydrateThread(
    threadId: string,
    summary: CodexThreadSummary,
    attachMode: "auto" | "manual",
    hydrateOptions?: HydrateThreadOptions
  ): Promise<HydratedThreadResult>;
  resolveThreadMetadata(
    threadId: string,
    preferred?: ResolvedThreadMetadata | null,
    options?: {
      allowFilesystemScan?: boolean;
    }
  ): Promise<ResolvedThreadMetadata>;
  syntheticSummary(
    threadId: string,
    preferredName: string,
    status: CodexThreadStatus | null
  ): CodexThreadSummary;
  tryReadThread(threadId: string): Promise<CodexThreadSummary | null>;
}

export class ThreadContextCoordinator {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: ThreadContextCoordinatorDependencies
  ) {}

  lookupProjectContext(
    threadId: string
  ): Pick<ThreadRuntimeState, "projectKey" | "projectName"> | undefined {
    const runtime = this.runtime.threadState.get(threadId);
    if (runtime) {
      return { projectKey: runtime.projectKey, projectName: runtime.projectName };
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    return bridge ? { projectKey: bridge.projectKey, projectName: bridge.projectName } : undefined;
  }

  rememberChildThreadParent(childThreadId: string, parentThreadId: string): void {
    const normalizedChildThreadId = childThreadId.trim();
    const normalizedParentThreadId = parentThreadId.trim();
    if (
      !normalizedChildThreadId ||
      !normalizedParentThreadId ||
      normalizedChildThreadId === normalizedParentThreadId
    ) {
      return;
    }
    this.runtime.childThreadParentHints.set(normalizedChildThreadId, normalizedParentThreadId);
  }

  resolveThreadIdForDesktopEvent(
    event: Extract<CodexSessionEvent, { type: "nativeApprovalResolved" }>
  ): string | null {
    const approval = this.context.stateStore.findPendingApprovalByRequestId(event.requestId);
    return approval?.threadId ?? null;
  }

  async ensureParentBridge(
    parentThreadId: string | null,
    attachMode: "auto" | "manual"
  ): Promise<ThreadBridgeRecord> {
    if (!parentThreadId) {
      throw new Error("Cannot create a sub-agent Discord thread without a parent thread.");
    }
    const existing = this.context.stateStore.getThreadBridge(parentThreadId);
    if (existing) {
      return existing;
    }
    const details =
      (await this.deps.tryReadThread(parentThreadId)) ??
      this.deps.syntheticSummary(parentThreadId, `Codex ${shortThreadId(parentThreadId)}`, null);
    await this.deps.hydrateThread(parentThreadId, details, attachMode);
    const hydrated = this.context.stateStore.getThreadBridge(parentThreadId);
    if (!hydrated) {
      throw new Error(`Failed to hydrate parent Codex thread ${parentThreadId}.`);
    }
    return hydrated;
  }

  async ensureThreadStateForRequest(
    threadId: string,
    preferredName: string
  ): Promise<ThreadRuntimeState> {
    const existingState = this.runtime.threadState.get(threadId);
    if (existingState) {
      return existingState;
    }
    const existingBridge = this.context.stateStore.getThreadBridge(threadId);
    const persistedAnchor = this.deps.getChildThreadAnchor(threadId);
    const hintedAnchor = this.runtime.childThreadAnchorHints.get(threadId) ?? null;
    const hintedParentThreadId =
      existingBridge?.parentCodexThreadId ??
      persistedAnchor?.parentThreadId ??
      hintedAnchor?.parentThreadId ??
      this.runtime.threadState.get(threadId)?.parentThreadId ??
      null;
    const resolvedParentThreadId =
      hintedParentThreadId ??
      (await this.resolveParentThreadIdForThread(threadId, true));
    const resolvedMetadata = await this.deps.resolveThreadMetadata(
      threadId,
      resolvedParentThreadId
        ? {
            cwd: null,
            repoName: null,
            threadName: null,
            actorName: null,
            parentThreadId: resolvedParentThreadId
          }
        : null,
      {
        allowFilesystemScan: !resolvedParentThreadId
      }
    );
    const effectiveParentAnchorTurnId =
      existingBridge?.parentAnchorTurnId ??
      persistedAnchor?.parentTurnId ??
      hintedAnchor?.parentAnchorTurnId ??
      null;
    const effectiveParentAnchorTurnCursor =
      existingBridge?.parentAnchorTurnCursor ??
      persistedAnchor?.parentTurnCursor ??
      hintedAnchor?.parentAnchorTurnCursor ??
      null;
    const fallbackName =
      (existingBridge?.channelKind === "subagent" || resolvedParentThreadId)
        ? `Sub-agent ${shortThreadId(threadId)}`
        : `Codex ${shortThreadId(threadId)}`;
    const details =
      (await this.deps.tryReadThread(threadId)) ??
      this.deps.syntheticSummary(threadId, fallbackName, {
        type: "active",
        activeFlags: ["waitingOnApproval"]
      });
    const inheritedSourceKind =
      resolvedParentThreadId
        ? this.runtime.threadState.get(resolvedParentThreadId)?.sourceKind ??
          this.context.stateStore.getThreadBridge(resolvedParentThreadId)?.sourceKind ??
          null
        : null;
    const { runtime } = await this.deps.hydrateThread(
      threadId,
      details,
      existingBridge?.attachMode ?? "auto",
      {
        parentThreadId: resolvedParentThreadId,
        ...(effectiveParentAnchorTurnId !== null
          ? { parentAnchorTurnId: effectiveParentAnchorTurnId }
          : {}),
        ...(effectiveParentAnchorTurnCursor !== null
          ? { parentAnchorTurnCursor: effectiveParentAnchorTurnCursor }
          : {}),
        preferredName: existingBridge?.threadName ?? preferredName ?? fallbackName,
        sourceKind: existingBridge?.sourceKind ?? inheritedSourceKind ?? "app-server",
        resolvedMetadata
      }
    );
    return runtime;
  }

  async resolveParentThreadIdForThread(
    threadId: string,
    allowThreadScan: boolean
  ): Promise<string | null> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return null;
    }

    const existingBridge = this.context.stateStore.getThreadBridge(normalizedThreadId);
    if (existingBridge?.parentCodexThreadId) {
      this.rememberChildThreadParent(normalizedThreadId, existingBridge.parentCodexThreadId);
      return existingBridge.parentCodexThreadId;
    }

    const persistedAnchor = this.deps.getChildThreadAnchor(normalizedThreadId);
    if (persistedAnchor?.parentThreadId) {
      this.rememberChildThreadParent(normalizedThreadId, persistedAnchor.parentThreadId);
      return persistedAnchor.parentThreadId;
    }

    const current = this.runtime.threadState.get(normalizedThreadId);
    if (current?.parentThreadId) {
      this.rememberChildThreadParent(normalizedThreadId, current.parentThreadId);
      return current.parentThreadId;
    }

    const sessionResolvedParentThreadId =
      await this.context.sessionEventTailer.resolveParentThreadId(normalizedThreadId, {
        allowFilesystemScan: allowThreadScan
      });
    if (sessionResolvedParentThreadId) {
      this.rememberChildThreadParent(normalizedThreadId, sessionResolvedParentThreadId);
      return sessionResolvedParentThreadId;
    }
    return null;
  }
}
