export { default as test } from "node:test";
export { default as assert } from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { BridgeService } from "../../src/bridge/BridgeService.js";
export { createBridgeConfigFromPreset } from "../../src/config.js";
import { Policy } from "../../src/policy/Policy.js";
export { Policy };
import type { BridgeProviderHandlers } from "../../src/providers/types.js";
import { StateStore } from "../../src/store/StateStore.js";
import { createLogger } from "../../src/logger.js";
export { StateStore };
export { createLogger };
export { CodexSessionEventTailer } from "../../src/codex/CodexSessionEventTailer.js";
export { LIVE_E2E_IGNORE_HELPER_COMMANDS_ENV } from "../../src/util/liveE2e.js";
export {
  ACCEPT_PROPOSED_PLAN_LABEL,
  TELL_CODEX_DIFFERENTLY_LABEL
} from "../../src/util/approvalDecisions.js";

export { mkdirSync, mkdtempSync, path, tmpdir, writeFileSync };

export function testApprovalsConfig(userId: string) {
  return {
    allowFromDiscord: true,
    allowedUserIds: [userId],
    mentionApprovers: true
  };
}

export class FakeCodexAdapter extends EventEmitter {
  public started = false;
  public startCalls = 0;
  public responses: Array<{ requestId: string; result: unknown }> = [];
  public steerRequests: Array<{ threadId: string; expectedTurnId: string; text: string }> = [];
  public steerErrorsByExpectedTurnId = new Map<string, Error>();
  public steerVisibilityDelayMsByExpectedTurnId = new Map<string, number>();
  public startTurnRequests: Array<{ threadId: string; text: string }> = [];
  public resumedThreadIds: string[] = [];
  public readThreadCalls: string[] = [];
  public readThreadErrors = new Map<string, Error>();
  public readThreadDelayMsByThread = new Map<string, number>();
  private readonly readThreadBlockersByThread = new Map<string, Promise<void>>();
  public threads: Array<{
    id: string;
    name: string | null;
    preview: string | null;
    modelProvider: null;
    createdAt: number | null;
    updatedAt: number | null;
    ephemeral: boolean;
    archived?: boolean;
    status: { type: "idle" | "notLoaded" } | { type: "active"; activeFlags: string[] };
  }> = [];
  public metadata = new Map<
    string,
    {
      cwd: string | null;
      repoName: string | null;
      threadName?: string | null;
      actorName?: string | null;
      parentThreadId?: string | null;
      sourceSubagentOther?: string | null;
      originator?: string | null;
      source?: string | null;
    }
  >();
  private readonly filesystemScanMetadataBlockersByThread = new Map<string, Promise<void>>();
  public threadDetails = new Map<string, any>();
  public resumeErrors = new Map<string, Error>();
  public resumeDelayMsByThread = new Map<string, number>();
  public responseDelayMsByRequest = new Map<string, number>();
  public resolveMetadataCalls: Array<{ threadId: string; allowFilesystemScan: boolean }> = [];
  private pendingVisibleUserMessages: Array<{
    threadId: string;
    expectedTurnId: string;
    text: string;
    availableAt: number;
  }> = [];

