import type {
  ApprovalCardView,
  ApprovalDecision,
  DiscordCommandButton,
  DiscordCommandResult,
  StatusCardView
} from "../domain.js";
import type { ProviderOperationContext } from "../bridge/startupTransport.js";

export interface ProviderActorContext {
  userId: string;
  roleIds: string[];
  username: string | null;
}

export interface ProviderDetailButton {
  token: string;
  label: string;
}

export interface ProviderMessageOptions {
  detailButtons?: ProviderDetailButton[];
  actionButtons?: DiscordCommandButton[];
  operationContext?: ProviderOperationContext;
}

export interface BridgeProviderHandlers {
  onStatusCommand(actor: ProviderActorContext): Promise<DiscordCommandResult>;
  onRetryCommand?(actor: ProviderActorContext, channelId: string): Promise<DiscordCommandResult>;
  onSendCommand(
    actor: ProviderActorContext,
    channelId: string,
    text: string,
    mode: "queue" | "steer",
    sourceDiscordMessageId?: string
  ): Promise<DiscordCommandResult>;
  onRetractCommand(actor: ProviderActorContext, channelId: string): Promise<DiscordCommandResult>;
  onWriteBackButton(
    actor: ProviderActorContext,
    action: "retract" | "steer",
    queueItemId: number
  ): Promise<DiscordCommandResult>;
  onAttachCommand(actor: ProviderActorContext, threadId: string): Promise<DiscordCommandResult>;
  onDetachCommand(actor: ProviderActorContext, threadId: string): Promise<DiscordCommandResult>;
  onCleanIdCommand(actor: ProviderActorContext, threadId: string): Promise<DiscordCommandResult>;
  onCleanAllCommand(actor: ProviderActorContext): Promise<DiscordCommandResult>;
  onHelpCommand(actor: ProviderActorContext): Promise<DiscordCommandResult>;
  onApprovalDetails(actor: ProviderActorContext, token: string): Promise<DiscordCommandResult>;
  onApprovalAction(
    actor: ProviderActorContext,
    token: string,
    decision: ApprovalDecision
  ): Promise<DiscordCommandResult>;
  onToolInputOption(
    actor: ProviderActorContext,
    token: string,
    questionIndex: number,
    optionIndex: number
  ): Promise<DiscordCommandResult>;
  onToolInputOther(
    actor: ProviderActorContext,
    token: string,
    questionIndex: number,
    answer: string
  ): Promise<DiscordCommandResult>;
  onApprovalFeedback(actor: ProviderActorContext, token: string, feedback: string): Promise<DiscordCommandResult>;
  onMessageDetails(actor: ProviderActorContext, token: string): Promise<DiscordCommandResult>;
  onProposedPlanAction(
    actor: ProviderActorContext,
    token: string,
    action: "accept"
  ): Promise<DiscordCommandResult>;
  onProposedPlanFeedback(
    actor: ProviderActorContext,
    token: string,
    feedback: string
  ): Promise<DiscordCommandResult>;
}

export interface BridgeProviderStartOptions {
  registerCommands?: boolean;
  listenForInteractions?: boolean;
}

export interface BridgeProvider {
  start(
    handlers: BridgeProviderHandlers,
    options?: BridgeProviderStartOptions
  ): Promise<void>;
  stop(): Promise<void>;
  setInputReaction?(
    channelId: string,
    messageId: string,
    reaction: "📨" | "🤔",
    present: boolean
  ): Promise<void>;
  ensureProjectCategory(
    projectKey: string,
    projectName: string,
    existingCategoryId: string | null,
    operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }>;
  ensureConversationChannel(
    codexThreadId: string,
    title: string,
    categoryId: string,
    existingDiscordChannelId: string | null,
    operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }>;
  ensureSubagentThread(
    codexThreadId: string,
    title: string,
    parentChannelId: string,
    existingDiscordChannelId: string | null,
    operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }>;
  countConversationChannelsInCategory(categoryId: string): Promise<number>;
  deleteDiscordLocation(channelId: string, reason: string): Promise<void>;
  discoverBridgeManagedLocations(seedCategoryIds: string[], options?: {
    restrictToSeedCategories?: boolean;
    requiredScope?: string | null;
  }): Promise<{
    categoryIds: string[];
    channelIds: string[];
  }>;
  upsertStatusCard(
    channelId: string,
    messageId: string | null,
    view: StatusCardView,
    operationContext?: ProviderOperationContext
  ): Promise<string>;
  postMilestone(channelId: string, content: string): Promise<void>;
  upsertLiveTextMessage(
    channelId: string,
    messageId: string | null,
    content: string,
    options?: ProviderMessageOptions
  ): Promise<string>;
  sendTextMessage(
    channelId: string,
    content: string,
    options?: ProviderMessageOptions
  ): Promise<string>;
  postApprovalCard(
    channelId: string,
    existingMessageId: string | null,
    view: ApprovalCardView
  ): Promise<string>;
  disableApprovalCard(
    channelId: string,
    messageId: string,
    resolutionText: string,
    view: ApprovalCardView
  ): Promise<void>;
  markApprovalCardStale(
    channelId: string,
    messageId: string,
    view: ApprovalCardView
  ): Promise<void>;
  updateMessageDetailsButtons(
    channelId: string,
    messageId: string,
    buttons: ProviderDetailButton[]
  ): Promise<void>;
  deleteMessages(channelId: string, messageIds: string[]): Promise<void>;
  detachDiscordLocation(channelId: string, codexThreadId: string): Promise<void>;
}
