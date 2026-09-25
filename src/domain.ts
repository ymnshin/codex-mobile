export type JsonRpcId = number | string;

export type CodexThreadStatus =
  | { type: "active"; activeFlags?: string[] }
  | { type: "idle" | "notLoaded" | "systemError" };

export interface CodexThreadSummary {
  id: string;
  name: string | null;
  preview: string | null;
  modelProvider: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  ephemeral: boolean;
  archived?: boolean;
  status: CodexThreadStatus;
}

export interface CodexThreadDetails extends CodexThreadSummary {
  turns?: unknown[];
}

export interface CodexNotification {
  method: string;
  params: Record<string, any>;
}

export interface CodexCommandAction {
  label?: string;
  type?: string;
  value?: string;
}

export interface CodexCollabToolCall {
  senderThreadId: string;
  receiverThreadId?: string | null;
  newThreadId?: string | null;
  agentNickname?: string | null;
  prompt?: string | null;
  agentStatus?: string | null;
}

export interface CodexCommandExecutionItem {
  type: "commandExecution";
  id: string;
  command?: string;
  cwd?: string;
  status?: string;
  commandActions?: CodexCommandAction[];
  aggregatedOutput?: string;
  exitCode?: number;
  durationMs?: number;
  collabToolCall?: CodexCollabToolCall;
}

export interface CodexFileChangeItem {
  type: "fileChange";
  id: string;
  status?: string;
  changes?: Array<{ path?: string; kind?: string; diff?: string }>;
  collabToolCall?: CodexCollabToolCall;
}

export interface CodexAgentMessageItem {
  type: "agentMessage";
  id: string;
  text?: string;
  phase?: string;
  collabToolCall?: CodexCollabToolCall;
}

export type CodexItem =
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexAgentMessageItem
  | { type: string; id: string; collabToolCall?: CodexCollabToolCall; [key: string]: unknown };

export interface CommandApprovalRequest {
  method: "item/commandExecution/requestApproval";
  id: JsonRpcId;
  params: {
    itemId: string;
    threadId: string;
    turnId: string;
    reason?: string;
    command?: string;
    cwd?: string;
    commandActions?: CodexCommandAction[];
    availableDecisions?: string[];
  };
}

export interface ExecCommandApprovalRequest {
  method: "execCommandApproval";
  id: JsonRpcId;
  params: {
    approvalId?: string | null;
    callId: string;
    command: string[];
    conversationId?: string;
    cwd: string;
    parsedCmd: unknown[];
    reason?: string | null;
  };
}

export interface FileChangeApprovalRequest {
  method: "item/fileChange/requestApproval";
  id: JsonRpcId;
  params: {
    itemId: string;
    threadId: string;
    turnId: string;
    reason?: string;
    grantRoot?: string;
    availableDecisions?: string[];
  };
}

export interface ApplyPatchApprovalRequest {
  method: "applyPatchApproval";
  id: JsonRpcId;
  params: {
    callId: string;
    conversationId?: string;
    fileChanges: Record<string, unknown>;
    grantRoot?: string | null;
    reason?: string | null;
  };
}

export interface PermissionsApprovalRequest {
  method: "item/permissions/requestApproval";
  id: JsonRpcId;
  params: {
    threadId?: string;
    turnId?: string;
    itemId?: string;
    reason?: string;
    cwd?: string;
    availableDecisions?: string[];
    [key: string]: unknown;
  };
}

export interface ToolUserInputOption {
  label?: string;
  description?: string;
  isOther?: boolean;
}

export interface ToolUserInputQuestion {
  id: string;
  header?: string;
  question?: string;
  options?: ToolUserInputOption[];
}

export interface ToolUserInputOptionState {
  label: string;
  description?: string | null;
  isOther?: boolean;
}

export interface ToolUserInputQuestionState {
  id: string;
  header?: string | null;
  question: string;
  options: ToolUserInputOptionState[];
}

export interface ToolUserInputState {
  questions: ToolUserInputQuestionState[];
  selectedAnswers: Record<string, string>;
}

export interface DesktopLogCursorRecord {
  filePath: string;
  byteOffset: number;
  updatedAt: string;
}

