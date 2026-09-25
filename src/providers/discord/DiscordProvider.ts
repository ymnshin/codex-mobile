import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  GatewayIntentBits,
  MessageFlags,
  MessageType,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type NonThreadGuildBasedChannel,
  type TextChannel,
  type ThreadChannel
} from "discord.js";
import type {
  ApprovalCardView,
  DiscordCommandButton,
  DiscordCommandResult,
  StatusCardView
} from "../../domain.js";
import type { Logger } from "../../logger.js";
import type { BridgeMessageWriteBackConfig } from "../../config.js";
import type {
  BridgeProvider,
  BridgeProviderHandlers,
  ProviderDetailButton,
  BridgeProviderStartOptions,
  ProviderActorContext,
  ProviderMessageOptions
} from "../types.js";
import {
  recordStartupCacheStat,
  recordStartupWrite,
  type ProviderOperationContext,
  type StartupTransportContext
} from "../../bridge/startupTransport.js";
import {
  formatDiscordCategoryName,
  formatDiscordChannelName,
  formatDiscordThreadName,
  renderApprovalCard,
  renderStatusCard,
  shortThreadId
} from "../../util/formatting.js";
import {
  buildApprovalDecisionCustomId,
  buildToolInputOptionCustomId,
  buildToolInputOtherCustomId,
  buildToolInputOtherSubmitCustomId,
  buildProposedPlanFeedbackSubmitCustomId,
  canRenderDiscordApprovalDecisions,
  canRenderDiscordToolInput,
  findNextToolInputQuestionIndex,
  formatApprovalDecisionLabel,
  formatToolInputOptionLabel,
  supportsApprovalFeedback,
  TELL_CODEX_DIFFERENTLY_LABEL
} from "../../util/approvalDecisions.js";
import {
  formatStartupTimingMs,
  isStartupTimingEnabled,
  startupTimingNow
} from "../../util/startupTiming.js";
import { selectLatestInspectionMessage } from "./inspection.js";
import {
  selectCanonicalConversationChannel,
  type ConversationChannelCandidate
} from "./conversationChannelSelection.js";

type BridgeTargetChannel = TextChannel | ThreadChannel;
const NO_ALLOWED_MENTIONS = { parse: [] as [] };
const INSPECTION_MESSAGE_FETCH_LIMIT = 50;
type ProviderMessagePayload = {
  content: string;
  components?: Array<ActionRowBuilder<ButtonBuilder>>;
  allowedMentions?: { parse: []; users?: string[] };
};
type GuildChannelSnapshot = Awaited<ReturnType<Guild["channels"]["fetch"]>>;

interface DiscordStartupSession {
  guildChannels: GuildChannelSnapshot | null;
  writableTargets: Map<string, BridgeTargetChannel>;
  messages: Map<string, Message<true>>;
  knownEmptyStatusCardChannels: Set<string>;
}

export interface DiscordCategorySnapshot {
  id: string;
  name: string;
  channelCount: number;
}

export interface DiscordManagedChannelSnapshot {
  categoryId: string | null;
  categoryName: string | null;
  channelId: string;
  channelName: string;
  codexThreadId: string | null;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
}

export interface DiscordManagedThreadSnapshot {
  categoryId: string | null;
  categoryName: string | null;
  parentChannelId: string | null;
  parentChannelName: string | null;
  threadId: string;
  threadName: string;
  ownerId: string | null;
  archived: boolean;
  locked: boolean;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
}

export interface DiscordMessageReferenceSnapshot {
  messageId: string | null;
  channelId: string | null;
  guildId: string | null;
  type: number | null;
}

export interface DiscordMessageEmbedSnapshot {
  title: string | null;
  description: string | null;
  url: string | null;
  authorName: string | null;
  footerText: string | null;
  fieldCount: number;
}

export interface DiscordMessageComponentSnapshot {
  type: string;
  style: number | null;
  customId: string | null;
  label: string | null;
  disabled: boolean;
  url: string | null;
}

export interface DiscordMessageComponentRowSnapshot {
  type: string;
  components: DiscordMessageComponentSnapshot[];
}

export interface DiscordMessageSnapshot {
  messageId: string;
  createdAt: number;
  editedAt: number | null;
  authorId: string;
  authorName: string;
  content: string;
  pinned: boolean;
  type: string;
  flags: string[];
  reference: DiscordMessageReferenceSnapshot | null;
  embeds: DiscordMessageEmbedSnapshot[];
  components: DiscordMessageComponentRowSnapshot[];
}

export interface DiscordInspectionSnapshot {
  guildId: string;
  guildName: string;
  categories: DiscordCategorySnapshot[];
  channels: DiscordManagedChannelSnapshot[];
  threads: DiscordManagedThreadSnapshot[];
}

export class DiscordProvider implements BridgeProvider {
  private readonly client: Client;
  private readonly reactionRest: REST;
  private readonly inputReactionUpdates = new Map<string, Promise<void>>();
  private readonly interactionListener = async (interaction: Interaction) => {
    await this.handleInteraction(interaction);
  };

  private handlers: BridgeProviderHandlers | null = null;
  private interactionListenerAttached = false;
  private messageListenerAttached = false;
  private messageListeningSince = 0;
  private readonly messageListener = async (message: Message) => {
    try {
      await this.handlePlainTextMessage(message);
    } catch {
      // Message bodies and arbitrary transport errors must not enter logs.
      this.logger.warn({ messageId: message.id }, "Discord plain-text message handling failed.");
    }
  };
  private readonly startupSessions = new WeakMap<StartupTransportContext, DiscordStartupSession>();

