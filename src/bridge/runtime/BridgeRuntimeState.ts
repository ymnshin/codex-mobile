import type {
  ChildThreadAnchorRecord,
  CodexThreadStatus,
  CodexItem,
  CodexThreadSummary,
  RetainedTurnRecord,
  ThreadRuntimeState
} from "../../domain.js";
import type { GroupedDiscordMessageEntry } from "../messageRendering.js";
import type { StartupTransportContext } from "../startupTransport.js";

export interface ResolvedThreadMetadata {
  cwd: string | null;
  repoName: string | null;
  threadName: string | null;
  actorName: string | null;
  parentThreadId: string | null;
  sourceSubagentOther?: string | null;
  originator?: string | null;
  source?: string | null;
}

export interface HydrateThreadOptions {
  parentThreadId?: string | null;
  parentAnchorTurnId?: string | null;
  parentAnchorTurnCursor?: string | null;
  preferredName?: string | null;
  sourceKind?: "app-server" | "cli-session";
  resolvedMetadata?: ResolvedThreadMetadata;
  allowFilesystemScan?: boolean;
  reuseExistingDiscordLocation?: boolean;
  startupContext?: StartupTransportContext | null;
}

export interface HydratedThreadResult {
  runtime: ThreadRuntimeState;
  createdDiscordLocation: boolean;
}

export interface BridgeStartOptions {
  skipDiscovery?: boolean;
  providerOnly?: boolean;
  skipRehydrate?: boolean;
  skipStartupLogFastForward?: boolean;
}

export interface BridgeCleanOptions {
  discoverOrphans?: boolean;
}

export type CleanProgressReporter = (message: string) => void;

export interface LiveAgentMessageState {
  messageId: string | null;
  content: string;
  timestampMs: number | null;
  itemId: string | null;
  cursor: string | null;
}

export interface TrackedDiscordMessageState {
  messageId: string;
  content: string;
}

export interface GroupedDiscordMessageState {
  messageId: string | null;
  turnId: string | null;
  turnCursor: string | null;
  entries: GroupedDiscordMessageEntry[];
  groupDevDetailToken: string | null;
  groupDevDetailExpiresAt: string | null;
  groupDevDetailButtonLabel: string | null;
  groupDevDetail: string | null;
}

export interface CommandActivitySummaryState {
  threadId: string;
  messageId: string | null;
  turnId: string | null;
  turnCursor: string | null;
  commandItemIds: Set<string>;
  createdFileKeys: Set<string>;
  editedFileKeys: Set<string>;
  deletedFileKeys: Set<string>;
  timestampMs: number | null;
  timestampIsApproximate: boolean;
}

export interface FileActivityCounts {
  created: number;
  edited: number;
  deleted: number;
  createdPaths?: string[];
  editedPaths?: string[];
  deletedPaths?: string[];
}

export interface MirrorCandidate {
  itemId: string;
  turnId: string | null;
  timestampMs: number | null;
  timestampIsApproximate: boolean;
  cursor: string | null;
  turnCursor: string | null;
  turnOrder: number;
  itemOrder: number;
  kind: "user" | "agentCommentary" | "agentAnswer" | "command" | "fileChange";
  text: string;
  detail: string | null;
  showDetailsButton: boolean;
  phase: string | null;
  status: string | null;
  rawItem: CodexItem;
  rawTurn: unknown;
}

export interface CommandPreviewInfo {
  preview: string | null;
  truncated: boolean;
}

export interface DiscoveryCandidate {
  summary: CodexThreadSummary;
  source: "app-server" | "cli-session";
  hasLocalSessionSnapshot?: boolean;
  resolvedMetadata?: ResolvedThreadMetadata;
}

export interface ThreadSourceFrontier {
  filePath: string;
  offset: number;
  eventKey: string;
}

export interface UserTurnMirrorState {
  firstItemId: string;
  textFingerprints: Set<string>;
}

export interface PendingSubagentAnchorHint {
  parentThreadId: string;
  parentAnchorTurnId: string | null;
  parentAnchorTurnCursor: string | null;
}

export interface StartupMirrorBatchEntry {
  itemId: string;
  kind: "user" | "agentCommentary" | "agentAnswer" | "command" | "fileChange";
  contentSignature: string;
  renderedContent: string;
  timestampMs: number | null;
  timestampIsApproximate: boolean;
  cursor: string | null;
  turnId: string | null;
  turnCursor: string | null;
  groupedEntryContent?: string | null;
  fileCounts?: FileActivityCounts | null;
  markUserText?: string | null;
}

export interface StartupMirrorBatchState {
  entries: StartupMirrorBatchEntry[];
}

