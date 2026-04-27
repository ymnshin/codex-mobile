import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { DesktopConversationState } from "../../codex/CodexDesktopIpcClient.js";
import { shortThreadId } from "../../util/formatting.js";
import { withLogScope } from "../../util/terminalLogging.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";

const DESKTOP_STEER_DUMP_THRESHOLD_BYTES = 25 * 1024 * 1024;

export type DesktopSteerRestoreStateSource = "desktop-ipc" | "thread-read" | "none";

export interface DesktopSteerPayloadBuilderDependencies {
  logger: BridgeRuntimeContext["logger"];
  runtimeConfig: BridgeRuntimeContext["runtimeConfig"];
  printProgress(message: string): void;
}

export interface DesktopSteerPayloadSummary {
  conversationTurnCount: number;
  rollbackTurnCount: number;
  rollbackItemCount: number;
  conversationStateBytes: number | null;
  restoreContextBytes: number | null;
  restoreThreadBytes: number | null;
  restoreRollbackResponseBytes: number | null;
  restoreRollbackResponseThreadBytes: number | null;
  estimatedDuplicatedThreadBytes: number | null;
  restoreMessageBytes: number | null;
}

export class DesktopSteerPayloadBuilder {
  constructor(private readonly deps: DesktopSteerPayloadBuilderDependencies) {}

