import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { CodexAdapter } from "./codex/CodexAdapter.js";
import { CodexDesktopIpcClient } from "./codex/CodexDesktopIpcClient.js";
import { CodexSessionEventTailer } from "./codex/CodexSessionEventTailer.js";
import {
  DiscordProvider,
  type DiscordInspectionSnapshot,
  type DiscordMessageSnapshot
} from "./providers/discord/DiscordProvider.js";
import { LocalStoreProvider } from "./providers/local/LocalStoreProvider.js";
import { BridgeService } from "./bridge/BridgeService.js";
import { formatApprovalDecisionResolution } from "./bridge/approval/approvalModel.js";
import type {
  CanonicalThreadEventRecord,
  ChildThreadAnchorRecord,
  MessageDetailRecord,
  PendingApprovalRecord,
  RetainedTurnRecord,
  ThreadBridgeRecord
} from "./domain.js";
import { createLogger } from "./logger.js";
import { Policy } from "./policy/Policy.js";
import { StateStore } from "./store/StateStore.js";
import { acquireInstanceLock } from "./instanceLock.js";
import { resolveCommandSpawn, resolveDesktopIpcPath, resolveDesktopLogPaths } from "./platform.js";
import { shortThreadId, statusLabel } from "./util/formatting.js";
import { resolveCodexListenUrl, type CodexListenUrlMode } from "./util/codexListenUrl.js";
import { formatTerminalLogLine } from "./util/terminalLogging.js";
import {
  ensureWindowsStandaloneCodexLauncher,
  formatStandaloneCodexLauncherResult,
  rewriteStandaloneCodexRemoteArgs
} from "./codex/CodexCliStandaloneLauncher.js";

type InspectScope = "all" | "discord" | "discord-thread" | "codex" | "store" | "thread" | "desktop" | "ipc" | "trace";

function createComponents(
  options: { codexListenUrlOverride?: string; listenUrlMode?: CodexListenUrlMode } = {}
) {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const codexAdapter = new CodexAdapter(
    config.codexCommand,
    logger,
    config.codexHome,
    options.codexListenUrlOverride ??
      resolveCodexListenUrl(config.codexAppServerListenUrl, options.listenUrlMode ?? "local-control")
  );
  const desktopIpcClient = new CodexDesktopIpcClient(logger, config.codexDesktopIpcPath);
  const provider =
    process.env.CODEX_MOBILE_PROVIDER === "local"
      ? new LocalStoreProvider()
      : new DiscordProvider(
          {
            token: config.discordBotToken,
            applicationId: config.discordApplicationId,
            guildId: config.discordGuildId,
            messageWriteBacks: config.bridge.messageWriteBacks
          },
          logger
        );
  const discordProvider =
    provider instanceof DiscordProvider
      ? provider
      : new DiscordProvider(
          {
            token: config.discordBotToken,
            applicationId: config.discordApplicationId,
            guildId: config.discordGuildId,
            messageWriteBacks: config.bridge.messageWriteBacks
          },
          logger
        );
  const stateStore = new StateStore(config.storePath);
  const sessionEventTailer = new CodexSessionEventTailer(config.codexHome, stateStore, logger, {
    desktopLogRootOverride: config.codexDesktopLogRoot
  });

  const serviceOptions = {
    codexAdapter,
    provider,
    stateStore,
    policy: new Policy(config.bridge.approvals, config.bridge.messageWriteBacks),
    logger,
    discoveryPollSeconds: config.codexDiscoveryPollSeconds,
    sourceKinds: config.codexThreadSourceKinds,
    runtimeConfig: config.bridge,
    sessionEventTailer
  } as const;
  const service = new BridgeService({
    ...serviceOptions,
    desktopIpcClient
  });

  return {
    config,
    logger,
    codexAdapter,
    desktopIpcClient,
    discordProvider,
    stateStore,
    service,
    sessionEventTailer
  };
}

async function runCli(extraArgs: string[]): Promise<void> {
  const config = loadConfig();
  if (config.codexAppServerListenUrl === "stdio://") {
    throw new Error(
      "CLI remote mode requires CODEX_APP_SERVER_LISTEN_URL to be a ws://127.0.0.1:<port> listener, not stdio://."
    );
  }

  const remoteArgs = [
    "--remote",
    config.codexAppServerListenUrl,
    ...rewriteStandaloneCodexRemoteArgs(extraArgs, process.cwd())
  ];

  await new Promise<void>((resolve, reject) => {
    const resolved = resolveCommandSpawn(config.codexCommand, remoteArgs, { windowsHide: false });
    const child = spawn(resolved.command, resolved.args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: resolved.shell,
      ...(resolved.windowsHide === undefined ? {} : { windowsHide: resolved.windowsHide })
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Codex CLI exited due to signal ${signal}.`));
        return;
      }
      if (code && code !== 0) {
        reject(new Error(`Codex CLI exited with code ${code}.`));
        return;
      }
      resolve();
    });
  });
}

function createNoopDiscordHandlers() {
  const notAvailable = { content: "This command is not available in inspection mode.", ephemeral: true };
  return {
    onStatusCommand: async () => notAvailable,
    onSendCommand: async () => notAvailable,
    onRetractCommand: async () => notAvailable,
    onWriteBackButton: async () => notAvailable,
    onAttachCommand: async () => notAvailable,
    onDetachCommand: async () => notAvailable,
    onCleanIdCommand: async () => notAvailable,
    onCleanAllCommand: async () => notAvailable,
    onHelpCommand: async () => notAvailable,
    onApprovalDetails: async () => notAvailable,
    onApprovalAction: async () => notAvailable,
    onToolInputOption: async () => notAvailable,
    onToolInputOther: async () => notAvailable,
    onApprovalFeedback: async () => notAvailable,
    onMessageDetails: async () => notAvailable,
    onProposedPlanAction: async () => notAvailable,
    onProposedPlanFeedback: async () => notAvailable
  };
}

function parseInspectScope(value: string | undefined): InspectScope {
  if (
    value === "discord" ||
    value === "discord-thread" ||
    value === "codex" ||
    value === "store" ||
    value === "thread" ||
    value === "desktop" ||
    value === "ipc" ||
    value === "trace"
  ) {
    return value;
  }
  return "all";
}

function truncate(text: string | null, max = 140): string {
  if (!text) {
    return "(none)";
  }
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatAge(timestampMs: number | null): string {
  if (!timestampMs) {
    return "unknown";
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}

function printHeader(title: string): void {
  console.log(`\n== ${title} ==`);
}

function parseLimit(value: string | undefined, fallback = 10): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 200);
}

function formatAbsoluteTime(timestampMs: number | null): string {
  if (!timestampMs) {
    return "unknown";
  }
  return new Date(timestampMs).toLocaleString("en-GB", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatMessageContent(content: string | null, max = 300): string {
  if (!content) {
    return "(no content)";
  }
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(no content)";
  }
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function matchesThreadSelector(value: string | null | undefined, selector: string): boolean {
  return typeof value === "string" && (value === selector || value.startsWith(selector));
}

function formatThreadBridgeLabel(threadId: string | null | undefined): string {
  return typeof threadId === "string" && threadId.length > 0 ? shortThreadId(threadId) : "unknown";
}

function printDiscordInspection(snapshot: DiscordInspectionSnapshot, threadBridges: ThreadBridgeRecord[] = []): void {
  const bridgeByDiscordChannelId = new Map(threadBridges.map((bridge) => [bridge.discordChannelId, bridge]));
  printHeader("Discord");
  console.log(`Guild: ${snapshot.guildName} (${snapshot.guildId})`);
  console.log(`Bridge-managed categories: ${snapshot.categories.length}`);
  console.log(`Conversation channels shown: ${snapshot.channels.length}`);
  console.log(`Child threads shown: ${snapshot.threads.length}`);

  if (snapshot.categories.length === 0) {
    console.log("No bridge-managed Discord categories found.");
  } else {
    console.log("Categories:");
    for (const category of snapshot.categories) {
      console.log(`- ${category.name} (${category.channelCount} channels)`);
    }
  }

  if (snapshot.channels.length > 0) {
    console.log("Conversation channels:");
    for (const channel of snapshot.channels) {
      const bridge = bridgeByDiscordChannelId.get(channel.channelId);
      const threadLabel = formatThreadBridgeLabel(channel.codexThreadId ?? bridge?.codexThreadId);
      const category = channel.categoryName ?? "No category";
      console.log(
        `- ${category} / #${channel.channelName} id=${channel.channelId} codex=${threadLabel} last=${formatAge(
          channel.lastMessageAt
        )} preview=${truncate(channel.lastMessagePreview)}`
      );
    }
  } else {
    console.log("No bridge-managed Discord conversation channels found.");
  }

  if (snapshot.threads.length > 0) {
    console.log("Child threads:");
    for (const thread of snapshot.threads) {
      const bridge = bridgeByDiscordChannelId.get(thread.threadId);
      const parentBridge =
        thread.parentChannelId ? bridgeByDiscordChannelId.get(thread.parentChannelId) ?? null : null;
      const codexLabel = formatThreadBridgeLabel(bridge?.codexThreadId);
      const parentCodexLabel = formatThreadBridgeLabel(bridge?.parentCodexThreadId ?? parentBridge?.codexThreadId);
      const archived = thread.archived ? " archived" : "";
      const locked = thread.locked ? " locked" : "";
      const parentLabel = thread.parentChannelName
        ? `#${thread.parentChannelName}`
        : thread.parentChannelId ?? "(unknown parent)";
      console.log(
        `- ${thread.threadName} id=${thread.threadId} codex=${codexLabel} parent=${parentLabel} parentCodex=${parentCodexLabel}${archived}${locked} last=${formatAge(
          thread.lastMessageAt
        )} preview=${truncate(thread.lastMessagePreview)}`
      );
    }
  } else {
    console.log("No bridge-managed Discord child threads found.");
  }
}