export interface BridgeRuntimeStateFields {
  sessionEventTailerEnabled: boolean;
  bridgeStartedAtMs: number;
  threadState: Map<string, ThreadRuntimeState>;
  statusUpdateTimers: Map<string, NodeJS.Timeout>;
  statusUpdateChains: Map<string, Promise<void>>;
  messageSyncTimers: Map<string, NodeJS.Timeout>;
  messageSyncChains: Map<string, Promise<void>>;
  liveAgentMessages: Map<string, LiveAgentMessageState>;
  mirroredUserMessages: Map<string, TrackedDiscordMessageState>;
  mirroredAnswerMessages: Map<string, TrackedDiscordMessageState>;
  groupedCommentaryMessages: Map<string, GroupedDiscordMessageState>;
  groupedCommandMessages: Map<string, GroupedDiscordMessageState>;
  groupedFileChangeMessages: Map<string, GroupedDiscordMessageState>;
  commandActivitySummaries: Map<string, CommandActivitySummaryState>;
  latestMirroredCursorByThread: Map<string, string>;
  latestMirroredTurnCursorByThread: Map<string, string>;
  latestMirroredTimestampMsByThread: Map<string, number>;
  latestSourceFrontierByThread: Map<string, ThreadSourceFrontier>;
  mirroredChatItems: Map<string, string>;
  mirroredAgentItems: Map<string, string>;
  mirroredCommandItems: Map<string, string>;
  mirroredFileChangeItems: Map<string, string>;
  mirroredUserTurnStateByThread: Map<string, Map<string, UserTurnMirrorState>>;
  retainedTurnsByThread: Map<string, Map<string, RetainedTurnRecord>>;
  childThreadAnchors: Map<string, ChildThreadAnchorRecord>;
  pendingConversationAnchorThreadIds: Set<string>;
  suppressedSyntheticSessionTurnIdsByThread: Map<string, Set<string>>;
  hydratedMirrorStateThreadIds: Set<string>;
  attachingThreadIds: Set<string>;
  projectBridgePromises: Map<string, Promise<import("../../domain.js").ProjectBridgeRecord>>;
  threadHydrationPromises: Map<string, Promise<HydratedThreadResult>>;
  lastAppServerResumeAttemptAtByThread: Map<string, number>;
  threadEventChains: Map<string, Promise<void>>;
  desktopRequestThreadHints: Map<string, string>;
  childThreadParentHints: Map<string, string>;
  childThreadAnchorHints: Map<string, PendingSubagentAnchorHint>;
  initializingSubagentThreadIds: Set<string>;
  hintedSessionPollThreadIds: Set<string>;
  pendingHintedSessionRepollThreadIds: Set<string>;
  resolvedMetadataByThread: Map<string, ResolvedThreadMetadata>;
  mirrorTraceWriteChain: Promise<void>;
  discoveryTimer: NodeJS.Timeout | null;
  discoveryCyclePromise: Promise<void> | null;
  discoveryCycleStartedAt: number | null;
  isColdStart: boolean;
  startupRefreshedThreadIds: Set<string>;
  startupStatusSuppressedThreadIds: Set<string>;
  startupStatusDirtyThreadIds: Set<string>;
  startupTransportContextByThreadId: Map<string, StartupTransportContext>;
  startupMirrorBatchByThreadId: Map<string, StartupMirrorBatchState>;
}

export class BridgeRuntimeState implements BridgeRuntimeStateFields {
  sessionEventTailerEnabled: boolean;
  bridgeStartedAtMs = Date.now();
  threadState = new Map<string, ThreadRuntimeState>();
  statusUpdateTimers = new Map<string, NodeJS.Timeout>();
  statusUpdateChains = new Map<string, Promise<void>>();
  messageSyncTimers = new Map<string, NodeJS.Timeout>();
  messageSyncChains = new Map<string, Promise<void>>();
  liveAgentMessages = new Map<string, LiveAgentMessageState>();
  mirroredUserMessages = new Map<string, TrackedDiscordMessageState>();
  mirroredAnswerMessages = new Map<string, TrackedDiscordMessageState>();
  groupedCommentaryMessages = new Map<string, GroupedDiscordMessageState>();
  groupedCommandMessages = new Map<string, GroupedDiscordMessageState>();
  groupedFileChangeMessages = new Map<string, GroupedDiscordMessageState>();
  commandActivitySummaries = new Map<string, CommandActivitySummaryState>();
  latestMirroredCursorByThread = new Map<string, string>();
  latestMirroredTurnCursorByThread = new Map<string, string>();
  latestMirroredTimestampMsByThread = new Map<string, number>();
  latestSourceFrontierByThread = new Map<string, ThreadSourceFrontier>();
  mirroredChatItems = new Map<string, string>();
  mirroredAgentItems = new Map<string, string>();
  mirroredCommandItems = new Map<string, string>();
  mirroredFileChangeItems = new Map<string, string>();
  mirroredUserTurnStateByThread = new Map<string, Map<string, UserTurnMirrorState>>();
  retainedTurnsByThread = new Map<string, Map<string, RetainedTurnRecord>>();
  childThreadAnchors = new Map<string, ChildThreadAnchorRecord>();
  pendingConversationAnchorThreadIds = new Set<string>();
  suppressedSyntheticSessionTurnIdsByThread = new Map<string, Set<string>>();
  hydratedMirrorStateThreadIds = new Set<string>();
  attachingThreadIds = new Set<string>();
  projectBridgePromises = new Map<string, Promise<import("../../domain.js").ProjectBridgeRecord>>();
  threadHydrationPromises = new Map<string, Promise<HydratedThreadResult>>();
  lastAppServerResumeAttemptAtByThread = new Map<string, number>();
  threadEventChains = new Map<string, Promise<void>>();
  desktopRequestThreadHints = new Map<string, string>();
  childThreadParentHints = new Map<string, string>();
  childThreadAnchorHints = new Map<string, PendingSubagentAnchorHint>();
  initializingSubagentThreadIds = new Set<string>();
  hintedSessionPollThreadIds = new Set<string>();
  pendingHintedSessionRepollThreadIds = new Set<string>();
  resolvedMetadataByThread = new Map<string, ResolvedThreadMetadata>();
  mirrorTraceWriteChain: Promise<void> = Promise.resolve();
  discoveryTimer: NodeJS.Timeout | null = null;
  discoveryCyclePromise: Promise<void> | null = null;
  discoveryCycleStartedAt: number | null = null;
  isColdStart = false;
  startupRefreshedThreadIds = new Set<string>();
  startupStatusSuppressedThreadIds = new Set<string>();
  startupStatusDirtyThreadIds = new Set<string>();
  startupTransportContextByThreadId = new Map<string, StartupTransportContext>();
  startupMirrorBatchByThreadId = new Map<string, StartupMirrorBatchState>();