  async start() {
    this.started = true;
    this.startCalls += 1;
  }
  async stop() {
    this.started = false;
  }
  async checkWriteBackAvailability(_refreshToken = false): Promise<import("../../src/codex/WriteBackAvailability.js").WriteBackAvailability> {
    return { ready: true };
  }
  async listThreads() {
    return this.threads;
  }
  async readThread(threadId: string) {
    this.readThreadCalls.push(threadId);
    this.flushPendingVisibleUserMessages(threadId);
    const blocker = this.readThreadBlockersByThread.get(threadId);
    if (blocker) {
      await blocker;
    }
    const readError = this.readThreadErrors.get(threadId);
    if (readError) {
      throw readError;
    }
    const delayMs = this.readThreadDelayMsByThread.get(threadId) ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (this.threadDetails.has(threadId)) {
      return this.threadDetails.get(threadId);
    }
    return {
      id: threadId,
      name: "Thread",
      preview: "Preview",
      modelProvider: null,
      createdAt: null,
      updatedAt: null,
      ephemeral: false,
      status: { type: "idle" as const }
    };
  }
  async resumeThread(threadId: string, options: { timeoutMs?: number } = {}) {
    this.resumedThreadIds.push(threadId);
    const delayMs = this.resumeDelayMsByThread.get(threadId) ?? 0;
    if (delayMs > 0) {
      const timeoutMs = options.timeoutMs ?? 0;
      if (timeoutMs > 0 && delayMs > timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        throw new Error(`thread/resume timed out after ${timeoutMs}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const error = this.resumeErrors.get(threadId);
    if (error) {
      throw error;
    }
  }
  async steerTurn(threadId: string, expectedTurnId: string, text: string) {
    this.steerRequests.push({ threadId, expectedTurnId, text });
    const error = this.steerErrorsByExpectedTurnId.get(expectedTurnId);
    if (error) {
      throw error;
    }
    const visibilityDelayMs = this.steerVisibilityDelayMsByExpectedTurnId.get(expectedTurnId) ?? 0;
    this.queueVisibleUserMessage(threadId, expectedTurnId, text, visibilityDelayMs);
  }
  async startTurn(threadId: string, text: string) {
    this.startTurnRequests.push({ threadId, text });
    this.scheduleVisibleUserMessage(threadId, `turn_start_${this.startTurnRequests.length}`, text, 0);
  }
  async respondToApproval(requestId: string, decision: string) {
    const delayMs = this.responseDelayMsByRequest.get(requestId) ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    this.responses.push({ requestId, result: decision });
  }
  async respondToServerRequest(requestId: string, result: unknown) {
    const delayMs = this.responseDelayMsByRequest.get(requestId) ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    this.responses.push({ requestId, result });
  }
  async resolveMetadata(
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ) {
    this.resolveMetadataCalls.push({
      threadId,
      allowFilesystemScan: options.allowFilesystemScan ?? true
    });
    const filesystemScanBlocker = this.filesystemScanMetadataBlockersByThread.get(threadId);
    if (filesystemScanBlocker && options.allowFilesystemScan !== false) {
      await filesystemScanBlocker;
    }
    return (
      this.metadata.get(threadId) ?? {
        cwd: null,
        repoName: null,
        threadName: null,
        actorName: null,
        parentThreadId: null,
        sourceSubagentOther: null,
        originator: null,
        source: null
      }
    );
  }

  setFilesystemScanMetadataBlocker(threadId: string, blocker: Promise<void>) {
    this.filesystemScanMetadataBlockersByThread.set(threadId, blocker);
  }

  setReadThreadBlocker(threadId: string, blocker: Promise<void>) {
    this.readThreadBlockersByThread.set(threadId, blocker);
  }

  scheduleVisibleUserMessage(threadId: string, expectedTurnId: string, text: string, delayMs = 0) {
    this.queueVisibleUserMessage(threadId, expectedTurnId, text, delayMs);
  }

  private queueVisibleUserMessage(
    threadId: string,
    expectedTurnId: string,
    text: string,
    delayMs: number
  ) {
    this.pendingVisibleUserMessages.push({
      threadId,
      expectedTurnId,
      text,
      availableAt: Date.now() + Math.max(0, delayMs)
    });
    if (delayMs <= 0) {
      this.flushPendingVisibleUserMessages(threadId);
    }
  }

  private flushPendingVisibleUserMessages(threadId?: string) {
    const now = Date.now();
    const remaining: typeof this.pendingVisibleUserMessages = [];
    for (const pending of this.pendingVisibleUserMessages) {
      const matchesThread = !threadId || pending.threadId === threadId;
      if (matchesThread && pending.availableAt <= now) {
        this.applyVisibleUserMessage(pending.threadId, pending.expectedTurnId, pending.text);
        continue;
      }
      remaining.push(pending);
    }
    this.pendingVisibleUserMessages = remaining;
  }

  private applyVisibleUserMessage(threadId: string, expectedTurnId: string, text: string) {
    const details = this.ensureThreadDetails(threadId);
    const turns = Array.isArray(details.turns) ? details.turns : [];
    details.turns = turns;
    let turn = turns.find((candidate: unknown) => {
      if (!candidate || typeof candidate !== "object") {
        return false;
      }
      const record = candidate as Record<string, unknown>;
      return record.turnId === expectedTurnId || record.id === expectedTurnId;
    });
    if (!turn) {
      turn = {
        id: expectedTurnId,
        status: "inProgress",
        items: []
      };
      turns.push(turn);
    }

    const turnRecord = turn as Record<string, unknown>;
    const items = Array.isArray(turnRecord.items) ? (turnRecord.items as unknown[]) : [];
    turnRecord.items = items;
    const normalizedText = text.trim();
    const exists = items.some((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }
      const record = item as Record<string, unknown>;
      if (record.type !== "userMessage" || !Array.isArray(record.content)) {
        return false;
      }
      const parts = record.content
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const value = (entry as Record<string, unknown>).text;
          return typeof value === "string" ? value.trim() : null;
        })
        .filter((value): value is string => value !== null);
      return parts.join("\n") === normalizedText;
    });
    if (!exists) {
      items.push({
        id: `visible_feedback_${threadId}_${expectedTurnId}_${items.length + 1}`,
        type: "userMessage",
        content: [
          {
            type: "text",
            text
          }
        ]
      });
    }
  }

  private ensureThreadDetails(threadId: string) {
    const existing = this.threadDetails.get(threadId);
    if (existing) {
      return existing;
    }
    const created = {
      id: threadId,
      name: "Thread",
      preview: "Preview",
      modelProvider: null,
      createdAt: null,
      updatedAt: null,
      ephemeral: false,
      status: { type: "idle" as const },
      turns: []
    };
    this.threadDetails.set(threadId, created);
    return created;
  }
}

export class FakeSessionEventTailer {
  private readonly eventsByThread = new Map<string, any[]>();
  private readonly latestTurnBackfillEventsByThread = new Map<string, any[]>();
  private readonly backfillEventsSinceByThread = new Map<string, any[]>();
  private readonly capturedFrontiersByThread = new Map<string, { filePath: string; offset: number } | null>();
  private readonly parentByThread = new Map<string, string | null>();
  private readonly pollBlockersByThread = new Map<string, Promise<void>>();
  private readonly filesystemScanPollBlockersByThread = new Map<string, Promise<void>>();
  private readonly filesystemScanParentThreadBlockersByThread = new Map<string, Promise<void>>();
  private desktopEvents: any[] = [];
  private cliThreads: any[] = [];
  private localThreads: any[] = [];
  public readonly pollThreadCalls: Array<{
    threadId: string;
    allowFilesystemScan?: boolean;
  }> = [];
  public readonly resolveParentThreadIdCalls: Array<{
    threadId: string;
    allowFilesystemScan?: boolean;
  }> = [];
  public readonly rememberedTurnHints: Array<{ threadId: string; turnId: string }> = [];
  public readonly fastForwardedThreadIds: string[] = [];
  public readonly replayedFrontierThreadIds: string[] = [];
  public desktopFastForwardCount = 0;

  setEvents(threadId: string, events: any[]) {
    this.eventsByThread.set(threadId, [...events]);
  }

  setDesktopEvents(events: any[]) {
    this.desktopEvents = [...events];
  }

  setCliThreads(threads: any[]) {
    this.cliThreads = [...threads];
  }

  setLocalThreads(threads: any[]) {
    this.localThreads = [...threads];
  }

  setLatestTurnBackfillEvents(threadId: string, events: any[]) {
    this.latestTurnBackfillEventsByThread.set(threadId, [...events]);
  }

  setBackfillEventsSince(threadId: string, events: any[]) {
    this.backfillEventsSinceByThread.set(threadId, [...events]);
  }

  setCapturedFrontier(threadId: string, frontier: { filePath: string; offset: number } | null) {
    this.capturedFrontiersByThread.set(threadId, frontier);
  }

  setParentThread(threadId: string, parentThreadId: string | null) {
    this.parentByThread.set(threadId, parentThreadId);
  }

  setPollBlocker(threadId: string, blocker: Promise<void>) {
    this.pollBlockersByThread.set(threadId, blocker);
  }

  setFilesystemScanPollBlocker(threadId: string, blocker: Promise<void>) {
    this.filesystemScanPollBlockersByThread.set(threadId, blocker);
  }

  setFilesystemScanParentThreadBlocker(threadId: string, blocker: Promise<void>) {
    this.filesystemScanParentThreadBlockersByThread.set(threadId, blocker);
  }

  rememberTurnHint(threadId: string, turnId: string) {
    this.rememberedTurnHints.push({ threadId, turnId });
  }

  async pollThread(
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ) {
    const call: {
      threadId: string;
      allowFilesystemScan?: boolean;
    } = { threadId };
    if (options.allowFilesystemScan !== undefined) {
      call.allowFilesystemScan = options.allowFilesystemScan;
    }
    this.pollThreadCalls.push(call);
    const filesystemScanBlocker = this.filesystemScanPollBlockersByThread.get(threadId);
    if (filesystemScanBlocker && options.allowFilesystemScan !== false) {
      await filesystemScanBlocker;
    }
    const blocker = this.pollBlockersByThread.get(threadId);
    if (blocker) {
      await blocker;
    }
    const events = this.eventsByThread.get(threadId) ?? [];
    this.eventsByThread.set(threadId, []);
    return events;
  }

  async pollDesktop() {
    const events = this.desktopEvents;
    this.desktopEvents = [];
    return events;
  }

  async fastForwardThread(threadId: string) {
    this.fastForwardedThreadIds.push(threadId);
    this.eventsByThread.set(threadId, []);
    return true;
  }

  async captureThreadFrontier(threadId: string) {
    return this.capturedFrontiersByThread.get(threadId) ?? {
      filePath: `${threadId}.jsonl`,
      offset: 0
    };
  }

  async replayThreadFromFrontier(threadId: string) {
    this.replayedFrontierThreadIds.push(threadId);
    const events = this.eventsByThread.get(threadId) ?? [];
    this.eventsByThread.set(threadId, []);
    return events;
  }

  async fastForwardDesktop() {
    this.desktopFastForwardCount += 1;
    this.desktopEvents = [];
    return 1;
  }

  async listRecentCliThreads() {
    return this.cliThreads;
  }

  async listRecentLocalThreads() {
    if (this.localThreads.length > 0) {
      return this.localThreads;
    }
    return this.cliThreads.map((thread) => ({
      ...thread,
      sourceKind: "cli-session",
      parentThreadId: null,
      actorName: null
    }));
  }

  async readLatestTurnBackfillEvents(threadId: string) {
    return this.readRecentTurnBackfillEvents(threadId, 1);
  }

  async readRecentTurnBackfillEvents(threadId: string, turnCount: number) {
    const events = this.latestTurnBackfillEventsByThread.get(threadId) ?? [];
    if (turnCount <= 1) {
      return events;
    }
    const grouped: Array<{ turnId: string | null; events: any[]; hasUserMessage: boolean }> = [];
    for (const event of events) {
      const turnId = event?.turnId ?? null;
      const current = grouped.at(-1);
      if (!current || current.turnId !== turnId) {
        grouped.push({
          turnId,
          events: [event],
          hasUserMessage: event?.type === "sessionUserMessage"
        });
        continue;
      }
      current.events.push(event);
      if (event?.type === "sessionUserMessage") {
        current.hasUserMessage = true;
      }
    }
    const preferred = grouped.filter((group) => group.turnId && group.hasUserMessage);
    const selectedTurnIds = new Set(
      (preferred.length > 0 ? preferred : grouped)
        .slice(-turnCount)
        .map((group) => group.turnId)
    );
    return grouped
      .filter((group) => selectedTurnIds.has(group.turnId))
      .flatMap((group) => group.events);
  }

  async readBackfillEventsSince(threadId: string) {
    return [...(this.backfillEventsSinceByThread.get(threadId) ?? [])];
  }

  async resolveParentThreadId(
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ) {
    const call: {
      threadId: string;
      allowFilesystemScan?: boolean;
    } = { threadId };
    if (options.allowFilesystemScan !== undefined) {
      call.allowFilesystemScan = options.allowFilesystemScan;
    }
    this.resolveParentThreadIdCalls.push(call);
    const filesystemScanBlocker = this.filesystemScanParentThreadBlockersByThread.get(threadId);
    if (filesystemScanBlocker && options.allowFilesystemScan !== false) {
      await filesystemScanBlocker;
    }
    return this.parentByThread.get(threadId) ?? null;
  }
}

export function createBridgeService(
  options: Record<string, unknown> & {
    policy?: Policy;
    logger?: ReturnType<typeof createLogger>;
    discoveryPollSeconds?: number;
    sourceKinds?: string[];
    sessionEventTailer?: FakeSessionEventTailer;
  }
) {
  return new BridgeService({
    policy: new Policy(testApprovalsConfig("user_1")),
    logger: createLogger("silent"),
    discoveryPollSeconds: 15,
    sourceKinds: ["vscode"],
    ...options
  } as never);
}

export function createBridgeTestRig(
  options: Record<string, unknown> & {
    runtimeConfig?: unknown;
    sessionEventTailer?: FakeSessionEventTailer;
    desktopIpcClient?: FakeDesktopIpcClient;
    discord?: FakeDiscordAdapter;
  } = {}
) {
  const { runtimeConfig, sessionEventTailer, desktopIpcClient, discord: providedDiscord, ...bridgeOptions } = options;
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-bridge-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));
  const codex = new FakeCodexAdapter();
  const discord = providedDiscord ?? new FakeDiscordAdapter();
  const bridge = createBridgeService({
    codexAdapter: codex as never,
    provider: discord as never,
    stateStore: store,
    ...bridgeOptions,
    ...(runtimeConfig !== undefined ? { runtimeConfig } : {}),
    ...(sessionEventTailer ? { sessionEventTailer: sessionEventTailer as never } : {}),
    ...(desktopIpcClient ? { desktopIpcClient: desktopIpcClient as never } : {})
  });

  return {
    dir,
    store,
    codex,
    discord,
    bridge
  };
}

export class FakeDesktopIpcClient extends EventEmitter {
  public started = false;
  public responses: Array<{ method: string; params: Record<string, unknown> }> = [];
  public steerError: Error | null = null;
  public conversationStates = new Map<string, Record<string, unknown>>();
  public ownerClientIdsByThread = new Map<string, string>();
  public pendingRequestsByThread = new Map<string, Map<string, unknown>>();
  public onSteerTurn:
    | ((
        conversationId: string,
        expectedTurnId: string,
        input: unknown,
        options: {
          attachments?: unknown[];
          restoreMessage?: unknown;
          confirmDelivery?: () => Promise<boolean>;
        }
      ) => void | Promise<void>)
    | null = null;

  async start() {
    this.started = true;
  }

  async stop() {
    this.started = false;
  }

  isReady() {
    return this.started;
  }

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    if (eventName === "requestUpserted") {
      const snapshot = args[0] as { threadId?: string; requestId?: string; request?: unknown } | undefined;
      const threadId = typeof snapshot?.threadId === "string" ? snapshot.threadId : null;
      const requestId = typeof snapshot?.requestId === "string" ? snapshot.requestId : null;
      if (threadId && requestId) {
        const requests = this.pendingRequestsByThread.get(threadId) ?? new Map<string, unknown>();
        requests.set(requestId, snapshot?.request ?? null);
        this.pendingRequestsByThread.set(threadId, requests);
      }
    } else if (eventName === "requestRemoved") {
      const snapshot = args[0] as { threadId?: string; requestId?: string } | undefined;
      const threadId = typeof snapshot?.threadId === "string" ? snapshot.threadId : null;
      const requestId = typeof snapshot?.requestId === "string" ? snapshot.requestId : null;
      if (threadId && requestId) {
        const requests = this.pendingRequestsByThread.get(threadId);
        requests?.delete(requestId);
        if (requests && requests.size === 0) {
          this.pendingRequestsByThread.delete(threadId);
        }
      }
    }
    return super.emit(eventName, ...args);
  }

  hasRequest(conversationId: string, requestId: string) {
    return this.pendingRequestsByThread.get(conversationId)?.has(requestId) ?? false;
  }

  getConversationState(conversationId: string) {
    const state = this.conversationStates.get(conversationId);
    return state ? structuredClone(state) : null;
  }

  getOwnerClientId(conversationId: string) {
    return this.ownerClientIdsByThread.get(conversationId) ?? null;
  }

  async waitForConversationState(conversationId: string) {
    return this.getConversationState(conversationId);
  }

  async sendCommandApprovalDecision(conversationId: string, requestId: string, decision: unknown) {
    this.responses.push({
      method: "thread-follower-command-approval-decision",
      params: { conversationId, requestId, decision }
    });
  }

  async sendFileApprovalDecision(conversationId: string, requestId: string, decision: unknown) {
    this.responses.push({
      method: "thread-follower-file-approval-decision",
      params: { conversationId, requestId, decision }
    });
  }

  async submitUserInputResponse(conversationId: string, requestId: string, response: unknown) {
    this.responses.push({
      method: "thread-follower-submit-user-input",
      params: { conversationId, requestId, response }
    });
  }

  async submitMcpElicitationResponse(conversationId: string, requestId: string, response: unknown) {
    this.responses.push({
      method: "thread-follower-submit-mcp-server-elicitation-response",
      params: { conversationId, requestId, response }
    });
  }

  async steerTurn(
    conversationId: string,
    expectedTurnId: string,
    input: unknown,
    options: {
      attachments?: unknown[];
      restoreMessage?: unknown;
      confirmDelivery?: () => Promise<boolean>;
    } = {}
  ) {
    this.responses.push({
      method: "thread-follower-steer-turn",
      params: {
        conversationId,
        expectedTurnId,
        input,
        attachments: options.attachments ?? [],
        ...(options.restoreMessage !== undefined ? { restoreMessage: options.restoreMessage } : {})
      }
    });

    await this.onSteerTurn?.(conversationId, expectedTurnId, input, options);

    if (this.steerError) {
      throw this.steerError;
    }
  }

  async startTurn(conversationId: string, turnStartParams: Record<string, unknown>) {
    this.responses.push({
      method: "thread-follower-start-turn",
      params: { conversationId, turnStartParams }
    });
  }
}

export function extractSteerInputText(input: unknown): string | null {
  if (!Array.isArray(input)) {
    return null;
  }
  const parts = input
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const text = (entry as Record<string, unknown>).text;
      return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
    })
    .filter((value): value is string => value !== null);
  return parts.length > 0 ? parts.join("\n") : null;
}

export function linkDesktopFeedbackVisibility(
  desktopIpc: FakeDesktopIpcClient,
  codex: FakeCodexAdapter,
  delayMs = 0
) {
  desktopIpc.onSteerTurn = (conversationId, expectedTurnId, input) => {
    const text = extractSteerInputText(input);
    if (!text) {
      return;
    }
    codex.scheduleVisibleUserMessage(conversationId, expectedTurnId, text, delayMs);
  };
}

export class FakeDiscordAdapter {
  public handlers: BridgeProviderHandlers | null = null;
  public operations: Array<{ type: string; channelId: string; preview?: string; content?: string }> = [];
  public conversationChannelIds = new Set<string>();
  public threadChannelIds = new Set<string>();
  public statusCardChannelIds: string[] = [];
  public milestoneMessages: string[] = [];
  public conversationEnsureCalls: string[] = [];
  public conversationEnsureRequests: Array<{
    codexThreadId: string;
    title: string | undefined;
    categoryId: string | undefined;
    existingDiscordChannelId: string | null | undefined;
  }> = [];
  public subagentEnsureCalls: string[] = [];
  public subagentEnsureRequests: Array<{
    codexThreadId: string | undefined;
    title: string | undefined;
    parentChannelId: string | undefined;
    existingDiscordChannelId: string | null | undefined;
  }> = [];
  public deletedLocationIds: string[] = [];
  public disabledApprovalCards: Array<{
    channelId: string;
    messageId: string;
    resolutionText: string;
    token: string;
  }> = [];
  public staleApprovalCards: Array<{
    channelId: string;
    messageId: string;
    token: string;
  }> = [];
  public updatedMessageDetailsButtons: Array<{
    channelId: string;
    messageId: string;
    buttons: Array<{ token: string; label: string }>;
  }> = [];
  public deletedMessageIds: string[] = [];
  public threadStarterMessageIdsByThreadId = new Map<string, string[]>();
  public approvalCards: Array<{
    channelId: string;
    existingMessageId: string | null;
    token: string;
    preview: string;
    decisions: string[];
    toolInputQuestionCount: number;
    toolInputSelections: Record<string, string>;
  }> = [];
  public categoryIds = new Set<string>(["discord_category_1"]);
  public discoveredCategoryIds = new Set<string>();
  public discoveredChannelIds = new Set<string>();
  public discoverBridgeManagedLocationsCalls: Array<{
    seedCategoryIds: string[];
    options: {
      restrictToSeedCategories?: boolean;
      requiredScope?: string | null;
    };
  }> = [];
  public liveTextMessages: Array<{
    channelId: string;
    messageId: string;
    content: string;
    action: "create" | "edit";
    detailButtons: string[];
    actionButtons: string[];
    actionCustomIds: string[];
  }> = [];
  public sentTextMessages: Array<{
    channelId: string;
    messageId: string;
    content: string;
    detailButtons: string[];
    actionButtons: string[];
    actionCustomIds: string[];
  }> = [];
  private readonly subagentEnsureBlockersByThread = new Map<string, Promise<void>>();
  private messageSequence = 1;

  async start(handlers?: BridgeProviderHandlers) {
    this.handlers = handlers ?? null;
  }
  async stop() {}
  async ensureProjectCategory() {
    this.categoryIds.add("discord_category_1");
    return { id: "discord_category_1", created: true };
  }
  async ensureConversationChannel(codexThreadId: string, _title?: string, _categoryId?: string, existingDiscordChannelId?: string | null) {
    this.conversationEnsureCalls.push(codexThreadId);
    this.conversationEnsureRequests.push({
      codexThreadId,
      title: _title,
      categoryId: _categoryId,
      existingDiscordChannelId
    });
    if (existingDiscordChannelId && this.conversationChannelIds.has(existingDiscordChannelId)) {
      return { id: existingDiscordChannelId, created: false };
    }
    const id = `discord_channel_${codexThreadId}`;
    const created = !this.conversationChannelIds.has(id);
    this.conversationChannelIds.add(id);
    return { id, created };
  }
  async ensureSubagentThread(codexThreadId?: string, _title?: string, _parentChannelId?: string, existingDiscordChannelId?: string | null) {
    if (codexThreadId) {
      const blocker = this.subagentEnsureBlockersByThread.get(codexThreadId);
      if (blocker) {
        await blocker;
      }
      this.subagentEnsureCalls.push(codexThreadId);
    }
    this.subagentEnsureRequests.push({
      codexThreadId,
      title: _title,
      parentChannelId: _parentChannelId,
      existingDiscordChannelId
    });
    if (existingDiscordChannelId && this.threadChannelIds.has(existingDiscordChannelId)) {
      return { id: existingDiscordChannelId, created: false };
    }
    const id = "discord_subagent_1";
    const created = !this.threadChannelIds.has(id);
    this.threadChannelIds.add(id);
    return { id, created };
  }
  setSubagentEnsureBlocker(codexThreadId: string, blocker: Promise<void>) {
    this.subagentEnsureBlockersByThread.set(codexThreadId, blocker);
  }
  seedThreadStarterNotification(threadId: string, messageId: string) {
    const existing = this.threadStarterMessageIdsByThreadId.get(threadId) ?? [];
    existing.push(messageId);
    this.threadStarterMessageIdsByThreadId.set(threadId, existing);
  }
  async countConversationChannelsInCategory() {
    return this.conversationChannelIds.size;
  }
  async deleteDiscordLocation(channelId: string) {
    this.deletedLocationIds.push(channelId);
    const starterMessageIds = this.threadStarterMessageIdsByThreadId.get(channelId) ?? [];
    if (starterMessageIds.length > 0) {
      this.deletedMessageIds.push(...starterMessageIds);
      this.threadStarterMessageIdsByThreadId.delete(channelId);
    }
    this.conversationChannelIds.delete(channelId);
    this.threadChannelIds.delete(channelId);
    this.categoryIds.delete(channelId);
    this.discoveredChannelIds.delete(channelId);
    this.discoveredCategoryIds.delete(channelId);
  }
  async discoverBridgeManagedLocations(seedCategoryIds: string[], _options: {
    restrictToSeedCategories?: boolean;
    requiredScope?: string | null;
  } = {}) {
    this.discoverBridgeManagedLocationsCalls.push({
      seedCategoryIds: [...seedCategoryIds],
      options: { ..._options }
    });
    return {
      categoryIds: [...new Set([...seedCategoryIds, ...this.discoveredCategoryIds])],
      channelIds: [...this.discoveredChannelIds]
    };
  }
  async upsertStatusCard(channelId: string) {
    if (channelId.startsWith("missing")) {
      const error = new Error("Unknown Channel") as Error & { code?: number };
      error.code = 10003;
      throw error;
    }
    this.statusCardChannelIds.push(channelId);
    return `status_msg_${channelId}`;
  }
  async upsertLiveTextMessage(
    channelId: string,
    messageId: string | null,
    content: string,
    options: {
      detailButtons?: Array<{ label: string }>;
      actionButtons?: Array<{ label: string; customId: string }>;
    } = {}
  ) {
    const nextMessageId = messageId ?? `live_msg_${this.messageSequence++}`;
    this.operations.push({
      type: messageId ? "live-edit" : "live-create",
      channelId,
      content
    });
    this.liveTextMessages.push({
      channelId,
      messageId: nextMessageId,
      content,
      action: messageId ? "edit" : "create",
      detailButtons: (options.detailButtons ?? []).map((button) => button.label),
      actionButtons: (options.actionButtons ?? []).map((button) => button.label),
      actionCustomIds: (options.actionButtons ?? []).map((button) => button.customId)
    });
    return nextMessageId;
  }
  async sendTextMessage(
    channelId: string,
    content: string,
    options: {
      detailButtons?: Array<{ label: string }>;
      actionButtons?: Array<{ label: string; customId: string }>;
    } = {}
  ) {
    const messageId = `text_msg_${this.messageSequence++}`;
    this.operations.push({
      type: "text-send",
      channelId,
      content
    });
    this.sentTextMessages.push({
      channelId,
      messageId,
      content,
      detailButtons: (options.detailButtons ?? []).map((button) => button.label),
      actionButtons: (options.actionButtons ?? []).map((button) => button.label),
      actionCustomIds: (options.actionButtons ?? []).map((button) => button.customId)
    });
    return messageId;
  }
  async postMilestone(_channelId: string, content: string) {
    this.operations.push({
      type: "milestone",
      channelId: _channelId,
      content
    });
    this.milestoneMessages.push(content);
  }
  async postApprovalCard(
    channelId: string,
    existingMessageId: string | null,
    view: {
      token: string;
      sanitizedPreview: string;
      availableDecisions: string[];
      toolInput?: { questions: unknown[]; selectedAnswers: Record<string, string> } | null;
    }
  ) {
    this.operations.push({
      type: existingMessageId ? "approval-edit" : "approval-create",
      channelId,
      preview: view.sanitizedPreview
    });
    this.approvalCards.push({
      channelId,
      existingMessageId,
      token: view.token,
      preview: view.sanitizedPreview,
      decisions: view.availableDecisions,
      toolInputQuestionCount: view.toolInput?.questions.length ?? 0,
      toolInputSelections: { ...(view.toolInput?.selectedAnswers ?? {}) }
    });
    return "approval_msg_1";
  }
  async disableApprovalCard(
    channelId: string,
    messageId: string,
    resolutionText: string,
    view: { token: string }
  ) {
    this.disabledApprovalCards.push({ channelId, messageId, resolutionText, token: view.token });
  }
  async markApprovalCardStale(
    channelId: string,
    messageId: string,
    view: { token: string }
  ) {
    this.staleApprovalCards.push({ channelId, messageId, token: view.token });
  }
  async updateMessageDetailsButtons(
    channelId: string,
    messageId: string,
    buttons: Array<{ token: string; label: string }>
  ) {
    this.updatedMessageDetailsButtons.push({ channelId, messageId, buttons });
  }
  async deleteMessages(_channelId: string, messageIds: string[]) {
    this.deletedMessageIds.push(...messageIds);
  }
  async detachDiscordLocation() {}
}