function printDiscordMessages(messages: DiscordMessageSnapshot[]): void {
  printHeader("Discord Messages");
  if (messages.length === 0) {
    console.log("No Discord messages found for this channel.");
    return;
  }

  for (const message of messages) {
    const flags = message.flags.length > 0 ? ` flags=${message.flags.join(",")}` : "";
    const edited = message.editedAt ? ` edited=${formatAbsoluteTime(message.editedAt)}` : "";
    const pinned = message.pinned ? " pinned" : "";
    console.log(
      `- ${formatAbsoluteTime(message.createdAt)} id=${message.messageId} ${message.authorName} type=${message.type}${pinned}${edited}${flags}`
    );
    console.log(`  content: ${formatMessageContent(message.content, 700)}`);
    if (message.reference) {
      console.log(
        `  reference: message=${message.reference.messageId ?? "(none)"} channel=${message.reference.channelId ?? "(none)"} type=${message.reference.type ?? "(none)"}`
      );
    }
    if (message.components.length > 0) {
      const rows = message.components.map((row) =>
        row.components
          .map((component) => {
            const customId = component.customId ? ` customId=${component.customId}` : "";
            const url = component.url ? ` url=${component.url}` : "";
            const style = component.style !== null ? ` style=${component.style}` : "";
            const disabled = component.disabled ? " disabled" : "";
            return `${component.type}:${component.label ?? "(no label)"}${style}${customId}${url}${disabled}`;
          })
          .join(" | ")
      );
      console.log(`  components: ${rows.join(" || ")}`);
    }
    if (message.embeds.length > 0) {
      const embeds = message.embeds.map(
        (embed) =>
          `title=${truncate(embed.title, 80)} desc=${truncate(embed.description, 120)} author=${truncate(
            embed.authorName,
            60
          )} footer=${truncate(embed.footerText, 60)} fields=${embed.fieldCount}`
      );
      console.log(`  embeds: ${embeds.join(" || ")}`);
    }
  }
}

interface DesktopApprovalEventSnapshot {
  timestamp: string;
  kind: "showApproval" | "showQuestion" | "response";
  threadId: string | null;
  requestId: string;
  method: string | null;
  detail: string;
}

interface DesktopApprovalInspectionResult {
  events: DesktopApprovalEventSnapshot[];
  message: string | null;
}

function listFilesRecursive(root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".log")) {
      results.push(fullPath);
    }
  }
  return results;
}