  constructor(sessionEventTailerEnabled: boolean) {
    this.sessionEventTailerEnabled = sessionEventTailerEnabled;
  }

  clearTransientState(): void {
    this.liveAgentMessages.clear();
    this.mirroredUserMessages.clear();
    this.mirroredAnswerMessages.clear();
    this.groupedCommentaryMessages.clear();
    this.groupedCommandMessages.clear();
    this.groupedFileChangeMessages.clear();
    this.commandActivitySummaries.clear();
    this.latestMirroredCursorByThread.clear();
    this.latestMirroredTurnCursorByThread.clear();
    this.latestMirroredTimestampMsByThread.clear();
    this.latestSourceFrontierByThread.clear();
    this.threadEventChains.clear();
    this.mirroredChatItems.clear();
    this.mirroredAgentItems.clear();
    this.mirroredCommandItems.clear();
    this.mirroredFileChangeItems.clear();
    this.mirroredUserTurnStateByThread.clear();
    this.retainedTurnsByThread.clear();
    this.childThreadAnchors.clear();
    this.pendingConversationAnchorThreadIds.clear();
    this.suppressedSyntheticSessionTurnIdsByThread.clear();
    this.hydratedMirrorStateThreadIds.clear();
    this.attachingThreadIds.clear();
    this.threadHydrationPromises.clear();
    this.lastAppServerResumeAttemptAtByThread.clear();
    this.desktopRequestThreadHints.clear();
    this.childThreadParentHints.clear();
    this.childThreadAnchorHints.clear();
    this.initializingSubagentThreadIds.clear();
    this.hintedSessionPollThreadIds.clear();
    this.pendingHintedSessionRepollThreadIds.clear();
    this.discoveryCyclePromise = null;
    this.discoveryCycleStartedAt = null;
    this.startupRefreshedThreadIds.clear();
    this.startupStatusSuppressedThreadIds.clear();
    this.startupStatusDirtyThreadIds.clear();
    this.startupTransportContextByThreadId.clear();
    this.startupMirrorBatchByThreadId.clear();
  }

  clearAllState(): void {
    this.clearTransientState();
    this.threadState.clear();
    this.projectBridgePromises.clear();
    this.threadHydrationPromises.clear();
    this.resolvedMetadataByThread.clear();
  }
}

export function markThreadTurnInProgress(
  state: ThreadRuntimeState,
  turnId: string | null | undefined
): void {
  if (turnId) {
    state.lastTurnId = turnId;
  }
  state.lastTurnStatus = "in_progress";
  state.status = normalizeActiveThreadStatus(state.status);
}

export function markThreadTurnCompleted(
  state: ThreadRuntimeState,
  turnStatus: string
): void {
  state.lastTurnStatus = turnStatus;
  state.status = turnStatus === "in_progress" ? normalizeActiveThreadStatus(state.status) : { type: "idle" };
}

export function hasSteerableActiveTurn(
  state: ThreadRuntimeState | null | undefined
): state is ThreadRuntimeState & { lastTurnId: string; lastTurnStatus: "in_progress" } {
  return Boolean(state?.lastTurnId && state.lastTurnStatus === "in_progress");
}

function normalizeActiveThreadStatus(status: CodexThreadStatus): CodexThreadStatus {
  if (status.type === "active") {
    const activeFlags = status.activeFlags?.filter(Boolean) ?? [];
    return activeFlags.length > 0 ? { type: "active", activeFlags } : { type: "active" };
  }
  return { type: "active" };
}
