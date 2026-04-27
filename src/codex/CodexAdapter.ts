import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type {
  ApprovalDecision,
  CodexNotification,
  CodexServerRequest,
  CodexThreadDetails,
  CodexThreadSummary,
  JsonRpcId
} from "../domain.js";
import type { Logger } from "../logger.js";
import { resolveCommandSpawn } from "../platform.js";
import { CodexSessionMetadataResolver } from "./CodexSessionMetadataResolver.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

type TransportMode = "stdio" | "websocket";

type WebSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  readyState?: number;
};

export interface CodexAdapterEvents {
  ready: [];
  notification: [CodexNotification];
  serverRequest: [CodexServerRequest];
  account: [unknown];
  exited: [number | null];
}

export declare interface CodexAdapter {
  on<EventName extends keyof CodexAdapterEvents>(
    event: EventName,
    listener: (...args: CodexAdapterEvents[EventName]) => void
  ): this;
  emit<EventName extends keyof CodexAdapterEvents>(
    event: EventName,
    ...args: CodexAdapterEvents[EventName]
  ): boolean;
}

export class CodexAdapter extends EventEmitter {
  private childProcess: ChildProcessWithoutNullStreams | null = null;
  private requestSequence = 1;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly metadataResolver: CodexSessionMetadataResolver;
  private lineReader: readline.Interface | null = null;
  private websocket: WebSocketLike | null = null;
  private disconnectHandled = false;
  private readonly transportMode: TransportMode;

  constructor(
    private readonly codexCommand: string,
    private readonly logger: Logger,
    codexHome: string,
    private readonly listenUrl = "stdio://"
  ) {
    super();
    this.metadataResolver = new CodexSessionMetadataResolver(codexHome);
    this.transportMode = listenUrl === "stdio://" ? "stdio" : "websocket";
  }