function collectRecentDesktopApprovalEvents(
  limit = 20,
  desktopLogRootOverride: string | null = null
): DesktopApprovalInspectionResult {
  const resolution = resolveDesktopLogPaths(new Date(), {
    overrideRoot: desktopLogRootOverride
  });

  if (resolution.directories.length === 0) {
    return {
      events: [],
      message: resolution.reason ?? "No recent desktop approval/question events found."
    };
  }

  try {
    const files = resolution.directories
      .flatMap((directory) => {
        try {
          return listFilesRecursive(directory);
        } catch {
          return [];
        }
      })
      .map((filePath) => ({
        filePath,
        mtimeMs: statSync(filePath).mtimeMs
      }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, 6);

    const events: DesktopApprovalEventSnapshot[] = [];
    const showApprovalPattern =
      /^(?<timestamp>\S+)\s+\w+\s+\[electron-message-handler\]\s+\[desktop-notifications\]\s+show approval conversationId=(?<threadId>\S+)\s+kind=(?<approvalKind>\S+)\s+requestId=(?<requestId>\S+)/;
    const showQuestionPattern =
      /^(?<timestamp>\S+)\s+\w+\s+\[electron-message-handler\]\s+\[desktop-notifications\]\s+show question conversationId=(?<threadId>\S+)\s+questionCount=(?<questionCount>\d+)\s+requestId=(?<requestId>\S+)/;
    const responsePattern =
      /^(?<timestamp>\S+)\s+\w+\s+\[electron-message-handler\]\s+Sending server response id=(?<requestId>\S+)\s+method=(?<method>\S+)\s+response=(?<response>.+)$/;

    for (const file of files) {
      const lines = readFileSync(file.filePath, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const approvalMatch = line.match(showApprovalPattern);
        if (approvalMatch?.groups) {
          events.push({
            timestamp: approvalMatch.groups.timestamp ?? "(unknown)",
            kind: "showApproval",
            threadId: approvalMatch.groups.threadId ?? null,
            requestId: approvalMatch.groups.requestId ?? "(unknown)",
            method: "item/commandExecution/requestApproval",
            detail: approvalMatch.groups.approvalKind ?? "commandExecution"
          });
          continue;
        }

        const questionMatch = line.match(showQuestionPattern);
        if (questionMatch?.groups) {
          events.push({
            timestamp: questionMatch.groups.timestamp ?? "(unknown)",
            kind: "showQuestion",
            threadId: questionMatch.groups.threadId ?? null,
            requestId: questionMatch.groups.requestId ?? "(unknown)",
            method: "item/tool/requestUserInput",
            detail: `${questionMatch.groups.questionCount ?? "0"} question(s)`
          });
          continue;
        }

        const responseMatch = line.match(responsePattern);
        if (responseMatch?.groups) {
          const method = responseMatch.groups.method ?? null;
          if (
            method === "item/commandExecution/requestApproval" ||
            method === "item/tool/requestUserInput" ||
            method === "mcpServer/elicitation/request"
          ) {
            events.push({
              timestamp: responseMatch.groups.timestamp ?? "(unknown)",
              kind: "response",
              threadId: null,
              requestId: responseMatch.groups.requestId ?? "(unknown)",
              method,
              detail: formatMessageContent(responseMatch.groups.response ?? "", 220)
            });
          }
        }
      }
    }

    if (files.length === 0) {
      return {
        events: [],
        message:
          resolution.source === "mac-default" && !desktopLogRootOverride
            ? "Codex Desktop log discovery is best-effort on macOS. No logs were found in the default macOS locations. Set CODEX_DESKTOP_LOG_ROOT if Desktop inspection stays empty."
            : "No recent desktop approval/question events found."
      };
    }

    return {
      events: events
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .slice(-limit),
      message: null
    };
  } catch {
    return {
      events: [],
      message: "No recent desktop approval/question events found."
    };
  }
}

function printDesktopInspection(limit = 20, desktopLogRootOverride: string | null = null): void {
  const inspection = collectRecentDesktopApprovalEvents(limit, desktopLogRootOverride);
  printHeader("Desktop Approval Events");
  if (inspection.events.length === 0) {
    console.log(inspection.message ?? "No recent desktop approval/question events found.");
    return;
  }

  for (const event of inspection.events) {
    const threadPart = event.threadId ? ` thread=${shortThreadId(event.threadId)}` : "";
    const methodPart = event.method ? ` method=${event.method}` : "";
    console.log(`- ${event.timestamp} ${event.kind}${threadPart} request=${event.requestId}${methodPart} :: ${event.detail}`);
  }
}

function printIpcInspection(
  requests: Array<{ threadId: string; requestId: string; request: { method: string; params?: Record<string, unknown> } }>
): void {
  printHeader("Desktop IPC Requests");
  if (requests.length === 0) {
    console.log("No live Desktop IPC approval requests captured.");
    return;
  }

  for (const snapshot of requests) {
    const preview =
      typeof snapshot.request.params?.command === "string"
        ? snapshot.request.params.command
        : typeof snapshot.request.params?.message === "string"
          ? snapshot.request.params.message
          : typeof snapshot.request.params?.prompt === "string"
            ? snapshot.request.params.prompt
            : typeof snapshot.request.params?.reason === "string"
              ? snapshot.request.params.reason
              : "(no preview)";
    console.log(
      `- ${shortThreadId(snapshot.threadId)} request=${snapshot.requestId} method=${snapshot.request.method} :: ${truncate(
        String(preview),
        180
      )}`
    );
  }
}

function printStoreInspection(stateStore: StateStore): void {
  const projects = stateStore.listProjectBridges();
  const threads = stateStore.listThreadBridges();
  const approvalRecords = stateStore.listPendingApprovals();
  const actionableApprovals = approvalRecords.filter(
    (approval) => approval.status === "pending" || approval.status === "decisionSent"
  );
  const historicalApprovals = approvalRecords.filter(
    (approval) => approval.status !== "pending" && approval.status !== "decisionSent"
  );

  printHeader("Local Store");
  console.log(`Projects: ${projects.length}`);
  console.log(`Mapped threads: ${threads.length}`);
  console.log(`Actionable approvals: ${actionableApprovals.length}`);
  console.log(`Historical approval records: ${historicalApprovals.length}`);

  if (threads.length > 0) {
    console.log("Latest mappings:");
    for (const thread of threads.slice(0, 15)) {
      console.log(
        `- ${thread.projectName} / ${thread.threadName ?? shortThreadId(thread.codexThreadId)} -> ${thread.discordChannelId} (${thread.channelKind}, ${thread.attachMode}, seen ${formatAge(Date.parse(thread.lastSeenAt))})`
      );
    }
  }

  if (actionableApprovals.length > 0) {
    console.log("Actionable approvals:");
    for (const approval of actionableApprovals.slice(0, 10)) {
      console.log(
        `- ${approval.kind} ${shortThreadId(approval.threadId)} status=${approval.status} expires=${formatAge(Date.parse(approval.expiresAt))} preview=${truncate(approval.sanitizedPreview)}`
      );
    }
  }

  if (historicalApprovals.length > 0) {
    console.log("Recent historical approvals:");
    for (const approval of historicalApprovals.slice(0, 10)) {
      console.log(
        `- ${approval.kind} ${shortThreadId(approval.threadId)} status=${approval.status} expires=${formatAge(Date.parse(approval.expiresAt))} preview=${truncate(approval.sanitizedPreview)}`
      );
    }
  }
}

function printMirrorTraceInspection(tracePath: string, limit = 40): void {
  printHeader("Mirror Trace");
  console.log(`Path: ${tracePath}`);
  let content: string;
  try {
    content = readFileSync(tracePath, "utf8");
  } catch {
    console.log("No trace file found. Enable diagnostics.mirrorTraceEnabled and restart the bridge.");
    return;
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    console.log("Trace file is empty.");
    return;
  }

  const selected = lines.slice(-Math.max(1, Math.min(limit, 200)));
  for (const line of selected) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.log(`- ${truncate(line, 260)}`);
      continue;
    }

    const at = typeof parsed.at === "string" ? parsed.at : "(unknown)";
    const event = typeof parsed.event === "string" ? parsed.event : "(event)";
    const threadId = typeof parsed.threadId === "string" ? parsed.threadId : null;
    const itemId = typeof parsed.itemId === "string" ? parsed.itemId : null;
    const messageId = typeof parsed.messageId === "string" ? parsed.messageId : null;
    const reason = typeof parsed.reason === "string" ? parsed.reason : null;
    const preview =
      typeof parsed.renderedPreview === "string"
        ? parsed.renderedPreview
        : typeof parsed.preview === "string"
          ? parsed.preview
          : null;
    const threadLabel = threadId ? shortThreadId(threadId) : "-";
    const itemLabel = itemId ? ` item=${truncate(itemId, 48)}` : "";
    const messageLabel = messageId ? ` message=${truncate(messageId, 40)}` : "";
    const reasonLabel = reason ? ` reason=${reason}` : "";
    const previewLabel = preview ? ` :: ${truncate(preview, 180)}` : "";
    console.log(`- ${at} ${event} thread=${threadLabel}${itemLabel}${messageLabel}${reasonLabel}${previewLabel}`);
  }
}

