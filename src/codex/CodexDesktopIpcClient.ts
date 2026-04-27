import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net, { type Socket } from "node:net";
import type { CodexServerRequest } from "../domain.js";
import type { Logger } from "../logger.js";
import { resolveDesktopIpcPath } from "../platform.js";
import { withLogScope } from "../util/terminalLogging.js";
const REQUEST_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const START_REQUEST_TIMEOUT_MS = 30_000;
const STEER_REQUEST_TIMEOUT_MS = 30_000;
const DESKTOP_IPC_CLIENT_TYPE = "codex-mobile-bridge-ipc";

type JsonFrame = Record<string, unknown>;
export type DesktopConversationState = Record<string, unknown>;

interface PendingIpcRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingSteerRequest {
  requestId: string;
  conversationId: string;
  expectedTurnId: string;
  targetClientId: string | null;
  sentAtMs: number;
  lastDiagnosticLogAtMs: number | null;
}

export interface DesktopIpcApprovalRequestSnapshot {
  threadId: string;
  requestId: string;
  request: CodexServerRequest;
}

export interface DesktopIpcApprovalRemovedSnapshot {
  threadId: string;
  requestId: string;
  request: CodexServerRequest | null;
}

export interface DesktopIpcEvents {
  ready: [];
  conversationStateChanged: [string, DesktopConversationState];
  requestUpserted: [DesktopIpcApprovalRequestSnapshot];
  requestRemoved: [DesktopIpcApprovalRemovedSnapshot];
  exited: [Error | null];
}

export declare interface CodexDesktopIpcClient {
  on<EventName extends keyof DesktopIpcEvents>(
    event: EventName,
    listener: (...args: DesktopIpcEvents[EventName]) => void
  ): this;
  emit<EventName extends keyof DesktopIpcEvents>(
    event: EventName,
    ...args: DesktopIpcEvents[EventName]
  ): boolean;
}