export interface ToolUserInputRequest {
  method: "item/tool/requestUserInput" | "tool/requestUserInput";
  id: JsonRpcId;
  params: {
    threadId?: string;
    turnId?: string;
    itemId?: string;
    questions?: ToolUserInputQuestion[];
    [key: string]: unknown;
  };
}

export interface McpElicitationRequest {
  method: "mcpServer/elicitation/request";
  id: JsonRpcId;
  params: {
    threadId?: string;
    conversationId?: string;
    turnId?: string;
    itemId?: string;
    title?: string;
    message?: string;
    prompt?: string;
    reason?: string;
    [key: string]: unknown;
  };
}

export type CodexServerRequest =
  | CommandApprovalRequest
  | ExecCommandApprovalRequest
  | FileChangeApprovalRequest
  | ApplyPatchApprovalRequest
  | PermissionsApprovalRequest
  | ToolUserInputRequest
  | McpElicitationRequest
  | { method: string; id: JsonRpcId; params: Record<string, any> };

export type ApprovalKind =
  | "commandExecution"
  | "fileChange"
  | "toolUserInput"
  | "permissions"
  | "mcpElicitation";
export type ApprovalDecision = "accept" | "decline" | "cancel" | (string & {});
export type ApprovalStatus =
  | "pending"
  | "decisionSent"
  | "approved"
  | "rejected"
  | "expired"
  | "stale";

export type DiscordBridgeKind = "conversation" | "subagent";

export interface PendingApprovalRecord {
  token: string;
  requestId: string;
  threadId: string;
  turnId: string;
  feedbackTurnId?: string | null;
  itemId: string;
  kind: ApprovalKind;
  sanitizedPreview: string;
  cwd: string | null;
  reason: string | null;
  availableDecisions: string[];
  decisionPayloads: Record<string, unknown>;
  expiresAt: string;
  discordMessageId: string | null;
  status: ApprovalStatus;
  details: string;
  createdAt: string;
  restartDisabledAt?: string | null;
  toolInput?: ToolUserInputState | null;
}

export interface ProjectBridgeRecord {
  projectKey: string;
  projectName: string;
  discordCategoryId: string;
  createdByBridge: boolean;
  updatedAt: string;
}

export interface ThreadBridgeRecord {
  codexThreadId: string;
  parentCodexThreadId: string | null;
  parentAnchorTurnId?: string | null;
  parentAnchorTurnCursor?: string | null;
  projectKey: string;
  projectName: string;
  discordChannelId: string;
  discordParentChannelId: string | null;
  statusMessageId: string | null;
  cwd: string | null;
  repoName: string | null;
  lastSeenAt: string;
  attachMode: "auto" | "manual";
  threadName: string | null;
  actorName?: string | null;
  lastStatusType: string | null;
  lastTurnId?: string | null;
  lastTurnStatus?: string | null;
  channelKind: DiscordBridgeKind;
  sourceKind?: "app-server" | "cli-session";
  latestMirroredTimestampMs?: number | null;
  latestMirroredCursor?: string | null;
  latestMirroredTurnCursor?: string | null;
  latestMirroredSourceFilePath?: string | null;
  latestMirroredSourceOffset?: number | null;
  latestMirroredSourceEventKey?: string | null;
}

export interface AuditLogRecord {
  timestamp: string;
  discordUserId: string;
  threadId: string;
  turnId: string;
  requestId: string;
  decision: string;
  sanitizedPreview: string;
}

export type MirroredMessageKind =
  | "user"
  | "agentCommentary"
  | "agentAnswer"
  | "command"
  | "fileChange";

export interface MirroredItemRecord {
  threadId: string;
  itemId: string;
  turnId: string | null;
  kind: MirroredMessageKind;
  discordMessageId: string;
  discordMessageIds?: string[];
  groupKey: string | null;
  contentSignature: string;
  renderedContent: string;
  timestampMs: number | null;
  cursor: string | null;
  turnCursor: string | null;
  updatedAt: string;
}

export interface SessionLogCursorRecord {
  threadId: string;
  filePath: string;
  byteOffset: number;
  updatedAt: string;
}