function printApprovalList(stateStore: StateStore): void {
  const approvals = stateStore.listActionableApprovals();
  printHeader("Pending Approvals");
  if (approvals.length === 0) {
    console.log("No pending approvals found.");
    return;
  }

  for (const approval of approvals) {
    const decisions =
      approval.availableDecisions.length > 0 ? approval.availableDecisions.join(", ") : "(read-only in Discord)";
    console.log(
      `- token=${approval.token} request=${approval.requestId} kind=${approval.kind} status=${approval.status} thread=${shortThreadId(
        approval.threadId
      )} expires=${approval.expiresAt} decisions=[${decisions}] preview=${truncate(approval.sanitizedPreview)}`
    );
  }
}

function findApprovalBySelector(stateStore: StateStore, selector: string) {
  return (
    stateStore.findPendingApprovalByToken(selector) ??
    stateStore.findPendingApprovalByRequestId(selector) ??
    stateStore
      .listPendingApprovals()
      .find((approval) => approval.token.startsWith(selector) || approval.requestId === selector || approval.requestId.endsWith(selector))
  );
}

async function tryStartDesktopIpc(client: CodexDesktopIpcClient): Promise<boolean> {
  try {
    await client.start();
    return true;
  } catch {
    return false;
  }
}

async function runApprovalList(): Promise<void> {
  const { stateStore } = createComponents();
  try {
    printApprovalList(stateStore);
  } finally {
    stateStore.close();
  }
}

async function runApprove(selector: string | undefined, decisionParts: string[]): Promise<void> {
  const decision = decisionParts.join(" ").trim();
  if (!selector || !decision) {
    console.log("Usage: node dist/src/index.js approve <token-or-requestId> <decision>");
    return;
  }

  const { config, codexAdapter, desktopIpcClient, discordProvider, stateStore } = createComponents();
  try {
    const approval = findApprovalBySelector(stateStore, selector);
    if (!approval) {
      console.log(`No pending approval matched "${selector}".`);
      printApprovalList(stateStore);
      return;
    }

    const policy = new Policy(config.bridge.approvals, config.bridge.messageWriteBacks);
    policy.ensurePendingApproval(approval);
    policy.ensureAllowedDecision(approval, decision);

    await Promise.all([
      codexAdapter.start(),
      tryStartDesktopIpc(desktopIpcClient),
      discordProvider.start(createNoopDiscordHandlers(), {
        registerCommands: false,
        listenForInteractions: false
      })
    ]);

    const responsePayload =
      Object.prototype.hasOwnProperty.call(approval.decisionPayloads, decision)
        ? approval.decisionPayloads[decision]
        : decision;
    const wrappedDecision =
      responsePayload && typeof responsePayload === "object" && "decision" in (responsePayload as Record<string, unknown>)
        ? (responsePayload as { decision: unknown }).decision
        : decision;
    if (desktopIpcClient.isReady()) {
      switch (approval.kind) {
        case "commandExecution":
          await desktopIpcClient.sendCommandApprovalDecision(approval.threadId, approval.requestId, wrappedDecision);
          break;
        case "fileChange":
          await desktopIpcClient.sendFileApprovalDecision(approval.threadId, approval.requestId, wrappedDecision);
          break;
        case "toolUserInput":
          await desktopIpcClient.submitUserInputResponse(approval.threadId, approval.requestId, responsePayload);
          break;
        case "mcpElicitation":
          await desktopIpcClient.submitMcpElicitationResponse(approval.threadId, approval.requestId, responsePayload);
          break;
        default:
          await codexAdapter.respondToServerRequest(approval.requestId, responsePayload);
      }
    } else {
      await codexAdapter.respondToServerRequest(approval.requestId, responsePayload);
    }
    stateStore.setPendingApprovalStatus(approval.token, "decisionSent");
    stateStore.appendAuditLog({
      timestamp: new Date().toISOString(),
      discordUserId: config.bridge.approvals.allowedUserIds[0] ?? "terminal",
      threadId: approval.threadId,
      turnId: approval.turnId,
      requestId: approval.requestId,
      decision,
      sanitizedPreview: approval.sanitizedPreview
    });

    const bridge = stateStore.getThreadBridge(approval.threadId);
    if (bridge && approval.discordMessageId) {
      await discordProvider.disableApprovalCard(
        bridge.discordChannelId,
        approval.discordMessageId,
        formatApprovalDecisionResolution(decision, "terminal"),
        policy.buildApprovalDetails(approval)
      );
    }

    console.log(`Sent decision "${decision}" for request ${approval.requestId}.`);
  } finally {
    await Promise.allSettled([
      codexAdapter.stop(),
      desktopIpcClient.stop(),
      discordProvider.stop()
    ]);
    stateStore.close();
  }
}

function printCodexInspection(
  threads: Array<{
    id: string;
    name: string | null;
    preview: string | null;
    updatedAt: number | null;
    status: { type: string; activeFlags?: string[] };
    source?: string;
  }>,
  mappedThreadIds: Set<string>
): void {
  printHeader("Codex");
  console.log(`Latest threads fetched: ${threads.length}`);

  const activeCount = threads.filter((thread) => thread.status.type === "active").length;
  const idleCount = threads.filter((thread) => thread.status.type === "idle").length;
  const notLoadedCount = threads.filter((thread) => thread.status.type === "notLoaded").length;
  const systemErrorCount = threads.filter((thread) => thread.status.type === "systemError").length;
  console.log(
    `Status mix: active=${activeCount}, idle=${idleCount}, notLoaded=${notLoadedCount}, systemError=${systemErrorCount}`
  );

  if (threads.length === 0) {
    console.log("No Codex threads returned by app-server.");
    return;
  }

  for (const thread of threads) {
    const mapped = mappedThreadIds.has(thread.id) ? "mapped" : "unmapped";
    const source = thread.source ? ` source=${thread.source}` : "";
    const flags =
      thread.status.type === "active" && Array.isArray(thread.status.activeFlags) && thread.status.activeFlags.length > 0
        ? ` flags=${thread.status.activeFlags.join(",")}`
        : "";
    console.log(
      `- ${shortThreadId(thread.id)} ${statusLabel(thread.status as never)} ${mapped} updated=${formatAge(
        thread.updatedAt ? thread.updatedAt * 1000 : null
      )}${source} title=${truncate(thread.name ?? thread.preview, 100)}${flags}`
    );
  }
}

interface CodexThreadItemSnapshot {
  timestampMs: number | null;
  itemId: string;
  kind: string;
  content: string;
}

interface MirroredStoreItemSnapshot {
  turnId: string | null;
  itemId: string;
  kind: string;
  cursor: string | null;
  turnCursor: string | null;
  timestampMs: number | null;
}

interface ThreadInspectSelection {
  codexThreadId: string | null;
  discordChannelId: string;
  projectName: string | null;
  threadName: string | null;
  lastSeenAt: string | null;
  latestMirroredCursor: string | null;
  latestMirroredTimestampMs: number | null;
  channelKind: ThreadBridgeRecord["channelKind"] | "unknown";
  parentCodexThreadId: string | null;
  parentDiscordChannelId: string | null;
  parentDiscordChannelName: string | null;
}

interface MessageDetailsByDiscordMessage {
  messageId: string;
  details: MessageDetailRecord[];
}