export class CodexDesktopIpcClient extends EventEmitter {
  private socket: Socket | null = null;
  private clientId: string | null = null;
  private buffer = Buffer.alloc(0);
  private readonly pendingRequests = new Map<string, PendingIpcRequest>();
  private readonly pendingSteerRequestsById = new Map<string, PendingSteerRequest>();
  private readonly pendingSteerRequestsByThread = new Map<string, PendingSteerRequest>();
  private readonly conversationStatesByThread = new Map<string, DesktopConversationState>();
  private readonly ownerClientIdsByThread = new Map<string, string>();
  private readonly requestsByThread = new Map<string, Map<string, CodexServerRequest>>();
  private connectPromise: Promise<void> | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly pipePath = resolveDesktopIpcPath().path
  ) {
    super();
  }

  isReady(): boolean {
    return this.socket !== null && this.clientId !== null && !this.socket.destroyed;
  }

  async start(): Promise<void> {
    if (this.isReady()) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectAndInitialize();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.clientId = null;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex Desktop IPC disconnected."));
    }
    this.pendingRequests.clear();
    this.pendingSteerRequestsById.clear();
    this.pendingSteerRequestsByThread.clear();
    this.conversationStatesByThread.clear();
    this.ownerClientIdsByThread.clear();
    this.requestsByThread.clear();
    this.buffer = Buffer.alloc(0);

    const socket = this.socket;
    this.socket = null;
    if (!socket) {
      return;
    }

    if (socket.destroyed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      socket.once("close", finish);
      socket.destroy();
      setTimeout(finish, 250);
    });
  }

  listRequests(): DesktopIpcApprovalRequestSnapshot[] {
    const snapshots: DesktopIpcApprovalRequestSnapshot[] = [];
    for (const [threadId, requests] of this.requestsByThread) {
      for (const [requestId, request] of requests) {
        snapshots.push({ threadId, requestId, request });
      }
    }
    return snapshots.sort((left, right) => left.threadId.localeCompare(right.threadId) || left.requestId.localeCompare(right.requestId));
  }

  hasRequest(threadId: string, requestId: string): boolean {
    return this.requestsByThread.get(threadId)?.has(requestId) ?? false;
  }

  getOwnerClientId(threadId: string): string | null {
    const ownerClientId = this.ownerClientIdsByThread.get(threadId);
    return typeof ownerClientId === "string" && ownerClientId.trim().length > 0
      ? ownerClientId
      : null;
  }

  getConversationState(threadId: string): DesktopConversationState | null {
    const state = this.conversationStatesByThread.get(threadId);
    return state ? (structuredClone(state) as DesktopConversationState) : null;
  }

  async waitForConversationState(
    threadId: string,
    timeoutMs = 1_500
  ): Promise<DesktopConversationState | null> {
    const existing = this.getConversationState(threadId);
    if (existing) {
      return existing;
    }

    return new Promise<DesktopConversationState | null>((resolve) => {
      let settled = false;
      const finish = (state: DesktopConversationState | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.off("conversationStateChanged", handleConversationStateChanged);
        resolve(state);
      };
      const handleConversationStateChanged = (
        nextThreadId: string,
        nextState: DesktopConversationState
      ) => {
        if (nextThreadId === threadId) {
          finish(nextState);
        }
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.on("conversationStateChanged", handleConversationStateChanged);
    });
  }

  async sendCommandApprovalDecision(
    conversationId: string,
    requestId: string,
    decision: unknown
  ): Promise<unknown> {
    return this.sendThreadFollowerRequest("thread-follower-command-approval-decision", {
      conversationId,
      requestId: this.coerceRequestId(requestId),
      decision
    });
  }

  async sendFileApprovalDecision(
    conversationId: string,
    requestId: string,
    decision: unknown
  ): Promise<unknown> {
    return this.sendThreadFollowerRequest("thread-follower-file-approval-decision", {
      conversationId,
      requestId: this.coerceRequestId(requestId),
      decision
    });
  }

  async submitUserInputResponse(
    conversationId: string,
    requestId: string,
    response: unknown
  ): Promise<unknown> {
    return this.sendThreadFollowerRequest("thread-follower-submit-user-input", {
      conversationId,
      requestId: this.coerceRequestId(requestId),
      response
    });
  }

  async submitMcpElicitationResponse(
    conversationId: string,
    requestId: string,
    response: unknown
  ): Promise<unknown> {
    return this.sendThreadFollowerRequest("thread-follower-submit-mcp-server-elicitation-response", {
      conversationId,
      requestId: this.coerceRequestId(requestId),
      response
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
  ): Promise<unknown> {
    const targetClientId = this.ownerClientIdsByThread.get(conversationId) ?? null;
    const params = {
      conversationId,
      expectedTurnId,
      input,
      attachments: options.attachments ?? [],
      ...(options.restoreMessage !== undefined ? { restoreMessage: options.restoreMessage } : {})
    };

    this.logger.debug(
      {
        scope: "ipc-steer",
        conversationIdPresent: conversationId.length > 0,
        expectedTurnIdPresent: expectedTurnId.length > 0,
        timeoutMs: STEER_REQUEST_TIMEOUT_MS,
        targetClientIdPresent: Boolean(targetClientId),
        steerPayloadShape: this.summarizePayloadShape(params)
      },
      withLogScope("ipc-steer", "Sending Desktop IPC steer payload shape.")
    );

    return this.sendThreadFollowerRequest("thread-follower-steer-turn", params, {
      timeoutMs: STEER_REQUEST_TIMEOUT_MS,
      ...(targetClientId ? { targetClientId } : {})
    });
  }

  async startTurn(
    conversationId: string,
    turnStartParams: Record<string, unknown>
  ): Promise<unknown> {
    const targetClientId = this.ownerClientIdsByThread.get(conversationId) ?? null;
    return this.sendThreadFollowerRequest(
      "thread-follower-start-turn",
      {
        conversationId,
        turnStartParams
      },
      {
        timeoutMs: START_REQUEST_TIMEOUT_MS,
        ...(targetClientId ? { targetClientId } : {})
      }
    );
  }

  private async connectAndInitialize(): Promise<void> {
    const pipePath = this.pipePath;
    if (!pipePath) {
      throw new Error(
        resolveDesktopIpcPath().reason ?? "Codex Desktop IPC is unavailable on this platform."
      );
    }

    this.buffer = Buffer.alloc(0);
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const socket = net.connect(pipePath);
      const timer = setTimeout(() => {
        socket.destroy(new Error("Timed out connecting to Codex Desktop IPC."));
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    this.socket.on("data", (chunk) => this.handleData(chunk));
    this.socket.on("close", () => this.handleDisconnect(null));
    this.socket.on("error", (error) => this.handleDisconnect(error));

    const result = (await this.sendFrameInternal("initialize", { clientType: DESKTOP_IPC_CLIENT_TYPE }, {
      requestId: "init",
      sourceClientId: "initializing-client"
    })) as { clientId?: unknown } | undefined;

    const clientId = typeof result?.clientId === "string" ? result.clientId : null;
    if (!clientId) {
      throw new Error("Codex Desktop IPC initialize did not return a clientId.");
    }

    this.clientId = clientId;
    this.emit("ready");
  }

  private handleDisconnect(error: Error | null): void {
    if (!this.socket) {
      return;
    }

    if (
      this.pendingSteerRequestsById.size > 0 ||
      this.conversationStatesByThread.size > 0 ||
      this.ownerClientIdsByThread.size > 0
    ) {
      this.logger.info(
        {
          scope: "ipc",
          pendingSteerCount: this.pendingSteerRequestsById.size,
          cachedConversationCount: this.conversationStatesByThread.size,
          cachedOwnerCount: this.ownerClientIdsByThread.size,
          errorMessage: error?.message ?? null
        },
        withLogScope("ipc", "Desktop IPC disconnected; clearing cached ownership and conversation state.")
      );
    }

    const socket = this.socket;
    this.socket = null;
    this.clientId = null;
    try {
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
    } catch {
      // Ignore socket cleanup failures.
    }

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("Codex Desktop IPC disconnected."));
    }
    this.pendingRequests.clear();
    this.pendingSteerRequestsById.clear();
    this.pendingSteerRequestsByThread.clear();
    this.conversationStatesByThread.clear();
    this.ownerClientIdsByThread.clear();
    this.requestsByThread.clear();
    this.buffer = Buffer.alloc(0);
    this.emit("exited", error);
  }

  private summarizePayloadShape(value: unknown, depth = 0): unknown {
    if (value === null) {
      return "null";
    }
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        items: depth >= 2 ? [] : value.slice(0, 3).map((entry) => this.summarizePayloadShape(entry, depth + 1))
      };
    }

    const valueType = typeof value;
    if (valueType !== "object") {
      return valueType;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: "object",
      keys: entries.map(([key]) => key),
      ...(depth >= 2
        ? {}
        : {
            fields: Object.fromEntries(
              entries.slice(0, 12).map(([key, entryValue]) => [key, this.summarizePayloadShape(entryValue, depth + 1)])
            )
          })
    };
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const frameLength = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + frameLength) {
        return;
      }

      const payload = this.buffer.subarray(4, 4 + frameLength);
      this.buffer = this.buffer.subarray(4 + frameLength);

      let frame: JsonFrame;
      try {
        frame = JSON.parse(payload.toString("utf8")) as JsonFrame;
      } catch (error) {
        this.logger.warn({ error }, "Failed to parse Codex Desktop IPC frame.");
        continue;
      }

      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: JsonFrame): void {
    const type = typeof frame.type === "string" ? frame.type : null;
    if (!type) {
      return;
    }

    if (type === "response") {
      const requestId = typeof frame.requestId === "string" ? frame.requestId : null;
      if (!requestId) {
        return;
      }
      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }

      const pendingSteer = this.consumePendingSteerRequest(requestId);
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      if (frame.resultType === "error") {
        const message =
          typeof frame.error === "string"
            ? frame.error
            : frame.error && typeof frame.error === "object" && typeof (frame.error as { message?: unknown }).message === "string"
              ? String((frame.error as { message: string }).message)
              : "Unknown Codex Desktop IPC error";
        if (pendingSteer) {
          this.logger.warn(
            {
              scope: "ipc-steer",
              requestId,
              conversationId: pendingSteer.conversationId,
              expectedTurnId: pendingSteer.expectedTurnId,
              targetClientId: pendingSteer.targetClientId,
              durationMs: Date.now() - pendingSteer.sentAtMs,
              errorMessage: message
            },
            withLogScope("ipc-steer", "Desktop IPC steer request completed with an error response.")
          );
        }
        pending.reject(new Error(message));
        return;
      }

      if (pendingSteer) {
        this.logger.info(
          {
            scope: "ipc-steer",
            requestId,
            conversationId: pendingSteer.conversationId,
            expectedTurnId: pendingSteer.expectedTurnId,
            targetClientId: pendingSteer.targetClientId,
            durationMs: Date.now() - pendingSteer.sentAtMs
          },
          withLogScope("ipc-steer", "Desktop IPC steer request completed successfully.")
        );
      }
      pending.resolve(frame.result);
      return;
    }

    if (type === "client-discovery-request") {
      const requestId = typeof frame.requestId === "string" ? frame.requestId : null;
      if (!requestId || !this.clientId) {
        return;
      }

      this.writeFrame({
        type: "client-discovery-response",
        requestId,
        sourceClientId: this.clientId,
        version: REQUEST_VERSION,
        result: { canHandle: false }
      });
      return;
    }

    if (type === "broadcast" && frame.method === "thread-stream-state-changed") {
      this.handleThreadStreamStateChanged(frame);
    }
  }

  private handleThreadStreamStateChanged(frame: JsonFrame): void {
    const params = frame.params;
    if (!params || typeof params !== "object") {
      return;
    }

    const threadId = typeof (params as { conversationId?: unknown }).conversationId === "string"
      ? String((params as { conversationId: string }).conversationId)
      : null;
    const change = (params as { change?: unknown }).change;
    if (!threadId || !change || typeof change !== "object") {
      return;
    }

    const nextConversationState = this.computeNextConversationState(threadId, change as Record<string, unknown>);
    if (!nextConversationState) {
      return;
    }

    const sourceClientId =
      typeof frame.sourceClientId === "string" && frame.sourceClientId.trim().length > 0
        ? frame.sourceClientId
        : null;
    if (sourceClientId) {
      this.ownerClientIdsByThread.set(threadId, sourceClientId);
    }
    const pendingSteer = this.pendingSteerRequestsByThread.get(threadId);
    if (pendingSteer) {
      const now = Date.now();
      const pendingDurationMs = now - pendingSteer.sentAtMs;
      const ownerClientId = this.ownerClientIdsByThread.get(threadId) ?? null;
      const pendingRequestCount =
        Array.isArray(nextConversationState.requests) ? (nextConversationState.requests as unknown[]).length : 0;
      const shouldPromoteToInfo =
        pendingDurationMs >= 1_000 &&
        (
          pendingSteer.lastDiagnosticLogAtMs === null ||
          now - pendingSteer.lastDiagnosticLogAtMs >= 2_000 ||
          (pendingSteer.targetClientId !== null &&
            (sourceClientId !== pendingSteer.targetClientId || ownerClientId !== pendingSteer.targetClientId))
        );
      if (shouldPromoteToInfo) {
        pendingSteer.lastDiagnosticLogAtMs = now;
      }
      const logMethod = shouldPromoteToInfo ? this.logger.info.bind(this.logger) : this.logger.debug.bind(this.logger);
      logMethod(
        {
          scope: "ipc-steer",
          requestId: pendingSteer.requestId,
          conversationId: threadId,
          expectedTurnId: pendingSteer.expectedTurnId,
          pendingDurationMs,
          targetClientId: pendingSteer.targetClientId,
          sourceClientId,
          ownerClientId,
          pendingRequestCount
        },
        withLogScope("ipc-steer", "Desktop IPC thread state changed while a steer request was still pending.")
      );
    }

    const previous = this.requestsByThread.get(threadId) ?? new Map<string, CodexServerRequest>();
    const nextRequests = this.normalizeRequests(
      threadId,
      Array.isArray(nextConversationState.requests) ? (nextConversationState.requests as unknown[]) : []
    );
    const nextMap = new Map<string, CodexServerRequest>();
    for (const request of nextRequests) {
      const requestId = String(request.id);
      nextMap.set(requestId, request);
    }

    for (const [requestId, request] of nextMap) {
      const previousRequest = previous.get(requestId);
      if (!previousRequest || JSON.stringify(previousRequest) !== JSON.stringify(request)) {
        this.emit("requestUpserted", { threadId, requestId, request });
      }
    }

    for (const [requestId, request] of previous) {
      if (!nextMap.has(requestId)) {
        this.emit("requestRemoved", { threadId, requestId, request: request ?? null });
      }
    }

    if (nextMap.size > 0) {
      this.requestsByThread.set(threadId, nextMap);
    } else {
      this.requestsByThread.delete(threadId);
    }
    this.conversationStatesByThread.set(threadId, nextConversationState);
    this.emit("conversationStateChanged", threadId, structuredClone(nextConversationState) as DesktopConversationState);
  }

  private computeNextConversationState(
    threadId: string,
    change: Record<string, unknown>
  ): DesktopConversationState | null {
    const changeType = typeof change.type === "string" ? change.type : null;
    if (changeType === "snapshot") {
      const state = change.conversationState;
      if (!state || typeof state !== "object") {
        return null;
      }
      return structuredClone(state as DesktopConversationState);
    }

    if (changeType !== "patches") {
      return null;
    }

    const patches = Array.isArray(change.patches) ? change.patches : [];
    if (patches.length === 0) {
      return null;
    }

    const currentState = this.conversationStatesByThread.get(threadId);
    if (!currentState) {
      return null;
    }

    const root = structuredClone(currentState) as DesktopConversationState;
    for (const patch of patches) {
      this.applyPatch(root, patch);
    }
    return root;
  }

  private applyPatch(root: Record<string, unknown>, patch: unknown): void {
    if (!patch || typeof patch !== "object") {
      return;
    }
    const op = typeof (patch as { op?: unknown }).op === "string" ? String((patch as { op: string }).op) : null;
    const path = Array.isArray((patch as { path?: unknown }).path) ? ((patch as { path: unknown[] }).path) : null;
    if (!op || !path || path.length === 0) {
      return;
    }

    let parent: unknown = root;
    for (let index = 0; index < path.length - 1; index += 1) {
      const segment = path[index];
      if (parent === null || typeof parent !== "object") {
        return;
      }

      if (Array.isArray(parent)) {
        if (typeof segment !== "number" || segment < 0 || segment >= parent.length) {
          return;
        }
        parent = parent[segment];
        continue;
      }

      const key = String(segment);
      if (!(key in (parent as Record<string, unknown>))) {
        (parent as Record<string, unknown>)[key] = typeof path[index + 1] === "number" ? [] : {};
      }
      parent = (parent as Record<string, unknown>)[key];
    }

    const last = path[path.length - 1];
    if (parent === null || typeof parent !== "object") {
      return;
    }

    if (Array.isArray(parent)) {
      if (typeof last !== "number") {
        return;
      }
      if (op === "remove") {
        parent.splice(last, 1);
        return;
      }
      if (op === "add") {
        parent.splice(last, 0, structuredClone((patch as { value?: unknown }).value));
        return;
      }
      if (op === "replace") {
        parent[last] = structuredClone((patch as { value?: unknown }).value);
      }
      return;
    }

    const key = String(last);
    if (op === "remove") {
      delete (parent as Record<string, unknown>)[key];
      return;
    }

    if (op === "add" || op === "replace") {
      (parent as Record<string, unknown>)[key] = structuredClone((patch as { value?: unknown }).value);
    }
  }

  private normalizeRequests(threadId: string, rawRequests: unknown[]): CodexServerRequest[] {
    return rawRequests
      .map((raw) => this.normalizeRequest(threadId, raw))
      .filter((request): request is CodexServerRequest => request !== null);
  }

  private normalizeRequest(threadId: string, raw: unknown): CodexServerRequest | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const request = structuredClone(raw) as Record<string, unknown>;
    const method = typeof request.method === "string" ? request.method : null;
    const id = request.id;
    if (!method || (typeof id !== "string" && typeof id !== "number")) {
      return null;
    }

    const params =
      request.params && typeof request.params === "object"
        ? ({ ...(request.params as Record<string, unknown>) })
        : {};

    if (typeof params.threadId !== "string" || params.threadId.trim().length === 0) {
      params.threadId = threadId;
    }
    if (typeof params.conversationId !== "string" || params.conversationId.trim().length === 0) {
      params.conversationId = threadId;
    }

    return {
      method,
      id,
      params
    } as CodexServerRequest;
  }

  private async sendThreadFollowerRequest(
    method: string,
    params: Record<string, unknown>,
    overrides: { timeoutMs?: number; targetClientId?: string } = {}
  ): Promise<unknown> {
    return this.sendFrame(method, params, {
      version: REQUEST_VERSION,
      ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
      ...(overrides.targetClientId ? { targetClientId: overrides.targetClientId } : {})
    });
  }

  private async sendFrame(
    method: string,
    params: Record<string, unknown>,
    overrides: {
      requestId?: string;
      sourceClientId?: string;
      version?: number;
      timeoutMs?: number;
      targetClientId?: string;
    } = {}
  ): Promise<unknown> {
    await this.start();
    return this.sendFrameInternal(method, params, overrides);
  }

  private async sendFrameInternal(
    method: string,
    params: Record<string, unknown>,
    overrides: {
      requestId?: string;
      sourceClientId?: string;
      version?: number;
      timeoutMs?: number;
      targetClientId?: string;
    } = {}
  ): Promise<unknown> {
    if (!this.socket) {
      throw new Error("Codex Desktop IPC is not connected.");
    }

    const requestId = overrides.requestId ?? randomUUID();
    const sourceClientId = overrides.sourceClientId ?? this.clientId;
    if (!sourceClientId) {
      throw new Error("Codex Desktop IPC client is not initialized.");
    }

    const frame = {
      type: "request",
      requestId,
      sourceClientId,
      version: overrides.version ?? REQUEST_VERSION,
      method,
      params,
      ...(typeof overrides.targetClientId === "string" && overrides.targetClientId.trim().length > 0
        ? { targetClientId: overrides.targetClientId }
        : {})
    };

    return new Promise((resolve, reject) => {
      const timeoutMs = overrides.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const pendingSteer = this.createPendingSteerRequest(method, requestId, params, overrides.targetClientId);
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        const timedOutSteer = this.consumePendingSteerRequest(requestId);
        if (timedOutSteer) {
          this.logger.warn(
            {
              scope: "ipc-steer",
              requestId,
              conversationId: timedOutSteer.conversationId,
              expectedTurnId: timedOutSteer.expectedTurnId,
              targetClientId: timedOutSteer.targetClientId,
              durationMs: Date.now() - timedOutSteer.sentAtMs,
              timeoutMs
            },
            withLogScope("ipc-steer", "Desktop IPC steer request timed out while waiting for a response.")
          );
        }
        reject(new Error(`Timed out waiting for Codex Desktop IPC response to ${method}.`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      if (pendingSteer) {
        this.pendingSteerRequestsById.set(requestId, pendingSteer);
        this.pendingSteerRequestsByThread.set(pendingSteer.conversationId, pendingSteer);
        this.logger.info(
          {
            scope: "ipc-steer",
            requestId,
            conversationId: pendingSteer.conversationId,
            expectedTurnId: pendingSteer.expectedTurnId,
            targetClientId: pendingSteer.targetClientId,
            timeoutMs
          },
          withLogScope("ipc-steer", "Sent Desktop IPC steer request.")
        );
      }
      this.writeFrame(frame);
    });
  }

  private createPendingSteerRequest(
    method: string,
    requestId: string,
    params: Record<string, unknown>,
    targetClientId: string | undefined
  ): PendingSteerRequest | null {
    if (method !== "thread-follower-steer-turn") {
      return null;
    }

    const conversationId =
      typeof params.conversationId === "string" && params.conversationId.trim().length > 0 ? params.conversationId : null;
    const expectedTurnId =
      typeof params.expectedTurnId === "string" && params.expectedTurnId.trim().length > 0 ? params.expectedTurnId : null;
    if (!conversationId || !expectedTurnId) {
      return null;
    }

    return {
      requestId,
      conversationId,
      expectedTurnId,
      targetClientId: typeof targetClientId === "string" && targetClientId.trim().length > 0 ? targetClientId : null,
      sentAtMs: Date.now(),
      lastDiagnosticLogAtMs: null
    };
  }

  private consumePendingSteerRequest(requestId: string): PendingSteerRequest | null {
    const pendingSteer = this.pendingSteerRequestsById.get(requestId) ?? null;
    if (!pendingSteer) {
      return null;
    }

    this.pendingSteerRequestsById.delete(requestId);
    const threadPendingSteer = this.pendingSteerRequestsByThread.get(pendingSteer.conversationId);
    if (threadPendingSteer?.requestId === requestId) {
      this.pendingSteerRequestsByThread.delete(pendingSteer.conversationId);
    }
    return pendingSteer;
  }

  private writeFrame(frame: JsonFrame): void {
    if (!this.socket) {
      throw new Error("Codex Desktop IPC is not connected.");
    }
    const body = Buffer.from(JSON.stringify(frame), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    this.socket.write(Buffer.concat([header, body]));
  }

  private coerceRequestId(value: string): string | number {
    return /^\d+$/.test(value) ? Number(value) : value;
  }
}
