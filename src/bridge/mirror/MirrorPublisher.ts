import type {
  CodexFileChangeItem,
  DiscordCommandButton,
  MessageDetailRecord,
  ProposedPlanActionRecord
} from "../../domain.js";
import type { ProviderDetailButton, ProviderMessageOptions } from "../../providers/types.js";
import { normalizePathForComparison } from "../../platform.js";
import {
  formatMirroredNarrativeText as formatMirroredNarrativeMessage,
  formatMirroredTimestamp as formatRenderedTimestamp,
  renderGroupedMessage as renderGroupedDiscordMessage,
  sortGroupedEntries as sortGroupedDiscordEntries,
  type GroupedDiscordMessageEntry
} from "../messageRendering.js";
import type {
  BridgeRuntimeState,
  CommandActivitySummaryState,
  FileActivityCounts,
  GroupedDiscordMessageState,
  MirrorCandidate,
  StartupMirrorBatchEntry,
  TrackedDiscordMessageState
} from "../runtime/BridgeRuntimeState.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import {
  escapeDiscordInlineCode,
  redactSensitiveText,
  truncateForDiscord
} from "../../util/redaction.js";
import { createProviderOperationContext } from "../startupTransport.js";
import {
  ACCEPT_PROPOSED_PLAN_LABEL,
  buildProposedPlanActionCustomId,
  TELL_CODEX_DIFFERENTLY_LABEL
} from "../../util/approvalDecisions.js";

const PROPOSED_PLAN_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface MirrorPublisherDependencies {
  allowLateSameTurnCandidate(threadId: string, candidate: MirrorCandidate): boolean;
  canMirrorNonUserActivity(
    threadId: string,
    turnId?: string | null,
    turnCursor?: string | null
  ): boolean;
  buildCandidateDevDetail(threadId: string, candidate: MirrorCandidate): string;
  buildMirrorCursor(timestampMs: number | null, itemId: string, orderKey?: number | null): string | null;
  compareItemCursor(left: string, right: string): number;
  compareTurnCursor(left: string, right: string): number;
  ensureMirrorStateHydrated(threadId: string): void;
  enforceTurnRetention(threadId: string): Promise<void>;
  extractFileActivityCounts(item: CodexFileChangeItem): FileActivityCounts | null;
  markUserTurnMirrored(
    threadId: string,
    itemId: string,
    turnId: string | null,
    turnCursor: string | null,
    text: string
  ): void;
  mirroredItemKey(threadId: string, itemId: string): string;
  mirroredTurnKey(turnId: string | null, turnCursor: string | null): string | null;
  rememberMirroredItem(record: {
    threadId: string;
    itemId: string;
    turnId: string | null;
    kind: "user" | "agentCommentary" | "agentAnswer" | "command" | "fileChange";
    discordMessageId: string;
    discordMessageIds?: string[];
    groupKey: string | null;
    contentSignature: string;
    renderedContent: string;
    timestampMs: number | null;
    cursor: string | null;
    turnCursor: string | null;
  }): void;
  rememberThreadMirrorCursor(
    threadId: string,
    latestMirroredTimestampMs: number | null,
    latestMirroredCursor: string,
    latestMirroredTurnCursor: string | null
  ): void;
  renderActivityHeading(threadId: string | null): string;
  renderCodexHeading(level: 1 | 3, label: string): string;
  renderCodexMessageLabel(threadId: string, phase: string | null | undefined, isLive: boolean): string;
  renderFileEditHeading(threadId: string | null): string;
  renderMirroredBlock(heading: string, body: string): string;
  renderUserHeading(level: 1 | 3, threadId: string): string;
  resolveUserHeadingLevel(
    threadId: string,
    itemId: string,
    turnId: string | null,
    turnCursor: string | null
  ): 1 | 3;
  shouldMirrorCandidate(threadId: string, cursor: string | null): boolean;
  shouldMirrorTurnCandidate(threadId: string, turnCursor: string | null): boolean;
  shouldSkipDuplicateUserText(
    threadId: string,
    itemId: string,
    turnId: string | null,
    turnCursor: string | null,
    text: string
  ): boolean;
  traceMirror(event: string, payload: Record<string, unknown>): void;
  retryPendingApprovalCardsForTurn(
    threadId: string,
    turnId: string | null,
    turnCursor: string | null,
    timestampMs: number | null
  ): Promise<void>;
}

interface StartupMirrorRenderedBlock {
  content: string;
  entries: StartupMirrorBatchEntry[];
  rememberContentSignature?: string | null;
  rememberRenderedContent?: string | null;
}

interface StartupGroupedBatchEntry {
  source: StartupMirrorBatchEntry;
  rendered: GroupedDiscordMessageEntry;
}

type PendingMessageDetail = {
  button: ProviderDetailButton;
  record: Omit<MessageDetailRecord, "discordMessageId">;
};

type PendingProposedPlanAction = {
  buttons: DiscordCommandButton[];
  record: Omit<ProposedPlanActionRecord, "discordMessageId">;
};