  constructor(
    private readonly config: {
      token: string;
      applicationId: string;
      guildId: string;
      messageWriteBacks?: BridgeMessageWriteBackConfig;
    },
    private readonly logger: Logger
  ) {
    this.reactionRest = new REST({ version: "10", retries: 0, timeout: 2_000,
      rejectOnRateLimit: () => true }).setToken(config.token);
    const plainTextEnabled = config.messageWriteBacks?.allowFromDiscord &&
      (config.messageWriteBacks.plainTextChannelIds?.length ?? 0) > 0;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, ...(plainTextEnabled
        ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
        : [])]
    });
  }

  async start(handlers: BridgeProviderHandlers, options: BridgeProviderStartOptions = {}): Promise<void> {
    this.handlers = handlers;

    if (options.listenForInteractions !== false && !this.interactionListenerAttached) {
      this.client.on("interactionCreate", this.interactionListener);
      this.interactionListenerAttached = true;
    }
    if (options.listenForInteractions !== false && !this.messageListenerAttached &&
        this.config.messageWriteBacks?.allowFromDiscord &&
        (this.config.messageWriteBacks.plainTextChannelIds?.length ?? 0) > 0) {
      this.messageListeningSince = Date.now();
      this.client.on("messageCreate", this.messageListener);
      this.messageListenerAttached = true;
    }

    await this.client.login(this.config.token);
    if (options.registerCommands !== false) {
      await this.registerCommands();
    }
  }

  async stop(): Promise<void> {
    if (this.messageListenerAttached) {
      this.client.off("messageCreate", this.messageListener);
      this.messageListenerAttached = false;
    }
    if (this.interactionListenerAttached) {
      this.client.off("interactionCreate", this.interactionListener);
      this.interactionListenerAttached = false;
    }
    await this.client.destroy();
  }

  async setInputReaction(channelId: string, messageId: string, reaction: "📨" | "🤔", present: boolean): Promise<void> {
    if (!this.config.messageWriteBacks?.allowFromDiscord ||
        !this.config.messageWriteBacks.plainTextChannelIds?.includes(channelId)) return;
    // Keep add/remove ordering for this original even if completion races the start response.
    const key = `${channelId}:${messageId}`;
    const previous = this.inputReactionUpdates.get(key) ?? Promise.resolve();
    const update = previous.then(async () => {
      try {
        const route = Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(reaction));
        const options = { signal: AbortSignal.timeout(2_000) };
        if (present) await this.reactionRest.put(route, options);
        else await this.reactionRest.delete(route, options);
      } catch {
        this.logger.warn({ channelId, messageId, reaction, present }, "Discord input reaction unavailable; input processing continues.");
      }
    });
    this.inputReactionUpdates.set(key, update);
    try { await update; }
    finally { if (this.inputReactionUpdates.get(key) === update) this.inputReactionUpdates.delete(key); }
  }

  async inspectBridgeManagedLocations(limit = 25): Promise<DiscordInspectionSnapshot> {
    const guild = await this.getGuild();
    const channels = await guild.channels.fetch();
    const categoryMap = new Map<string, CategoryChannel>();
    for (const channel of channels.values()) {
      if (channel?.type === ChannelType.GuildCategory) {
        categoryMap.set(channel.id, channel);
      }
    }

    const managedChannels = [...channels.values()]
      .filter(
        (channel): channel is TextChannel =>
          channel !== null &&
          channel.type === ChannelType.GuildText &&
          this.isBridgeManagedConversationChannel(channel)
      );

    const channelSnapshots = await Promise.all(
      managedChannels.map(async (channel) => {
        const { lastMessageAt, lastMessagePreview } = await this.inspectRecentTargetActivity(channel, {
          channelId: channel.id,
          targetKind: "channel"
        });

        const category = channel.parentId ? categoryMap.get(channel.parentId) : null;
        return {
          categoryId: category?.id ?? null,
          categoryName: category?.name ?? null,
          channelId: channel.id,
          channelName: channel.name,
          codexThreadId: this.parseCodexThreadIdFromTopic(channel.topic),
          lastMessageAt,
          lastMessagePreview
        } satisfies DiscordManagedChannelSnapshot;
      })
    );

    const managedParentIds = new Set(managedChannels.map((channel) => channel.id));
    const managedThreads = new Map<string, ThreadChannel>();
    for (const parentChannel of managedChannels) {
      const threads = await this.fetchBridgeOwnedThreadsForParent(parentChannel, managedParentIds);
      for (const thread of threads) {
        managedThreads.set(thread.id, thread);
      }
    }

    const channelById = new Map(managedChannels.map((channel) => [channel.id, channel]));
    const threadSnapshots = await Promise.all(
      [...managedThreads.values()].map(async (thread) => {
        const { lastMessageAt, lastMessagePreview } = await this.inspectRecentTargetActivity(thread, {
          channelId: thread.id,
          targetKind: "thread"
        });
        const parentChannel = thread.parentId ? channelById.get(thread.parentId) ?? null : null;
        const category = parentChannel?.parentId ? categoryMap.get(parentChannel.parentId) : null;
        return {
          categoryId: category?.id ?? null,
          categoryName: category?.name ?? null,
          parentChannelId: parentChannel?.id ?? thread.parentId ?? null,
          parentChannelName: parentChannel?.name ?? null,
          threadId: thread.id,
          threadName: thread.name,
          ownerId: thread.ownerId ?? null,
          archived: Boolean(thread.archived),
          locked: Boolean(thread.locked),
          lastMessageAt,
          lastMessagePreview
        } satisfies DiscordManagedThreadSnapshot;
      })
    );

    const categories = [...categoryMap.values()]
      .map((category) => ({
        id: category.id,
        name: category.name,
        channelCount: managedChannels.filter((channel) => channel.parentId === category.id).length
      }))
      .filter((category) => category.channelCount > 0)
      .sort((left, right) => left.name.localeCompare(right.name));

    return {
      guildId: guild.id,
      guildName: guild.name,
      categories,
      channels: channelSnapshots
        .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))
        .slice(0, limit),
      threads: threadSnapshots
        .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))
        .slice(0, limit)
    };
  }

  async inspectChannelMessages(channelId: string, limit = 10): Promise<DiscordMessageSnapshot[]> {
    const target = await this.fetchTargetChannel(channelId);
    const messages = await target.messages.fetch({ limit });
    return [...messages.values()]
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .map((message) => this.serializeMessageSnapshot(message));
  }

  async ensureProjectCategory(
    projectKey: string,
    projectName: string,
    existingCategoryId: string | null,
    operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }> {
    const startedAt = startupTimingNow();
    const guild = await this.getGuild();
    const desiredName = formatDiscordCategoryName(projectName);
    const existing = await this.fetchExistingChannelOrNull(
      existingCategoryId,
      "Discord category mapping points to a missing channel. Recreating it.",
      operationContext
    );
    if (existing?.type === ChannelType.GuildCategory) {
      if (existing.name !== desiredName) {
        await existing.edit({
          name: desiredName,
          reason: `Rename project category for ${projectKey}`
        });
      }
      this.logStartupTiming(
        `discord category project=${projectKey} created=false total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
      );
      return { id: existing.id, created: false };
    }

    const created = await guild.channels.create({
      name: desiredName,
      type: ChannelType.GuildCategory,
      reason: `Create Codex project category for ${projectKey}`
    });
    this.rememberGuildChannelSnapshotEntry(created, operationContext);
    this.logStartupTiming(
      `discord category project=${projectKey} created=true total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
    );
    return { id: created.id, created: true };
  }

  async ensureConversationChannel(
    codexThreadId: string,
    title: string,
    categoryId: string,
    existingDiscordChannelId: string | null,
    operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }> {
    const startedAt = startupTimingNow();
    const guild = await this.getGuild();
    const desiredName = formatDiscordChannelName(title, `thread-${shortThreadId(codexThreadId)}`);
    const bridgeScope = this.normalizeBridgeScope(operationContext?.projectScope);
    const topic = this.buildConversationChannelTopic(codexThreadId, bridgeScope);
    const existing = await this.fetchExistingChannelOrNull(
      existingDiscordChannelId,
      "Discord conversation channel mapping points to a missing channel. Recreating it.",
      operationContext
    );
    const channels = await this.fetchGuildChannels(guild, operationContext);
    const textChannels = [...channels.values()].filter(
      (channel): channel is TextChannel => channel !== null && channel.type === ChannelType.GuildText
    );
    const canReuseExisting =
      existing?.type === ChannelType.GuildText &&
      (
        operationContext?.isolateProjectCategory !== true ||
        (existing.parentId === categoryId && this.parseBridgeScopeFromTopic(existing.topic) === bridgeScope)
      );
    if (canReuseExisting) {
      await this.syncConversationChannel(existing, desiredName, categoryId, topic, codexThreadId);
      await this.deleteDuplicateConversationChannels(
        textChannels.filter(
          (channel) =>
            channel.id !== existing.id &&
            this.isBridgeManagedConversationChannel(channel) &&
            this.parseCodexThreadIdFromTopic(channel.topic) === codexThreadId
        ),
        codexThreadId,
        operationContext
      );
      this.logStartupTiming(
        `discord conversation ${shortThreadId(codexThreadId)} created=false reused=existing total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
      );
      return { id: existing.id, created: false };
    }

    const selection = selectCanonicalConversationChannel(
      textChannels.map((channel) => this.toConversationChannelCandidate(channel)),
      {
        codexThreadId,
        desiredName,
        categoryId,
        preferredChannelId: existingDiscordChannelId,
        allowCrossCategoryExactMatch: operationContext?.isolateProjectCategory !== true,
        bridgeScope
      }
    );
    if (selection.canonical) {
      const canonicalChannel = textChannels.find((channel) => channel.id === selection.canonical?.id);
      if (canonicalChannel) {
        await this.syncConversationChannel(canonicalChannel, desiredName, categoryId, topic, codexThreadId);
        await this.deleteDuplicateConversationChannels(
          textChannels.filter((channel) => selection.duplicates.some((duplicate) => duplicate.id === channel.id)),
          codexThreadId,
          operationContext
        );
        this.logStartupTiming(
          `discord conversation ${shortThreadId(codexThreadId)} created=false reused=canonical total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
        );
        return { id: canonicalChannel.id, created: false };
      }
    }

    const created = (await guild.channels.create({
      name: desiredName,
      type: ChannelType.GuildText,
      parent: categoryId,
      topic,
      reason: `Attach Codex thread ${codexThreadId}`
    })) as TextChannel;
    this.rememberGuildChannelSnapshotEntry(created, operationContext);
    this.logStartupTiming(
      `discord conversation ${shortThreadId(codexThreadId)} created=true total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
    );
    return { id: created.id, created: true };
  }

  async ensureSubagentThread(
    codexThreadId: string,
    title: string,
    parentChannelId: string,
    existingDiscordChannelId: string | null,
    operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }> {
    const parentChannel = await this.fetchTextChannel(parentChannelId, operationContext);
    const desiredName = formatDiscordThreadName(title, `Sub-agent ${shortThreadId(codexThreadId)}`);
    const existing = await this.fetchExistingChannelOrNull(
      existingDiscordChannelId,
      "Discord sub-agent thread mapping points to a missing thread. Recreating it.",
      operationContext
    );
    if (existing?.isThread()) {
      await this.ensureThreadIsWritable(existing);
      if (existing.name !== desiredName) {
        await existing.setName(desiredName, "Sync Codex sub-agent thread");
      }
      return { id: existing.id, created: false };
    }

    const created = await parentChannel.threads.create({
      name: desiredName,
      type: ChannelType.PublicThread,
      autoArchiveDuration: 1440,
      reason: `Attach Codex sub-agent ${codexThreadId}`
    });
    this.evictWritableTarget(parentChannelId, operationContext);
    return { id: created.id, created: true };
  }

  async countConversationChannelsInCategory(categoryId: string): Promise<number> {
    const guild = await this.getGuild();
    const channels = await guild.channels.fetch();
    return channels.filter(
      (channel) =>
        channel !== null &&
        channel.type === ChannelType.GuildText &&
        channel.parentId === categoryId
    ).size;
  }

  async deleteDiscordLocation(channelId: string, reason: string): Promise<void> {
    let channel = null;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (error) {
      if (this.isUnknownChannelError(error)) {
        return;
      }
      throw error;
    }
    if (!channel) {
      return;
    }

    if (channel.isThread()) {
      await this.deleteParentThreadNotificationMessages(channel);
      await channel.delete(reason);
      return;
    }

    if (
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildCategory
    ) {
      await channel.delete(reason);
    }
  }

  private async deleteParentThreadNotificationMessages(thread: ThreadChannel): Promise<void> {
    const parentId = thread.parentId;
    if (!parentId) {
      return;
    }

    let parentChannel = thread.parent;
    if (!parentChannel) {
      try {
        const fetchedParent = await this.client.channels.fetch(parentId);
        if (fetchedParent?.type === ChannelType.GuildText) {
          parentChannel = fetchedParent;
        }
      } catch (error) {
        if (this.isUnknownChannelError(error)) {
          return;
        }
        this.logger.warn(
          { error, threadId: thread.id, parentChannelId: parentId },
          "Failed to resolve a Discord parent channel while deleting a child thread."
        );
        return;
      }
    }

    if (!parentChannel || parentChannel.type !== ChannelType.GuildText) {
      return;
    }

    let before: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      let messages;
      try {
        messages = await parentChannel.messages.fetch(
          before
            ? {
                limit: 100,
                before
              }
            : {
                limit: 100
              }
        );
      } catch (error) {
        if (this.isUnknownChannelError(error)) {
          return;
        }
        this.logger.warn(
          { error, threadId: thread.id, parentChannelId: parentChannel.id },
          "Failed to inspect a Discord parent channel while deleting a child thread."
        );
        return;
      }

      if (messages.size === 0) {
        return;
      }

      const matches = [...messages.values()].filter(
        (message) => message.hasThread && message.thread?.id === thread.id
      );
      for (const message of matches) {
        try {
          await message.delete();
        } catch (error) {
          if (this.isUnknownMessageError(error) || this.isUnknownChannelError(error)) {
            continue;
          }
          this.logger.warn(
            { error, threadId: thread.id, parentChannelId: parentChannel.id, messageId: message.id },
            "Failed to delete a Discord child-thread notification message."
          );
        }
      }

      if (matches.length > 0) {
        return;
      }
      before = messages.last()?.id;
      if (!before) {
        return;
      }
    }
  }

  async discoverBridgeManagedLocations(seedCategoryIds: string[], options: {
    restrictToSeedCategories?: boolean;
    requiredScope?: string | null;
  } = {}): Promise<{
    categoryIds: string[];
    channelIds: string[];
  }> {
    const guild = await this.getGuild();
    const channels = await guild.channels.fetch();
    const categoryIds = new Set<string>(seedCategoryIds);
    const seedCategorySet = new Set(seedCategoryIds);
    const requiredScope = this.normalizeBridgeScope(options.requiredScope);
    const channelIds = new Set<string>();

    for (const channel of channels.values()) {
      if (!channel || channel.type !== ChannelType.GuildText) {
        continue;
      }
      if (
        options.restrictToSeedCategories &&
        (!channel.parentId || !seedCategorySet.has(channel.parentId))
      ) {
        continue;
      }

      const scopeMatches = requiredScope === null || this.parseBridgeScopeFromTopic(channel.topic) === requiredScope;
      if (this.isBridgeManagedConversationChannel(channel) && scopeMatches) {
        channelIds.add(channel.id);
        if (channel.parentId) {
          categoryIds.add(channel.parentId);
        }
        continue;
      }

      if (!requiredScope && await this.hasBridgeManagedMessages(channel)) {
        channelIds.add(channel.id);
        if (channel.parentId) {
          categoryIds.add(channel.parentId);
        }
      }
    }

    const safeCategoryIds = [...categoryIds].filter((categoryId) => {
      const childTextChannels = [...channels.values()].filter(
        (channel): channel is TextChannel =>
          channel !== null &&
          channel.type === ChannelType.GuildText &&
          channel.parentId === categoryId
      );
      // Include empty seeded/discovered categories so clean can remove them after channel deletion.
      // Keep the guard for non-empty categories: only delete when every child text channel is bridge-managed.
      if (childTextChannels.length === 0) {
        return true;
      }
      return childTextChannels.every((channel) => channelIds.has(channel.id));
    });

    return {
      categoryIds: safeCategoryIds,
      channelIds: [...channelIds]
    };
  }

  async upsertStatusCard(
    channelId: string,
    messageId: string | null,
    view: StatusCardView,
    operationContext?: ProviderOperationContext
  ): Promise<string> {
    const startedAt = startupTimingNow();
    const target = await this.fetchWritableTargetChannel(channelId, operationContext);
    const content = renderStatusCard(view);

    const lookupStartedAt = startupTimingNow();
    const existing = await this.findExistingStatusCard(target, view, messageId, operationContext);
    const lookupDurationMs = startupTimingNow() - lookupStartedAt;
    if (existing) {
      try {
        const editStartedAt = startupTimingNow();
        await existing.edit({ content, allowedMentions: NO_ALLOWED_MENTIONS });
        if (!existing.pinned) {
          await this.tryPinMessage(existing, "Pin Codex live status");
        }
        this.clearKnownEmptyStatusCardChannel(channelId, operationContext);
        this.rememberFetchedMessage(channelId, existing, operationContext);
        recordStartupWrite(operationContext, "status");
        this.logStartupTiming(
          `discord status-card channel=${channelId} mode=edit lookup=${formatStartupTimingMs(lookupDurationMs)} edit=${formatStartupTimingMs(startupTimingNow() - editStartedAt)} total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
        );
        return existing.id;
      } catch (error) {
        this.logger.warn({ error, channelId, messageId: existing.id }, "Failed to update existing status card.");
      }
    }

    const sendStartedAt = startupTimingNow();
    const created = await this.sendTargetMessage(target, { content, allowedMentions: NO_ALLOWED_MENTIONS });
    await this.tryPinMessage(created, "Pin Codex live status");
    this.clearKnownEmptyStatusCardChannel(channelId, operationContext);
    this.rememberFetchedMessage(channelId, created, operationContext);
    recordStartupWrite(operationContext, "status");
    this.logStartupTiming(
      `discord status-card channel=${channelId} mode=create lookup=${formatStartupTimingMs(lookupDurationMs)} send+pin=${formatStartupTimingMs(startupTimingNow() - sendStartedAt)} total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
    );
    return created.id;
  }

  async postMilestone(channelId: string, content: string): Promise<void> {
    const target = await this.fetchWritableTargetChannel(channelId);
    await this.sendTargetMessage(target, { content, allowedMentions: NO_ALLOWED_MENTIONS });
  }

  async upsertLiveTextMessage(
    channelId: string,
    messageId: string | null,
    content: string,
    options: ProviderMessageOptions = {}
  ): Promise<string> {
    const startedAt = startupTimingNow();
    const target = await this.fetchWritableTargetChannel(channelId, options.operationContext);
    const payload: ProviderMessagePayload = {
      content,
      components: this.buildMessageComponents(options),
      allowedMentions: NO_ALLOWED_MENTIONS
    };
    const existingId = await this.tryUpdateExistingMessage(target, channelId, messageId, payload, {
      warnContext: { channelId, messageId },
      warnMessage: "Failed to update live Codex message.",
      suppressWarn: (error) => this.isUnknownChannelError(error) || this.isUnknownMessageError(error),
      ...(options.operationContext ? { operationContext: options.operationContext } : {})
    });
    if (existingId) {
      recordStartupWrite(options.operationContext, "live");
      this.logStartupTiming(
        `discord live-message channel=${channelId} mode=edit length=${content.length} total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
      );
      return existingId;
    }

    const created = await this.sendTargetMessage(target, payload);
    this.rememberFetchedMessage(channelId, created, options.operationContext);
    const id = created.id;
    recordStartupWrite(options.operationContext, "live");
    this.logStartupTiming(
      `discord live-message channel=${channelId} mode=create length=${content.length} total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
    );
    return id;
  }

  async sendTextMessage(
    channelId: string,
    content: string,
    options: ProviderMessageOptions = {}
  ): Promise<string> {
    const startedAt = startupTimingNow();
    const target = await this.fetchWritableTargetChannel(channelId, options.operationContext);
    const created = await this.sendTargetMessage(target, {
      content,
      components: this.buildMessageComponents(options),
      allowedMentions: NO_ALLOWED_MENTIONS
    });
    this.rememberFetchedMessage(channelId, created, options.operationContext);
    recordStartupWrite(options.operationContext, "text");
    this.logStartupTiming(
      `discord text-message channel=${channelId} length=${content.length} total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
    );
    return created.id;
  }

  async postApprovalCard(
    channelId: string,
    existingMessageId: string | null,
    view: ApprovalCardView
  ): Promise<string> {
    const content = renderApprovalCard(view);
    const components = this.buildApprovalComponents(view, false);
    const target = await this.fetchWritableTargetChannel(channelId);
    const existingId = await this.tryUpdateExistingMessage(
      target,
      channelId,
      existingMessageId,
      { content, components, allowedMentions: NO_ALLOWED_MENTIONS },
      {
        warnContext: { existingMessageId, channelId },
        warnMessage: "Failed to refresh approval card."
      }
    );
    if (existingId) {
      return existingId;
    }

    const message = await this.sendTargetMessage(target, {
      content: renderApprovalCard(view, null, { includeMention: true }),
      components,
      allowedMentions: this.buildApprovalAllowedMentions(view)
    });
    return message.id;
  }

  async disableApprovalCard(
    channelId: string,
    messageId: string,
    resolutionText: string,
    view: ApprovalCardView
  ): Promise<void> {
    try {
      await this.editChannelMessage(channelId, messageId, () => ({
        content: renderApprovalCard(view, resolutionText),
        components: [],
        allowedMentions: NO_ALLOWED_MENTIONS
      }));
    } catch (error) {
      if (this.isUnknownMessageError(error) || this.isUnknownChannelError(error)) {
        this.evictFetchedMessage(channelId, messageId);
        this.logger.warn(
          { error, channelId, messageId, approvalToken: view.token },
          "Approval card was already missing while disabling it."
        );
        return;
      }
      throw error;
    }
  }

  async markApprovalCardStale(channelId: string, messageId: string, view: ApprovalCardView): Promise<void> {
    await this.disableApprovalCard(
      channelId,
      messageId,
      "⚠️ Bridge restarted. Waiting for a fresh approval request from Codex.",
      view
    );
  }

  async updateMessageDetailsButtons(
    channelId: string,
    messageId: string,
    buttons: ProviderDetailButton[]
  ): Promise<void> {
    await this.editChannelMessage(channelId, messageId, (message) => ({
      content: message.content,
      components: this.buildMessageComponents({ detailButtons: buttons }),
      allowedMentions: NO_ALLOWED_MENTIONS
    }));
  }

  async deleteMessages(channelId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const target = await this.fetchTargetChannel(channelId);
    for (const messageId of [...new Set(messageIds)]) {
      try {
        const message = await target.messages.fetch(messageId);
        await message.delete();
      } catch (error) {
        if (this.isUnknownMessageError(error) || this.isUnknownChannelError(error)) {
          continue;
        }
        this.logger.warn({ error, channelId, messageId }, "Failed to delete mirrored Discord message.");
      }
    }
  }

  async detachDiscordLocation(channelId: string, codexThreadId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      return;
    }
    if (channel.isThread()) {
      await channel.setName(
        formatDiscordThreadName(channel.name, `Detached ${shortThreadId(codexThreadId)}`),
        "Detach Codex bridge thread"
      );
      return;
    }
    if (channel.type === ChannelType.GuildText) {
      await channel.setTopic(
        `[codex-detached] former-thread:${codexThreadId}`,
        `Detach Codex thread ${codexThreadId} from bridge management`
      );
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) {
        await this.handleChatCommand(interaction);
        return;
      }

      if (interaction.isButton()) {
        await this.handleButton(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        await this.handleModalSubmit(interaction);
      }
    } catch (error) {
      if (this.isUnknownInteractionError(error) || this.isInteractionAlreadyAcknowledgedError(error)) {
        this.logger.warn({ error }, "Discord interaction expired or was already acknowledged.");
        return;
      }
      this.logger.warn({ error }, "Discord interaction handling failed.");
      try {
        await this.respondToInteractionError(interaction, "The command failed. Check the bridge terminal for details.");
      } catch (responseError) {
        if (
          this.isUnknownInteractionError(responseError) ||
          this.isInteractionAlreadyAcknowledgedError(responseError)
        ) {
          this.logger.warn(
            { error: responseError },
            "Discord interaction error response was already acknowledged or expired."
          );
          return;
        }
        throw responseError;
      }
    }
  }

  private async handlePlainTextMessage(message: Message): Promise<void> {
    const config = this.config.messageWriteBacks;
    if (!config?.allowFromDiscord || !config.plainTextChannelIds?.includes(message.channelId) ||
        !message.inGuild() || message.guildId !== this.config.guildId ||
        message.channel.type !== ChannelType.GuildText || message.author.bot || message.webhookId ||
        message.system || message.partial ||
        (message.type !== MessageType.Default && message.type !== MessageType.Reply) ||
        message.editedTimestamp !== null || message.createdTimestamp < this.messageListeningSince ||
        !config.allowedUserIds.includes(message.author.id)) {
      return;
    }
    if (message.attachments.size > 0 || message.stickers.size > 0) {
      await message.reply({
        content: "現在は文字だけの指示に対応しています。添付やスタンプを外して送信してください。",
        allowedMentions: { parse: [], repliedUser: false }
      });
      return;
    }
    if (!message.content.trim()) return;
    const result = await this.requireHandlers().onSendCommand(
      { userId: message.author.id, roleIds: [], username: message.author.username },
      message.channelId, message.content, "queue", message.id
    );
    // The original Discord post already shows the input. Do not quote it again.
    if (!result.content || result.content.startsWith("Started a new Codex turn.")) return;
    await message.reply({
      content: result.content.startsWith("Queued for the next turn.")
        ? "次のターンに追加しました。"
        : result.content.split("\n>")[0]!,
      allowedMentions: { parse: [], repliedUser: false }
    });
  }

  private async handleChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const handlers = this.requireHandlers();
    if (interaction.commandName !== "codex") {
      return;
    }

    const actor = this.extractActor(interaction);
    const subcommand = interaction.options.getSubcommand(true);
    const shouldDefer =
      subcommand === "send" ||
      subcommand === "retract" ||
      subcommand === "attach" ||
      subcommand === "detach" ||
      subcommand === "cleanid" ||
      subcommand === "cleanall";

    if (shouldDefer) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    let result: DiscordCommandResult;
    if (subcommand === "status") {
      result = await handlers.onStatusCommand(actor);
    } else if (subcommand === "send") {
      const mode = interaction.options.getString("mode", false);
      result = await handlers.onSendCommand(
        actor,
        interaction.channelId,
        interaction.options.getString("text", true),
        mode === "steer" ? "steer" : "queue"
      );
    } else if (subcommand === "retract") {
      result = await handlers.onRetractCommand(actor, interaction.channelId);
    } else if (subcommand === "attach") {
      result = await handlers.onAttachCommand(actor, interaction.options.getString("thread_id", true));
    } else if (subcommand === "detach") {
      result = await handlers.onDetachCommand(actor, interaction.options.getString("thread_id", true));
    } else if (subcommand === "cleanid") {
      result = await handlers.onCleanIdCommand(actor, interaction.options.getString("thread_id", true));
    } else if (subcommand === "cleanall") {
      result = await handlers.onCleanAllCommand(actor);
    } else {
      result = await handlers.onHelpCommand(actor);
    }

    if (shouldDefer) {
      await interaction.editReply({
        content: result.content,
        components: this.buildCommandResultComponents(result.buttons),
        allowedMentions: NO_ALLOWED_MENTIONS
      });
      return;
    }

    await interaction.reply({
      content: result.content,
      components: this.buildCommandResultComponents(result.buttons),
      flags: result.ephemeral === false ? undefined : MessageFlags.Ephemeral,
      allowedMentions: NO_ALLOWED_MENTIONS
    });
  }

  private async handleButton(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) {
      return;
    }

    const [prefix, action, token, ...decisionParts] = interaction.customId.split(":");
    if (prefix !== "codex" || !token) {
      return;
    }

    const handlers = this.requireHandlers();
    const actor = this.extractActor(interaction);
    let result: DiscordCommandResult;
    if (action === "writeback") {
      const writeBackAction = token === "retract" || token === "steer" ? token : null;
      const queueItemId = Number(decisionParts[0] ?? "");
      if (!writeBackAction || !Number.isSafeInteger(queueItemId)) {
        return;
      }
      await interaction.deferUpdate();
      result = await handlers.onWriteBackButton(actor, writeBackAction, queueItemId);
      await interaction.editReply({
        content: result.content,
        components: this.buildCommandResultComponents(result.buttons),
        allowedMentions: NO_ALLOWED_MENTIONS
      });
      return;
    } else if (action === "plan") {
      const planAction = decisionParts[0];
      if (planAction === "feedback") {
        await interaction.showModal(this.buildProposedPlanFeedbackModal(token));
        return;
      }
      if (planAction !== "accept") {
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      result = await handlers.onProposedPlanAction(actor, token, "accept");
      await interaction.editReply({
        content: result.content,
        components: this.buildCommandResultComponents(result.buttons),
        allowedMentions: NO_ALLOWED_MENTIONS
      });
      return;
    } else if (action === "details") {
      result = await handlers.onApprovalDetails(actor, token);
    } else if (action === "message-details") {
      result = await handlers.onMessageDetails(actor, token);
    } else if (action === "feedback") {
      await interaction.showModal(this.buildApprovalFeedbackModal(token));
      return;
    } else if (action === "input-other") {
      const questionIndex = Number(decisionParts[0] ?? "");
      if (!Number.isSafeInteger(questionIndex)) {
        return;
      }
      await interaction.showModal(this.buildToolInputOtherModal(token, questionIndex));
      return;
    } else if (action === "input") {
      const questionIndex = Number(decisionParts[0] ?? "");
      const optionIndex = Number(decisionParts[1] ?? "");
      if (!Number.isSafeInteger(questionIndex) || !Number.isSafeInteger(optionIndex)) {
        return;
      }
      await interaction.deferUpdate();
      result = await handlers.onToolInputOption(actor, token, questionIndex, optionIndex);
      if (result.content.trim()) {
        await interaction.followUp({
          content: result.content,
          flags: result.ephemeral === false ? undefined : MessageFlags.Ephemeral,
          allowedMentions: NO_ALLOWED_MENTIONS
        });
      }
      return;
    } else if (action === "decision") {
      const decision = decisionParts.join(":");
      if (!decision) {
        return;
      }
      await interaction.deferUpdate();
      result = await handlers.onApprovalAction(actor, token, decision);
      if (result.content.trim()) {
        await interaction.followUp({
          content: result.content,
          flags: result.ephemeral === false ? undefined : MessageFlags.Ephemeral,
          allowedMentions: NO_ALLOWED_MENTIONS
        });
      }
      return;
    } else {
      return;
    }

    await interaction.reply({
      content: result.content,
      flags: result.ephemeral === false ? undefined : MessageFlags.Ephemeral,
      allowedMentions: NO_ALLOWED_MENTIONS
    });
  }

  private async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const [prefix, action, token, indexPart] = interaction.customId.split(":");
    if (prefix !== "codex" || !token) {
      return;
    }

    const handlers = this.requireHandlers();
    const actor = this.extractActor(interaction);
    if (action === "input-other-submit") {
      const questionIndex = Number(indexPart ?? "");
      if (!Number.isSafeInteger(questionIndex)) {
        return;
      }
      const answer = interaction.fields.getTextInputValue("answer").trim();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await handlers.onToolInputOther(actor, token, questionIndex, answer);
      if (result.content.trim()) {
        await interaction.editReply({
          content: result.content,
          allowedMentions: NO_ALLOWED_MENTIONS
        });
        return;
      }
      await interaction.deleteReply().catch(() => undefined);
      return;
    }
    if (action === "plan-feedback-submit") {
      const feedback = interaction.fields.getTextInputValue("feedback").trim();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await handlers.onProposedPlanFeedback(actor, token, feedback);
      if (result.content.trim()) {
        await interaction.editReply({
          content: result.content,
          components: this.buildCommandResultComponents(result.buttons),
          allowedMentions: NO_ALLOWED_MENTIONS
        });
        return;
      }
      await interaction.deleteReply().catch(() => undefined);
      return;
    }
    if (action !== "feedback-submit") {
      return;
    }
    const feedback = interaction.fields.getTextInputValue("feedback").trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await handlers.onApprovalFeedback(actor, token, feedback);
    if (result.content.trim()) {
      await interaction.editReply({
        content: result.content,
        allowedMentions: NO_ALLOWED_MENTIONS
      });
      return;
    }
    await interaction.deleteReply().catch(() => undefined);
  }

  private buildCommandResultComponents(buttons: DiscordCommandButton[] | undefined): Array<ActionRowBuilder<ButtonBuilder>> {
    const renderedButtons = (buttons ?? []).slice(0, 5).map((button) =>
      new ButtonBuilder()
        .setCustomId(button.customId)
        .setLabel(button.label)
        .setStyle(this.commandButtonStyle(button.style))
    );
    return renderedButtons.length > 0
      ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...renderedButtons)]
      : [];
  }

  private commandButtonStyle(style: DiscordCommandButton["style"]): ButtonStyle {
    if (style === "primary") {
      return ButtonStyle.Primary;
    }
    if (style === "danger") {
      return ButtonStyle.Danger;
    }
    return ButtonStyle.Secondary;
  }

  private buildApprovalComponents(view: ApprovalCardView, disabled: boolean) {
    if (view.kind === "toolUserInput" && view.toolInput?.questions.length) {
      return this.buildToolInputComponents(view, disabled);
    }

    const decisions = view.actionsEnabled ? [...view.availableDecisions] : [];
    decisions.sort((left, right) => this.approvalDecisionPriority(left) - this.approvalDecisionPriority(right));
    const includeFeedback = this.shouldIncludeApprovalFeedbackButton(view, decisions);
    const renderedDecisions = canRenderDiscordApprovalDecisions({
      token: view.token,
      decisions,
      includeFeedback
    })
      ? decisions
      : [];

    const positiveButtons = renderedDecisions
      .filter((decision) => this.isPositiveApprovalDecision(decision))
      .map((decision) =>
        new ButtonBuilder()
          .setCustomId(buildApprovalDecisionCustomId(view.token, decision))
          .setLabel(formatApprovalDecisionLabel(decision))
          .setStyle(this.approvalDecisionStyle(decision))
          .setDisabled(disabled)
      );
    const negativeButtons = renderedDecisions
      .filter((decision) => !this.isPositiveApprovalDecision(decision))
      .map((decision) =>
        new ButtonBuilder()
          .setCustomId(buildApprovalDecisionCustomId(view.token, decision))
          .setLabel(formatApprovalDecisionLabel(decision))
          .setStyle(this.approvalDecisionStyle(decision))
          .setDisabled(disabled)
      );
    const feedbackButtons = this.shouldIncludeApprovalFeedbackButton(view, renderedDecisions)
      ? [
          new ButtonBuilder()
            .setCustomId(`codex:feedback:${view.token}`)
            .setLabel(TELL_CODEX_DIFFERENTLY_LABEL)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || !view.actionsEnabled)
        ]
      : [];
    const buttons = [
      ...positiveButtons,
      ...feedbackButtons,
      ...negativeButtons,
      new ButtonBuilder()
        .setCustomId(`codex:details:${view.token}`)
        .setLabel("Show details")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    ];

    return this.buildButtonRows(buttons);
  }

  private buildToolInputComponents(view: ApprovalCardView, disabled: boolean) {
    const toolInput = view.toolInput;
    if (!toolInput || !view.actionsEnabled || !canRenderDiscordToolInput({ token: view.token, toolInput })) {
      return this.buildButtonRows([
        new ButtonBuilder()
          .setCustomId(`codex:details:${view.token}`)
          .setLabel("Show details")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      ]);
    }

    const rows: Array<ActionRowBuilder<ButtonBuilder>> = [];
    const questionIndex = findNextToolInputQuestionIndex(toolInput);
    const question = toolInput.questions[questionIndex];
    if (!question) {
      return this.buildButtonRows([
        new ButtonBuilder()
          .setCustomId(`codex:details:${view.token}`)
          .setLabel("Show details")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      ]);
    }

    const selectedAnswer = toolInput.selectedAnswers[question.id] ?? null;
    const selectedMatchesStandardOption = question.options.some(
      (option) => !option.isOther && option.label === selectedAnswer
    );
    const buttons = question.options.map((option, optionIndex) => {
      const isSelected =
        selectedAnswer === option.label ||
        (option.isOther === true &&
          selectedAnswer !== null &&
          selectedAnswer.trim().length > 0 &&
          !selectedMatchesStandardOption);
      return new ButtonBuilder()
        .setCustomId(
          option.isOther
            ? buildToolInputOtherCustomId(view.token, questionIndex)
            : buildToolInputOptionCustomId(view.token, questionIndex, optionIndex)
        )
        .setLabel(formatToolInputOptionLabel(option.label, isSelected))
        .setStyle(isSelected ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled);
    });
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));

    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`codex:details:${view.token}`)
          .setLabel("Show details")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      )
    );
    return rows;
  }

  private shouldIncludeApprovalFeedbackButton(view: ApprovalCardView, decisions: string[]): boolean {
    return view.actionsEnabled && view.kind !== "mcpElicitation" && supportsApprovalFeedback(decisions);
  }

  private buildApprovalFeedbackModal(token: string): ModalBuilder {
    return this.buildFeedbackModal(`codex:feedback-submit:${token}`);
  }

  private buildProposedPlanFeedbackModal(token: string): ModalBuilder {
    return this.buildFeedbackModal(buildProposedPlanFeedbackSubmitCustomId(token));
  }

  private buildFeedbackModal(customId: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(customId)
      .setTitle("Tell Codex what to do differently")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("feedback")
            .setLabel("What should Codex do differently?")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000)
        )
      );
  }

  private buildToolInputOtherModal(token: string, questionIndex: number): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(buildToolInputOtherSubmitCustomId(token, questionIndex))
      .setTitle("Answer Codex")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("answer")
            .setLabel("Answer")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000)
        )
      );
  }

  private buildMessageComponents(
    options: ProviderMessageOptions
  ): Array<ActionRowBuilder<ButtonBuilder>> {
    const actionButtons = (options.actionButtons ?? []).map((button) =>
      new ButtonBuilder()
        .setCustomId(button.customId)
        .setLabel(button.label)
        .setStyle(this.commandButtonStyle(button.style))
    );
    const detailButtons = (options.detailButtons ?? []).map((button) =>
      new ButtonBuilder()
        .setCustomId(`codex:message-details:${button.token}`)
        .setLabel(button.label)
        .setStyle(ButtonStyle.Secondary)
    );
    const buttons = [...actionButtons, ...detailButtons];
    if (buttons.length === 0) {
      return [];
    }

    return this.buildButtonRows(buttons);
  }

  private buildButtonRows(buttons: ButtonBuilder[]): Array<ActionRowBuilder<ButtonBuilder>> {
    const rows: Array<ActionRowBuilder<ButtonBuilder>> = [];
    for (let index = 0; index < buttons.length; index += 5) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(index, index + 5)));
    }
    return rows;
  }

  private async fetchExistingChannelOrNull(
    channelId: string | null,
    missingMessage: string,
    operationContext?: ProviderOperationContext
  ): Promise<Awaited<ReturnType<Client["channels"]["fetch"]>> | null> {
    if (!channelId) {
      return null;
    }

    try {
      return await this.fetchChannel(channelId, operationContext);
    } catch (error) {
      if (!this.isUnknownChannelError(error)) {
        throw error;
      }
      this.evictWritableTarget(channelId, operationContext);
      this.logger.warn({ error, channelId }, missingMessage);
      return null;
    }
  }

  private async syncConversationChannel(
    channel: TextChannel,
    desiredName: string,
    categoryId: string,
    topic: string,
    codexThreadId: string
  ): Promise<void> {
    const updates: { name?: string; parent?: string; reason: string } = {
      reason: `Sync Codex thread ${codexThreadId}`
    };
    if (channel.name !== desiredName) {
      updates.name = desiredName;
    }
    if (channel.parentId !== categoryId) {
      updates.parent = categoryId;
    }
    if (updates.name || updates.parent) {
      await channel.edit({
        ...updates,
        topic
      });
    }
    if (channel.topic !== topic) {
      await channel.setTopic(topic, `Mark Codex thread ${codexThreadId} as bridge-managed`);
    }
  }

  private async deleteDuplicateConversationChannels(
    channels: TextChannel[],
    codexThreadId: string,
    operationContext?: ProviderOperationContext
  ): Promise<void> {
    for (const channel of channels) {
      try {
        await channel.delete(`Remove duplicate Codex bridge channel for ${codexThreadId}`);
        this.removeGuildChannelSnapshotEntry(channel.id, operationContext);
        this.evictWritableTarget(channel.id, operationContext);
      } catch (error) {
        if (this.isUnknownChannelError(error)) {
          continue;
        }
        this.logger.warn(
          { error, channelId: channel.id, codexThreadId },
          "Failed to delete a duplicate bridge-managed Discord conversation channel."
        );
      }
    }
  }

  private getStartupSession(operationContext?: ProviderOperationContext): DiscordStartupSession | null {
    const startup = operationContext?.startup;
    if (!startup || startup.startupPhase !== "cold-attach") {
      return null;
    }
    const existing = this.startupSessions.get(startup);
    if (existing) {
      return existing;
    }
    const created: DiscordStartupSession = {
      guildChannels: null,
      writableTargets: new Map<string, BridgeTargetChannel>(),
      messages: new Map<string, Message<true>>(),
      knownEmptyStatusCardChannels: new Set<string>()
    };
    this.startupSessions.set(startup, created);
    return created;
  }

  private async fetchGuildChannels(
    guild: Guild,
    operationContext?: ProviderOperationContext
  ): Promise<GuildChannelSnapshot> {
    const session = this.getStartupSession(operationContext);
    if (session?.guildChannels) {
      recordStartupCacheStat(operationContext, "channelSnapshotHits");
      return session.guildChannels;
    }
    recordStartupCacheStat(operationContext, "channelSnapshotMisses");
    const channels = await guild.channels.fetch();
    if (session) {
      session.guildChannels = channels;
    }
    return channels;
  }

  private rememberGuildChannelSnapshotEntry(
    channel: NonThreadGuildBasedChannel,
    operationContext?: ProviderOperationContext
  ): void {
    if (!channel) {
      return;
    }
    const session = this.getStartupSession(operationContext);
    session?.guildChannels?.set(channel.id, channel);
  }

  private removeGuildChannelSnapshotEntry(channelId: string, operationContext?: ProviderOperationContext): void {
    const session = this.getStartupSession(operationContext);
    session?.guildChannels?.delete(channelId);
  }

  private async fetchChannel(
    channelId: string,
    operationContext?: ProviderOperationContext
  ): Promise<Awaited<ReturnType<Client["channels"]["fetch"]>>> {
    const session = this.getStartupSession(operationContext);
    const snapshotChannel = session?.guildChannels?.get(channelId) ?? undefined;
    if (snapshotChannel !== undefined) {
      recordStartupCacheStat(operationContext, "channelSnapshotHits");
      return snapshotChannel;
    }
    recordStartupCacheStat(operationContext, "channelSnapshotMisses");
    return this.client.channels.fetch(channelId);
  }

  private getCachedWritableTarget(
    channelId: string,
    operationContext?: ProviderOperationContext
  ): BridgeTargetChannel | null {
    return this.getStartupSession(operationContext)?.writableTargets.get(channelId) ?? null;
  }

  private rememberWritableTarget(target: BridgeTargetChannel, operationContext?: ProviderOperationContext): void {
    this.getStartupSession(operationContext)?.writableTargets.set(target.id, target);
  }

  private evictWritableTarget(channelId: string, operationContext?: ProviderOperationContext): void {
    this.getStartupSession(operationContext)?.writableTargets.delete(channelId);
  }

  private buildStartupMessageCacheKey(channelId: string, messageId: string): string {
    return `${channelId}:${messageId}`;
  }

  private async fetchMessage(
    target: BridgeTargetChannel,
    channelId: string,
    messageId: string,
    operationContext?: ProviderOperationContext
  ): Promise<Message<true>> {
    const session = this.getStartupSession(operationContext);
    const cacheKey = this.buildStartupMessageCacheKey(channelId, messageId);
    const cached = session?.messages.get(cacheKey) ?? null;
    if (cached) {
      recordStartupCacheStat(operationContext, "messageHits");
      return cached;
    }
    recordStartupCacheStat(operationContext, "messageMisses");
    const fetched = await target.messages.fetch(messageId);
    session?.messages.set(cacheKey, fetched);
    return fetched;
  }

  private rememberFetchedMessage(
    channelId: string,
    message: Message,
    operationContext?: ProviderOperationContext
  ): void {
    const session = this.getStartupSession(operationContext);
    if (!session) {
      return;
    }
    session.messages.set(
      this.buildStartupMessageCacheKey(channelId, message.id),
      message as Message<true>
    );
  }

  private evictFetchedMessage(
    channelId: string,
    messageId: string,
    operationContext?: ProviderOperationContext
  ): void {
    this.getStartupSession(operationContext)?.messages.delete(
      this.buildStartupMessageCacheKey(channelId, messageId)
    );
  }

  private isKnownEmptyStatusCardChannel(channelId: string, operationContext?: ProviderOperationContext): boolean {
    return this.getStartupSession(operationContext)?.knownEmptyStatusCardChannels.has(channelId) ?? false;
  }

  private markKnownEmptyStatusCardChannel(channelId: string, operationContext?: ProviderOperationContext): void {
    this.getStartupSession(operationContext)?.knownEmptyStatusCardChannels.add(channelId);
  }

  private clearKnownEmptyStatusCardChannel(channelId: string, operationContext?: ProviderOperationContext): void {
    this.getStartupSession(operationContext)?.knownEmptyStatusCardChannels.delete(channelId);
  }

  private approvalDecisionStyle(decision: string): ButtonStyle {
    const normalized = decision.trim().toLowerCase();
    switch (decision) {
      case "accept":
      case "acceptForSession":
      case "acceptWithExecpolicyAmendment":
        return ButtonStyle.Success;
      case "decline":
        return ButtonStyle.Danger;
      default:
        if (normalized.includes("allow") || normalized.includes("approve") || normalized.includes("accept")) {
          return ButtonStyle.Success;
        }
        if (
          normalized.includes("decline") ||
          normalized.includes("reject") ||
          normalized.includes("deny") ||
          normalized.includes("cancel")
        ) {
          return ButtonStyle.Danger;
        }
        return ButtonStyle.Secondary;
    }
  }

  private isPositiveApprovalDecision(decision: string): boolean {
    const normalized = decision.trim().toLowerCase();
    return (
      decision === "accept" ||
      decision === "acceptForSession" ||
      decision === "acceptWithExecpolicyAmendment" ||
      normalized.includes("allow") ||
      normalized.includes("approve") ||
      normalized.includes("accept")
    );
  }

  private approvalDecisionPriority(decision: string): number {
    switch (decision) {
      case "accept":
        return 0;
      case "acceptWithExecpolicyAmendment":
        return 1;
      case "acceptForSession":
        return 2;
      case "decline":
        return 10;
      case "cancel":
        return 11;
      default:
        return this.isPositiveApprovalDecision(decision) ? 5 : 20;
    }
  }

  private async getGuild(): Promise<Guild> {
    return this.client.guilds.fetch(this.config.guildId);
  }

  private async respondToInteractionError(interaction: Interaction, message: string): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.deferred) {
          await interaction.editReply({ content: message, allowedMentions: NO_ALLOWED_MENTIONS });
          return;
        }
        if (!interaction.replied) {
          await interaction.reply({
            content: message,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_ALLOWED_MENTIONS
          });
        }
        return;
      }

      if (interaction.isButton()) {
        if (interaction.deferred) {
          await interaction.followUp({
            content: message,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_ALLOWED_MENTIONS
          });
          return;
        }
        if (!interaction.replied) {
          await interaction.reply({
            content: message,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_ALLOWED_MENTIONS
          });
        }
        return;
      }

      if (interaction.isModalSubmit()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content: message,
            allowedMentions: NO_ALLOWED_MENTIONS
          });
          return;
        }
        await interaction.reply({
          content: message,
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_ALLOWED_MENTIONS
        });
      }
    } catch (error) {
      if (this.isUnknownInteractionError(error) || this.isInteractionAlreadyAcknowledgedError(error)) {
        this.logger.warn({ error }, "Discord interaction error response was already acknowledged or expired.");
        return;
      }
      throw error;
    }
  }

  private async fetchTextChannel(channelId: string, operationContext?: ProviderOperationContext): Promise<TextChannel> {
    const channel = await this.fetchChannel(channelId, operationContext);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`Discord channel ${channelId} is not a text channel.`);
    }
    return channel;
  }

  private async fetchTargetChannel(
    channelId: string,
    operationContext?: ProviderOperationContext
  ): Promise<BridgeTargetChannel> {
    const channel = await this.fetchChannel(channelId, operationContext);
    if (channel?.isThread()) {
      return channel;
    }
    if (channel?.type === ChannelType.GuildText) {
      return channel;
    }
    throw new Error(`Discord channel ${channelId} could not be fetched as a message target.`);
  }

  private async fetchWritableTargetChannel(
    channelId: string,
    operationContext?: ProviderOperationContext
  ): Promise<BridgeTargetChannel> {
    const cachedTarget = this.getCachedWritableTarget(channelId, operationContext);
    if (cachedTarget) {
      recordStartupCacheStat(operationContext, "writableTargetHits");
      return cachedTarget;
    }
    recordStartupCacheStat(operationContext, "writableTargetMisses");
    const target = await this.fetchTargetChannel(channelId, operationContext);
    await this.ensureTargetIsWritable(target);
    this.rememberWritableTarget(target, operationContext);
    return target;
  }

  private async ensureTargetIsWritable(channel: BridgeTargetChannel): Promise<void> {
    if (channel.isThread()) {
      await this.ensureThreadIsWritable(channel);
    }
  }

  private async sendTargetMessage(target: BridgeTargetChannel, payload: ProviderMessagePayload): Promise<Message> {
    return target.send(payload);
  }

  private async tryUpdateExistingMessage(
    target: BridgeTargetChannel,
    channelId: string,
    messageId: string | null,
    payload: ProviderMessagePayload,
    options: {
      warnContext: Record<string, unknown>;
      warnMessage: string;
      suppressWarn?: (error: unknown) => boolean;
      operationContext?: ProviderOperationContext;
    }
  ): Promise<string | null> {
    if (!messageId) {
      return null;
    }

    try {
      const existing = await this.fetchMessage(target, channelId, messageId, options.operationContext);
      await existing.edit(payload);
      this.rememberFetchedMessage(channelId, existing, options.operationContext);
      return existing.id;
    } catch (error) {
      this.evictFetchedMessage(channelId, messageId, options.operationContext);
      if (!options.suppressWarn?.(error)) {
        this.logger.warn({ error, ...options.warnContext }, options.warnMessage);
      }
      return null;
    }
  }

  private async editChannelMessage(
    channelId: string,
    messageId: string,
    buildPayload: (message: Message) => ProviderMessagePayload
  ): Promise<void> {
    const target = await this.fetchWritableTargetChannel(channelId);
    const message = await this.fetchMessage(target, channelId, messageId);
    await message.edit(buildPayload(message));
  }

  private async ensureThreadIsWritable(thread: ThreadChannel): Promise<void> {
    if (thread.archived && !thread.locked) {
      await thread.setArchived(false, "Resume Codex bridge updates");
    }
  }

  private buildApprovalAllowedMentions(view: ApprovalCardView): {
    parse: [];
    users?: string[];
  } {
    const users = (view.mentionUserIds ?? []).filter(Boolean);
    const allowedMentions: {
      parse: [];
      users?: string[];
    } = { parse: [] };
    if (users.length > 0) {
      allowedMentions.users = users;
    }
    return allowedMentions;
  }

  private logStartupTiming(message: string): void {
    if (!isStartupTimingEnabled()) {
      return;
    }
    this.logger.info({ startupTiming: true }, message);
  }

  private async tryPinMessage(
    message: { id: string; pin(reason?: string): Promise<unknown> },
    reason: string
  ): Promise<void> {
    try {
      await message.pin(reason);
    } catch (error) {
      this.logger.warn({ error, messageId: message.id }, "Failed to pin Discord status message.");
    }
  }

  private async findExistingStatusCard(
    target: BridgeTargetChannel,
    view: StatusCardView,
    preferredMessageId: string | null,
    operationContext?: ProviderOperationContext
  ): Promise<Message<true> | null> {
    if (preferredMessageId) {
      try {
        const existing = await this.fetchMessage(target, target.id, preferredMessageId, operationContext);
        if (this.isStatusCardMessage(existing, view)) {
          recordStartupCacheStat(operationContext, "statusCardLookupHits");
          return existing;
        }
      } catch (error) {
        this.evictFetchedMessage(target.id, preferredMessageId, operationContext);
        if (!this.isUnknownChannelError(error) && !this.isUnknownMessageError(error)) {
          this.logger.warn({ error, preferredMessageId }, "Failed to fetch preferred status card message.");
        }
      }
    }

    if (this.isKnownEmptyStatusCardChannel(target.id, operationContext)) {
      recordStartupCacheStat(operationContext, "statusCardLookupMisses");
      return null;
    }

    try {
      const pinned = await target.messages.fetchPins();
      const pinnedMatch = pinned.items
        .map((item) => item.message)
        .filter((message) => this.isStatusCardMessage(message, view))
        .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0];
      if (pinnedMatch) {
        this.rememberFetchedMessage(target.id, pinnedMatch, operationContext);
        recordStartupCacheStat(operationContext, "statusCardLookupHits");
        return pinnedMatch;
      }
    } catch (error) {
      this.logger.warn({ error, channelId: target.id }, "Failed to fetch pinned messages while locating a status card.");
    }

    try {
      const recent = await target.messages.fetch({ limit: 20 });
      const recentMatch =
        [...recent.values()]
          .filter((message) => this.isStatusCardMessage(message, view))
          .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0] ?? null;
      if (recentMatch) {
        this.rememberFetchedMessage(target.id, recentMatch, operationContext);
        recordStartupCacheStat(operationContext, "statusCardLookupHits");
        return recentMatch;
      }
      this.markKnownEmptyStatusCardChannel(target.id, operationContext);
      recordStartupCacheStat(operationContext, "statusCardLookupMisses");
      return null;
    } catch (error) {
      this.logger.warn({ error, channelId: target.id }, "Failed to fetch recent messages while locating a status card.");
      return null;
    }
  }

  private async registerCommands(): Promise<void> {
    const command = new SlashCommandBuilder()
      .setName("codex")
      .setDescription("Monitor and control the Codex Discord bridge.")
      .addSubcommand((subcommand) =>
        subcommand.setName("status").setDescription("List mapped Codex conversations.")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("send")
          .setDescription("Send a message to the Codex thread mapped to this channel.")
          .addStringOption((option) =>
            option
              .setName("text")
              .setDescription("Message for Codex")
              .setRequired(true)
              .setMaxLength(2000)
          )
          .addStringOption((option) =>
            option
              .setName("mode")
              .setDescription("Queue for the next turn or steer the active turn")
              .setRequired(false)
              .addChoices(
                { name: "queue", value: "queue" },
                { name: "steer", value: "steer" }
              )
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("retract")
          .setDescription("Retract the latest pending queued Codex message in this channel.")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("attach")
          .setDescription("Attach Discord to an existing Codex conversation.")
          .addStringOption((option) =>
            option.setName("thread_id").setDescription("Codex thread id").setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("detach")
          .setDescription("Stop syncing a mapped Codex conversation without deleting the channel.")
          .addStringOption((option) =>
            option.setName("thread_id").setDescription("Codex thread id").setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("cleanid")
          .setDescription("Delete the Discord mapping for one Codex conversation.")
          .addStringOption((option) =>
            option.setName("thread_id").setDescription("Codex thread id").setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("cleanall")
          .setDescription("Delete all bridge-managed Discord categories, channels, and threads.")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("help").setDescription("Show bridge usage.")
      );
    const rest = new REST({ version: "10" }).setToken(this.config.token);
    await rest.put(
      Routes.applicationGuildCommands(this.config.applicationId, this.config.guildId),
      {
        body: [command.toJSON()]
      }
    );
  }

  private requireHandlers(): BridgeProviderHandlers {
    if (!this.handlers) {
      throw new Error("Discord adapter handlers are not registered.");
    }
    return this.handlers;
  }

  private extractActor(interaction: {
    user: { id: string; username: string | null };
    member?: unknown;
  }): ProviderActorContext {
    return {
      userId: interaction.user.id,
      roleIds: this.extractRoleIds(interaction),
      username: interaction.user.username ?? null
    };
  }

  private extractRoleIds(interaction: { member?: unknown }): string[] {
    const member = interaction.member ?? null;
    if (!member || typeof member !== "object") {
      return [];
    }

    const roles = (member as { roles?: unknown }).roles;
    if (Array.isArray(roles)) {
      return roles.filter((roleId): roleId is string => typeof roleId === "string");
    }

    if (
      roles &&
      typeof roles === "object" &&
      "cache" in roles &&
      roles.cache &&
      typeof roles.cache === "object" &&
      "keys" in roles.cache &&
      typeof roles.cache.keys === "function"
    ) {
      return [...(roles.cache.keys() as IterableIterator<string>)];
    }

    return [];
  }

  private isUnknownChannelError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      Number((error as { code?: unknown }).code) === 10003
    );
  }

  private isUnknownMessageError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      Number((error as { code?: unknown }).code) === 10008
    );
  }

  private isUnknownInteractionError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      Number((error as { code?: unknown }).code) === 10062
    );
  }

  private isInteractionAlreadyAcknowledgedError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      Number((error as { code?: unknown }).code) === 40060
    );
  }

  private buildConversationChannelTopic(codexThreadId: string, bridgeScope: string | null = null): string {
    const normalizedScope = this.normalizeBridgeScope(bridgeScope);
    return normalizedScope
      ? `[codex-bridge] thread:${codexThreadId} scope:${normalizedScope}`
      : `[codex-bridge] thread:${codexThreadId}`;
  }

  private parseCodexThreadIdFromTopic(topic: string | null): string | null {
    if (!topic) {
      return null;
    }
    const match = topic.match(/\[codex-bridge\]\s+thread:([^\s]+)/i);
    return match?.[1] ?? null;
  }

  private parseBridgeScopeFromTopic(topic: string | null): string | null {
    if (!topic) {
      return null;
    }
    const match = topic.match(/\s+scope:([^\s]+)/i);
    return match?.[1] ?? null;
  }

  private normalizeBridgeScope(scope: string | null | undefined): string | null {
    const normalized = scope?.trim().replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 80) ?? "";
    return normalized || null;
  }

  private summarizeMessage(content: string): string {
    const normalized = content.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "(no content)";
    }
    return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
  }

  private isBridgeManagedConversationChannel(channel: TextChannel): boolean {
    if (channel.topic?.startsWith("[codex-detached]")) {
      return false;
    }
    return channel.topic?.startsWith("[codex-bridge] thread:") ?? false;
  }

  private toConversationChannelCandidate(channel: TextChannel): ConversationChannelCandidate {
    return {
      id: channel.id,
      name: channel.name,
      parentId: channel.parentId,
      topic: channel.topic ?? null,
      codexThreadId: this.parseCodexThreadIdFromTopic(channel.topic),
      bridgeScope: this.parseBridgeScopeFromTopic(channel.topic),
      isBridgeManaged: this.isBridgeManagedConversationChannel(channel),
      createdTimestamp: channel.createdTimestamp
    };
  }

  private async hasBridgeManagedMessages(channel: TextChannel): Promise<boolean> {
    if (channel.topic?.startsWith("[codex-detached]")) {
      return false;
    }
    const botUserId = this.client.user?.id;
    if (!botUserId) {
      return false;
    }

    const messages = await channel.messages.fetch({ limit: 10 });
    return messages.some((message) => {
      if (message.author.id !== botUserId) {
        return false;
      }
      return (
        message.content.includes("Bridge attached to Codex thread `") ||
        (
          message.content.includes("Thread: `") &&
          message.content.includes("Project:") &&
          message.content.includes("Last activity:")
        )
      );
    });
  }

  private async inspectRecentTargetActivity(
    target: BridgeTargetChannel,
    logContext: { channelId: string; targetKind: "channel" | "thread" }
  ): Promise<{ lastMessageAt: number | null; lastMessagePreview: string | null }> {
    try {
      const recent = await target.messages.fetch({ limit: INSPECTION_MESSAGE_FETCH_LIMIT });
      const latest = selectLatestInspectionMessage(
        [...recent.values()].map((message) => ({
          createdTimestamp: message.createdTimestamp,
          editedTimestamp: message.editedTimestamp ?? null,
          content: message.content
        })),
        (content) => this.summarizeMessage(content)
      );
      return latest
        ? { lastMessageAt: latest.activityTimestamp, lastMessagePreview: latest.preview }
        : { lastMessageAt: null, lastMessagePreview: null };
    } catch (error) {
      this.logger.warn({ error, ...logContext }, "Failed to inspect recent Discord target messages.");
      return { lastMessageAt: null, lastMessagePreview: null };
    }
  }

  private async fetchBridgeOwnedThreadsForParent(
    parentChannel: TextChannel,
    managedParentIds: Set<string>
  ): Promise<ThreadChannel[]> {
    const threads = new Map<string, ThreadChannel>();
    const addThreads = (candidates: Iterable<ThreadChannel>) => {
      for (const thread of candidates) {
        if (this.isBridgeManagedChildThread(thread, managedParentIds)) {
          threads.set(thread.id, thread);
        }
      }
    };

    try {
      const active = await parentChannel.threads.fetchActive(false);
      addThreads(active.threads.values());
    } catch (error) {
      this.logger.warn({ error, channelId: parentChannel.id }, "Failed to inspect active Discord child threads.");
    }

    try {
      const archived = await parentChannel.threads.fetchArchived({ type: "public", fetchAll: true }, false);
      addThreads(archived.threads.values());
    } catch (error) {
      this.logger.warn({ error, channelId: parentChannel.id }, "Failed to inspect archived Discord child threads.");
    }

    return [...threads.values()];
  }

  private isBridgeManagedChildThread(thread: ThreadChannel, managedParentIds: Set<string>): boolean {
    const botUserId = this.client.user?.id;
    return Boolean(thread.parentId && managedParentIds.has(thread.parentId) && botUserId && thread.ownerId === botUserId);
  }

  private serializeMessageSnapshot(message: Message): DiscordMessageSnapshot {
    return {
      messageId: message.id,
      createdAt: message.createdTimestamp,
      editedAt: message.editedTimestamp ?? null,
      authorId: message.author.id,
      authorName: message.author.username,
      content: message.content,
      pinned: message.pinned,
      type: this.serializeMessageType(message.type),
      flags: typeof message.flags.toArray === "function" ? message.flags.toArray().map((flag) => String(flag)) : [],
      reference: message.reference
        ? {
            messageId: message.reference.messageId ?? null,
            channelId: message.reference.channelId ?? null,
            guildId: message.reference.guildId ?? null,
            type: message.reference.type ?? null
          }
        : null,
      embeds: message.embeds.map((embed) => {
        const raw = embed.toJSON() as {
          title?: string;
          description?: string;
          url?: string;
          author?: { name?: string };
          footer?: { text?: string };
          fields?: unknown[];
        };
        return {
          title: raw.title ?? null,
          description: raw.description ?? null,
          url: raw.url ?? null,
          authorName: raw.author?.name ?? null,
          footerText: raw.footer?.text ?? null,
          fieldCount: Array.isArray(raw.fields) ? raw.fields.length : 0
        };
      }),
      components: message.components.flatMap((row) => {
        if (!("components" in row) || !Array.isArray(row.components)) {
          return [];
        }
        return [
          {
            type: this.serializeComponentType(row.type),
            components: row.components.map((component: { toJSON(): unknown }) => {
              const raw = component.toJSON() as {
                type?: number;
                style?: number;
                custom_id?: string;
                label?: string;
                disabled?: boolean;
                url?: string;
              };
              return {
                type: this.serializeComponentType(raw.type),
                style: typeof raw.style === "number" ? raw.style : null,
                customId: raw.custom_id ?? null,
                label: raw.label ?? null,
                disabled: raw.disabled ?? false,
                url: raw.url ?? null
              };
            })
          }
        ];
      })
    };
  }

  private serializeMessageType(type: number): string {
    return MessageType[type] ?? `Unknown(${type})`;
  }

  private serializeComponentType(type: number | undefined): string {
    if (typeof type !== "number") {
      return "Unknown";
    }
    return ComponentType[type] ?? `Unknown(${type})`;
  }

  private isStatusCardMessage(message: Message<true>, view: StatusCardView): boolean {
    const botUserId = this.client.user?.id;
    if (!botUserId || message.author.id !== botUserId) {
      return false;
    }

    return (
      message.content.includes(`Thread: \`${view.shortThreadId}\``) &&
      message.content.includes("Project:") &&
      message.content.includes("Last activity:")
    );
  }
}