function extractTimestampMs(input: unknown): number | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const fields = ["createdAt", "startedAt", "completedAt", "timestamp", "timestampMs"];
  for (const field of fields) {
    const value = candidate[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1_000_000_000_000 ? value : value * 1000;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  const id = candidate.id;
  if (typeof id === "string") {
    const normalized = id.replace(/-/g, "").toLowerCase();
    if (/^[0-9a-f]{32}$/.test(normalized) && normalized[12] === "7") {
      const parsed = Number.parseInt(normalized.slice(0, 12), 16);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function extractUserText(item: Record<string, unknown>): string | null {
  if (item.type !== "userMessage") {
    return null;
  }
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = content
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const candidate = entry as Record<string, unknown>;
      const text = candidate.text;
      return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
    })
    .filter((value): value is string => value !== null);
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractAssistantText(item: Record<string, unknown>): { label: string; text: string } | null {
  const role = item.role;
  if (item.type === "message" && role === "assistant") {
    const phase = typeof item.phase === "string" ? item.phase : null;
    const content = Array.isArray(item.content) ? item.content : [];
    const parts = content
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const candidate = entry as Record<string, unknown>;
        const text = candidate.text;
        return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
      })
      .filter((value): value is string => value !== null);
    if (parts.length === 0) {
      return null;
    }
    const label =
      phase === "final_answer" || phase === "final" || phase === "answer"
        ? "assistant/final"
        : `assistant/${phase ?? "message"}`;
    return { label, text: parts.join("\n") };
  }

  if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim().length > 0) {
    const phase = typeof item.phase === "string" ? item.phase : null;
    const label =
      phase === "final_answer" || phase === "final" || phase === "answer"
        ? "assistant/final"
        : `assistant/${phase ?? "message"}`;
    return { label, text: item.text.trim() };
  }

  return null;
}

