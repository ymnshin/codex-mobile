import type {
  CodexThreadStatus,
  CodexThreadSummary,
  ThreadBridgeRecord,
  ThreadRuntimeState
} from "../../domain.js";
import { shortThreadId } from "../../util/formatting.js";
import { redactSensitiveText, truncateForDiscord } from "../../util/redaction.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import { DISCOVERY_RESUME_TIMEOUT_MS } from "../runtime/BridgeRuntimeContext.js";
import type { BridgeRuntimeState, ResolvedThreadMetadata } from "../runtime/BridgeRuntimeState.js";

interface PrepareSubagentAttachmentInput {
  parentThreadId: string;
  childThreadId: string;
  prompt?: string | null | undefined;
  actorNameHint?: string | null | undefined;
}

interface PrepareSubagentAttachmentDependencies {
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

interface RefreshSubagentStatusDependencies {
  flushStatusUpdate(threadId: string): Promise<void>;
  persistThreadState(state: ThreadRuntimeState): void;
  queueStatusUpdate(threadId: string): void;
  updateStateLastActivityAt(state: ThreadRuntimeState, timestampMs: number | null | undefined): void;
}

interface AttachPreparedSubagentDependencies extends RefreshSubagentStatusDependencies {
  hydrateThread(
    threadId: string,
    summary: CodexThreadSummary,
    attachMode: "auto" | "manual",
    hydrateOptions?: import("../runtime/BridgeRuntimeState.js").HydrateThreadOptions
  ): Promise<import("../runtime/BridgeRuntimeState.js").HydratedThreadResult>;
}

export interface PreparedSubagentAttachment {
  existingChild: ThreadBridgeRecord | null;
  fallbackName: string;
  resolvedMetadata: ResolvedThreadMetadata;
  sourceKind: "app-server" | "cli-session";
  summary: CodexThreadSummary;
  summaryWasSynthetic: boolean;
}

export function buildSubagentFallbackName(childThreadId: string, prompt?: string | null): string {
  return prompt
    ? truncateForDiscord(redactSensitiveText(prompt), 90)
    : `Sub-agent ${shortThreadId(childThreadId)}`;
}

export async function prepareSubagentAttachment(
  context: BridgeRuntimeContext,
  runtime: BridgeRuntimeState,
  deps: PrepareSubagentAttachmentDependencies,
  input: PrepareSubagentAttachmentInput
): Promise<PreparedSubagentAttachment> {
  const existingChild = context.stateStore.getThreadBridge(input.childThreadId) ?? null;
  const inheritedRuntime = runtime.threadState.get(input.parentThreadId);
  const inheritedBridge = context.stateStore.getThreadBridge(input.parentThreadId);
  const resolvedMetadata = await deps.resolveThreadMetadata(input.childThreadId, null, {
    allowFilesystemScan: false
  });
  const fallbackName = buildSubagentFallbackName(input.childThreadId, input.prompt);
  const effectiveMetadata: ResolvedThreadMetadata = {
    cwd: resolvedMetadata.cwd ?? inheritedRuntime?.cwd ?? inheritedBridge?.cwd ?? null,
    repoName: resolvedMetadata.repoName ?? inheritedRuntime?.repoName ?? inheritedBridge?.repoName ?? null,
    threadName: resolvedMetadata.threadName ?? null,
    actorName: resolvedMetadata.actorName ?? input.actorNameHint ?? existingChild?.actorName ?? null,
    parentThreadId: resolvedMetadata.parentThreadId ?? input.parentThreadId
  };
  const readableSummary = await deps.tryReadThread(input.childThreadId);
  const summaryWasSynthetic = readableSummary === null;
  const summary =
    readableSummary ??
    deps.syntheticSummary(input.childThreadId, fallbackName, { type: "active", activeFlags: [] });
  const sourceKind =
    inheritedRuntime?.sourceKind ??
    inheritedBridge?.sourceKind ??
    existingChild?.sourceKind ??
    "app-server";

  return {
    existingChild,
    fallbackName,
    resolvedMetadata: effectiveMetadata,
    sourceKind,
    summary,
    summaryWasSynthetic
  };
}

export async function refreshAttachedSubagentStatus(
  runtime: BridgeRuntimeState,
  deps: RefreshSubagentStatusDependencies,
  childThreadId: string,
  existingChild: ThreadBridgeRecord | null,
  statusText: string | null
): Promise<void> {
  const childState = runtime.threadState.get(childThreadId);
  if (childState) {
    if (statusText) {
      childState.latestAgentMessage = statusText;
    }
    deps.updateStateLastActivityAt(childState, null);
    deps.persistThreadState(childState);
    if (existingChild) {
      deps.queueStatusUpdate(childThreadId);
    } else {
      await deps.flushStatusUpdate(childThreadId);
    }
    return;
  }

  if (!existingChild) {
    await deps.flushStatusUpdate(childThreadId);
  }
}

export async function attachPreparedSubagentThread(
  context: BridgeRuntimeContext,
  runtime: BridgeRuntimeState,
  deps: AttachPreparedSubagentDependencies,
  input: {
    childThreadId: string;
    prepared: PreparedSubagentAttachment;
    parentAnchorTurnId: string | null;
    parentAnchorTurnCursor: string | null;
    statusText?: string | null;
    failureMessage: string;
  }
): Promise<void> {
  const { childThreadId, prepared, parentAnchorTurnId, parentAnchorTurnCursor } = input;
  await deps.hydrateThread(childThreadId, prepared.summary, prepared.existingChild?.attachMode ?? "auto", {
    parentThreadId: prepared.resolvedMetadata.parentThreadId,
    parentAnchorTurnId,
    parentAnchorTurnCursor,
    preferredName: prepared.summary.name ?? prepared.fallbackName,
    sourceKind: prepared.sourceKind,
    resolvedMetadata: prepared.resolvedMetadata,
    allowFilesystemScan: false
  });

  // Discord orders the parent "started a thread" row and the child status card by send time, not
  // by Codex event time. Keep this sequence stable even though backfilled subagent threads can look
  // slightly out of order; earlier status flushing risks perturbing eager child attachment/backfill.
  try {
    await context.codexAdapter.resumeThread(childThreadId, {
      timeoutMs: DISCOVERY_RESUME_TIMEOUT_MS
    });
  } catch (error) {
    context.logger.warn({ error, childThreadId }, input.failureMessage);
  }

  await refreshAttachedSubagentStatus(
    runtime,
    deps,
    childThreadId,
    prepared.existingChild,
    input.statusText ?? null
  );
}
