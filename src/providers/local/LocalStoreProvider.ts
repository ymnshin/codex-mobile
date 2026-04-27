import type {
  ApprovalCardView,
  StatusCardView
} from "../../domain.js";
import type { ProviderOperationContext } from "../../bridge/startupTransport.js";
import type {
  BridgeProvider,
  BridgeProviderHandlers,
  BridgeProviderStartOptions,
  ProviderDetailButton,
  ProviderMessageOptions
} from "../types.js";

function slug(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "local";
}

export class LocalStoreProvider implements BridgeProvider {
  private messageSequence = 0;
  private readonly categories = new Map<string, string>();
  private readonly conversationChannels = new Map<string, { id: string; categoryId: string }>();
  private readonly subagentThreads = new Map<string, { id: string; parentChannelId: string }>();

  async start(
    _handlers: BridgeProviderHandlers,
    _options: BridgeProviderStartOptions = {}
  ): Promise<void> {}

  async stop(): Promise<void> {}

  async ensureProjectCategory(
    projectKey: string,
    _projectName: string,
    existingCategoryId: string | null,
    _operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }> {
    const existing = existingCategoryId || this.categories.get(projectKey);
    if (existing) {
      this.categories.set(projectKey, existing);
      return { id: existing, created: false };
    }

    const id = `local_category_${slug(projectKey)}`;
    this.categories.set(projectKey, id);
    return { id, created: true };
  }

  async ensureConversationChannel(
    codexThreadId: string,
    _title: string,
    categoryId: string,
    existingDiscordChannelId: string | null,
    _operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }> {
    const existing = existingDiscordChannelId || this.conversationChannels.get(codexThreadId)?.id;
    if (existing) {
      this.conversationChannels.set(codexThreadId, { id: existing, categoryId });
      return { id: existing, created: false };
    }

    const id = `local_channel_${slug(codexThreadId)}`;
    this.conversationChannels.set(codexThreadId, { id, categoryId });
    return { id, created: true };
  }

  async ensureSubagentThread(
    codexThreadId: string,
    _title: string,
    parentChannelId: string,
    existingDiscordChannelId: string | null,
    _operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }> {
    const existing = existingDiscordChannelId || this.subagentThreads.get(codexThreadId)?.id;
    if (existing) {
      this.subagentThreads.set(codexThreadId, { id: existing, parentChannelId });
      return { id: existing, created: false };
    }

    const id = `local_thread_${slug(codexThreadId)}`;
    this.subagentThreads.set(codexThreadId, { id, parentChannelId });
    return { id, created: true };
  }

  async countConversationChannelsInCategory(categoryId: string): Promise<number> {
    return [...this.conversationChannels.values()].filter((channel) => channel.categoryId === categoryId).length;
  }

  async deleteDiscordLocation(channelId: string, _reason: string): Promise<void> {
    for (const [threadId, channel] of this.conversationChannels.entries()) {
      if (channel.id === channelId) {
        this.conversationChannels.delete(threadId);
      }
    }
    for (const [threadId, thread] of this.subagentThreads.entries()) {
      if (thread.id === channelId) {
        this.subagentThreads.delete(threadId);
      }
    }
  }

  async discoverBridgeManagedLocations(_seedCategoryIds: string[], _options: {
    restrictToSeedCategories?: boolean;
    requiredScope?: string | null;
  } = {}): Promise<{
    categoryIds: string[];
    channelIds: string[];
  }> {
    return {
      categoryIds: [...this.categories.values()],
      channelIds: [
        ...[...this.conversationChannels.values()].map((channel) => channel.id),
        ...[...this.subagentThreads.values()].map((thread) => thread.id)
      ]
    };
  }

  async upsertStatusCard(
    _channelId: string,
    messageId: string | null,
    _view: StatusCardView,
    _operationContext?: ProviderOperationContext
  ): Promise<string> {
    return messageId || this.nextMessageId("status");
  }

  async postMilestone(_channelId: string, _content: string): Promise<void> {}

  async upsertLiveTextMessage(
    _channelId: string,
    messageId: string | null,
    _content: string,
    _options?: ProviderMessageOptions
  ): Promise<string> {
    return messageId || this.nextMessageId("live");
  }

  async sendTextMessage(
    _channelId: string,
    _content: string,
    _options?: ProviderMessageOptions
  ): Promise<string> {
    return this.nextMessageId("text");
  }

  async postApprovalCard(
    _channelId: string,
    existingMessageId: string | null,
    _view: ApprovalCardView
  ): Promise<string> {
    return existingMessageId || this.nextMessageId("approval");
  }

  async disableApprovalCard(
    _channelId: string,
    _messageId: string,
    _resolutionText: string,
    _view: ApprovalCardView
  ): Promise<void> {}

  async markApprovalCardStale(
    _channelId: string,
    _messageId: string,
    _view: ApprovalCardView
  ): Promise<void> {}

  async updateMessageDetailsButtons(
    _channelId: string,
    _messageId: string,
    _buttons: ProviderDetailButton[]
  ): Promise<void> {}

  async deleteMessages(_channelId: string, _messageIds: string[]): Promise<void> {}

  async detachDiscordLocation(_channelId: string, _codexThreadId: string): Promise<void> {}

  private nextMessageId(prefix: string): string {
    this.messageSequence += 1;
    return `local_message_${prefix}_${this.messageSequence}`;
  }
}