  findInProgressTurnId(turns: unknown[] | undefined): string | null {
    if (!Array.isArray(turns) || turns.length === 0) {
      return null;
    }

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!turn || typeof turn !== "object") {
        continue;
      }
      const status = typeof (turn as { status?: unknown }).status === "string" ? (turn as { status: string }).status : null;
      const turnId =
        typeof (turn as { turnId?: unknown }).turnId === "string"
          ? String((turn as { turnId: string }).turnId)
          : typeof (turn as { id?: unknown }).id === "string"
            ? String((turn as { id: string }).id)
            : null;
      if (status === "inProgress" && turnId) {
        return turnId;
      }
    }

    return null;
  }

  findDesktopInProgressTurnId(desktopConversationState: DesktopConversationState | null): string | null {
    if (!desktopConversationState) {
      return null;
    }
    const turns = Array.isArray(desktopConversationState.turns)
      ? (desktopConversationState.turns as unknown[])
      : undefined;
    return this.findInProgressTurnId(turns);
  }

  buildDesktopRestoreMessage(
    targetThreadId: string,
    desktopConversationState: DesktopConversationState | null,
    preferredTurnId: string
  ): Record<string, unknown> | null {
    if (!desktopConversationState) {
      return null;
    }

    const turns = Array.isArray(desktopConversationState.turns)
      ? (desktopConversationState.turns as unknown[])
      : [];
    const preferredTurn = this.findDesktopTurnById(turns, preferredTurnId);
    const inProgressTurnId = this.findInProgressTurnId(turns);
    const activeTurn = preferredTurn ?? (inProgressTurnId ? this.findDesktopTurnById(turns, inProgressTurnId) : null);
    const latestTurn = activeTurn ?? this.findLatestDesktopTurn(turns);
    if (!latestTurn && turns.length === 0) {
      return null;
    }

    const rawParams =
      latestTurn?.params && typeof latestTurn.params === "object"
        ? (structuredClone(latestTurn.params as Record<string, unknown>) as Record<string, unknown>)
        : {};

    if (typeof rawParams.threadId !== "string" || rawParams.threadId.trim().length === 0) {
      rawParams.threadId = targetThreadId;
    }

    const cwd = this.pickDesktopConversationCwd(rawParams, desktopConversationState);
    if (cwd) {
      rawParams.cwd = cwd;
      if (typeof rawParams.fallbackCwd !== "string" || rawParams.fallbackCwd.trim().length === 0) {
        rawParams.fallbackCwd = cwd;
      }
    }

    if (!Array.isArray(rawParams.attachments)) {
      rawParams.attachments = [];
    }
    if (!Array.isArray(rawParams.commentAttachments)) {
      rawParams.commentAttachments = [];
    }

    if (
      (!rawParams.collaborationMode || typeof rawParams.collaborationMode !== "object") &&
      desktopConversationState.latestCollaborationMode &&
      typeof desktopConversationState.latestCollaborationMode === "object"
    ) {
      rawParams.collaborationMode = structuredClone(
        desktopConversationState.latestCollaborationMode as Record<string, unknown>
      );
    }

    const latestModel =
      typeof desktopConversationState.latestModel === "string" && desktopConversationState.latestModel.trim().length > 0
        ? desktopConversationState.latestModel
        : null;
    if ((rawParams.model == null || rawParams.model === "") && latestModel) {
      rawParams.model = latestModel;
    }

    const latestReasoningEffort =
      typeof desktopConversationState.latestReasoningEffort === "string" &&
      desktopConversationState.latestReasoningEffort.trim().length > 0
        ? desktopConversationState.latestReasoningEffort
        : null;
    if ((rawParams.effort == null || rawParams.effort === "") && latestReasoningEffort) {
      rawParams.effort = latestReasoningEffort;
    }
    if ((rawParams.reasoningEffort == null || rawParams.reasoningEffort === "") && latestReasoningEffort) {
      rawParams.reasoningEffort = latestReasoningEffort;
    }

    const workspaceRoots = this.deriveDesktopWorkspaceRoots(rawParams, cwd);
    if (workspaceRoots.length > 0) {
      rawParams.workspaceRoots = workspaceRoots;
    }

    const restoreContext = this.buildDesktopRestoreContext(rawParams, workspaceRoots);
    const rollbackThread = this.buildDesktopRollbackThread(
      targetThreadId,
      desktopConversationState,
      turns,
      cwd
    );
    if (!restoreContext && !rollbackThread) {
      return null;
    }

    const restoreMessage: Record<string, unknown> = {
      id: `restore:${preferredTurnId || this.findDesktopInProgressTurnId(desktopConversationState) || targetThreadId}`,
      text: restoreContext?.prompt ?? "",
      cwd,
      createdAt: this.pickDesktopRestoreMessageCreatedAt(latestTurn, desktopConversationState)
    };
    if (restoreContext) {
      restoreMessage.context = restoreContext;
    }
    if (rollbackThread) {
      restoreMessage.thread = rollbackThread;
    }

    return restoreMessage;
  }

  summarizeDesktopSteerPayload(
    desktopConversationState: DesktopConversationState | null,
    restoreMessage: Record<string, unknown> | null
  ): DesktopSteerPayloadSummary {
    const conversationTurns = Array.isArray(desktopConversationState?.turns)
      ? (desktopConversationState.turns as unknown[])
      : [];
    const restoreContext =
      restoreMessage?.context && typeof restoreMessage.context === "object"
        ? (restoreMessage.context as Record<string, unknown>)
        : null;
    const rollbackThread =
      restoreMessage?.thread && typeof restoreMessage.thread === "object"
        ? (restoreMessage.thread as Record<string, unknown>)
        : null;
    const rollbackResponse =
      restoreMessage?.rollbackResponse && typeof restoreMessage.rollbackResponse === "object"
        ? (restoreMessage.rollbackResponse as Record<string, unknown>)
        : null;
    const rollbackResponseThread =
      rollbackResponse?.thread && typeof rollbackResponse.thread === "object"
        ? (rollbackResponse.thread as Record<string, unknown>)
        : null;
    const rollbackTurns = Array.isArray(rollbackThread?.turns) ? (rollbackThread.turns as unknown[]) : [];
    let rollbackItemCount = 0;
    for (const turn of rollbackTurns) {
      if (!turn || typeof turn !== "object") {
        continue;
      }
      const items = Array.isArray((turn as { items?: unknown }).items) ? ((turn as { items: unknown[] }).items ?? []) : [];
      rollbackItemCount += items.length;
    }

    return {
      conversationTurnCount: conversationTurns.length,
      rollbackTurnCount: rollbackTurns.length,
      rollbackItemCount,
      conversationStateBytes: this.safeJsonByteLength(desktopConversationState),
      restoreContextBytes: this.safeJsonByteLength(restoreContext),
      restoreThreadBytes: this.safeJsonByteLength(rollbackThread),
      restoreRollbackResponseBytes: this.safeJsonByteLength(rollbackResponse),
      restoreRollbackResponseThreadBytes: this.safeJsonByteLength(rollbackResponseThread),
      estimatedDuplicatedThreadBytes:
        rollbackThread !== null && rollbackResponseThread === rollbackThread
          ? this.safeJsonByteLength(rollbackThread)
          : null,
      restoreMessageBytes: this.safeJsonByteLength(restoreMessage)
    };
  }

  async dumpOversizedDesktopSteerPayload(args: {
    targetThreadId: string;
    runtimeTurnId: string;
    preferredTurnId: string;
    desktopTurnId: string;
    restoreStateSource: DesktopSteerRestoreStateSource;
    waitedForConversationState: boolean;
    waitForConversationStateDurationMs: number;
    desktopConversationState: DesktopConversationState | null;
    restoreMessage: Record<string, unknown> | null;
    steerPayloadSummary: DesktopSteerPayloadSummary;
  }): Promise<void> {
    const restoreMessageBytes =
      typeof args.steerPayloadSummary.restoreMessageBytes === "number"
        ? args.steerPayloadSummary.restoreMessageBytes
        : null;
    if (
      !this.deps.runtimeConfig.diagnostics.desktopSteerDumpEnabled ||
      restoreMessageBytes == null ||
      restoreMessageBytes < DESKTOP_STEER_DUMP_THRESHOLD_BYTES ||
      !args.desktopConversationState
    ) {
      return;
    }

    const configPath = this.deps.runtimeConfig.configPath;
    const dumpDir = path.resolve(path.dirname(configPath), "tmp", "desktop-steer-dumps");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dumpFileName = `${this.sanitizeDesktopSteerDumpComponent(args.targetThreadId)}-${this.sanitizeDesktopSteerDumpComponent(args.desktopTurnId)}-${timestamp}.json`;
    const dumpPath = path.join(dumpDir, dumpFileName);

    const dumpPayload = {
      createdAt: new Date().toISOString(),
      targetThreadId: args.targetThreadId,
      runtimeTurnId: args.runtimeTurnId,
      preferredTurnId: args.preferredTurnId,
      desktopTurnId: args.desktopTurnId,
      restoreStateSource: args.restoreStateSource,
      waitedForConversationState: args.waitedForConversationState,
      waitForConversationStateDurationMs: args.waitForConversationStateDurationMs,
      steerPayloadSummary: args.steerPayloadSummary,
      restoreMessageMeta: args.restoreMessage
        ? {
            id: args.restoreMessage.id ?? null,
            text: args.restoreMessage.text ?? null,
            cwd: args.restoreMessage.cwd ?? null,
            createdAt: args.restoreMessage.createdAt ?? null,
            context: args.restoreMessage.context ?? null,
            keys: Object.keys(args.restoreMessage).slice(0, 24)
          }
        : null,
      desktopConversationState: args.desktopConversationState
    };

    try {
      await mkdir(dumpDir, { recursive: true });
      await writeFile(dumpPath, `${JSON.stringify(dumpPayload)}\n`, "utf8");
      this.deps.printProgress(
        withLogScope(
          "steer-dump",
          `Dumped oversized Desktop steer payload for ${shortThreadId(args.targetThreadId)} to ${dumpPath}.`
        )
      );
      this.deps.logger.info(
        {
          scope: "steer-dump",
          targetThreadId: args.targetThreadId,
          desktopTurnId: args.desktopTurnId,
          dumpPath,
          restoreMessageBytes
        },
        withLogScope("steer-dump", "Dumped oversized Desktop steer payload to disk.")
      );
    } catch (error) {
      this.deps.logger.warn(
        {
          scope: "steer-dump",
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          targetThreadId: args.targetThreadId,
          desktopTurnId: args.desktopTurnId,
          dumpPath
        },
        withLogScope("steer-dump", "Failed to dump oversized Desktop steer payload to disk.")
      );
    }
  }

  formatLogBytes(value: unknown): string {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return "n/a";
    }
    if (value < 1024) {
      return `${value}B`;
    }
    if (value < 1024 * 1024) {
      return `${(value / 1024).toFixed(1)}KB`;
    }
    return `${(value / (1024 * 1024)).toFixed(2)}MB`;
  }

  private buildDesktopRestoreContext(
    rawParams: Record<string, unknown>,
    workspaceRoots: string[]
  ): Record<string, unknown> | null {
    const prompt = this.extractDesktopRestorePrompt(rawParams.input);
    const collaborationMode =
      rawParams.collaborationMode && typeof rawParams.collaborationMode === "object"
        ? structuredClone(rawParams.collaborationMode as Record<string, unknown>)
        : null;
    const commentAttachments = Array.isArray(rawParams.commentAttachments)
      ? (structuredClone(rawParams.commentAttachments as unknown[]) as unknown[])
      : [];
    const fileAttachments = Array.isArray(rawParams.attachments)
      ? (structuredClone(rawParams.attachments as unknown[]) as unknown[])
      : [];

    const context: Record<string, unknown> = {
      prompt,
      workspaceRoots,
      commentAttachments,
      fileAttachments,
      imageAttachments: [],
      addedFiles: []
    };
    if (collaborationMode) {
      context.collaborationMode = collaborationMode;
    }

    if (
      prompt.length === 0 &&
      workspaceRoots.length === 0 &&
      commentAttachments.length === 0 &&
      fileAttachments.length === 0 &&
      !collaborationMode
    ) {
      return null;
    }

    return context;
  }

  private buildDesktopRollbackThread(
    targetThreadId: string,
    desktopConversationState: DesktopConversationState,
    turns: unknown[],
    cwd: string | null
  ): Record<string, unknown> | null {
    const rollbackTurns = turns
      .map((turn) => this.buildDesktopRollbackTurn(turn))
      .filter((turn): turn is Record<string, unknown> => Boolean(turn));
    if (rollbackTurns.length === 0) {
      return null;
    }

    const rollbackThread: Record<string, unknown> = {
      id:
        typeof desktopConversationState.id === "string" && desktopConversationState.id.trim().length > 0
          ? desktopConversationState.id
          : targetThreadId,
      cwd,
      turns: rollbackTurns
    };

    const rolloutPath =
      typeof desktopConversationState.rolloutPath === "string" && desktopConversationState.rolloutPath.trim().length > 0
        ? desktopConversationState.rolloutPath
        : typeof desktopConversationState.path === "string" && desktopConversationState.path.trim().length > 0
          ? desktopConversationState.path
          : null;
    if (rolloutPath) {
      rollbackThread.path = rolloutPath;
    }

    if (desktopConversationState.source != null) {
      rollbackThread.source =
        typeof desktopConversationState.source === "object"
          ? structuredClone(desktopConversationState.source)
          : desktopConversationState.source;
    }

    if (desktopConversationState.gitInfo && typeof desktopConversationState.gitInfo === "object") {
      rollbackThread.gitInfo = structuredClone(desktopConversationState.gitInfo as Record<string, unknown>);
    }

    if (desktopConversationState.threadRuntimeStatus != null) {
      rollbackThread.status =
        typeof desktopConversationState.threadRuntimeStatus === "object"
          ? structuredClone(desktopConversationState.threadRuntimeStatus as Record<string, unknown>)
          : desktopConversationState.threadRuntimeStatus;
    }

    const updatedAtSeconds = this.normalizeDesktopUpdatedAtSeconds(desktopConversationState.updatedAt);
    if (updatedAtSeconds != null) {
      rollbackThread.updatedAt = updatedAtSeconds;
    }

    return rollbackThread;
  }

  private buildDesktopRollbackTurn(turn: unknown): Record<string, unknown> | null {
    if (!turn || typeof turn !== "object") {
      return null;
    }

    const turnRecord = turn as Record<string, unknown>;
    const turnId =
      typeof turnRecord.turnId === "string"
        ? turnRecord.turnId
        : typeof turnRecord.id === "string"
          ? turnRecord.id
          : null;
    if (!turnId) {
      return null;
    }

    const items = this.buildDesktopRollbackTurnItems(turnId, turnRecord);
    const rollbackTurn: Record<string, unknown> = {
      id: turnId,
      status: typeof turnRecord.status === "string" ? turnRecord.status : "complete",
      error: turnRecord.error ?? null,
      items
    };

    return rollbackTurn;
  }

  private buildDesktopRollbackTurnItems(turnId: string, turn: Record<string, unknown>): unknown[] {
    const items = Array.isArray(turn.items)
      ? (structuredClone(turn.items as unknown[]) as unknown[])
      : [];
    for (const item of items) {
      this.sanitizeDesktopRollbackItem(item);
    }
    if (this.hasDesktopRollbackUserMessage(items)) {
      return items;
    }

    const input = this.extractDesktopRollbackInput(turn);
    if (input.length === 0) {
      return items;
    }

    items.unshift({
      id: `${turnId}:user-message`,
      type: "userMessage",
      content: input
    });
    return items;
  }

  private sanitizeDesktopRollbackItem(item: unknown): void {
    if (!item || typeof item !== "object") {
      return;
    }

    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.type === "steeringUserMessage") {
      delete itemRecord.restoreMessage;
      return;
    }

    if (itemRecord.type === "commandExecution") {
      delete itemRecord.aggregatedOutput;
    }
  }

  private hasDesktopRollbackUserMessage(items: unknown[]): boolean {
    const first = items[0];
    return Boolean(
      first &&
        typeof first === "object" &&
        (first as { type?: unknown }).type === "userMessage" &&
        Array.isArray((first as { content?: unknown }).content)
    );
  }

  private extractDesktopRollbackInput(turn: Record<string, unknown>): unknown[] {
    const params = turn.params && typeof turn.params === "object" ? (turn.params as Record<string, unknown>) : null;
    if (params && Array.isArray(params.input)) {
      return structuredClone(params.input as unknown[]) as unknown[];
    }

    if (Array.isArray(turn.input)) {
      return structuredClone(turn.input as unknown[]) as unknown[];
    }

    return [];
  }

  private normalizeDesktopUpdatedAtSeconds(value: unknown): number | null {
    const timestamp =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(timestamp)) {
      return null;
    }

    if (timestamp > 1_000_000_000_000) {
      return Math.floor(timestamp / 1_000);
    }

    return timestamp;
  }

  private pickDesktopRestoreMessageCreatedAt(
    latestTurn: Record<string, unknown> | null,
    desktopConversationState: DesktopConversationState
  ): number {
    const turnStartedAtMs =
      latestTurn && typeof latestTurn.turnStartedAtMs === "number" && Number.isFinite(latestTurn.turnStartedAtMs)
        ? latestTurn.turnStartedAtMs
        : null;
    if (turnStartedAtMs != null) {
      return turnStartedAtMs;
    }

    const updatedAtMs =
      typeof desktopConversationState.updatedAt === "number" && Number.isFinite(desktopConversationState.updatedAt)
        ? desktopConversationState.updatedAt
        : typeof desktopConversationState.updatedAt === "string" && desktopConversationState.updatedAt.trim().length > 0
          ? Number(desktopConversationState.updatedAt)
          : Number.NaN;
    if (Number.isFinite(updatedAtMs)) {
      return updatedAtMs > 1_000_000_000_000 ? updatedAtMs : updatedAtMs * 1_000;
    }

    return Date.now();
  }

  private extractDesktopRestorePrompt(input: unknown): string {
    if (!Array.isArray(input)) {
      return "";
    }

    return input
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const record = entry as Record<string, unknown>;
        return record.type === "text" && typeof record.text === "string" ? record.text : null;
      })
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("");
  }

  private findDesktopTurnById(turns: unknown[], turnId: string): Record<string, unknown> | null {
    for (const turn of turns) {
      if (!turn || typeof turn !== "object") {
        continue;
      }
      const candidateTurnId =
        typeof (turn as { turnId?: unknown }).turnId === "string"
          ? String((turn as { turnId: string }).turnId)
          : typeof (turn as { id?: unknown }).id === "string"
            ? String((turn as { id: string }).id)
            : null;
      if (candidateTurnId === turnId) {
        return turn as Record<string, unknown>;
      }
    }

    return null;
  }

  private findLatestDesktopTurn(turns: unknown[]): Record<string, unknown> | null {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn && typeof turn === "object") {
        return turn as Record<string, unknown>;
      }
    }

    return null;
  }

  private pickDesktopConversationCwd(
    restoreMessage: Record<string, unknown>,
    desktopConversationState: DesktopConversationState
  ): string | null {
    if (typeof restoreMessage.cwd === "string" && restoreMessage.cwd.trim().length > 0) {
      return restoreMessage.cwd;
    }

    return typeof desktopConversationState.cwd === "string" && desktopConversationState.cwd.trim().length > 0
      ? desktopConversationState.cwd
      : null;
  }

  private deriveDesktopWorkspaceRoots(restoreMessage: Record<string, unknown>, cwd: string | null): string[] {
    if (Array.isArray(restoreMessage.workspaceRoots)) {
      const explicitRoots = restoreMessage.workspaceRoots
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim());
      if (explicitRoots.length > 0) {
        return [...new Set(explicitRoots)];
      }
    }

    const sandboxPolicy =
      restoreMessage.sandboxPolicy && typeof restoreMessage.sandboxPolicy === "object"
        ? (restoreMessage.sandboxPolicy as Record<string, unknown>)
        : null;
    const writableRoots = Array.isArray(sandboxPolicy?.writableRoots)
      ? sandboxPolicy.writableRoots
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((entry) => entry.trim())
      : [];
    if (writableRoots.length > 0) {
      return [...new Set(writableRoots)];
    }

    return cwd ? [cwd] : [];
  }

  private sanitizeDesktopSteerDumpComponent(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return "unknown";
    }

    return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  }

  private safeJsonByteLength(value: unknown): number | null {
    if (value == null) {
      return null;
    }
    try {
      return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
      return null;
    }
  }
}
