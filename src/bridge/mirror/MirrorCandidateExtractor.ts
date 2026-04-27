import type {
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexItem,
  CodexThreadSummary
} from "../../domain.js";
import { shortThreadId } from "../../util/formatting.js";
import {
  escapeDiscordInlineCode,
  redactSensitiveText,
  truncateForDiscord
} from "../../util/redaction.js";
import { shouldIgnoreLiveE2eHelperCommand } from "../../util/liveE2e.js";
import { isConversationUserAnchorText, parseUserEnvelope } from "../events/eventParsing.js";
import { formatMirroredTimestamp as formatRenderedTimestamp } from "../messageRendering.js";
import {
  compareItemCursor as compareMirrorItemCursor,
  compareTurnCursor as compareMirrorTurnCursor
} from "../mirrorCursors.js";
import type {
  BridgeRuntimeState,
  CommandPreviewInfo,
  FileActivityCounts,
  MirrorCandidate,
  ThreadSourceFrontier
} from "../runtime/BridgeRuntimeState.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";

export class MirrorCandidateExtractor {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState
  ) {}

  countUserMessagesInTurn(threadId: string, turn: unknown): number {
    return this.extractTurnItems(turn).filter((item) => {
      const text = this.extractUserMessageText(item, threadId);
      return Boolean(text && isConversationUserAnchorText(text));
    }).length;
  }

  isSyntheticOnlyConversationTurn(threadId: string, turn: unknown): boolean {
    if (this.isSubagentThread(threadId)) {
      return false;
    }

    let hasSyntheticUser = false;
    let hasRealUser = false;
    for (const item of this.extractTurnItems(turn)) {
      const info = this.extractUserMessageInfo(item);
      if (!info) {
        continue;
      }
      const envelope = parseUserEnvelope(info.text);
      if (info.isSyntheticSubagentInstruction || envelope?.kind === "subagentNotification") {
        hasSyntheticUser = true;
      } else if (isConversationUserAnchorText(info.text)) {
        hasRealUser = true;
      }
    }

    return hasSyntheticUser && !hasRealUser;
  }

  extractUserMessageText(item: CodexItem, threadId?: string | null): string | null {
    const info = this.extractUserMessageInfo(item);
    if (!info) {
      return null;
    }

    if (threadId !== undefined && this.shouldSuppressSyntheticUserMessage(threadId, info)) {
      return null;
    }

    return info.text;
  }

  extractUserMessageInfo(item: CodexItem): {
    text: string;
    isSyntheticSubagentInstruction: boolean;
  } | null {
    const candidate = item as CodexItem & {
      text?: string;
      role?: string;
      content?: Array<Record<string, unknown>>;
    };
    const type = String(item.type ?? "").toLowerCase();
    const role = String(candidate.role ?? "").toLowerCase();
    if (!(type.includes("user") || role === "user")) {
      return null;
    }

    const directText = typeof candidate.text === "string" ? candidate.text.trim() : "";
    if (directText) {
      return {
        text: directText,
        isSyntheticSubagentInstruction: false
      };
    }

    if (!Array.isArray(candidate.content)) {
      return null;
    }

    const fragments: string[] = [];
    let hasInputTextPart = false;
    for (const part of candidate.content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const partType = typeof part.type === "string" ? part.type.trim().toLowerCase() : "";
      if (partType === "input_text") {
        hasInputTextPart = true;
      }
      if (typeof part.text === "string" && part.text.trim()) {
        fragments.push(part.text.trim());
      }
    }

    const combined = fragments.join("\n").trim();
    if (!combined) {
      return null;
    }

    return {
      text: combined,
      isSyntheticSubagentInstruction: type === "message" && role === "user" && hasInputTextPart
    };
  }

  shouldSuppressSyntheticUserMessage(
    threadId: string | null,
    info: { isSyntheticSubagentInstruction: boolean }
  ): boolean {
    if (!info.isSyntheticSubagentInstruction) {
      return false;
    }
    return !this.isSubagentThread(threadId);
  }

  shouldSuppressSyntheticSessionUserEvent(
    threadId: string,
    event: { isSyntheticSubagentInstruction?: boolean }
  ): boolean {
    return Boolean(event.isSyntheticSubagentInstruction) && !this.isSubagentThread(threadId);
  }

  shouldSuppressSyntheticSessionTurn(threadId: string, turnId: string | null): boolean {
    if (!turnId || this.isSubagentThread(threadId)) {
      return false;
    }
    return this.runtime.suppressedSyntheticSessionTurnIdsByThread.get(threadId)?.has(turnId) ?? false;
  }

  rememberSuppressedSyntheticSessionTurn(threadId: string, turnId: string): void {
    const existing = this.runtime.suppressedSyntheticSessionTurnIdsByThread.get(threadId) ?? new Set<string>();
    existing.add(turnId);
    this.runtime.suppressedSyntheticSessionTurnIdsByThread.set(threadId, existing);
  }

  isSubagentThread(threadId: string | null): boolean {
    if (!threadId) {
      return false;
    }
    const state = this.runtime.threadState.get(threadId);
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if ((state?.channelKind ?? bridge?.channelKind ?? null) === "subagent") {
      return true;
    }
    if (this.runtime.childThreadParentHints.has(threadId)) {
      return true;
    }
    return Boolean(this.runtime.resolvedMetadataByThread.get(threadId)?.parentThreadId);
  }

  extractAssistantMessage(item: CodexItem): { text: string; phase: string | null } | null {
    const candidate = item as CodexItem & {
      text?: string;
      role?: string;
      content?: Array<Record<string, unknown>>;
      phase?: string;
    };
    const type = String(item.type ?? "").toLowerCase();
    const role = String(candidate.role ?? "").toLowerCase();
    if (!(type === "agentmessage" || role === "assistant")) {
      return null;
    }

    const directText = typeof candidate.text === "string" ? candidate.text.trim() : "";
    if (directText) {
      return {
        text: directText,
        phase: typeof candidate.phase === "string" ? candidate.phase : null
      };
    }

    if (!Array.isArray(candidate.content)) {
      return null;
    }

    const fragments: string[] = [];
    for (const part of candidate.content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      if (typeof part.text === "string" && part.text.trim()) {
        fragments.push(part.text.trim());
      }
    }

    const combined = fragments.join("\n").trim();
    if (!combined) {
      return null;
    }

    return {
      text: combined,
      phase: typeof candidate.phase === "string" ? candidate.phase : null
    };
  }

  extractCommandPreview(item: CodexCommandExecutionItem): string | null {
    return this.extractCommandPreviewInfo(item).preview;
  }

  extractCommandPreviewInfo(item: CodexCommandExecutionItem): CommandPreviewInfo {
    const commandText = this.extractCommandText(item);
    if (!commandText) {
      return { preview: null, truncated: false };
    }

    const fragments = [redactSensitiveText(commandText)];
    if (typeof item.cwd === "string" && item.cwd.trim()) {
      fragments.push(`cwd=${redactSensitiveText(item.cwd.trim())}`);
    }
    if (typeof item.exitCode === "number") {
      fragments.push(`exit=${item.exitCode}`);
    }
    if (typeof item.durationMs === "number") {
      fragments.push(`duration=${item.durationMs}ms`);
    }

    const fullPreview = fragments.join(" | ");
    return {
      preview: truncateForDiscord(fullPreview, this.context.runtimeConfig.ui.commandPreviewMaxLength),
      truncated: fullPreview.length > this.context.runtimeConfig.ui.commandPreviewMaxLength
    };
  }

  extractCommandDetail(item: CodexCommandExecutionItem): string | null {
    const lines: string[] = [];
    const commandText = this.extractCommandText(item, true);

    if (commandText) {
      lines.push(`Command: \`${escapeDiscordInlineCode(commandText)}\``);
    }
    if (typeof item.cwd === "string" && item.cwd.trim()) {
      lines.push(`CWD: \`${escapeDiscordInlineCode(redactSensitiveText(item.cwd.trim()))}\``);
    }
    if (typeof item.status === "string" && item.status.trim()) {
      lines.push(`Status: ${item.status.trim()}`);
    }
    if (typeof item.exitCode === "number") {
      lines.push(`Exit code: ${item.exitCode}`);
    }
    if (typeof item.durationMs === "number") {
      lines.push(`Duration: ${item.durationMs}ms`);
    }
    if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim()) {
      lines.push(`Output preview: ${truncateForDiscord(redactSensitiveText(item.aggregatedOutput.trim()), 600)}`);
    }

    return lines.join("\n");
  }

  renderCommandDetail(
    command: string,
    status: string | null,
    timestampMs: number | null,
    timestampIsApproximate = false
  ): string {
    const lines = [
      `${formatRenderedTimestamp(timestampMs, timestampIsApproximate)} Command`,
      `Command: \`${escapeDiscordInlineCode(redactSensitiveText(command))}\``
    ];
    if (status) {
      lines.push(`Status: ${status}`);
    }
    return lines.join("\n");
  }

  extractFileChangeSummary(item: CodexFileChangeItem): string | null {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    if (changes.length === 0) {
      return item.status === "completed" ? "Applied file changes" : "Edited files";
    }

    const summarized = changes
      .map((change) => {
        const rawPath = typeof change.path === "string" ? redactSensitiveText(change.path.trim()) : "";
        const normalizedPath = rawPath || "unknown file";
        const rawKind = typeof change.kind === "string" ? change.kind.trim().toLowerCase() : "changed";
        const kind =
          rawKind === "add" || rawKind === "added"
            ? "added"
            : rawKind === "delete" || rawKind === "deleted" || rawKind === "remove" || rawKind === "removed"
              ? "deleted"
              : rawKind === "rename" || rawKind === "renamed"
                ? "renamed"
                : "edited";
        return `${kind} \`${escapeDiscordInlineCode(truncateForDiscord(normalizedPath, 120))}\``;
      })
      .slice(0, 5);

    const remainder = changes.length - summarized.length;
    return remainder > 0
      ? `${summarized.join(", ")} (+${remainder} more)`
      : summarized.join(", ");
  }

  extractFileActivityCounts(item: CodexFileChangeItem): FileActivityCounts {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    if (changes.length === 0) {
      return {
        created: 0,
        edited: 1,
        deleted: 0,
        createdPaths: [],
        editedPaths: [],
        deletedPaths: []
      };
    }

    const counts: FileActivityCounts = {
      created: 0,
      edited: 0,
      deleted: 0,
      createdPaths: [],
      editedPaths: [],
      deletedPaths: []
    };
    for (const change of changes) {
      const rawKind = typeof change.kind === "string" ? change.kind.trim().toLowerCase() : "changed";
      const rawPath = typeof change.path === "string" ? change.path.trim() : "";
      if (rawKind === "add" || rawKind === "added") {
        counts.created += 1;
        if (rawPath) {
          counts.createdPaths?.push(rawPath);
        }
        continue;
      }
      if (
        rawKind === "delete" ||
        rawKind === "deleted" ||
        rawKind === "remove" ||
        rawKind === "removed"
      ) {
        counts.deleted += 1;
        if (rawPath) {
          counts.deletedPaths?.push(rawPath);
        }
        continue;
      }
      counts.edited += 1;
      if (rawPath) {
        counts.editedPaths?.push(rawPath);
      }
    }

    if (counts.created === 0 && counts.edited === 0 && counts.deleted === 0) {
      counts.edited = 1;
    }
    return counts;
  }

  extractTurnItems(turn: unknown): CodexItem[] {
    if (!turn || typeof turn !== "object") {
      return [];
    }
    const items = (turn as { items?: unknown }).items;
    return Array.isArray(items) ? (items as CodexItem[]) : [];
  }

  extractTurnStatus(turn: unknown): string | null {
    if (!turn || typeof turn !== "object") {
      return null;
    }
    return typeof (turn as { status?: unknown }).status === "string"
      ? String((turn as { status?: unknown }).status)
      : null;
  }

  extractTimestampMs(input: unknown): number | null {
    return this.extractTimestampFromFields(input, [
      "createdAt",
      "updatedAt",
      "startedAt",
      "completedAt",
      "timestamp",
      "timestampMs"
    ]);
  }

  extractStableTimestampMs(input: unknown): number | null {
    return this.extractTimestampFromFields(input, ["createdAt", "startedAt", "timestamp", "timestampMs"], true);
  }

  extractTurnBaseTimestampMs(input: unknown): number | null {
    return this.extractTimestampFromFields(input, ["createdAt", "startedAt", "timestamp", "timestampMs"], true);
  }

  extractObjectId(input: unknown): string | null {
    if (!input || typeof input !== "object") {
      return null;
    }

    const id = (input as { id?: unknown }).id;
    return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
  }

  extractTrailingNumber(value: string | null | undefined): number | null {
    if (!value) {
      return null;
    }

    const match = value.match(/(\d+)(?!.*\d)/);
    if (!match) {
      return null;
    }

    const parsed = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  extractUuidV7TimestampMs(value: string): number | null {
    const normalized = value.replace(/-/g, "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(normalized)) {
      return null;
    }

    if (normalized[12] !== "7") {
      return null;
    }

    const parsed = Number.parseInt(normalized.slice(0, 12), 16);
    return Number.isFinite(parsed) ? parsed : null;
  }

  compareChronology(
    leftTimestampMs: number | null,
    leftFallbackOrder: number,
    rightTimestampMs: number | null,
    rightFallbackOrder: number
  ): number {
    if (leftTimestampMs !== null && rightTimestampMs !== null && leftTimestampMs !== rightTimestampMs) {
      return leftTimestampMs - rightTimestampMs;
    }
    if (leftTimestampMs !== null && rightTimestampMs === null) {
      return -1;
    }
    if (leftTimestampMs === null && rightTimestampMs !== null) {
      return 1;
    }
    return leftFallbackOrder - rightFallbackOrder;
  }

  resolveMirroredActorName(threadId: string | null): string {
    if (!threadId) {
      return "Codex";
    }
    const state = this.runtime.threadState.get(threadId);
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const channelKind = state?.channelKind ?? bridge?.channelKind ?? "conversation";
    if (channelKind !== "subagent") {
      return "Codex";
    }

    const preferredName = state?.actorName?.trim() || bridge?.actorName?.trim() || "";
    return preferredName || `Sub-agent ${shortThreadId(threadId)}`;
  }

  resolveUserActorContext(threadId: string | null): { label: string; emoji: string } {
    if (!threadId) {
      return { label: "You", emoji: "\u{1F464}" };
    }

    const state = this.runtime.threadState.get(threadId);
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const channelKind = state?.channelKind ?? bridge?.channelKind ?? "conversation";
    if (channelKind !== "subagent") {
      return { label: "You", emoji: "\u{1F464}" };
    }

    const parentThreadId = state?.parentThreadId ?? bridge?.parentCodexThreadId ?? null;
    const parentActorName = this.resolveMirroredActorName(parentThreadId);
    return { label: parentActorName, emoji: "\u{1F916}" };
  }

  renderCodexMessageLabel(
    threadId: string,
    phase: string | null | undefined,
    isLive: boolean
  ): string {
    const actorName = this.resolveMirroredActorName(threadId);
    if (isLive) {
      return `\u{1F4AD} **${actorName}**`;
    }

    const normalized = String(phase ?? "").trim().toLowerCase();
    if (!normalized || normalized.includes("final") || normalized.includes("answer")) {
      return `\u{1F916} **${actorName}**`;
    }

    return `\u{1F4AD} **${actorName}**`;
  }

  renderActivityHeading(threadId: string | null): string {
    const actorName = this.resolveMirroredActorName(threadId);
    return `\u{1F6E0}\uFE0F **${actorName}**`;
  }

  private extractCommandText(item: CodexCommandExecutionItem, redact = false): string {
    if (typeof item.command === "string" && item.command.trim()) {
      return redact ? redactSensitiveText(item.command.trim()) : item.command.trim();
    }

    if (!Array.isArray(item.commandActions)) {
      return "";
    }

    return item.commandActions
      .map((action) => this.extractCommandActionText(action, redact))
      .filter((value): value is string => Boolean(value))
      .join(" | ");
  }

  private extractCommandActionText(
    action: { value?: unknown; label?: unknown },
    redact = false
  ): string | null {
    if (typeof action.value === "string" && action.value.trim()) {
      return redact ? redactSensitiveText(action.value.trim()) : action.value.trim();
    }
    if (typeof action.label === "string" && action.label.trim()) {
      return redact ? redactSensitiveText(action.label.trim()) : action.label.trim();
    }
    return null;
  }

  private extractTimestampFromFields(
    input: unknown,
    fields: string[],
    allowUuidFallback = false
  ): number | null {
    if (!input || typeof input !== "object") {
      return null;
    }

    const candidate = input as Record<string, unknown>;
    for (const field of fields) {
      const parsed = this.parseTimestampValue(candidate[field]);
      if (parsed !== null) {
        return parsed;
      }
    }

    if (!allowUuidFallback) {
      return null;
    }

    const id = this.extractObjectId(input);
    if (!id) {
      return null;
    }
    return this.extractUuidV7TimestampMs(id);
  }

  private parseTimestampValue(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1_000_000_000_000 ? value : value * 1000;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  renderFileEditHeading(threadId: string | null): string {
    const actorName = this.resolveMirroredActorName(threadId);
    return `\u{1F4DD} **${actorName}**`;
  }

  renderCodexHeading(level: 1 | 3, label: string): string {
    const headingPrefix = level === 1 ? "# " : "### ";
    return `${headingPrefix}${label}`.trim();
  }

  renderUserHeading(level: 1 | 3, threadId: string): string {
    const headingPrefix = level === 1 ? "# " : "### ";
    const actor = this.resolveUserActorContext(threadId);
    return `${headingPrefix}${actor.emoji} **${actor.label}**`.trim();
  }

  renderMirroredBlock(heading: string, body: string): string {
    const trimmedHeading = heading.trim();
    const trimmedBody = body.trim();
    if (!trimmedHeading) {
      return trimmedBody;
    }
    if (!trimmedBody) {
      return trimmedHeading;
    }
    return `${trimmedHeading}\n${trimmedBody}`;
  }

  isCommentaryPhase(phase: string | null | undefined): boolean {
    const normalized = String(phase ?? "").trim().toLowerCase();
    return (
      normalized.includes("commentary") ||
      normalized.includes("think") ||
      normalized.includes("analysis") ||
      normalized.includes("reason") ||
      normalized.includes("plan")
    );
  }

  shouldPreferSessionStreamForThread(threadId: string): boolean {
    if (!this.runtime.sessionEventTailerEnabled) {
      return false;
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge) {
      return false;
    }
    return bridge.channelKind === "conversation" || bridge.channelKind === "subagent";
  }

  buildMirrorCandidateCursor(turn: unknown, item: CodexItem, itemOrder: number): string | null {
    const turnTimestampMs = this.extractTurnBaseTimestampMs(turn);
    const turnId = this.extractObjectId(turn);
    const orderKey = itemOrder;

    if (turnTimestampMs !== null) {
      return `${String(turnTimestampMs).padStart(16, "0")}:${String(orderKey).padStart(8, "0")}:${item.id}`;
    }

    if (turnId) {
      return `turn:${turnId.toLowerCase()}:${String(orderKey).padStart(8, "0")}:${item.id}`;
    }

    return `item-order:${String(itemOrder).padStart(8, "0")}:${item.id}`;
  }

  buildNotificationCursor(turnId: string, itemId: string): string | null {
    const turnTimestampMs = this.extractUuidV7TimestampMs(turnId);
    const itemNumericSuffix = this.extractTrailingNumber(itemId);
    const orderKey = itemNumericSuffix ?? 0;

    if (turnTimestampMs !== null) {
      return `${String(turnTimestampMs).padStart(16, "0")}:${String(orderKey).padStart(8, "0")}:${itemId}`;
    }

    if (turnId) {
      return `turn:${turnId.toLowerCase()}:${String(orderKey).padStart(8, "0")}:${itemId}`;
    }

    if (itemNumericSuffix !== null) {
      return `item:${String(itemNumericSuffix).padStart(12, "0")}:${itemId}`;
    }

    return null;
  }

  buildMirrorCursor(timestampMs: number | null, itemId: string, orderKey: number | null = null): string | null {
    if (timestampMs === null) {
      return null;
    }

    const normalizedOrderKey =
      orderKey !== null && Number.isFinite(orderKey)
        ? Math.max(0, Math.trunc(orderKey))
        : (this.extractTrailingNumber(itemId) ?? 0);
    return `${String(timestampMs).padStart(16, "0")}:${String(normalizedOrderKey).padStart(8, "0")}:${itemId}`;
  }

  buildSessionEventCursor(
    sourceOrder: string | null | undefined,
    eventKey: string | null | undefined
  ): string | null {
    const normalizedSourceOrder = sourceOrder?.trim() ?? "";
    const normalizedEventKey = eventKey?.trim() ?? "";
    if (!normalizedSourceOrder || !normalizedEventKey) {
      return null;
    }
    return `session:${normalizedSourceOrder}:${normalizedEventKey}`;
  }

  buildSessionEventItemId(
    fallbackPrefix: string,
    fallbackToken: string,
    eventKey: string | null | undefined,
    sourceOrder: string | null | undefined
  ): string {
    const normalizedEventKey = eventKey?.trim() ?? "";
    if (normalizedEventKey) {
      return `session:${normalizedEventKey}`;
    }
    const normalizedSourceOrder = sourceOrder?.trim() ?? "";
    if (normalizedSourceOrder) {
      return `session:${fallbackPrefix}:${normalizedSourceOrder}`;
    }
    return `session:${fallbackPrefix}:${fallbackToken}`;
  }

  extractSessionSourceFrontier(event: {
    sourceFilePath?: string;
    sourceOffset?: number;
    eventKey?: string;
  }): ThreadSourceFrontier | null {
    if (
      !event.sourceFilePath ||
      typeof event.sourceOffset !== "number" ||
      !Number.isFinite(event.sourceOffset) ||
      !event.eventKey
    ) {
      return null;
    }
    return {
      filePath: event.sourceFilePath,
      offset: Math.max(0, Math.trunc(event.sourceOffset)),
      eventKey: event.eventKey
    };
  }

  buildSessionTurnCursor(turnId: string | null | undefined): string | null {
    if (!turnId) {
      return null;
    }
    return this.buildTurnCursor({ id: turnId }, 0);
  }

  buildTurnCursor(turn: unknown, turnOrder: number): string | null {
    const turnTimestampMs = this.extractTurnBaseTimestampMs(turn);
    const turnId = this.extractObjectId(turn);

    if (turnTimestampMs !== null) {
      return `${String(turnTimestampMs).padStart(16, "0")}:${(turnId ?? `turn-${turnOrder}`).toLowerCase()}`;
    }

    if (turnId) {
      return `turn:${turnId.toLowerCase()}`;
    }

    return `turn-order:${String(turnOrder).padStart(8, "0")}`;
  }

  collectMirrorCandidates(threadId: string, turns: unknown[]): MirrorCandidate[] {
    const candidates: MirrorCandidate[] = [];

    turns.forEach((turn, turnOrder) => {
      if (this.isSyntheticOnlyConversationTurn(threadId, turn)) {
        return;
      }
      const turnTimestampMs = this.extractTurnBaseTimestampMs(turn);
      const turnId = this.extractObjectId(turn);
      const turnCursor = this.buildTurnCursor(turn, turnOrder);
      let lastKnownTimestampMs: number | null = null;
      this.extractTurnItems(turn).forEach((item, itemOrder) => {
        const itemTimestampMs = this.extractStableTimestampMs(item);
        const priorKnownTimestampMs = lastKnownTimestampMs;
        const inheritedTimestampMs = priorKnownTimestampMs ?? turnTimestampMs;
        const timestampMs = itemTimestampMs ?? inheritedTimestampMs;
        if (itemTimestampMs !== null) {
          lastKnownTimestampMs = itemTimestampMs;
        } else if (timestampMs !== null) {
          lastKnownTimestampMs = timestampMs;
        }
        const userText = this.extractUserMessageText(item, threadId);
        if (userText) {
          const envelope = parseUserEnvelope(userText);
          if (envelope?.kind === "subagentNotification") {
            return;
          }
          if (envelope?.kind === "turnAborted") {
            const timestampIsApproximate = !(
              itemTimestampMs !== null || (priorKnownTimestampMs === null && turnTimestampMs !== null && inheritedTimestampMs === turnTimestampMs)
            );
            candidates.push({
              itemId: item.id,
              turnId,
              timestampMs,
              timestampIsApproximate,
              cursor: this.buildMirrorCandidateCursor(turn, item, itemOrder),
              turnCursor,
              turnOrder,
              itemOrder,
              kind: "agentAnswer",
              text: envelope.message,
              detail: null,
              showDetailsButton: false,
              phase: "final_answer",
              status: null,
              rawItem: item,
              rawTurn: turn
            });
            return;
          }
          const timestampIsApproximate = !(
            itemTimestampMs !== null || (priorKnownTimestampMs === null && turnTimestampMs !== null && inheritedTimestampMs === turnTimestampMs)
          );
          candidates.push({
            itemId: item.id,
            turnId,
            timestampMs,
            timestampIsApproximate,
            cursor: this.buildMirrorCandidateCursor(turn, item, itemOrder),
            turnCursor,
            turnOrder,
            itemOrder,
            kind: "user",
            text: userText,
            detail: null,
            showDetailsButton: false,
            phase: null,
            status: null,
            rawItem: item,
            rawTurn: turn
          });
          return;
        }

        const assistantMessage = this.extractAssistantMessage(item);
        if (assistantMessage) {
          const timestampIsApproximate = itemTimestampMs === null && timestampMs !== null;
          candidates.push({
            itemId: item.id,
            turnId,
            timestampMs,
            timestampIsApproximate,
            cursor: this.buildMirrorCandidateCursor(turn, item, itemOrder),
            turnCursor,
            turnOrder,
            itemOrder,
            kind: this.isCommentaryPhase(assistantMessage.phase) ? "agentCommentary" : "agentAnswer",
            text: assistantMessage.text,
            detail: null,
            showDetailsButton: false,
            phase: assistantMessage.phase,
            status: null,
            rawItem: item,
            rawTurn: turn
          });
          return;
        }

        const commandPreview =
          item.type === "commandExecution"
            ? this.extractCommandPreviewInfo(item as CodexCommandExecutionItem)
            : { preview: null, truncated: false };
        if (commandPreview.preview) {
          if (shouldIgnoreLiveE2eHelperCommand(commandPreview.preview)) {
            return;
          }
          const timestampIsApproximate = itemTimestampMs === null && timestampMs !== null;
          const commandItem = item as CodexCommandExecutionItem;
          candidates.push({
            itemId: item.id,
            turnId,
            timestampMs,
            timestampIsApproximate,
            cursor: this.buildMirrorCandidateCursor(turn, item, itemOrder),
            turnCursor,
            turnOrder,
            itemOrder,
            kind: "command",
            text: commandPreview.preview,
            detail: this.extractCommandDetail(commandItem),
            showDetailsButton: commandPreview.truncated,
            phase: null,
            status: typeof commandItem.status === "string" ? commandItem.status : null,
            rawItem: item,
            rawTurn: turn
          });
          return;
        }

        const fileChangeSummary =
          item.type === "fileChange"
            ? this.extractFileChangeSummary(item as CodexFileChangeItem)
            : null;
        if (fileChangeSummary) {
          const timestampIsApproximate = itemTimestampMs === null && timestampMs !== null;
          const fileChangeItem = item as CodexFileChangeItem;
          candidates.push({
            itemId: item.id,
            turnId,
            timestampMs,
            timestampIsApproximate,
            cursor: this.buildMirrorCandidateCursor(turn, item, itemOrder),
            turnCursor,
            turnOrder,
            itemOrder,
            kind: "fileChange",
            text: fileChangeSummary,
            detail: null,
            showDetailsButton: false,
            phase: null,
            status: typeof fileChangeItem.status === "string" ? fileChangeItem.status : null,
            rawItem: item,
            rawTurn: turn
          });
        }
      });
    });

    const sorted = candidates.sort((left, right) => {
      if (left.turnCursor && right.turnCursor && left.turnCursor !== right.turnCursor) {
        return this.compareTurnCursor(left.turnCursor, right.turnCursor);
      }
      if (left.turnCursor && !right.turnCursor) {
        return 1;
      }
      if (!left.turnCursor && right.turnCursor) {
        return -1;
      }
      if (
        (left.turnCursor && right.turnCursor && left.turnCursor === right.turnCursor) ||
        (left.turnId && right.turnId && left.turnId === right.turnId) ||
        left.turnOrder === right.turnOrder
      ) {
        if (left.cursor && right.cursor && left.cursor !== right.cursor) {
          return this.compareItemCursor(left.cursor, right.cursor);
        }
        const leftExact = left.timestampMs !== null && !left.timestampIsApproximate;
        const rightExact = right.timestampMs !== null && !right.timestampIsApproximate;
        if (leftExact && rightExact) {
          const leftTimestampMs = left.timestampMs;
          const rightTimestampMs = right.timestampMs;
          if (leftTimestampMs !== null && rightTimestampMs !== null && leftTimestampMs !== rightTimestampMs) {
            return leftTimestampMs - rightTimestampMs;
          }
        }
        if (left.itemOrder !== right.itemOrder) {
          return left.itemOrder - right.itemOrder;
        }
        return left.itemId.localeCompare(right.itemId);
      }
      const chronology = this.compareChronology(left.timestampMs, left.turnOrder, right.timestampMs, right.turnOrder);
      if (chronology !== 0) {
        return chronology;
      }
      if (left.cursor && right.cursor && left.cursor !== right.cursor) {
        return this.compareItemCursor(left.cursor, right.cursor);
      }
      return left.itemOrder - right.itemOrder;
    });

    const floorTimestampMsByTurn = new Map<string, number>();
    for (const candidate of sorted) {
      if (candidate.timestampMs === null) {
        continue;
      }
      const turnKey = candidate.turnCursor ?? `turn-order:${candidate.turnOrder}`;
      const floorTimestampMs = floorTimestampMsByTurn.get(turnKey) ?? null;
      if (floorTimestampMs !== null && candidate.timestampIsApproximate && candidate.timestampMs < floorTimestampMs) {
        candidate.timestampMs = floorTimestampMs;
      }
      if (floorTimestampMs === null || candidate.timestampMs > floorTimestampMs) {
        floorTimestampMsByTurn.set(turnKey, candidate.timestampMs);
      }
    }

    return sorted;
  }

  describeStatusMix(threads: CodexThreadSummary[]): string {
    const counts = {
      active: 0,
      idle: 0,
      notLoaded: 0,
      systemError: 0
    };

    for (const thread of threads) {
      if (thread.status.type === "active") counts.active += 1;
      else if (thread.status.type === "idle") counts.idle += 1;
      else if (thread.status.type === "systemError") counts.systemError += 1;
      else counts.notLoaded += 1;
    }

    return `active=${counts.active}, idle=${counts.idle}, notLoaded=${counts.notLoaded}, systemError=${counts.systemError}`;
  }

  compareItemCursor(left: string, right: string): number {
    return compareMirrorItemCursor(left, right, {
      extractUuidV7TimestampMs: (value) => this.extractUuidV7TimestampMs(value)
    });
  }

  compareTurnCursor(left: string, right: string): number {
    return compareMirrorTurnCursor(left, right, {
      extractUuidV7TimestampMs: (value) => this.extractUuidV7TimestampMs(value)
    });
  }
}