function extractCommandText(item: Record<string, unknown>): string | null {
  if (item.type !== "commandExecution") {
    return null;
  }
  const parts = [];
  if (typeof item.command === "string" && item.command.trim().length > 0) {
    parts.push(item.command.trim());
  }
  if (typeof item.cwd === "string" && item.cwd.trim().length > 0) {
    parts.push(`cwd=${item.cwd.trim()}`);
  }
  if (typeof item.status === "string" && item.status.trim().length > 0) {
    parts.push(`status=${item.status.trim()}`);
  }
  if (typeof item.exitCode === "number") {
    parts.push(`exit=${item.exitCode}`);
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

function extractFileChangeText(item: Record<string, unknown>): string | null {
  if (item.type !== "fileChange") {
    return null;
  }
  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (changes.length === 0) {
    return typeof item.status === "string" ? `status=${item.status}` : "file change";
  }
  return changes
    .slice(0, 5)
    .map((change) => {
      if (!change || typeof change !== "object") return "change";
      const candidate = change as Record<string, unknown>;
      const kind = typeof candidate.kind === "string" ? candidate.kind : "change";
      const path = typeof candidate.path === "string" ? candidate.path : "(unknown path)";
      return `${kind} ${path}`;
    })
    .join(" | ");
}

function extractCodexThreadItemSnapshots(turns: unknown[] | undefined): CodexThreadItemSnapshot[] {
  const snapshots: CodexThreadItemSnapshot[] = [];
  for (const turn of turns ?? []) {
    if (!turn || typeof turn !== "object") {
      continue;
    }
    const turnRecord = turn as Record<string, unknown>;
    const items = Array.isArray(turnRecord.items) ? turnRecord.items : [];
    const turnTimestampMs = extractTimestampMs(turnRecord);
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const itemRecord = item as Record<string, unknown>;
      const itemId = typeof itemRecord.id === "string" ? itemRecord.id : "(unknown)";
      const timestampMs = extractTimestampMs(itemRecord) ?? turnTimestampMs;

      const userText = extractUserText(itemRecord);
      if (userText) {
        snapshots.push({ timestampMs, itemId, kind: "user", content: userText });
        continue;
      }

      const assistantText = extractAssistantText(itemRecord);
      if (assistantText) {
        snapshots.push({
          timestampMs,
          itemId,
          kind: assistantText.label,
          content: assistantText.text
        });
        continue;
      }

      const commandText = extractCommandText(itemRecord);
      if (commandText) {
        snapshots.push({ timestampMs, itemId, kind: "command", content: commandText });
        continue;
      }

      const fileChangeText = extractFileChangeText(itemRecord);
      if (fileChangeText) {
        snapshots.push({ timestampMs, itemId, kind: "fileChange", content: fileChangeText });
      }
    }
  }

  return snapshots.sort((left, right) => {
    const leftTs = left.timestampMs ?? 0;
    const rightTs = right.timestampMs ?? 0;
    if (leftTs !== rightTs) {
      return leftTs - rightTs;
    }
    return left.itemId.localeCompare(right.itemId);
  });
}

function printCodexThreadItems(items: CodexThreadItemSnapshot[]): void {
  printHeader("Codex Items");
  if (items.length === 0) {
    console.log("No Codex items found for this thread.");
    return;
  }

  for (const item of items) {
    console.log(
      `- ${formatAbsoluteTime(item.timestampMs)} ${item.kind} [${item.itemId}] :: ${formatMessageContent(item.content)}`
    );
  }
}

function printMirroredStoreItems(items: MirroredStoreItemSnapshot[]): void {
  printHeader("Mirrored Store Items");
  if (items.length === 0) {
    console.log("No mirrored store items for this thread yet.");
    return;
  }

  for (const item of items) {
    console.log(
      `- ${formatAbsoluteTime(item.timestampMs)} turn=${item.turnId ?? "(none)"} item=${item.itemId} kind=${item.kind} cursor=${item.cursor ?? "(none)"} turnCursor=${item.turnCursor ?? "(none)"}`
    );
  }
}

function printPendingApprovals(approvals: PendingApprovalRecord[]): void {
  printHeader("Pending Approvals");
  if (approvals.length === 0) {
    console.log("No approval records for this thread.");
    return;
  }

  for (const approval of approvals) {
    console.log(
      `- ${approval.kind} status=${approval.status} request=${approval.requestId} item=${approval.itemId} message=${approval.discordMessageId ?? "(none)"} created=${approval.createdAt} expires=${approval.expiresAt} preview=${truncate(approval.sanitizedPreview, 180)}`
    );
  }
}

function printRetainedTurns(turns: RetainedTurnRecord[]): void {
  printHeader("Canonical Retained Turns");
  if (turns.length === 0) {
    console.log("No retained parent turns are stored for this thread.");
    return;
  }

  for (const turn of turns) {
    console.log(
      `- key=${turn.turnKey} turn=${turn.turnId ?? "(none)"} cursor=${turn.turnCursor ?? "(none)"} source=${turn.source} anchorItem=${turn.anchorItemId ?? "(none)"} updated=${turn.updatedAt} text=${truncate(turn.anchorText ?? "", 160)}`
    );
  }
}

function printChildAnchor(anchor: ChildThreadAnchorRecord | null): void {
  printHeader("Child Anchor");
  if (!anchor) {
    console.log("No canonical child-thread anchor is stored for this thread.");
    return;
  }

  console.log(`Child thread: ${anchor.childThreadId}`);
  console.log(`Parent thread: ${anchor.parentThreadId}`);
  console.log(`Parent turn: ${anchor.parentTurnId ?? "(none)"}`);
  console.log(`Parent turn cursor: ${anchor.parentTurnCursor ?? "(none)"}`);
  console.log(`Source: ${anchor.source}`);
  console.log(`Updated: ${anchor.updatedAt}`);
}

function printCanonicalEvents(events: CanonicalThreadEventRecord[]): void {
  printHeader("Canonical Events");
  if (events.length === 0) {
    console.log("No canonical events stored for this thread.");
    return;
  }

  for (const event of events) {
    console.log(
      `- #${event.id} ${event.createdAt} source=${event.source} kind=${event.eventKind} itemKind=${event.itemKind ?? "(none)"} turn=${event.turnId ?? "(none)"} turnCursor=${event.turnCursor ?? "(none)"} item=${event.itemId ?? "(none)"} request=${event.requestId ?? "(none)"} summary=${truncate(event.summary ?? "", 160)} detail=${truncate(event.detail ?? "", 160)}`
    );
  }
}

function printMessageDetails(records: MessageDetailsByDiscordMessage[]): void {
  printHeader("Message Details");
  if (records.length === 0) {
    console.log("No stored message-detail records for the fetched Discord messages.");
    return;
  }

  for (const record of records) {
    console.log(`- message=${record.messageId}`);
    for (const detail of record.details) {
      console.log(
        `  ${detail.kind} token=${detail.token} label=${detail.buttonLabel} expires=${detail.expiresAt} updated=${detail.updatedAt} title=${truncate(detail.title, 120)}`
      );
    }
  }
}

function findSnapshotLocationByDiscordChannelId(
  snapshot: DiscordInspectionSnapshot,
  discordChannelId: string
):
  | {
      kind: "channel" | "thread";
      channelId: string;
      channelName: string;
      categoryName: string | null;
      lastMessageAt: number | null;
      parentChannelId: string | null;
      parentChannelName: string | null;
    }
  | null {
  const channel = snapshot.channels.find((entry) => entry.channelId === discordChannelId);
  if (channel) {
    return {
      kind: "channel",
      channelId: channel.channelId,
      channelName: channel.channelName,
      categoryName: channel.categoryName,
      lastMessageAt: channel.lastMessageAt,
      parentChannelId: null,
      parentChannelName: null
    };
  }

  const thread = snapshot.threads.find((entry) => entry.threadId === discordChannelId);
  if (thread) {
    return {
      kind: "thread",
      channelId: thread.threadId,
      channelName: thread.threadName,
      categoryName: thread.categoryName,
      lastMessageAt: thread.lastMessageAt,
      parentChannelId: thread.parentChannelId,
      parentChannelName: thread.parentChannelName
    };
  }

  return null;
}

function resolveInspectSelection(
  selector: string | undefined,
  threadBridges: ThreadBridgeRecord[],
  discordSnapshot: DiscordInspectionSnapshot
): ThreadInspectSelection | null {
  const bridgeByDiscordChannelId = new Map(threadBridges.map((bridge) => [bridge.discordChannelId, bridge]));
  const selectedFromStore =
    selector
      ? threadBridges.find(
          (thread) =>
            matchesThreadSelector(thread.codexThreadId, selector) ||
            matchesThreadSelector(thread.discordChannelId, selector)
        ) ?? null
      : threadBridges[0] ?? null;

  if (selectedFromStore) {
    const snapshotLocation = findSnapshotLocationByDiscordChannelId(discordSnapshot, selectedFromStore.discordChannelId);
    const parentSnapshot = selectedFromStore.discordParentChannelId
      ? findSnapshotLocationByDiscordChannelId(discordSnapshot, selectedFromStore.discordParentChannelId)
      : null;
    const parentBridge = selectedFromStore.parentCodexThreadId
      ? threadBridges.find((bridge) => bridge.codexThreadId === selectedFromStore.parentCodexThreadId) ?? null
      : null;
    return {
      codexThreadId: selectedFromStore.codexThreadId,
      discordChannelId: selectedFromStore.discordChannelId,
      projectName: selectedFromStore.projectName ?? snapshotLocation?.categoryName ?? null,
      threadName: selectedFromStore.threadName ?? snapshotLocation?.channelName ?? null,
      lastSeenAt: selectedFromStore.lastSeenAt,
      latestMirroredCursor: selectedFromStore.latestMirroredCursor ?? null,
      latestMirroredTimestampMs: selectedFromStore.latestMirroredTimestampMs ?? null,
      channelKind: selectedFromStore.channelKind,
      parentCodexThreadId: selectedFromStore.parentCodexThreadId ?? parentBridge?.codexThreadId ?? null,
      parentDiscordChannelId: selectedFromStore.discordParentChannelId ?? parentSnapshot?.channelId ?? null,
      parentDiscordChannelName: parentSnapshot?.channelName ?? parentBridge?.threadName ?? null
    };
  }

  const discordLocation = selector
    ? [
        ...discordSnapshot.channels.map((channel) => ({
          kind: "channel" as const,
          channelId: channel.channelId,
          channelName: channel.channelName,
          categoryName: channel.categoryName,
          lastMessageAt: channel.lastMessageAt,
          parentChannelId: null,
          parentChannelName: null
        })),
        ...discordSnapshot.threads.map((thread) => ({
          kind: "thread" as const,
          channelId: thread.threadId,
          channelName: thread.threadName,
          categoryName: thread.categoryName,
          lastMessageAt: thread.lastMessageAt,
          parentChannelId: thread.parentChannelId,
          parentChannelName: thread.parentChannelName
        }))
      ].find((location) => matchesThreadSelector(location.channelId, selector)) ?? null
    : discordSnapshot.channels[0]
      ? {
          kind: "channel" as const,
          channelId: discordSnapshot.channels[0].channelId,
          channelName: discordSnapshot.channels[0].channelName,
          categoryName: discordSnapshot.channels[0].categoryName,
          lastMessageAt: discordSnapshot.channels[0].lastMessageAt,
          parentChannelId: null,
          parentChannelName: null
        }
      : discordSnapshot.threads[0]
        ? {
            kind: "thread" as const,
            channelId: discordSnapshot.threads[0].threadId,
            channelName: discordSnapshot.threads[0].threadName,
            categoryName: discordSnapshot.threads[0].categoryName,
            lastMessageAt: discordSnapshot.threads[0].lastMessageAt,
            parentChannelId: discordSnapshot.threads[0].parentChannelId,
            parentChannelName: discordSnapshot.threads[0].parentChannelName
          }
        : null;

  if (!discordLocation) {
    return null;
  }

  const storeBridge = bridgeByDiscordChannelId.get(discordLocation.channelId) ?? null;
  const parentBridge =
    discordLocation.parentChannelId && bridgeByDiscordChannelId.has(discordLocation.parentChannelId)
      ? bridgeByDiscordChannelId.get(discordLocation.parentChannelId) ?? null
      : null;
  return {
    codexThreadId: storeBridge?.codexThreadId ?? null,
    discordChannelId: discordLocation.channelId,
    projectName: storeBridge?.projectName ?? discordLocation.categoryName ?? null,
    threadName: storeBridge?.threadName ?? discordLocation.channelName,
    lastSeenAt:
      storeBridge?.lastSeenAt ??
      (discordLocation.lastMessageAt ? new Date(discordLocation.lastMessageAt).toISOString() : null),
    latestMirroredCursor: storeBridge?.latestMirroredCursor ?? null,
    latestMirroredTimestampMs: storeBridge?.latestMirroredTimestampMs ?? null,
    channelKind: storeBridge?.channelKind ?? "unknown",
    parentCodexThreadId: storeBridge?.parentCodexThreadId ?? parentBridge?.codexThreadId ?? null,
    parentDiscordChannelId: storeBridge?.discordParentChannelId ?? discordLocation.parentChannelId ?? null,
    parentDiscordChannelName: discordLocation.parentChannelName ?? parentBridge?.threadName ?? null
  };
}

export async function runInspectDiscordThread(threadIdOrChannelId: string | undefined, limit: number): Promise<void> {
  const { discordProvider, stateStore } = createComponents();

  try {
    await discordProvider.start(createNoopDiscordHandlers(), {
      registerCommands: false,
      listenForInteractions: false
    });

    const threadBridges = stateStore.listThreadBridges();
    const discordSnapshot = await discordProvider.inspectBridgeManagedLocations(Math.max(limit, 100));
    const selected = resolveInspectSelection(threadIdOrChannelId, threadBridges, discordSnapshot);

    if (!selected) {
      printHeader("Discord Thread Inspect");
      if (!threadIdOrChannelId) {
        console.log("No mapped Discord bridge channel or thread is currently available to inspect.");
      } else {
        console.log(`No mapped Discord bridge channel or thread matched "${threadIdOrChannelId}".`);
      }
      return;
    }

    printHeader("Discord Thread Inspect");
    console.log(`Discord channel/thread: ${selected.discordChannelId}`);
    console.log(`Kind: ${selected.channelKind}`);
    console.log(`Codex thread: ${selected.codexThreadId ?? "(unmapped)"}`);
    console.log(`Project: ${selected.projectName ?? "(unknown project)"}`);
    console.log(`Name: ${selected.threadName ?? "(unnamed)"}`);
    console.log(`Parent Discord channel: ${selected.parentDiscordChannelId ?? "(none)"} ${selected.parentDiscordChannelName ?? ""}`.trim());
    console.log(`Parent Codex thread: ${selected.parentCodexThreadId ?? "(none)"}`);
    console.log(`Last seen: ${selected.lastSeenAt ?? "unknown"}`);
    console.log(
      `Mirror cursor: ${selected.latestMirroredCursor ?? "(none)"} timestamp=${formatAbsoluteTime(
        selected.latestMirroredTimestampMs ?? null
      )}`
    );

    const discordMessages = await discordProvider.inspectChannelMessages(selected.discordChannelId, limit);
    const mirroredStoreItems =
      selected.codexThreadId !== null
        ? stateStore
            .listMirroredItems(selected.codexThreadId)
            .slice(-limit)
            .map((record) => ({
              turnId: record.turnId,
              itemId: record.itemId,
              kind: record.kind,
              cursor: record.cursor,
              turnCursor: record.turnCursor,
              timestampMs: record.timestampMs
            }))
        : [];
    const detailsByMessage = discordMessages
      .map((message) => ({
        messageId: message.messageId,
        details: stateStore.listMessageDetailsByDiscordMessageId(message.messageId)
      }))
      .filter((record) => record.details.length > 0);
    const pendingApprovals =
      selected.codexThreadId !== null
        ? stateStore
            .listPendingApprovals()
            .filter((approval) => approval.threadId === selected.codexThreadId)
            .slice(0, limit)
        : [];
    const retainedTurns =
      selected.codexThreadId !== null ? stateStore.listRetainedTurns(selected.codexThreadId) : [];
    const childAnchor =
      selected.codexThreadId !== null ? stateStore.getChildThreadAnchor(selected.codexThreadId) ?? null : null;
    const canonicalEvents =
      selected.codexThreadId !== null ? stateStore.listCanonicalThreadEvents(selected.codexThreadId, limit) : [];

    printDiscordMessages(discordMessages);
    printMessageDetails(detailsByMessage);
    printPendingApprovals(pendingApprovals);
    if (selected.codexThreadId !== null) {
      printRetainedTurns(retainedTurns);
      printChildAnchor(childAnchor);
      printCanonicalEvents(canonicalEvents);
      printMirroredStoreItems(mirroredStoreItems);
    }
  } finally {
    await Promise.allSettled([discordProvider.stop()]);
    stateStore.close();
  }
}

async function runInspectThread(threadIdOrChannelId: string | undefined, limit: number): Promise<void> {
  const { codexAdapter, discordProvider, stateStore } = createComponents();

  try {
    await Promise.all([
      codexAdapter.start(),
      discordProvider.start(createNoopDiscordHandlers(), {
        registerCommands: false,
        listenForInteractions: false
      })
    ]);

    const threadBridges = stateStore.listThreadBridges();
    const discordSnapshot = await discordProvider.inspectBridgeManagedLocations(100);
    const selected = resolveInspectSelection(threadIdOrChannelId, threadBridges, discordSnapshot);

    if (!selected) {
      if (!threadIdOrChannelId) {
        printHeader("Thread Inspect");
        console.log("No mapped thread or Discord bridge channel is currently available to inspect.");
        return;
      }

      try {
        const codexThread = await codexAdapter.readThread(threadIdOrChannelId, true);
        printHeader("Thread Inspect");
        console.log(`Codex thread: ${codexThread.id}`);
        console.log("Discord channel: (unmapped)");
        console.log(`Project: ${(await codexAdapter.resolveMetadata(codexThread.id)).repoName ?? "(unknown project)"}`);
        console.log(`Name: ${codexThread.name ?? codexThread.preview ?? shortThreadId(codexThread.id)}`);
        console.log("Last seen: (unmapped)");
        console.log("Mirror cursor: (none) timestamp=unknown");
        printDiscordMessages([]);
        printCodexThreadItems(extractCodexThreadItemSnapshots(codexThread.turns).slice(-limit));
        return;
      } catch {
        printHeader("Thread Inspect");
        console.log(`No mapped thread or Discord bridge channel matched "${threadIdOrChannelId}".`);
        return;
      }
    }

    if (!selected.codexThreadId) {
      printHeader("Thread Inspect");
      console.log("Codex thread: (unmapped)");
      console.log(`Discord channel: ${selected.discordChannelId}`);
      console.log(`Project: ${selected.projectName ?? "(unknown project)"}`);
      console.log(`Name: ${selected.threadName ?? "(unnamed)"}`);
      console.log(`Last seen: ${selected.lastSeenAt ?? "unknown"}`);
      console.log("Mirror cursor: (none) timestamp=unknown");
      printDiscordMessages(await discordProvider.inspectChannelMessages(selected.discordChannelId, limit));
      printCodexThreadItems([]);
      return;
    }

    printHeader("Thread Inspect");
    console.log(`Codex thread: ${selected.codexThreadId}`);
    console.log(`Discord channel: ${selected.discordChannelId}`);
    console.log(`Project: ${selected.projectName}`);
    console.log(`Name: ${selected.threadName ?? shortThreadId(selected.codexThreadId)}`);
    console.log(`Last seen: ${selected.lastSeenAt ?? "unknown"}`);
    console.log(
      `Mirror cursor: ${selected.latestMirroredCursor ?? "(none)"} timestamp=${formatAbsoluteTime(
        selected.latestMirroredTimestampMs ?? null
      )}`
    );

    const [discordMessages, codexThread] = await Promise.all([
      discordProvider.inspectChannelMessages(selected.discordChannelId, limit),
      codexAdapter.readThread(selected.codexThreadId, true)
    ]);
    const mirroredStoreItems = stateStore
      .listMirroredItems(selected.codexThreadId)
      .slice(-limit)
      .map((record) => ({
        turnId: record.turnId,
        itemId: record.itemId,
        kind: record.kind,
        cursor: record.cursor,
        turnCursor: record.turnCursor,
        timestampMs: record.timestampMs
      }));
    const retainedTurns = stateStore.listRetainedTurns(selected.codexThreadId);
    const childAnchor = stateStore.getChildThreadAnchor(selected.codexThreadId) ?? null;
    const canonicalEvents = stateStore.listCanonicalThreadEvents(selected.codexThreadId, limit);

    printDiscordMessages(discordMessages);
    printCodexThreadItems(extractCodexThreadItemSnapshots(codexThread.turns).slice(-limit));
    printRetainedTurns(retainedTurns);
    printChildAnchor(childAnchor);
    printCanonicalEvents(canonicalEvents);
    printMirroredStoreItems(mirroredStoreItems);
  } finally {
    await Promise.allSettled([codexAdapter.stop(), discordProvider.stop()]);
    stateStore.close();
  }
}

async function runInspect(scope: InspectScope, traceLimit = 40): Promise<void> {
  const { config, codexAdapter, desktopIpcClient, discordProvider, stateStore, sessionEventTailer } = createComponents({
    codexListenUrlOverride: "stdio://"
  });

  try {
    await Promise.all([
      scope === "codex" || scope === "all"
        ? codexAdapter.start()
        : Promise.resolve(),
      scope === "ipc" || scope === "all"
        ? tryStartDesktopIpc(desktopIpcClient)
        : Promise.resolve(),
      scope === "discord" || scope === "all"
        ? discordProvider.start(createNoopDiscordHandlers(), {
            registerCommands: false,
            listenForInteractions: false
          })
        : Promise.resolve()
    ]);

    if (scope === "discord" || scope === "all") {
      const discordSnapshot = await discordProvider.inspectBridgeManagedLocations();
      printDiscordInspection(discordSnapshot, stateStore.listThreadBridges());
    }

    if (scope === "store" || scope === "all") {
      printStoreInspection(stateStore);
    }

    if (scope === "trace" || scope === "all") {
      printMirrorTraceInspection(config.bridge.diagnostics.mirrorTracePath, traceLimit);
    }

    if (scope === "desktop" || scope === "all") {
      printDesktopInspection(20, config.codexDesktopLogRoot);
    }

    if (scope === "ipc" || scope === "all") {
      if (desktopIpcClient.isReady()) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        printIpcInspection(desktopIpcClient.listRequests());
      } else {
        printHeader("Desktop IPC Requests");
        const resolution = resolveDesktopIpcPath({ overridePath: config.codexDesktopIpcPath });
        console.log(resolution.reason ?? "Codex Desktop IPC is not currently available.");
      }
    }

    if (scope === "codex" || scope === "all") {
      const codexThreads = await codexAdapter.listThreads({
        limit: 25,
        sortKey: "updated_at",
        archived: false,
        sourceKinds: config.codexThreadSourceKinds
      });
      const cliThreads = await sessionEventTailer.listRecentCliThreads(25, 7 * 24 * 60 * 60 * 1000);
      const mergedThreads = [
        ...codexThreads.map((thread) => ({
          ...thread,
          source: "app-server"
        })),
        ...cliThreads
          .filter((thread) => !codexThreads.some((codexThread) => codexThread.id === thread.threadId))
          .map((thread) => ({
            id: thread.threadId,
            name: thread.name,
            preview: thread.preview,
            updatedAt: thread.updatedAtMs ? Math.floor(thread.updatedAtMs / 1000) : null,
            status: thread.status === "active" ? { type: "active", activeFlags: [] } : { type: "idle" },
            source: "cli-session"
          }))
      ];
      printCodexInspection(
        mergedThreads,
        new Set(stateStore.listThreadBridges().map((thread) => thread.codexThreadId))
      );
    }
  } finally {
    await Promise.allSettled([
      codexAdapter.stop(),
      desktopIpcClient.stop(),
      discordProvider.stop()
    ]);
    stateStore.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";

  if (command === "cli") {
    await runCli(process.argv.slice(3));
    return;
  }

  if (command === "approvals") {
    await runApprovalList();
    return;
  }

  if (command === "approve") {
    await runApprove(process.argv[3], process.argv.slice(4));
    return;
  }

  if (command === "inspect") {
    const scope = parseInspectScope(process.argv[3]);
    if (scope === "discord-thread") {
      await runInspectDiscordThread(process.argv[4], parseLimit(process.argv[5], 12));
      return;
    }
    if (scope === "thread") {
      await runInspectThread(process.argv[4], parseLimit(process.argv[5], 12));
      return;
    }
    await runInspect(scope, parseLimit(process.argv[4], 40));
    return;
  }

  const { config, logger, service } = createComponents({
    listenUrlMode: "bridge-service"
  });
  const lock = acquireInstanceLock(path.join(path.dirname(config.storePath), "bridge.lock"), {
    purpose: command === "clean" ? "clean" : "start"
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down Codex bridge.");
    await service.stop();
    lock.release();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  if (command === "clean") {
    const mappedOnly = process.argv.slice(3).includes("--mapped-only");
    await service.start({ providerOnly: true, skipRehydrate: true, skipDiscovery: true });
    console.log(
      formatTerminalLogLine(
        "clean",
        mappedOnly
          ? "Cleaning bridge-managed Discord structure from local state only..."
          : "Cleaning bridge-managed Discord structure..."
      )
    );
    const result = await service.cleanBridgeState((message) => {
      console.log(formatTerminalLogLine("clean", message));
    }, { discoverOrphans: !mappedOnly });
    console.log(
      formatTerminalLogLine(
        "clean",
        `Clean complete. Deleted ${result.deletedLocations} channels/threads and ${result.deletedCategories} categories.`
      )
    );
    await service.stop();
    lock.release();
    return;
  }

  if (process.env.CODEX_MOBILE_PROVIDER === "local") {
    logger.info("Skipped Windows standalone Codex launcher integration for local-store provider.");
  } else {
    const standaloneLauncher = await ensureWindowsStandaloneCodexLauncher({
      listenUrl: config.codexAppServerListenUrl
    });
    const standaloneLauncherMessage = formatStandaloneCodexLauncherResult(standaloneLauncher);
    if (standaloneLauncher.status === "skipped") {
      logger.warn({ reason: standaloneLauncher.reason }, standaloneLauncherMessage);
    } else {
      logger.info(standaloneLauncherMessage);
    }
  }

  await service.start();
  console.log(formatTerminalLogLine("bridge", "Codex-to-Discord bridge is running and waiting for Codex activity."));
  logger.info("Codex-to-Discord bridge is running.");
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