export class MirrorPublisher {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: MirrorPublisherDependencies
  ) {}

  beginStartupMirrorBatch(threadId: string): void {
    if (this.runtime.startupMirrorBatchByThreadId.has(threadId)) {
      return;
    }
    this.runtime.liveAgentMessages.delete(threadId);
    this.closeGroupedMessages(threadId);
    this.runtime.startupMirrorBatchByThreadId.set(threadId, { entries: [] });
  }

  closeCommandActivityGroup(threadId: string): void {
    this.closeCommandGroup(threadId);
  }

  async endStartupMirrorBatch(threadId: string): Promise<void> {
    try {
      await this.flushStartupMirrorBatch(threadId);
    } finally {
      this.runtime.startupMirrorBatchByThreadId.delete(threadId);
    }
  }

  private providerMessageOptions(
    threadId: string,
    options: ProviderMessageOptions = {}
  ): ProviderMessageOptions {
    const startupContext = this.runtime.startupTransportContextByThreadId.get(threadId) ?? null;
    if (!startupContext) {
      return options;
    }
    return {
      ...options,
      operationContext: createProviderOperationContext(threadId, startupContext)
    };
  }

  async publishLiveAgentDelta(
    threadId: string,
    delta: string,
    timestampMs: number | null = null,
    itemId: string | null = null,
    cursor: string | null = null,
    turnId: string | null = null,
    turnCursor: string | null = null
  ): Promise<void> {
    if (!this.context.runtimeConfig.visibility.thinkingMessages) {
      return;
    }
    if (!this.deps.canMirrorNonUserActivity(threadId, turnId, turnCursor)) {
      return;
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge || !delta) {
      return;
    }

    const current = this.runtime.liveAgentMessages.get(threadId) ?? {
      messageId: null,
      content: "",
      timestampMs,
      itemId,
      cursor
    };
    current.timestampMs = current.timestampMs ?? timestampMs ?? null;
    current.itemId = current.itemId ?? itemId;
    current.cursor = current.cursor ?? cursor;
    current.content = `${current.content}${delta}`;
    const preview = this.limitLiveMessageChunk(
      this.deps.renderMirroredBlock(
        this.deps.renderCodexHeading(3, this.deps.renderCodexMessageLabel(threadId, "thinking", true)),
        `${this.formatMirroredTimestamp(current.timestampMs)} ${current.content}`.trim()
      )
    );
    if (!preview.trim()) {
      this.runtime.liveAgentMessages.set(threadId, current);
      return;
    }

    current.messageId = await this.context.provider.upsertLiveTextMessage(
      bridge.discordChannelId,
      current.messageId,
      preview,
      this.providerMessageOptions(threadId)
    );
    this.deps.traceMirror("discord.live_delta.upsert", {
      threadId,
      channelId: bridge.discordChannelId,
      kind: "agentCommentaryDelta",
      itemId: current.itemId,
      cursor: current.cursor,
      timestampMs: current.timestampMs,
      timestampIso: current.timestampMs !== null ? new Date(current.timestampMs).toISOString() : null,
      messageId: current.messageId,
      renderedPreview: truncateForDiscord(
        redactSensitiveText(preview.replace(/\s+/g, " ").trim()),
        260
      )
    });
    this.runtime.liveAgentMessages.set(threadId, current);
  }

  async publishCompletedAgentMessage(
    threadId: string,
    itemId: string,
    text: string,
    phase?: string | null,
    timestampMs: number | null = null,
    timestampIsApproximate = false,
    cursor: string | null = null,
    turnId: string | null = null,
    turnCursor: string | null = null,
    devDetail: string | null = null
  ): Promise<void> {
    if (!this.context.runtimeConfig.visibility.finalMessages) {
      this.runtime.liveAgentMessages.delete(threadId);
      return;
    }
    if (!this.deps.canMirrorNonUserActivity(threadId, turnId, turnCursor)) {
      this.runtime.liveAgentMessages.delete(threadId);
      return;
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const sanitized = this.formatMirroredNarrativeText(redactSensitiveText(text).trim());
    if (!bridge || !sanitized) {
      this.runtime.liveAgentMessages.delete(threadId);
      return;
    }
    this.deps.ensureMirrorStateHydrated(threadId);
    const itemKey = this.deps.mirroredItemKey(threadId, itemId);

    const renderedContent = this.deps.renderMirroredBlock(
      this.deps.renderCodexHeading(1, this.deps.renderCodexMessageLabel(threadId, phase, false)),
      `${this.formatMirroredTimestamp(timestampMs, timestampIsApproximate)} ${sanitized}`.trim()
    );
    if (this.runtime.mirroredAgentItems.get(itemKey) === renderedContent) {
      this.runtime.liveAgentMessages.delete(threadId);
      return;
    }
    if (
      this.queueStartupMirrorBatchEntry(threadId, {
        itemId,
        kind: "agentAnswer",
        contentSignature: renderedContent,
        renderedContent,
        timestampMs,
        timestampIsApproximate,
        cursor: cursor ?? this.deps.buildMirrorCursor(timestampMs, itemId),
        turnId,
        turnCursor
      })
    ) {
      this.runtime.liveAgentMessages.delete(threadId);
      this.runtime.mirroredAgentItems.set(itemKey, renderedContent);
      return;
    }

    const chunks = this.splitDiscordMessage(
      renderedContent
    );
    if (chunks.length === 0) {
      this.runtime.liveAgentMessages.delete(threadId);
      return;
    }

    const signature = chunks.join("\n\n");
    if (this.runtime.mirroredAgentItems.get(itemKey) === signature) {
      this.runtime.liveAgentMessages.delete(threadId);
      return;
    }

    this.runtime.mirroredAgentItems.set(itemKey, signature);
    this.closeGroupedMessages(threadId);
    const liveMessage = this.runtime.liveAgentMessages.get(threadId);
    const tracked = this.runtime.mirroredAnswerMessages.get(itemKey);
    const createDevDetails = () =>
      [
        this.createPendingMessageDetail(
          threadId,
          "debug",
          "Codex message devDetails",
          "devDetails",
          devDetail
        )
      ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    await this.publishChunkedMirroredItem({
      threadId,
      itemId,
      turnId,
      turnCursor,
      timestampMs,
      timestampIsApproximate,
      cursor: cursor ?? this.deps.buildMirrorCursor(timestampMs, itemId),
      channelId: bridge.discordChannelId,
      itemKey,
      chunks,
      signature,
      traceKind: "agentAnswer",
      rememberKind: "agentAnswer",
      signatureMap: this.runtime.mirroredAgentItems,
      trackedMessages: this.runtime.mirroredAnswerMessages,
      firstMessageId: tracked?.messageId ?? liveMessage?.messageId ?? null,
      firstMessageMode: "upsert",
      createDetails: createDevDetails,
      createFirstAction: () => this.createPendingProposedPlanAction(threadId, itemId, turnId, sanitized),
      includeTimestampTrace: true
    });
    this.runtime.liveAgentMessages.delete(threadId);
  }

  async publishStartupBackfillNotice(
    threadId: string,
    itemId: string,
    text: string,
    turnId: string | null = null,
    turnCursor: string | null = null
  ): Promise<number> {
    if (this.isStartupMirrorBatchActive(threadId)) {
      await this.flushStartupMirrorBatch(threadId);
    }
    if (!this.deps.canMirrorNonUserActivity(threadId, turnId, turnCursor)) {
      return 0;
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const sanitized = this.formatMirroredNarrativeText(redactSensitiveText(text).trim());
    if (!bridge || !sanitized) {
      return 0;
    }

    const quotedNotice = sanitized.replace(/^/gm, "> ");
    const chunks = this.splitDiscordMessage(
      this.deps.renderMirroredBlock("### **⚠️ Bridge Notice ⚠️**", quotedNotice)
    );
    if (chunks.length === 0) {
      return 0;
    }

    this.deps.ensureMirrorStateHydrated(threadId);
    const itemKey = this.deps.mirroredItemKey(threadId, itemId);
    const signature = chunks.join("\n\n");
    if (this.runtime.mirroredAgentItems.get(itemKey) === signature) {
      return 0;
    }

    this.runtime.mirroredAgentItems.set(itemKey, signature);
    this.closeGroupedMessages(threadId);
    const tracked = this.runtime.mirroredAnswerMessages.get(itemKey);

    await this.publishChunkedMirroredItem({
      threadId,
      itemId,
      turnId,
      turnCursor,
      timestampMs: null,
      timestampIsApproximate: false,
      cursor: null,
      channelId: bridge.discordChannelId,
      itemKey,
      chunks,
      signature,
      traceKind: "startupBackfillNotice",
      rememberKind: "agentAnswer",
      signatureMap: this.runtime.mirroredAgentItems,
      trackedMessages: this.runtime.mirroredAnswerMessages,
      firstMessageId: tracked?.messageId ?? null,
      firstMessageMode: "sendUnlessTracked",
      createDetails: () => [],
      includeTimestampTrace: false
    });
    return 1;
  }

  async publishCommentaryAgentMessage(
    threadId: string,
    itemId: string,
    text: string,
    phase?: string | null,
    timestampMs: number | null = null,
    timestampIsApproximate = false,
    sortCursor: string | null = null,
    turnId: string | null = null,
    turnCursor: string | null = null,
    devDetail: string | null = null
  ): Promise<void> {
    if (!this.context.runtimeConfig.visibility.thinkingMessages) {
      this.runtime.liveAgentMessages.delete(threadId);
      return;
    }
    if (!this.deps.canMirrorNonUserActivity(threadId, turnId, turnCursor)) {
      this.runtime.liveAgentMessages.delete(threadId);
      return;
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const sanitized = this.formatMirroredNarrativeText(redactSensitiveText(text).trim());
    if (!bridge || !sanitized) {
      this.runtime.liveAgentMessages.delete(threadId);
      return;
    }
    this.deps.ensureMirrorStateHydrated(threadId);
    const itemKey = this.deps.mirroredItemKey(threadId, itemId);

    const entry = `${this.formatMirroredTimestamp(timestampMs, timestampIsApproximate)} ${sanitized}`;
    if (this.runtime.mirroredAgentItems.get(itemKey) === entry) {
      this.runtime.liveAgentMessages.delete(threadId);
      return;
    }
    if (
      this.queueStartupMirrorBatchEntry(threadId, {
        itemId,
        kind: "agentCommentary",
        contentSignature: entry,
        renderedContent: this.deps.renderMirroredBlock(
          this.deps.renderCodexHeading(3, this.deps.renderCodexMessageLabel(threadId, phase, false)),
          entry
        ),
        timestampMs,
        timestampIsApproximate,
        cursor: sortCursor ?? this.deps.buildMirrorCursor(timestampMs, itemId),
        turnId,
        turnCursor
      })
    ) {
      this.runtime.liveAgentMessages.delete(threadId);
      this.runtime.mirroredAgentItems.set(itemKey, entry);
      this.closeCommandGroup(threadId);
      this.closeFileChangeGroup(threadId);
      return;
    }

    this.runtime.mirroredAgentItems.set(itemKey, entry);
    this.closeCommandGroup(threadId);
    this.closeFileChangeGroup(threadId);
    const liveMessage = this.runtime.liveAgentMessages.get(threadId);
    await this.upsertGroupedMessageEntry(
      threadId,
      this.runtime.groupedCommentaryMessages,
      this.deps.renderCodexHeading(3, this.deps.renderCodexMessageLabel(threadId, phase, false)),
      itemId,
      entry,
      liveMessage?.messageId ?? null,
      "agentCommentary",
      entry,
      timestampMs,
      sortCursor,
      turnId,
      turnCursor,
      null,
      {
        title: "Codex commentary details",
        showDetailsButton: false,
        devTitle: "Codex commentary devDetails",
        devDetail
      }
    );
    this.runtime.liveAgentMessages.delete(threadId);
  }

  async publishCompletedUserMessage(
    threadId: string,
    itemId: string,
    text: string,
    timestampMs: number | null = null,
    timestampIsApproximate = false,
    cursor: string | null = null,
    turnId: string | null = null,
    turnCursor: string | null = null,
    devDetail: string | null = null
  ): Promise<void> {
    if (!this.context.runtimeConfig.visibility.userMessages) {
      return;
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const sanitized = this.formatMirroredNarrativeText(redactSensitiveText(text).trim());
    if (!bridge || !sanitized) {
      return;
    }
    if (this.isStartupMirrorBatchActive(threadId)) {
      await this.flushStartupMirrorBatch(threadId);
    }

    const userHeadingLevel = this.deps.resolveUserHeadingLevel(threadId, itemId, turnId, turnCursor);
    const chunks = this.splitDiscordMessage(
      this.deps.renderMirroredBlock(
        this.deps.renderUserHeading(userHeadingLevel, threadId),
        `${this.formatMirroredTimestamp(timestampMs, timestampIsApproximate)} ${sanitized}`.trim()
      )
    );
    if (chunks.length === 0) {
      return;
    }

    this.deps.ensureMirrorStateHydrated(threadId);
    const itemKey = this.deps.mirroredItemKey(threadId, itemId);
    if (
      !this.runtime.mirroredChatItems.has(itemKey) &&
      this.deps.shouldSkipDuplicateUserText(threadId, itemId, turnId, turnCursor, sanitized)
    ) {
      return;
    }
    const signature = chunks.join("\n\n");
    if (this.runtime.mirroredChatItems.get(itemKey) === signature) {
      return;
    }

    this.runtime.mirroredChatItems.set(itemKey, signature);
    this.runtime.liveAgentMessages.delete(threadId);
    this.closeGroupedMessages(threadId);
    const tracked = this.runtime.mirroredUserMessages.get(itemKey);
    const createDevDetails = () =>
      [
        this.createPendingMessageDetail(
          threadId,
          "debug",
          "User message devDetails",
          "devDetails",
          devDetail
        )
      ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    const published = await this.publishChunkedMirroredItem({
      threadId,
      itemId,
      turnId,
      turnCursor,
      timestampMs,
      timestampIsApproximate,
      cursor: cursor ?? this.deps.buildMirrorCursor(timestampMs, itemId),
      channelId: bridge.discordChannelId,
      itemKey,
      chunks,
      signature,
      traceKind: "user",
      rememberKind: "user",
      signatureMap: this.runtime.mirroredChatItems,
      trackedMessages: this.runtime.mirroredUserMessages,
      firstMessageId: tracked?.messageId ?? null,
      firstMessageMode: "sendUnlessTracked",
      createDetails: createDevDetails,
      includeTimestampTrace: true
    });
    const firstMessageId = published.firstMessageId;
    if (firstMessageId) {
      this.deps.markUserTurnMirrored(threadId, itemId, turnId, turnCursor, sanitized);
      try {
        await this.deps.retryPendingApprovalCardsForTurn(threadId, turnId, turnCursor, timestampMs);
      } catch (error) {
        this.context.logger.warn(
          { error, threadId, turnId, turnCursor },
          "Failed to retry pending approval cards after mirroring a user message."
        );
      }
    }
  }

  async publishCompletedCommandMessage(
    threadId: string,
    itemId: string,
    command: string | null,
    detail: string | null,
    status: string | null,
    timestampMs: number | null = null,
    timestampIsApproximate = false,
    showDetailsButton = false,
    sortCursor: string | null = null,
    turnId: string | null = null,
    turnCursor: string | null = null,
    devDetail: string | null = null
  ): Promise<void> {
    if (!this.context.runtimeConfig.visibility.commands) {
      return;
    }
    if (!this.deps.canMirrorNonUserActivity(threadId, turnId, turnCursor)) {
      return;
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const sanitizedCommand = redactSensitiveText(command ?? "").trim();
    if (!bridge || !sanitizedCommand) {
      return;
    }
    this.deps.ensureMirrorStateHydrated(threadId);
    const itemKey = this.deps.mirroredItemKey(threadId, itemId);

    const suffix = status && status !== "completed" ? ` (${status})` : "";
    const entry = `${this.formatMirroredTimestamp(timestampMs, timestampIsApproximate)} \`${escapeDiscordInlineCode(sanitizedCommand)}\`${suffix}`;
    if (this.runtime.mirroredCommandItems.get(itemKey) === entry) {
      return;
    }
    if (
      this.queueStartupMirrorBatchEntry(threadId, {
        itemId,
        kind: "command",
        contentSignature: entry,
        renderedContent: this.deps.renderMirroredBlock(this.deps.renderActivityHeading(threadId), entry),
        timestampMs,
        timestampIsApproximate,
        cursor: sortCursor ?? this.deps.buildMirrorCursor(timestampMs, itemId),
        turnId,
        turnCursor,
        groupedEntryContent: entry
      })
    ) {
      this.runtime.mirroredCommandItems.set(itemKey, entry);
      this.closeCommentaryGroup(threadId);
      this.closeFileChangeGroup(threadId);
      return;
    }

    if (this.context.runtimeConfig.ui.commandDisplayMode === "summary") {
      if (this.runtime.mirroredCommandItems.has(itemKey)) {
        return;
      }
      this.closeCommentaryGroup(threadId);
      this.closeFileChangeGroup(threadId);
      const messageId = await this.upsertCommandActivitySummary(
        threadId,
        itemId,
        "command",
        null,
        timestampMs,
        timestampIsApproximate,
        turnId,
        turnCursor
      );
      if (!messageId) {
        return;
      }
      const summaryContent = this.buildCommandActivitySummaryContent(
        this.runtime.commandActivitySummaries.get(threadId)
      );
      this.runtime.mirroredCommandItems.set(itemKey, summaryContent);
      this.deps.rememberMirroredItem({
        threadId,
        itemId,
        turnId,
        kind: "command",
        discordMessageId: messageId,
        groupKey: "command",
        contentSignature: summaryContent,
        renderedContent: summaryContent,
        timestampMs,
        cursor: sortCursor ?? this.deps.buildMirrorCursor(timestampMs, itemId),
        turnCursor
      });
      return;
    }
    this.runtime.mirroredCommandItems.set(itemKey, entry);
    this.closeCommentaryGroup(threadId);
    this.closeFileChangeGroup(threadId);
    await this.upsertGroupedMessageEntry(
      threadId,
      this.runtime.groupedCommandMessages,
      this.deps.renderActivityHeading(threadId),
      itemId,
      entry,
      null,
      "command",
      entry,
      timestampMs,
      sortCursor,
      turnId,
      turnCursor,
      detail ?? this.renderCommandDetail(sanitizedCommand, status, timestampMs, timestampIsApproximate),
      this.context.runtimeConfig.ui.enableCommandDetails
        ? {
            title: "Codex command details",
            showDetailsButton,
            devTitle: "Codex command devDetails",
            devDetail
          }
        : {
            title: "Codex command details",
            showDetailsButton: false,
            devTitle: "Codex command devDetails",
            devDetail
          }
    );
  }

  async publishCompletedFileChangeMessage(
    threadId: string,
    itemId: string,
    summary: string | null,
    status: string | null,
    timestampMs: number | null = null,
    timestampIsApproximate = false,
    sortCursor: string | null = null,
    turnId: string | null = null,
    turnCursor: string | null = null,
    devDetail: string | null = null,
    fileCounts: FileActivityCounts | null = null
  ): Promise<void> {
    if (!this.context.runtimeConfig.visibility.fileEdits) {
      return;
    }
    if (!this.deps.canMirrorNonUserActivity(threadId, turnId, turnCursor)) {
      return;
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const sanitizedSummary = redactSensitiveText(summary ?? "").trim();
    if (!bridge || !sanitizedSummary) {
      return;
    }
    this.deps.ensureMirrorStateHydrated(threadId);
    const itemKey = this.deps.mirroredItemKey(threadId, itemId);

    const suffix = status && status !== "completed" ? ` (${status})` : "";
    const entry = `${this.formatMirroredTimestamp(timestampMs, timestampIsApproximate)} ${sanitizedSummary}${suffix}`;
    if (this.runtime.mirroredFileChangeItems.get(itemKey) === entry) {
      return;
    }
    if (
      this.queueStartupMirrorBatchEntry(threadId, {
        itemId,
        kind: "fileChange",
        contentSignature: entry,
        renderedContent: this.deps.renderMirroredBlock(this.deps.renderFileEditHeading(threadId), entry),
        timestampMs,
        timestampIsApproximate,
        cursor: sortCursor ?? this.deps.buildMirrorCursor(timestampMs, itemId),
        turnId,
        turnCursor,
        groupedEntryContent: entry,
        fileCounts: fileCounts ?? { created: 0, edited: 1, deleted: 0 }
      })
    ) {
      this.runtime.mirroredFileChangeItems.set(itemKey, entry);
      this.closeCommentaryGroup(threadId);
      this.closeCommandGroup(threadId);
      return;
    }

    if (
      this.context.runtimeConfig.visibility.commands &&
      this.context.runtimeConfig.ui.commandDisplayMode === "summary"
    ) {
      if (this.runtime.mirroredFileChangeItems.has(itemKey)) {
        return;
      }
      this.closeCommentaryGroup(threadId);
      this.closeFileChangeGroup(threadId);
      const messageId = await this.upsertCommandActivitySummary(
        threadId,
        itemId,
        "fileEdit",
        fileCounts ?? { created: 0, edited: 1, deleted: 0 },
        timestampMs,
        timestampIsApproximate,
        turnId,
        turnCursor
      );
      if (!messageId) {
        return;
      }
      const summaryContent = this.buildCommandActivitySummaryContent(
        this.runtime.commandActivitySummaries.get(threadId)
      );
      this.runtime.mirroredFileChangeItems.set(itemKey, summaryContent);
      this.deps.rememberMirroredItem({
        threadId,
        itemId,
        turnId,
        kind: "fileChange",
        discordMessageId: messageId,
        groupKey: "command",
        contentSignature: summaryContent,
        renderedContent: summaryContent,
        timestampMs,
        cursor: sortCursor ?? this.deps.buildMirrorCursor(timestampMs, itemId),
        turnCursor
      });
      return;
    }
    this.runtime.mirroredFileChangeItems.set(itemKey, entry);
    this.closeCommentaryGroup(threadId);
    this.closeCommandGroup(threadId);
    await this.upsertGroupedMessageEntry(
      threadId,
      this.runtime.groupedFileChangeMessages,
      this.deps.renderFileEditHeading(threadId),
      itemId,
      entry,
      null,
      "fileChange",
      entry,
      timestampMs,
      sortCursor,
      turnId,
      turnCursor,
      null,
      {
        title: "Codex file-edit details",
        showDetailsButton: false,
        devTitle: "Codex file-edit devDetails",
        devDetail
      }
    );
  }

  async mirrorCandidates(
    threadId: string,
    candidates: MirrorCandidate[],
    _options?: { compactStartupReplay?: boolean }
  ): Promise<number> {
    this.deps.ensureMirrorStateHydrated(threadId);
    let mirrored = 0;
    let latestMirroredCursor: string | null = null;
    let latestMirroredTurnCursor: string | null = null;
    let latestMirroredTimestampMs: number | null = null;
    for (const candidate of candidates) {
      this.deps.traceMirror("mirror.candidate.evaluate", {
        threadId,
        itemId: candidate.itemId,
        kind: candidate.kind,
        cursor: candidate.cursor,
        turnCursor: candidate.turnCursor,
        turnId: candidate.turnId,
        timestampMs: candidate.timestampMs,
        timestampIso:
          candidate.timestampMs !== null ? new Date(candidate.timestampMs).toISOString() : null,
        timestampIsApproximate: candidate.timestampIsApproximate
      });
      const itemKey = this.deps.mirroredItemKey(threadId, candidate.itemId);
      if (candidate.kind === "user") {
        const previousSignature = this.runtime.mirroredChatItems.get(itemKey) ?? null;
        const alreadyMirrored = this.runtime.mirroredChatItems.has(itemKey);
        const allowByCursor =
          this.deps.shouldMirrorCandidate(threadId, candidate.cursor) ||
          this.deps.allowLateSameTurnCandidate(threadId, candidate);
        const allowByTurn = this.deps.shouldMirrorTurnCandidate(threadId, candidate.turnCursor);
        if (!alreadyMirrored && (!allowByCursor || !allowByTurn)) {
          this.deps.traceMirror("mirror.candidate.skip", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            reason: !allowByCursor ? "cursor_gate" : "turn_gate",
            cursor: candidate.cursor,
            turnCursor: candidate.turnCursor,
            turnId: candidate.turnId,
            timestampMs: candidate.timestampMs
          });
          continue;
        }
        await this.publishCompletedUserMessage(
          threadId,
          candidate.itemId,
          candidate.text,
          candidate.timestampMs,
          candidate.timestampIsApproximate,
          candidate.cursor,
          candidate.turnId,
          candidate.turnCursor,
          this.deps.buildCandidateDevDetail(threadId, candidate)
        );
        if (this.runtime.mirroredChatItems.get(itemKey) !== previousSignature) {
          mirrored += 1;
          this.deps.traceMirror("mirror.candidate.mirrored", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            cursor: candidate.cursor,
            turnCursor: candidate.turnCursor,
            turnId: candidate.turnId,
            timestampMs: candidate.timestampMs
          });
          if (
            candidate.cursor &&
            (!latestMirroredCursor || this.deps.compareItemCursor(candidate.cursor, latestMirroredCursor) > 0)
          ) {
            latestMirroredCursor = candidate.cursor;
            latestMirroredTimestampMs = candidate.timestampMs;
          }
          if (
            candidate.turnCursor &&
            (!latestMirroredTurnCursor ||
              this.deps.compareTurnCursor(candidate.turnCursor, latestMirroredTurnCursor) > 0)
          ) {
            latestMirroredTurnCursor = candidate.turnCursor;
          }
        } else {
          this.deps.traceMirror("mirror.candidate.noop", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            reason: "unchanged_signature"
          });
        }
        continue;
      }

      if (candidate.kind === "command") {
        const previousSignature = this.runtime.mirroredCommandItems.get(itemKey) ?? null;
        const alreadyMirrored = this.runtime.mirroredCommandItems.has(itemKey);
        const allowByCursor =
          this.deps.shouldMirrorCandidate(threadId, candidate.cursor) ||
          this.deps.allowLateSameTurnCandidate(threadId, candidate);
        const allowByTurn = this.deps.shouldMirrorTurnCandidate(threadId, candidate.turnCursor);
        if (!alreadyMirrored && (!allowByCursor || !allowByTurn)) {
          this.deps.traceMirror("mirror.candidate.skip", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            reason: !allowByCursor ? "cursor_gate" : "turn_gate",
            cursor: candidate.cursor,
            turnCursor: candidate.turnCursor,
            turnId: candidate.turnId,
            timestampMs: candidate.timestampMs
          });
          continue;
        }
        await this.publishCompletedCommandMessage(
          threadId,
          candidate.itemId,
          candidate.text || null,
          candidate.detail || null,
          candidate.status || null,
          candidate.timestampMs,
          candidate.timestampIsApproximate,
          candidate.showDetailsButton,
          candidate.cursor,
          candidate.turnId,
          candidate.turnCursor,
          this.deps.buildCandidateDevDetail(threadId, candidate)
        );
        if (this.runtime.mirroredCommandItems.get(itemKey) !== previousSignature) {
          mirrored += 1;
          this.deps.traceMirror("mirror.candidate.mirrored", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            cursor: candidate.cursor,
            turnCursor: candidate.turnCursor,
            turnId: candidate.turnId,
            timestampMs: candidate.timestampMs
          });
          if (
            candidate.cursor &&
            (!latestMirroredCursor || this.deps.compareItemCursor(candidate.cursor, latestMirroredCursor) > 0)
          ) {
            latestMirroredCursor = candidate.cursor;
            latestMirroredTimestampMs = candidate.timestampMs;
          }
          if (
            candidate.turnCursor &&
            (!latestMirroredTurnCursor ||
              this.deps.compareTurnCursor(candidate.turnCursor, latestMirroredTurnCursor) > 0)
          ) {
            latestMirroredTurnCursor = candidate.turnCursor;
          }
        } else {
          this.deps.traceMirror("mirror.candidate.noop", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            reason: "unchanged_signature"
          });
        }
        continue;
      }

      if (candidate.kind === "fileChange") {
        const previousSignature = this.runtime.mirroredFileChangeItems.get(itemKey) ?? null;
        const alreadyMirrored = this.runtime.mirroredFileChangeItems.has(itemKey);
        const allowByCursor =
          this.deps.shouldMirrorCandidate(threadId, candidate.cursor) ||
          this.deps.allowLateSameTurnCandidate(threadId, candidate);
        const allowByTurn = this.deps.shouldMirrorTurnCandidate(threadId, candidate.turnCursor);
        if (!alreadyMirrored && (!allowByCursor || !allowByTurn)) {
          this.deps.traceMirror("mirror.candidate.skip", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            reason: !allowByCursor ? "cursor_gate" : "turn_gate",
            cursor: candidate.cursor,
            turnCursor: candidate.turnCursor,
            turnId: candidate.turnId,
            timestampMs: candidate.timestampMs
          });
          continue;
        }
        await this.publishCompletedFileChangeMessage(
          threadId,
          candidate.itemId,
          candidate.text || null,
          candidate.status || null,
          candidate.timestampMs,
          candidate.timestampIsApproximate,
          candidate.cursor,
          candidate.turnId,
          candidate.turnCursor,
          this.deps.buildCandidateDevDetail(threadId, candidate),
          candidate.rawItem.type === "fileChange"
            ? this.deps.extractFileActivityCounts(candidate.rawItem as CodexFileChangeItem)
            : null
        );
        if (this.runtime.mirroredFileChangeItems.get(itemKey) !== previousSignature) {
          mirrored += 1;
          this.deps.traceMirror("mirror.candidate.mirrored", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            cursor: candidate.cursor,
            turnCursor: candidate.turnCursor,
            turnId: candidate.turnId,
            timestampMs: candidate.timestampMs
          });
          if (
            candidate.cursor &&
            (!latestMirroredCursor || this.deps.compareItemCursor(candidate.cursor, latestMirroredCursor) > 0)
          ) {
            latestMirroredCursor = candidate.cursor;
            latestMirroredTimestampMs = candidate.timestampMs;
          }
          if (
            candidate.turnCursor &&
            (!latestMirroredTurnCursor ||
              this.deps.compareTurnCursor(candidate.turnCursor, latestMirroredTurnCursor) > 0)
          ) {
            latestMirroredTurnCursor = candidate.turnCursor;
          }
        } else {
          this.deps.traceMirror("mirror.candidate.noop", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            reason: "unchanged_signature"
          });
        }
        continue;
      }

      if (candidate.kind === "agentCommentary") {
        const previousSignature = this.runtime.mirroredAgentItems.get(itemKey) ?? null;
        const alreadyMirrored = this.runtime.mirroredAgentItems.has(itemKey);
        const allowByCursor =
          this.deps.shouldMirrorCandidate(threadId, candidate.cursor) ||
          this.deps.allowLateSameTurnCandidate(threadId, candidate);
        const allowByTurn = this.deps.shouldMirrorTurnCandidate(threadId, candidate.turnCursor);
        if (!alreadyMirrored && (!allowByCursor || !allowByTurn)) {
          this.deps.traceMirror("mirror.candidate.skip", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            reason: !allowByCursor ? "cursor_gate" : "turn_gate",
            cursor: candidate.cursor,
            turnCursor: candidate.turnCursor,
            turnId: candidate.turnId,
            timestampMs: candidate.timestampMs
          });
          continue;
        }
        await this.publishCommentaryAgentMessage(
          threadId,
          candidate.itemId,
          candidate.text,
          candidate.phase || undefined,
          candidate.timestampMs,
          candidate.timestampIsApproximate,
          candidate.cursor,
          candidate.turnId,
          candidate.turnCursor,
          this.deps.buildCandidateDevDetail(threadId, candidate)
        );
        if (this.runtime.mirroredAgentItems.get(itemKey) !== previousSignature) {
          mirrored += 1;
          this.deps.traceMirror("mirror.candidate.mirrored", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            cursor: candidate.cursor,
            turnCursor: candidate.turnCursor,
            turnId: candidate.turnId,
            timestampMs: candidate.timestampMs
          });
          if (
            candidate.cursor &&
            (!latestMirroredCursor || this.deps.compareItemCursor(candidate.cursor, latestMirroredCursor) > 0)
          ) {
            latestMirroredCursor = candidate.cursor;
            latestMirroredTimestampMs = candidate.timestampMs;
          }
          if (
            candidate.turnCursor &&
            (!latestMirroredTurnCursor ||
              this.deps.compareTurnCursor(candidate.turnCursor, latestMirroredTurnCursor) > 0)
          ) {
            latestMirroredTurnCursor = candidate.turnCursor;
          }
        } else {
          this.deps.traceMirror("mirror.candidate.noop", {
            threadId,
            itemId: candidate.itemId,
            kind: candidate.kind,
            reason: "unchanged_signature"
          });
        }
        continue;
      }

      const alreadyMirrored = this.runtime.mirroredAgentItems.has(itemKey);
      const allowByCursor =
        this.deps.shouldMirrorCandidate(threadId, candidate.cursor) ||
        this.deps.allowLateSameTurnCandidate(threadId, candidate);
      const allowByTurn = this.deps.shouldMirrorTurnCandidate(threadId, candidate.turnCursor);
      if (!alreadyMirrored && (!allowByCursor || !allowByTurn)) {
        this.deps.traceMirror("mirror.candidate.skip", {
          threadId,
          itemId: candidate.itemId,
          kind: candidate.kind,
          reason: !allowByCursor ? "cursor_gate" : "turn_gate",
          cursor: candidate.cursor,
          turnCursor: candidate.turnCursor,
          turnId: candidate.turnId,
          timestampMs: candidate.timestampMs
        });
        continue;
      }
      const previousSignature = this.runtime.mirroredAgentItems.get(itemKey) ?? null;
      await this.publishCompletedAgentMessage(
        threadId,
        candidate.itemId,
        candidate.text,
        candidate.phase || undefined,
        candidate.timestampMs,
        candidate.timestampIsApproximate,
        candidate.cursor,
        candidate.turnId,
        candidate.turnCursor,
        this.deps.buildCandidateDevDetail(threadId, candidate)
      );
      if (this.runtime.mirroredAgentItems.get(itemKey) !== previousSignature) {
        mirrored += 1;
        this.deps.traceMirror("mirror.candidate.mirrored", {
          threadId,
          itemId: candidate.itemId,
          kind: candidate.kind,
          cursor: candidate.cursor,
          turnCursor: candidate.turnCursor,
          turnId: candidate.turnId,
          timestampMs: candidate.timestampMs
        });
        if (
          candidate.cursor &&
          (!latestMirroredCursor || this.deps.compareItemCursor(candidate.cursor, latestMirroredCursor) > 0)
        ) {
          latestMirroredCursor = candidate.cursor;
          latestMirroredTimestampMs = candidate.timestampMs;
        }
        if (
          candidate.turnCursor &&
          (!latestMirroredTurnCursor ||
            this.deps.compareTurnCursor(candidate.turnCursor, latestMirroredTurnCursor) > 0)
        ) {
          latestMirroredTurnCursor = candidate.turnCursor;
        }
      } else {
        this.deps.traceMirror("mirror.candidate.noop", {
          threadId,
          itemId: candidate.itemId,
          kind: candidate.kind,
          reason: "unchanged_signature"
        });
      }
    }
    if (latestMirroredCursor) {
      this.deps.rememberThreadMirrorCursor(
        threadId,
        latestMirroredTimestampMs,
        latestMirroredCursor,
        latestMirroredTurnCursor
      );
    }
    if (mirrored > 0) {
      await this.deps.enforceTurnRetention(threadId);
    }
    return mirrored;
  }

  private async upsertCommandActivitySummary(
    threadId: string,
    itemId: string,
    activityKind: "command" | "fileEdit",
    fileCounts: FileActivityCounts | null,
    timestampMs: number | null,
    timestampIsApproximate: boolean,
    turnId: string | null,
    turnCursor: string | null
  ): Promise<string | null> {
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge) {
      return null;
    }

    const state = this.updateCommandActivitySummaryState(
      this.runtime.commandActivitySummaries.get(threadId),
      threadId,
      itemId,
      activityKind,
      fileCounts,
      timestampMs,
      timestampIsApproximate,
      turnId,
      turnCursor
    );
    const content = this.buildCommandActivitySummaryContent(state);
    state.messageId = await this.context.provider.upsertLiveTextMessage(
      bridge.discordChannelId,
      state.messageId,
      content,
      this.providerMessageOptions(threadId, { detailButtons: [] })
    );
    this.runtime.commandActivitySummaries.set(threadId, state);
    this.deps.traceMirror("discord.grouped.upsert", {
      threadId,
      channelId: bridge.discordChannelId,
      kind: "command",
      itemId,
      turnId,
      turnCursor,
      messageId: state.messageId,
      entryCount: 1,
      detailButtonCount: 0,
      renderedPreview: truncateForDiscord(redactSensitiveText(content.replace(/\s+/g, " ").trim()), 260)
    });
    return state.messageId;
  }

  private isStartupMirrorBatchActive(threadId: string): boolean {
    return this.runtime.startupMirrorBatchByThreadId.has(threadId);
  }

  private queueStartupMirrorBatchEntry(threadId: string, entry: StartupMirrorBatchEntry): boolean {
    const batch = this.runtime.startupMirrorBatchByThreadId.get(threadId);
    if (!batch) {
      return false;
    }
    batch.entries.push(entry);
    return true;
  }

  private async flushStartupMirrorBatch(threadId: string): Promise<void> {
    const batch = this.runtime.startupMirrorBatchByThreadId.get(threadId);
    if (!batch || batch.entries.length === 0) {
      return;
    }

    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const entries = batch.entries;
    batch.entries = [];
    this.runtime.liveAgentMessages.delete(threadId);
    this.closeGroupedMessages(threadId);
    if (!bridge) {
      return;
    }

    const blocks = this.buildStartupMirrorBatchBlocks(threadId, entries);
    const messages: Array<{
      content: string;
      startingBlocks: StartupMirrorRenderedBlock[];
      blocks: StartupMirrorRenderedBlock[];
    }> = [];
    let currentContent = "";
    let currentStartingBlocks: StartupMirrorRenderedBlock[] = [];
    let currentBlocks = new Set<StartupMirrorRenderedBlock>();

    const flushCurrent = (): void => {
      const content = currentContent.trim();
      if (!content) {
        currentContent = "";
        currentStartingBlocks = [];
        currentBlocks = new Set<StartupMirrorRenderedBlock>();
        return;
      }
      messages.push({
        content,
        startingBlocks: currentStartingBlocks,
        blocks: [...currentBlocks]
      });
      currentContent = "";
      currentStartingBlocks = [];
      currentBlocks = new Set<StartupMirrorRenderedBlock>();
    };

    const appendChunk = (chunk: string, block: StartupMirrorRenderedBlock, isFirstChunk: boolean): void => {
      const normalizedChunk = chunk.trim();
      if (!normalizedChunk) {
        return;
      }
      const separator = currentContent ? "\n" : "";
      if (currentContent && currentContent.length + separator.length + normalizedChunk.length > 1800) {
        flushCurrent();
      }
      currentContent = currentContent ? `${currentContent}\n${normalizedChunk}` : normalizedChunk;
      currentBlocks.add(block);
      if (isFirstChunk) {
        currentStartingBlocks.push(block);
      }
    };

    for (const block of blocks) {
      const chunks = this.splitDiscordMessage(block.content);
      if (chunks.length === 0) {
        continue;
      }
      chunks.forEach((chunk, index) => appendChunk(chunk, block, index === 0));
    }
    flushCurrent();

    const rememberedItems = new Map<
      string,
      {
        entry: StartupMirrorBatchEntry;
        block: StartupMirrorRenderedBlock;
        discordMessageIds: Set<string>;
      }
    >();
    for (const message of messages) {
      const messageId = await this.context.provider.upsertLiveTextMessage(
        bridge.discordChannelId,
        null,
        message.content,
        this.providerMessageOptions(threadId, { detailButtons: [] })
      );
      this.deps.traceMirror("discord.message.send", {
        threadId,
        channelId: bridge.discordChannelId,
        kind: "startupBatch",
        itemCount: message.startingBlocks.reduce((total, block) => total + block.entries.length, 0),
        messageId,
        renderedPreview: truncateForDiscord(
          redactSensitiveText(message.content.replace(/\s+/g, " ").trim()),
          260
        )
      });
      for (const block of message.blocks) {
        for (const entry of block.entries) {
          let remembered = rememberedItems.get(entry.itemId);
          if (!remembered) {
            remembered = {
              entry,
              block,
              discordMessageIds: new Set<string>()
            };
            rememberedItems.set(entry.itemId, remembered);
          }
          remembered.discordMessageIds.add(messageId);
        }
      }
    }
    for (const remembered of rememberedItems.values()) {
      const [firstMessageId] = remembered.discordMessageIds;
      if (!firstMessageId) {
        continue;
      }
      this.deps.rememberMirroredItem({
        threadId,
        itemId: remembered.entry.itemId,
        turnId: remembered.entry.turnId,
        kind: remembered.entry.kind,
        discordMessageId: firstMessageId,
        discordMessageIds: [...remembered.discordMessageIds],
        groupKey: null,
        contentSignature: remembered.block.rememberContentSignature ?? remembered.entry.contentSignature,
        renderedContent: remembered.block.rememberRenderedContent ?? remembered.entry.renderedContent,
        timestampMs: remembered.entry.timestampMs,
        cursor: remembered.entry.cursor,
        turnCursor: remembered.entry.turnCursor
      });
    }
  }

  private buildStartupMirrorBatchBlocks(
    threadId: string,
    entries: StartupMirrorBatchEntry[]
  ): StartupMirrorRenderedBlock[] {
    const blocks: StartupMirrorRenderedBlock[] = [];
    const useActivitySummary =
      this.context.runtimeConfig.visibility.commands &&
      this.context.runtimeConfig.ui.commandDisplayMode === "summary";
    let summaryState: CommandActivitySummaryState | undefined;
    let summaryEntries: StartupMirrorBatchEntry[] = [];
    let commandGroup: StartupGroupedBatchEntry[] = [];
    let fileChangeGroup: StartupGroupedBatchEntry[] = [];

    const flushSummaryBlock = (): void => {
      if (!summaryState || summaryEntries.length === 0) {
        return;
      }
      const content = this.buildCommandActivitySummaryContent(summaryState);
      blocks.push({
        content,
        entries: [...summaryEntries],
        rememberContentSignature: content,
        rememberRenderedContent: content
      });
      summaryState = undefined;
      summaryEntries = [];
    };

    const flushGroupedBlock = (
      kind: "command" | "fileChange",
      prefix: string,
      groupedEntries: StartupGroupedBatchEntry[]
    ): StartupGroupedBatchEntry[] => {
      if (groupedEntries.length === 0) {
        return [];
      }
      blocks.push({
        content: this.renderGroupedMessage(
          kind,
          prefix,
          this.sortGroupedEntries(groupedEntries.map((groupedEntry) => groupedEntry.rendered))
        ),
        entries: groupedEntries.map((groupedEntry) => groupedEntry.source)
      });
      return [];
    };

    const flushActivityBlocks = (): void => {
      if (useActivitySummary) {
        flushSummaryBlock();
        return;
      }
      commandGroup = flushGroupedBlock("command", this.deps.renderActivityHeading(threadId), commandGroup);
      fileChangeGroup = flushGroupedBlock("fileChange", this.deps.renderFileEditHeading(threadId), fileChangeGroup);
    };

    for (const entry of entries) {
      if (entry.kind === "command" || entry.kind === "fileChange") {
        if (useActivitySummary) {
          const nextTurnKey = this.deps.mirroredTurnKey(entry.turnId, entry.turnCursor);
          const currentTurnKey =
            summaryEntries.length > 0
              ? this.deps.mirroredTurnKey(summaryEntries[0]!.turnId, summaryEntries[0]!.turnCursor)
              : null;
          if (summaryEntries.length > 0 && nextTurnKey && currentTurnKey && nextTurnKey !== currentTurnKey) {
            flushSummaryBlock();
          }
          summaryState = this.updateCommandActivitySummaryState(
            summaryState,
            threadId,
            entry.itemId,
            entry.kind === "command" ? "command" : "fileEdit",
            entry.fileCounts ?? null,
            entry.timestampMs,
            entry.timestampIsApproximate,
            entry.turnId,
            entry.turnCursor
          );
          summaryEntries.push(entry);
          continue;
        }

        if (entry.kind === "command") {
          const nextTurnKey = this.deps.mirroredTurnKey(entry.turnId, entry.turnCursor);
          const currentTurnKey =
            commandGroup.length > 0
              ? this.deps.mirroredTurnKey(commandGroup[0]!.source.turnId, commandGroup[0]!.source.turnCursor)
              : null;
          if (commandGroup.length > 0 && nextTurnKey && currentTurnKey && nextTurnKey !== currentTurnKey) {
            commandGroup = flushGroupedBlock("command", this.deps.renderActivityHeading(threadId), commandGroup);
          }
          fileChangeGroup = flushGroupedBlock("fileChange", this.deps.renderFileEditHeading(threadId), fileChangeGroup);
          commandGroup.push({
            source: entry,
            rendered: this.createStartupGroupedMessageEntry(entry)
          });
          continue;
        }

        const nextTurnKey = this.deps.mirroredTurnKey(entry.turnId, entry.turnCursor);
        const currentTurnKey =
          fileChangeGroup.length > 0
            ? this.deps.mirroredTurnKey(fileChangeGroup[0]!.source.turnId, fileChangeGroup[0]!.source.turnCursor)
            : null;
        if (fileChangeGroup.length > 0 && nextTurnKey && currentTurnKey && nextTurnKey !== currentTurnKey) {
          fileChangeGroup = flushGroupedBlock("fileChange", this.deps.renderFileEditHeading(threadId), fileChangeGroup);
        }
        commandGroup = flushGroupedBlock("command", this.deps.renderActivityHeading(threadId), commandGroup);
        fileChangeGroup.push({
          source: entry,
          rendered: this.createStartupGroupedMessageEntry(entry)
        });
        continue;
      }

      flushActivityBlocks();
      blocks.push({
        content: entry.renderedContent,
        entries: [entry]
      });
    }

    flushActivityBlocks();
    return blocks;
  }

  private buildCommandActivitySummaryContent(state: CommandActivitySummaryState | undefined): string {
    const commandCount = state?.commandItemIds.size ?? 0;
    const createdFileCount = state?.createdFileKeys.size ?? 0;
    const editedFileCount = state?.editedFileKeys.size ?? 0;
    const deletedFileCount = state?.deletedFileKeys.size ?? 0;
    const timestamp = this.formatMirroredTimestamp(
      state?.timestampMs ?? null,
      state?.timestampIsApproximate ?? true
    );
    const summaryParts: string[] = [];
    if (createdFileCount > 0) {
      summaryParts.push(`created ${createdFileCount} ${createdFileCount === 1 ? "file" : "files"}`);
    }
    if (editedFileCount > 0) {
      summaryParts.push(`edited ${editedFileCount} ${editedFileCount === 1 ? "file" : "files"}`);
    }
    if (deletedFileCount > 0) {
      summaryParts.push(`deleted ${deletedFileCount} ${deletedFileCount === 1 ? "file" : "files"}`);
    }
    if (commandCount > 0) {
      summaryParts.push(`ran ${commandCount} ${commandCount === 1 ? "command" : "commands"}`);
    }
    const firstPart = summaryParts[0];
    const summary =
      !firstPart
        ? "No command or file activity"
        : `${firstPart.charAt(0).toUpperCase()}${firstPart.slice(1)}${summaryParts.length > 1 ? `, ${summaryParts.slice(1).join(", ")}` : ""}`;
    const summaryLine = timestamp ? `${timestamp} ${summary}` : summary;
    return `${this.deps.renderActivityHeading(state?.threadId ?? null)}\n${summaryLine}`;
  }

  private updateCommandActivitySummaryState(
    state: CommandActivitySummaryState | undefined,
    threadId: string,
    itemId: string,
    activityKind: "command" | "fileEdit",
    fileCounts: FileActivityCounts | null,
    timestampMs: number | null,
    timestampIsApproximate: boolean,
    turnId: string | null,
    turnCursor: string | null
  ): CommandActivitySummaryState {
    const incomingTurnKey = this.deps.mirroredTurnKey(turnId, turnCursor);
    const currentTurnKey = state ? this.deps.mirroredTurnKey(state.turnId, state.turnCursor) : null;
    if (state && incomingTurnKey && currentTurnKey && incomingTurnKey !== currentTurnKey) {
      state = undefined;
    }

    const nextState: CommandActivitySummaryState =
      state ?? {
        threadId,
        messageId: null,
        turnId,
        turnCursor,
        commandItemIds: new Set<string>(),
        createdFileKeys: new Set<string>(),
        editedFileKeys: new Set<string>(),
        deletedFileKeys: new Set<string>(),
        timestampMs,
        timestampIsApproximate
      };

    nextState.threadId = threadId;
    if (!nextState.turnId && turnId) {
      nextState.turnId = turnId;
    }
    if (!nextState.turnCursor && turnCursor) {
      nextState.turnCursor = turnCursor;
    }
    if (timestampMs !== null) {
      if (nextState.timestampMs === null || timestampMs > nextState.timestampMs) {
        nextState.timestampMs = timestampMs;
        nextState.timestampIsApproximate = timestampIsApproximate;
      } else if (timestampMs === nextState.timestampMs && !timestampIsApproximate) {
        nextState.timestampIsApproximate = false;
      }
    }

    if (activityKind === "command") {
      nextState.commandItemIds.add(itemId);
    } else {
      this.addFileActivityKeys(
        nextState.createdFileKeys,
        fileCounts?.createdPaths,
        fileCounts?.created ?? 0,
        `created:${itemId}`
      );
      this.addFileActivityKeys(
        nextState.editedFileKeys,
        fileCounts?.editedPaths,
        fileCounts?.edited ?? 0,
        `edited:${itemId}`
      );
      this.addFileActivityKeys(
        nextState.deletedFileKeys,
        fileCounts?.deletedPaths,
        fileCounts?.deleted ?? 0,
        `deleted:${itemId}`
      );
    }

    return nextState;
  }

  private createStartupGroupedMessageEntry(entry: StartupMirrorBatchEntry): GroupedDiscordMessageEntry {
    const content = redactSensitiveText(entry.groupedEntryContent ?? entry.contentSignature).trim();
    return {
      itemId: entry.itemId,
      sortCursor: entry.cursor,
      content,
      detail: null,
      detailToken: null,
      detailButtonLabel: null,
      detailExpiresAt: null,
      showDetailButton: false,
      devDetail: null,
      devDetailToken: null,
      devDetailButtonLabel: null,
      devDetailExpiresAt: null,
      showDevDetailButton: false
    };
  }

  private addFileActivityKeys(
    target: Set<string>,
    paths: string[] | undefined,
    fallbackCount: number,
    fallbackPrefix: string
  ): void {
    const normalizedPaths = (Array.isArray(paths) ? paths : [])
      .map((value) => this.normalizeFileActivityKey(value))
      .filter((value): value is string => Boolean(value));
    if (normalizedPaths.length > 0) {
      for (const normalizedPath of normalizedPaths) {
        target.add(normalizedPath);
      }
      return;
    }

    const count = Math.max(0, Math.trunc(fallbackCount));
    for (let index = 0; index < count; index += 1) {
      target.add(`${fallbackPrefix}:${index}`);
    }
  }

  private normalizeFileActivityKey(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return normalizePathForComparison(trimmed);
  }

  private async publishChunkedMirroredItem(options: {
    threadId: string;
    itemId: string;
    turnId: string | null;
    turnCursor: string | null;
    timestampMs: number | null;
    timestampIsApproximate: boolean;
    cursor: string | null;
    channelId: string;
    itemKey: string;
    chunks: string[];
    signature: string;
    traceKind: "agentAnswer" | "startupBackfillNotice" | "user";
    rememberKind: "agentAnswer" | "user";
    signatureMap: Map<string, string>;
    trackedMessages: Map<string, TrackedDiscordMessageState>;
    firstMessageId: string | null;
    firstMessageMode: "upsert" | "sendUnlessTracked";
    createDetails: () => PendingMessageDetail[];
    createFirstAction?: () => PendingProposedPlanAction | null;
    includeTimestampTrace: boolean;
  }): Promise<{ firstMessageId: string | null }> {
    const firstChunk = options.chunks[0];
    if (!firstChunk) {
      return { firstMessageId: null };
    }

    const firstDetails = options.createDetails();
    const firstAction = options.createFirstAction?.() ?? null;
    const firstProviderOptions = this.providerMessageOptions(options.threadId, {
      detailButtons: firstDetails.map((entry) => entry.button),
      actionButtons: firstAction?.buttons ?? []
    });
    const firstMessageId =
      options.firstMessageMode === "upsert" || options.firstMessageId
        ? await this.context.provider.upsertLiveTextMessage(
            options.channelId,
            options.firstMessageId,
            firstChunk,
            firstProviderOptions
          )
        : await this.context.provider.sendTextMessage(
            options.channelId,
            firstChunk,
            firstProviderOptions
          );
    const firstTraceEvent =
      options.firstMessageMode === "upsert" || options.firstMessageId
        ? "discord.message.upsert"
        : "discord.message.send";
    this.traceChunkedMirroredItem(firstTraceEvent, options, firstMessageId, firstChunk);
    this.persistPendingMessageDetails(
      firstMessageId,
      firstDetails.map((entry) => entry.record)
    );
    this.persistPendingProposedPlanAction(firstMessageId, firstAction?.record ?? null);
    options.trackedMessages.set(options.itemKey, {
      messageId: firstMessageId,
      content: firstChunk
    });

    const discordMessageIds = [firstMessageId];
    for (const chunk of options.chunks.slice(1)) {
      const chunkDetails = options.createDetails();
      const messageId = await this.context.provider.sendTextMessage(
        options.channelId,
        chunk,
        this.providerMessageOptions(options.threadId, {
          detailButtons: chunkDetails.map((entry) => entry.button)
        })
      );
      this.traceChunkedMirroredItem("discord.message.send", options, messageId, chunk);
      this.persistPendingMessageDetails(
        messageId,
        chunkDetails.map((entry) => entry.record)
      );
      discordMessageIds.push(messageId);
    }

    this.deps.rememberMirroredItem({
      threadId: options.threadId,
      itemId: options.itemId,
      turnId: options.turnId,
      kind: options.rememberKind,
      discordMessageId: firstMessageId,
      discordMessageIds,
      groupKey: null,
      contentSignature: options.signature,
      renderedContent: firstChunk,
      timestampMs: options.timestampMs,
      cursor: options.cursor,
      turnCursor: options.turnCursor
    });
    options.signatureMap.set(options.itemKey, options.signature);
    return { firstMessageId };
  }

  private traceChunkedMirroredItem(
    event: "discord.message.upsert" | "discord.message.send",
    options: {
      threadId: string;
      channelId: string;
      traceKind: "agentAnswer" | "startupBackfillNotice" | "user";
      itemId: string;
      turnId: string | null;
      turnCursor: string | null;
      timestampMs: number | null;
      timestampIsApproximate: boolean;
      includeTimestampTrace: boolean;
    },
    messageId: string,
    chunk: string
  ): void {
    this.deps.traceMirror(event, {
      threadId: options.threadId,
      channelId: options.channelId,
      kind: options.traceKind,
      itemId: options.itemId,
      turnId: options.turnId,
      turnCursor: options.turnCursor,
      messageId,
      ...(options.includeTimestampTrace
        ? {
            timestampMs: options.timestampMs,
            timestampIso: options.timestampMs !== null ? new Date(options.timestampMs).toISOString() : null,
            timestampIsApproximate: options.timestampIsApproximate
          }
        : {}),
      renderedPreview: truncateForDiscord(
        redactSensitiveText(chunk.replace(/\s+/g, " ").trim()),
        260
      )
    });
  }

  private splitDiscordMessage(text: string): string[] {
    const normalized = text.trim();
    if (!normalized) {
      return [];
    }

    const maxLength = 1800;
    const chunks: string[] = [];
    let remaining = normalized;
    while (remaining.length > maxLength) {
      let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
      if (splitIndex < 500) {
        splitIndex = remaining.lastIndexOf("\n", maxLength);
      }
      if (splitIndex < 500) {
        splitIndex = remaining.lastIndexOf(" ", maxLength);
      }
      if (splitIndex < 500) {
        splitIndex = maxLength;
      }
      chunks.push(remaining.slice(0, splitIndex).trim());
      remaining = remaining.slice(splitIndex).trim();
    }
    if (remaining) {
      chunks.push(remaining);
    }
    return chunks;
  }

  private limitLiveMessageChunk(text: string): string {
    const chunks = this.splitDiscordMessage(text);
    if (chunks.length === 0) {
      return "";
    }
    return chunks[0] ?? "";
  }

  private async upsertGroupedMessageEntry(
    threadId: string,
    target: Map<string, GroupedDiscordMessageState>,
    prefix: string,
    itemId: string,
    entry: string,
    preferredMessageId: string | null = null,
    kind: "agentCommentary" | "command" | "fileChange",
    contentSignature: string,
    timestampMs: number | null,
    sortCursor: string | null = null,
    turnId: string | null = null,
    turnCursor: string | null = null,
    detail: string | null = null,
    interactiveOptions?: {
      title: string;
      showDetailsButton: boolean;
      devTitle?: string;
      devDetail?: string | null;
    }
  ): Promise<void> {
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const sanitizedEntry = redactSensitiveText(entry).trim();
    if (!bridge || !sanitizedEntry) {
      return;
    }

    let state = target.get(threadId) ?? {
      messageId: preferredMessageId,
      turnId,
      turnCursor,
      entries: [],
      groupDevDetailToken: null,
      groupDevDetailExpiresAt: null,
      groupDevDetailButtonLabel: null,
      groupDevDetail: null
    };
    const currentTurnKey = this.deps.mirroredTurnKey(state.turnId, state.turnCursor);
    const incomingTurnKey = this.deps.mirroredTurnKey(turnId, turnCursor);
    if (state.entries.length > 0 && currentTurnKey && incomingTurnKey && currentTurnKey !== incomingTurnKey) {
      state = {
        messageId: null,
        turnId,
        turnCursor,
        entries: [],
        groupDevDetailToken: null,
        groupDevDetailExpiresAt: null,
        groupDevDetailButtonLabel: null,
        groupDevDetail: null
      };
    } else {
      if (!state.turnId && turnId) {
        state.turnId = turnId;
      }
      if (!state.turnCursor && turnCursor) {
        state.turnCursor = turnCursor;
      }
    }
    const existingIndex = state.entries.findIndex((existing) => existing.itemId === itemId);
    const existingEntry = existingIndex >= 0 ? state.entries[existingIndex]! : null;
    const wantsDetailButton = Boolean(interactiveOptions?.showDetailsButton && detail);
    const removedDetailToken =
      existingEntry?.detailToken && !wantsDetailButton
        ? existingEntry.detailToken
        : null;
    const wantsDevDetailButton = Boolean(
      this.context.runtimeConfig.ui.showDevDetailButtons && interactiveOptions?.devDetail
    );
    const removedDevDetailToken =
      existingEntry?.devDetailToken && !wantsDevDetailButton
        ? existingEntry.devDetailToken
        : null;
    const nextDetailExpiresAt = wantsDetailButton ? this.messageDetailExpiresAtIso() : null;
    const nextDevDetailExpiresAt = wantsDevDetailButton ? this.messageDetailExpiresAtIso() : null;
    const nextEntry: GroupedDiscordMessageEntry =
      existingIndex >= 0
        ? {
            ...existingEntry!,
            itemId,
            sortCursor,
            content: sanitizedEntry,
            detail,
            detailToken: wantsDetailButton
              ? existingEntry!.detailToken ?? this.context.policy.createOpaqueToken()
              : null,
            detailButtonLabel: wantsDetailButton ? existingEntry!.detailButtonLabel : null,
            detailExpiresAt: wantsDetailButton ? nextDetailExpiresAt : null,
            showDetailButton: wantsDetailButton,
            devDetail: interactiveOptions?.devDetail ?? null,
            devDetailToken: wantsDevDetailButton
              ? existingEntry!.devDetailToken ?? this.context.policy.createOpaqueToken()
              : null,
            devDetailButtonLabel: wantsDevDetailButton ? existingEntry!.devDetailButtonLabel : null,
            devDetailExpiresAt: wantsDevDetailButton ? nextDevDetailExpiresAt : null,
            showDevDetailButton: wantsDevDetailButton
          }
        : {
            itemId,
            sortCursor,
            content: sanitizedEntry,
            detail,
            detailToken: wantsDetailButton ? this.context.policy.createOpaqueToken() : null,
            detailButtonLabel: null,
            detailExpiresAt: nextDetailExpiresAt,
            showDetailButton: wantsDetailButton,
            devDetail: interactiveOptions?.devDetail ?? null,
            devDetailToken: wantsDevDetailButton ? this.context.policy.createOpaqueToken() : null,
            devDetailButtonLabel: null,
            devDetailExpiresAt: nextDevDetailExpiresAt,
            showDevDetailButton: wantsDevDetailButton
          };
    let nextEntries =
      existingIndex >= 0
        ? state.entries.map((existing, index) =>
            index === existingIndex ? nextEntry : existing
          )
        : [...state.entries, nextEntry];
    nextEntries = this.sortGroupedEntries(nextEntries);
    let rendered = this.renderGroupedMessage(kind, prefix, nextEntries);
    if (this.splitDiscordMessage(rendered).length > 1 && state.entries.length > 0 && existingIndex < 0) {
      state = {
        messageId: null,
        turnId,
        turnCursor,
        entries: [nextEntry],
        groupDevDetailToken: null,
        groupDevDetailExpiresAt: null,
        groupDevDetailButtonLabel: null,
        groupDevDetail: null
      };
      nextEntries = state.entries;
      rendered = this.renderGroupedMessage(kind, prefix, nextEntries);
    } else {
      state.entries = nextEntries;
    }

    if (removedDetailToken) {
      this.context.stateStore.deleteMessageDetail(removedDetailToken);
    }
    if (removedDevDetailToken) {
      this.context.stateStore.deleteMessageDetail(removedDevDetailToken);
    }

    if (state.groupDevDetailToken) {
      this.context.stateStore.deleteMessageDetail(state.groupDevDetailToken);
      state.groupDevDetailToken = null;
      state.groupDevDetailExpiresAt = null;
      state.groupDevDetailButtonLabel = null;
      state.groupDevDetail = null;
    }

    const detailButtons = this.buildGroupedDetailButtons(kind, state.entries);
    state.messageId = await this.context.provider.upsertLiveTextMessage(
      bridge.discordChannelId,
      state.messageId,
      rendered,
      this.providerMessageOptions(threadId, {
        detailButtons
      })
    );
    target.set(threadId, state);
    this.deps.traceMirror("discord.grouped.upsert", {
      threadId,
      channelId: bridge.discordChannelId,
      kind,
      itemId,
      turnId,
      turnCursor,
      messageId: state.messageId,
      entryCount: state.entries.length,
      detailButtonCount: detailButtons.length,
      renderedPreview: truncateForDiscord(
        redactSensitiveText(rendered.replace(/\s+/g, " ").trim()),
        260
      )
    });
    if (interactiveOptions) {
      for (const [index, groupedEntry] of state.entries.entries()) {
        if (
          !groupedEntry.showDetailButton ||
          !groupedEntry.detailToken ||
          !groupedEntry.detail ||
          !groupedEntry.detailExpiresAt
        ) {
          continue;
        }
        const buttonLabel =
          groupedEntry.detailButtonLabel ??
          this.formatGroupedDetailButtonLabel(kind, index);
        groupedEntry.detailButtonLabel = buttonLabel;
        this.context.stateStore.upsertMessageDetail({
          token: groupedEntry.detailToken,
          threadId,
          kind: kind === "fileChange" ? "fileChange" : "command",
          title: `${interactiveOptions.title} ${buttonLabel}`,
          buttonLabel,
          detail: groupedEntry.detail,
          discordMessageId: state.messageId,
          expiresAt: groupedEntry.detailExpiresAt,
          updatedAt: new Date().toISOString()
        });
      }
      for (const [index, groupedEntry] of state.entries.entries()) {
        if (
          !groupedEntry.showDevDetailButton ||
          !groupedEntry.devDetailToken ||
          !groupedEntry.devDetail ||
          !groupedEntry.devDetailExpiresAt
        ) {
          continue;
        }
        const buttonLabel =
          groupedEntry.devDetailButtonLabel ??
          this.formatGroupedDevDetailButtonLabel(index);
        groupedEntry.devDetailButtonLabel = buttonLabel;
        this.context.stateStore.upsertMessageDetail({
          token: groupedEntry.devDetailToken,
          threadId,
          kind: "debug",
          title: `${interactiveOptions.devTitle ?? interactiveOptions.title} ${buttonLabel}`,
          buttonLabel,
          detail: groupedEntry.devDetail,
          discordMessageId: state.messageId,
          expiresAt: groupedEntry.devDetailExpiresAt,
          updatedAt: new Date().toISOString()
        });
      }
    }
    this.deps.rememberMirroredItem({
      threadId,
      itemId,
      turnId,
      kind,
      discordMessageId: state.messageId,
      groupKey: kind,
      contentSignature,
      renderedContent: sanitizedEntry,
      timestampMs,
      cursor: sortCursor ?? this.deps.buildMirrorCursor(timestampMs, itemId),
      turnCursor
    });
  }

  private renderGroupedMessage(
    kind: "agentCommentary" | "command" | "fileChange",
    prefix: string,
    entries: GroupedDiscordMessageEntry[]
  ): string {
    void kind;
    return renderGroupedDiscordMessage(prefix, entries);
  }

  private sortGroupedEntries(entries: GroupedDiscordMessageEntry[]): GroupedDiscordMessageEntry[] {
    return sortGroupedDiscordEntries(entries, (left, right) => this.deps.compareItemCursor(left, right));
  }

  private buildGroupedDetailButtons(
    kind: "agentCommentary" | "command" | "fileChange",
    entries: GroupedDiscordMessageEntry[]
  ): ProviderDetailButton[] {
    const buttons: ProviderDetailButton[] = [];
    entries.forEach((entry, index) => {
      if (entry.showDetailButton && entry.detailToken && entry.detail) {
        const label = entry.detailButtonLabel ?? this.formatGroupedDetailButtonLabel(kind, index);
        entry.detailButtonLabel = label;
        buttons.push({
          token: entry.detailToken,
          label
        });
      }
      if (entry.showDevDetailButton && entry.devDetailToken && entry.devDetail) {
        const label = entry.devDetailButtonLabel ?? this.formatGroupedDevDetailButtonLabel(index);
        entry.devDetailButtonLabel = label;
        buttons.push({
          token: entry.devDetailToken,
          label
        });
      }
    });
    return buttons.slice(0, 25);
  }

  private formatGroupedDetailButtonLabel(
    kind: "agentCommentary" | "command" | "fileChange",
    index: number
  ): string {
    const position = index + 1;
    if (kind === "fileChange") {
      return `Edit ${position}`;
    }
    return `Cmd ${position}`;
  }

  private formatGroupedDevDetailButtonLabel(index: number): string {
    return `Dev ${index + 1}`;
  }

  private messageDetailExpiresAtIso(fromMs = Date.now()): string {
    return new Date(fromMs + this.context.runtimeConfig.ui.detailButtonTtlMinutes * 60 * 1000).toISOString();
  }

  private createPendingMessageDetail(
    threadId: string,
    kind: "command" | "fileChange" | "debug",
    title: string,
    buttonLabel: string,
    detail: string | null
  ): { button: ProviderDetailButton; record: Omit<MessageDetailRecord, "discordMessageId"> } | null {
    if (kind === "debug" && !this.context.runtimeConfig.ui.showDevDetailButtons) {
      return null;
    }
    if (!detail?.trim()) {
      return null;
    }
    const token = this.context.policy.createOpaqueToken();
    return {
      button: {
        token,
        label: buttonLabel
      },
      record: {
        token,
        threadId,
        kind,
        title,
        buttonLabel,
        detail,
        expiresAt: this.messageDetailExpiresAtIso(),
        updatedAt: new Date().toISOString()
      }
    };
  }

  private persistPendingMessageDetails(
    discordMessageId: string,
    records: Array<Omit<MessageDetailRecord, "discordMessageId">>
  ): void {
    for (const record of records) {
      this.context.stateStore.upsertMessageDetail({
        ...record,
        discordMessageId
      });
    }
  }

  private createPendingProposedPlanAction(
    threadId: string,
    itemId: string,
    turnId: string | null,
    text: string
  ): { buttons: DiscordCommandButton[]; record: Omit<ProposedPlanActionRecord, "discordMessageId"> } | null {
    const match = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i.exec(text);
    const planText = match?.[1]?.trim();
    if (!planText) {
      return null;
    }
    if (!this.context.runtimeConfig.approvals.allowFromDiscord) {
      return null;
    }

    const token = this.context.policy.createOpaqueToken();
    const now = new Date();
    const nowIso = now.toISOString();
    return {
      buttons: [
        {
          customId: buildProposedPlanActionCustomId(token, "accept"),
          label: ACCEPT_PROPOSED_PLAN_LABEL,
          style: "primary"
        },
        {
          customId: buildProposedPlanActionCustomId(token, "feedback"),
          label: TELL_CODEX_DIFFERENTLY_LABEL,
          style: "secondary"
        }
      ],
      record: {
        token,
        threadId,
        turnId,
        itemId,
        planText,
        status: "pending",
        createdAt: nowIso,
        updatedAt: nowIso,
        completedAt: null,
        expiresAt: new Date(now.getTime() + PROPOSED_PLAN_ACTION_TTL_MS).toISOString(),
        error: null
      }
    };
  }

  private persistPendingProposedPlanAction(
    discordMessageId: string,
    record: Omit<ProposedPlanActionRecord, "discordMessageId"> | null
  ): void {
    if (!record) {
      return;
    }
    this.context.stateStore.upsertProposedPlanAction({
      ...record,
      discordMessageId
    });
  }

  private formatMirroredTimestamp(timestampMs: number | null, isApproximate = false): string {
    return formatRenderedTimestamp(timestampMs, isApproximate);
  }

  private formatMirroredNarrativeText(text: string): string {
    return formatMirroredNarrativeMessage(text);
  }

  private closeCommentaryGroup(threadId: string): void {
    this.runtime.groupedCommentaryMessages.delete(threadId);
  }

  private closeCommandGroup(threadId: string): void {
    this.runtime.groupedCommandMessages.delete(threadId);
    this.runtime.commandActivitySummaries.delete(threadId);
  }

  private closeFileChangeGroup(threadId: string): void {
    this.runtime.groupedFileChangeMessages.delete(threadId);
  }

  private closeGroupedMessages(threadId: string): void {
    this.closeCommentaryGroup(threadId);
    this.closeCommandGroup(threadId);
    this.closeFileChangeGroup(threadId);
  }

  private renderCommandDetail(
    command: string,
    status: string | null,
    timestampMs: number | null,
    timestampIsApproximate = false
  ): string {
    const lines = [
      `${this.formatMirroredTimestamp(timestampMs, timestampIsApproximate)} Command`,
      `Command: \`${escapeDiscordInlineCode(redactSensitiveText(command))}\``
    ];
    if (status) {
      lines.push(`Status: ${status}`);
    }
    return lines.join("\n");
  }
}