export interface RetainedTurnRecord {
  threadId: string;
  turnKey: string;
  turnId: string | null;
  turnCursor: string | null;
  anchorItemId: string | null;
  anchorText: string | null;
  source: "session" | "codex-read";
  updatedAt: string;
}

export interface ChildThreadAnchorRecord {
  childThreadId: string;
  parentThreadId: string;
  parentTurnId: string | null;
  parentTurnCursor: string | null;
  source: "session" | "codex-read";
  updatedAt: string;
}

export type CanonicalEventSource =
  | "session"
  | "desktop-ipc"
  | "app-server"
  | "discord"
  | "codex-read";

export type CanonicalEventKind =
  | "content"
  | "childAnchor"
  | "approvalUpsert"
  | "approvalResolved"
  | "status"
  | "ignoredHint"
  | "approvalHold"
  | "approvalRelease"
  | "writeBackQueued"
  | "writeBackSent"
  | "writeBackFailed"
  | "writeBackRetracted";

export interface CanonicalThreadEventRecord {
  id: number;
  threadId: string;
  source: CanonicalEventSource;
  eventKind: CanonicalEventKind;
  itemKind: string | null;
  turnId: string | null;
  turnCursor: string | null;
  itemId: string | null;
  requestId: string | null;
  summary: string | null;
  detail: string | null;
  createdAt: string;
}

export interface ThreadRuntimeState {
  threadId: string;
  parentThreadId: string | null;
  projectKey: string;
  projectName: string;
  channelKind: DiscordBridgeKind;
  sourceKind: "app-server" | "cli-session";
  name: string | null;
  actorName: string | null;
  preview: string | null;
  cwd: string | null;
  repoName: string | null;
  status: CodexThreadStatus;
  lastActivityAt: number | null;
  latestCommandPreview: string | null;
  latestAgentMessage: string | null;
  lastTurnId: string | null;
  lastTurnStatus: string | null;
}

export interface StatusCardView {
  threadId: string;
  title: string;
  shortThreadId: string;
  kindLabel: string;
  parentShortThreadId: string | null;
  projectLabel: string;
  statusLabel: string;
  attentionLabel: string;
  workspaceLabel: string;
  lastActivityAt: number | null;
  latestCommandPreview: string | null;
  latestAgentMessage: string | null;
}

export interface ApprovalCardView {
  token: string;
  threadId: string;
  shortThreadId: string;
  kind: ApprovalKind;
  actorLabel?: string | null;
  createdAt: Date;
  availableDecisions: string[];
  actionsEnabled: boolean;
  sourceKind?: "app-server" | "cli-session" | null;
  sanitizedPreview: string;
  cwd: string | null;
  reason: string | null;
  expiresAt: Date;
  details: string;
  toolInput?: ToolUserInputState | null;
  mentionText?: string | null;
  mentionUserIds?: string[];
}

export type DiscordCommandButtonStyle = "primary" | "secondary" | "danger";

export interface DiscordCommandButton {
  customId: string;
  label: string;
  style?: DiscordCommandButtonStyle;
}

export interface DiscordCommandResult {
  content: string;
  ephemeral?: boolean;
  buttons?: DiscordCommandButton[];
}

export type ProposedPlanActionStatus =
  | "pending"
  | "sending"
  | "accepted"
  | "feedbackSent"
  | "failed";

export interface ProposedPlanActionRecord {
  token: string;
  threadId: string;
  turnId: string | null;
  itemId: string;
  planText: string;
  status: ProposedPlanActionStatus;
  discordMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  expiresAt: string;
  error: string | null;
}

export type WriteBackQueueStatus =
  | "pending"
  | "sending"
  | "uncertain"
  | "sent"
  | "failed"
  | "retracted";

export interface WriteBackQueueRecord {
  id: number;
  threadId: string;
  discordChannelId: string;
  actorUserId: string;
  text: string;
  status: WriteBackQueueStatus;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  error: string | null;
}

export interface MessageDetailRecord {
  token: string;
  threadId: string;
  kind: "command" | "fileChange" | "debug";
  title: string;
  buttonLabel: string;
  detail: string;
  discordMessageId: string | null;
  expiresAt: string;
  updatedAt: string;
}