  async start(): Promise<void> {
    if (this.childProcess) {
      return;
    }

    this.disconnectHandled = false;
    const args = ["app-server"];
    if (this.transportMode === "websocket") {
      args.push("--listen", this.listenUrl);
    }

    const child = this.spawnCodexProcess(args);
    this.childProcess = child;

    child.stderr.on("data", (chunk) => {
      this.logger.debug({ chunk: String(chunk) }, "codex stderr");
    });

    child.stdout.on("data", (chunk) => {
      if (this.transportMode === "websocket") {
        this.logger.debug({ chunk: String(chunk) }, "codex stdout");
      }
    });

    child.on("exit", (code) => {
      this.childProcess = null;
      if (this.disconnectHandled) {
        return;
      }
      this.logger.warn({ code }, "Codex app-server exited.");
      if (this.transportMode === "websocket" && this.isWebSocketConnected()) {
        this.logger.warn(
          { code, listenUrl: this.listenUrl },
          "Codex app-server child exited, but the websocket transport is still connected. Continuing with the live websocket listener."
        );
        return;
      }
      this.handleDisconnect(code);
    });

    if (this.transportMode === "stdio") {
      this.lineReader = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity
      });
      this.lineReader.on("line", (line) => {
        this.handleLine(line);
      });
    } else {
      await this.connectWebSocket(this.listenUrl);
    }

    await this.initialize();
    const account = await this.request("account/read", { refreshToken: false });
    this.emit("account", account);
    this.emit("ready");
  }

  async stop(): Promise<void> {
    this.disconnectHandled = true;
    const child = this.childProcess;
    this.cleanup();
    if (child && !child.killed) {
      child.kill();
    }
  }

  async listThreads(params: {
    limit: number;
    sortKey: "created_at" | "updated_at";
    archived?: boolean;
    sourceKinds?: string[];
  }): Promise<CodexThreadSummary[]> {
    const result = (await this.request("thread/list", params)) as {
      data?: unknown[];
    };

    return (result.data ?? []).map((entry) => this.normalizeThreadSummary(entry));
  }

  async readThread(threadId: string, includeTurns = false): Promise<CodexThreadDetails> {
    const result = (await this.request("thread/read", { threadId, includeTurns })) as {
      thread: unknown;
    };

    return this.normalizeThreadSummary(result.thread, includeTurns) as CodexThreadDetails;
  }

  async resumeThread(threadId: string, options: { timeoutMs?: number } = {}): Promise<void> {
    await this.request("thread/resume", { threadId }, options);
  }

  async startTurn(threadId: string, text: string): Promise<void> {
    await this.request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text
        }
      ]
    });
  }

  async steerTurn(threadId: string, expectedTurnId: string, text: string): Promise<void> {
    await this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: [
        {
          type: "text",
          text
        }
      ]
    });
  }

  async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    this.respond(requestId, decision);
  }

  async respondToServerRequest(requestId: string, result: unknown): Promise<void> {
    this.respond(requestId, result);
  }

  async resolveMetadata(
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ): Promise<{
    cwd: string | null;
    repoName: string | null;
    threadName: string | null;
    actorName: string | null;
    parentThreadId: string | null;
    sourceSubagentOther: string | null;
    originator: string | null;
    source: string | null;
  }> {
    return (
      (await this.metadataResolver.resolve(threadId, options)) ?? {
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

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "codex-mobile",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        elicitation: {
          form: {},
          url: {}
        }
      }
    });

    this.notify("initialized", {});
  }

  private cleanup(): void {
    this.lineReader?.close();
    this.lineReader = null;

    if (this.websocket) {
      try {
        this.websocket.close();
      } catch {
        // Ignore websocket close failures during cleanup.
      }
      this.websocket = null;
    }

    this.childProcess = null;

    for (const pending of this.pendingRequests.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(new Error("Codex app-server disconnected."));
    }
    this.pendingRequests.clear();
  }

  private handleDisconnect(code: number | null): void {
    if (this.disconnectHandled) {
      return;
    }
    this.disconnectHandled = true;
    this.cleanup();
    this.emit("exited", code);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn({ line, error }, "Failed to parse app-server JSON line.");
      return;
    }

    if (message.id !== undefined && message.method !== undefined) {
      this.emit("serverRequest", message as unknown as CodexServerRequest);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id as JsonRpcId);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(message.id as JsonRpcId);
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      if (message.error) {
        const errorMessage =
          typeof message.error === "object" && message.error
            ? String((message.error as { message?: string }).message ?? "Unknown Codex error")
            : "Unknown Codex error";
        pending.reject(new Error(errorMessage));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (message.method) {
      this.emit("notification", message as unknown as CodexNotification);
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    const id = this.requestSequence++;
    const payload = { jsonrpc: "2.0", method, id, params };

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      const timeoutMs = options.timeoutMs;
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          if (this.pendingRequests.delete(id)) {
            reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
          }
        }, timeoutMs);
        pending.timeout.unref?.();
      }
      this.pendingRequests.set(id, pending);
      try {
        this.write(payload);
      } catch (error) {
        this.pendingRequests.delete(id);
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private respond(requestId: string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id: this.coerceJsonRpcId(requestId), result });
  }

  private write(payload: Record<string, unknown>): void {
    const serialized = JSON.stringify(payload);
    if (this.transportMode === "stdio") {
      if (!this.childProcess) {
        throw new Error("Codex app-server is not running.");
      }

      this.childProcess.stdin.write(`${serialized}\n`);
      return;
    }

    if (!this.websocket) {
      throw new Error("Codex app-server websocket is not connected.");
    }

    this.websocket.send(serialized);
  }

  private coerceJsonRpcId(value: string): JsonRpcId {
    return /^\d+$/.test(value) ? Number(value) : value;
  }

  private isWebSocketConnected(): boolean {
    if (!this.websocket) {
      return false;
    }
    return this.websocket.readyState === undefined || this.websocket.readyState === 1;
  }

  private normalizeThreadSummary(entry: unknown, includeTurns = false): CodexThreadSummary {
    const value = entry as Record<string, unknown>;
    const normalized: CodexThreadDetails = {
      id: String(value.id),
      name: value.name ? String(value.name) : null,
      preview: value.preview ? String(value.preview) : null,
      modelProvider: value.modelProvider ? String(value.modelProvider) : null,
      createdAt: typeof value.createdAt === "number" ? value.createdAt : null,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : null,
      ephemeral: Boolean(value.ephemeral),
      archived: Boolean(value.archived),
      status: this.normalizeStatus(value.status)
    };

    if (includeTurns && Array.isArray(value.turns)) {
      normalized.turns = value.turns;
    }

    return normalized;
  }

  private normalizeStatus(input: unknown): CodexThreadSummary["status"] {
    const value = (input ?? {}) as Record<string, unknown>;
    const type = value.type;
    if (type === "active") {
      return {
        type: "active",
        activeFlags: Array.isArray(value.activeFlags) ? value.activeFlags.map(String) : []
      };
    }
    if (type === "idle" || type === "systemError") {
      return { type };
    }
    return { type: "notLoaded" };
  }

  private async connectWebSocket(url: string): Promise<void> {
    const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (!WebSocketCtor) {
      throw new Error("Global WebSocket support is unavailable in this Node runtime.");
    }

    const deadline = Date.now() + 10_000;
    let lastError: Error | null = null;

    while (Date.now() < deadline) {
      try {
        const socket = await new Promise<WebSocketLike>((resolve, reject) => {
          const ws = new WebSocketCtor(url);
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            try {
              ws.close();
            } catch {
              // Ignore close failures during timeout.
            }
            reject(new Error(`Timed out connecting to Codex app-server websocket at ${url}.`));
          }, 1_500);

          const cleanup = () => {
            clearTimeout(timeout);
            ws.removeEventListener("open", handleOpen);
            ws.removeEventListener("error", handleError);
          };

          const handleOpen = () => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            resolve(ws);
          };

          const handleError = () => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            reject(new Error(`Failed to connect to Codex app-server websocket at ${url}.`));
          };

          ws.addEventListener("open", handleOpen);
          ws.addEventListener("error", handleError);
        });

        socket.addEventListener("message", (event: { data: string | ArrayBuffer | Uint8Array }) => {
          if (typeof event.data === "string") {
            this.handleLine(event.data);
            return;
          }

          if (event.data instanceof ArrayBuffer) {
            this.handleLine(Buffer.from(event.data).toString("utf8"));
            return;
          }

          this.handleLine(Buffer.from(event.data).toString("utf8"));
        });
        socket.addEventListener("close", () => {
          if (this.disconnectHandled) {
            return;
          }
          this.logger.warn("Codex app-server websocket closed.");
          this.handleDisconnect(null);
        });
        socket.addEventListener("error", (event) => {
          this.logger.warn({ event }, "Codex app-server websocket error.");
        });
        this.websocket = socket;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }

    throw lastError ?? new Error(`Failed to connect to Codex app-server websocket at ${url}.`);
  }

  private spawnCodexProcess(extraArgs: string[]): ChildProcessWithoutNullStreams {
    const resolved = resolveCommandSpawn(this.codexCommand, extraArgs, { windowsHide: true });
    return spawn(resolved.command, resolved.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: resolved.shell,
      ...(resolved.windowsHide === undefined ? {} : { windowsHide: resolved.windowsHide })
    });
  }
}
