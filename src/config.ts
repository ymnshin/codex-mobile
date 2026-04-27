import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveCodexHomePath, resolveDesktopIpcPath } from "./platform.js";
import { DEFAULT_LOCAL_APP_SERVER_LISTEN_URL } from "./util/codexListenUrl.js";
import { normalizeIdList } from "./util/idList.js";

loadDotenv();

export const DEFAULT_BRIDGE_CONFIG_PATH = "bridge.config.json";
export const DEFAULT_APPROVAL_TTL_MINUTES = 30;
const devFlagSchema = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((value) => value === true || value === 1);

export type BridgePreset = "basic" | "recommended" | "full";
const bridgePresetSchema = z.enum(["basic", "recommended", "full"]);
const BRIDGE_PRESETS: BridgePreset[] = ["basic", "recommended", "full"];

export interface BridgeVisibilityConfig {
  userMessages: boolean;
  thinkingMessages: boolean;
  finalMessages: boolean;
  commands: boolean;
  fileEdits: boolean;
}

export interface BridgeApprovalsConfig {
  allowFromDiscord: boolean;
  allowedUserIds: string[];
  mentionApprovers: boolean;
  approvalTtlMinutes?: number;
}

export interface BridgeMessageWriteBackConfig {
  allowFromDiscord: boolean;
  allowedUserIds: string[];
}

type BridgeMessageWriteBackConfigInput = {
  allowFromDiscord?: boolean | undefined;
};

export interface BridgeUiConfig {
  commandDisplayMode: "summary" | "full";
  commandPreviewMaxLength: number;
  enableCommandDetails: boolean;
  detailButtonTtlMinutes: number;
  showDevDetailButtons: boolean;
}

export interface BridgeDiagnosticsConfig {
  desktopSteerDumpEnabled: boolean;
  mirrorTraceEnabled: boolean;
  mirrorTracePath: string;
  mirrorTraceMaxBytes: number;
}

export interface BridgeDiscoveryConfig {
  allowedThreadIds: string[];
  projectNamePrefix: string | null;
}

export interface BridgeStartupBackfillConfig {
  maxCodexMessages: number;
  leadingEventBudget: number;
  trailingEventBudget: number;
}

export interface BridgeRetentionConfig {
  maxTurnsPerThread: number;
}

export interface BridgeRuntimeConfig {
  preset: BridgePreset;
  approvals: BridgeApprovalsConfig;
  messageWriteBacks: BridgeMessageWriteBackConfig;
  visibility: BridgeVisibilityConfig;
  startupBackfill: BridgeStartupBackfillConfig;
  retention: BridgeRetentionConfig;
  ui: BridgeUiConfig;
  diagnostics: BridgeDiagnosticsConfig;
  discovery: BridgeDiscoveryConfig;
  configPath: string;
}

export interface BridgeConfigOverrides {
  messageWriteBacks?: BridgeMessageWriteBackConfigInput;
  visibility?: Partial<BridgeVisibilityConfig>;
  startupBackfill?: Partial<BridgeStartupBackfillConfig>;
  retention?: Partial<BridgeRetentionConfig>;
  ui?: Partial<BridgeUiConfig>;
  diagnostics?: Partial<BridgeDiagnosticsConfig>;
  discovery?: Partial<BridgeDiscoveryConfig>;
}

export interface AppConfig {
  discordBotToken: string;
  discordApplicationId: string;
  discordGuildId: string;
  codexCommand: string;
  codexAppServerListenUrl: string;
  codexDesktopIpcPath: string | null;
  codexDesktopLogRoot: string | null;
  codexDiscoveryPollSeconds: number;
  codexThreadSourceKinds: string[];
  storePath: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  codexHome: string;
  bridge: BridgeRuntimeConfig;
}

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_APPLICATION_ID: z.string().min(1, "DISCORD_APPLICATION_ID is required"),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID is required"),
  DISCORD_CONTROLLER_USER_ID: z.string().trim().optional(),
  CODEX_COMMAND: z.string().trim().min(1).default("codex"),
  CODEX_APP_SERVER_LISTEN_URL: z.string().trim().min(1).default(DEFAULT_LOCAL_APP_SERVER_LISTEN_URL),
  CODEX_DISCOVERY_POLL_SECONDS: z.coerce.number().int().min(5).default(5),
  CODEX_THREAD_SOURCE_KINDS: z.string().trim().default("vscode,cli"),
  STORE_PATH: z.string().trim().default("./data/codex-discord-bridge.sqlite"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  BRIDGE_CONFIG_PATH: z.string().trim().optional(),
  CODEX_DESKTOP_IPC_PATH: z.string().trim().optional(),
  CODEX_DESKTOP_LOG_ROOT: z.string().trim().optional()
});

const bridgeConfigSchema = z
  .object({
    preset: bridgePresetSchema.optional(),
    approvals: z
      .object({
        allowFromDiscord: z.boolean().optional(),
        mentionApprovers: z.boolean().optional(),
        approvalTtlMinutes: z.coerce.number().int().min(1).max(24 * 60).optional()
      })
      .strict()
      .optional(),
    messageWriteBacks: z
      .object({
        allowFromDiscord: z.boolean().optional()
      })
      .strict()
      .optional(),
    visibility: z
      .object({
        userMessages: z.boolean().optional(),
        thinkingMessages: z.boolean().optional(),
        finalMessages: z.boolean().optional(),
        commands: z.boolean().optional(),
        fileEdits: z.boolean().optional()
      })
      .strict()
      .optional(),
    startupBackfill: z
      .object({
        maxCodexMessages: z.coerce.number().int().min(0).max(100).optional(),
        leadingEventBudget: z.coerce.number().int().min(0).max(100).optional(),
        trailingEventBudget: z.coerce.number().int().min(0).max(100).optional()
      })
      .strict()
      .optional(),
    retention: z
      .object({
        maxTurnsPerThread: z.coerce.number().int().min(1).max(20).optional()
      })
      .strict()
      .optional(),
    ui: z
      .object({
        commandDisplayMode: z.enum(["summary", "full"]).optional(),
        commandPreviewMaxLength: z.coerce.number().int().min(40).max(500).optional(),
        enableCommandDetails: z.boolean().optional(),
        detailButtonTtlMinutes: z.coerce.number().int().min(1).max(24 * 60).optional(),
        showDevDetailButtons: z.boolean().optional()
      })
      .strict()
      .optional(),
    diagnostics: z
      .object({
        desktopSteerDumpEnabled: devFlagSchema.optional(),
        mirrorTraceEnabled: z.boolean().optional(),
        mirrorTracePath: z.string().trim().min(1).optional(),
        mirrorTraceMaxBytes: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).optional()
      })
      .strict()
      .optional(),
    discovery: z
      .object({
        allowedThreadIds: z.array(z.string().trim().min(1)).optional(),
        projectNamePrefix: z.string().trim().min(1).max(60).nullable().optional()
      })
      .strict()
      .optional()
  })
  .strict();

type BridgePresetDefaults = Omit<BridgeRuntimeConfig, "preset" | "approvals" | "messageWriteBacks" | "configPath"> & {
  messageWriteBacks: Pick<BridgeMessageWriteBackConfig, "allowFromDiscord">;
};

const presetDefaultsSchema: z.ZodType<BridgePresetDefaults> = z
  .object({
    messageWriteBacks: z
      .object({
        allowFromDiscord: z.boolean()
      })
      .strict(),
    visibility: z
      .object({
        userMessages: z.boolean(),
        thinkingMessages: z.boolean(),
        finalMessages: z.boolean(),
        commands: z.boolean(),
        fileEdits: z.boolean()
      })
      .strict(),
    startupBackfill: z
      .object({
        maxCodexMessages: z.number().int().min(0).max(100),
        leadingEventBudget: z.number().int().min(0).max(100),
        trailingEventBudget: z.number().int().min(0).max(100)
      })
      .strict(),
    retention: z
      .object({
        maxTurnsPerThread: z.number().int().min(1).max(20)
      })
      .strict(),
    ui: z
      .object({
        commandDisplayMode: z.enum(["summary", "full"]),
        commandPreviewMaxLength: z.number().int().min(40).max(500),
        enableCommandDetails: z.boolean(),
        detailButtonTtlMinutes: z.number().int().min(1).max(24 * 60),
        showDevDetailButtons: z.boolean()
      })
      .strict(),
    diagnostics: z
      .object({
        desktopSteerDumpEnabled: z.boolean(),
        mirrorTraceEnabled: z.boolean(),
        mirrorTracePath: z.string().trim().min(1),
        mirrorTraceMaxBytes: z.number().int().min(1024).max(50 * 1024 * 1024)
      })
      .strict(),
    discovery: z
      .object({
        allowedThreadIds: z.array(z.string().trim().min(1)),
        projectNamePrefix: z.string().trim().min(1).max(60).nullable()
      })
      .strict()
  })
  .strict();

const PRESET_DEFAULTS: Record<BridgePreset, BridgePresetDefaults> = loadPresetDefaults();

function loadPresetDefaults(): Record<BridgePreset, BridgePresetDefaults> {
  return Object.fromEntries(
    BRIDGE_PRESETS.map((preset) => {
      const presetPath = path.resolve(process.cwd(), "config", "presets", `${preset}.json`);
      if (!existsSync(presetPath)) {
        throw new Error(`bridge preset file not found at ${presetPath}`);
      }
      const raw = parseBridgeConfigText(readFileSync(presetPath, "utf8"));
      return [preset, presetDefaultsSchema.parse(raw)];
    })
  ) as Record<BridgePreset, BridgePresetDefaults>;
}

export function createBridgeConfigFromPreset(
  preset: BridgePreset,
  approvers: {
    allowFromDiscord?: boolean;
    mentionApprovers?: boolean;
    allowedUserIds?: string[];
    approvalTtlMinutes?: number;
  } = {},
  overrides: BridgeConfigOverrides = {},
  configPath = path.resolve(process.cwd(), DEFAULT_BRIDGE_CONFIG_PATH)
): BridgeRuntimeConfig {
  const defaults = PRESET_DEFAULTS[preset];
  const allowFromDiscord = approvers.allowFromDiscord ?? true;
  const mentionApprovers = approvers.mentionApprovers ?? allowFromDiscord;
  const allowedUserIds = normalizeIdList(approvers.allowedUserIds ?? []);
  const approvalTtlMinutes = approvers.approvalTtlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES;
  const approvals: BridgeApprovalsConfig = {
    allowFromDiscord,
    allowedUserIds,
    mentionApprovers,
    approvalTtlMinutes
  };

  const runtimeConfig: BridgeRuntimeConfig = {
    preset,
    approvals,
    messageWriteBacks: resolveMessageWriteBackConfig(approvals, defaults.messageWriteBacks, overrides.messageWriteBacks),
    visibility: {
      ...defaults.visibility,
      ...overrides.visibility
    },
    startupBackfill: resolveStartupBackfillConfig(defaults.startupBackfill, overrides.startupBackfill),
    retention: {
      ...defaults.retention,
      ...overrides.retention
    },
    ui: {
      ...defaults.ui,
      ...overrides.ui
    },
    diagnostics: {
      ...defaults.diagnostics,
      ...overrides.diagnostics
    },
    discovery: {
      ...defaults.discovery,
      ...overrides.discovery,
      allowedThreadIds: normalizeIdList(overrides.discovery?.allowedThreadIds ?? defaults.discovery.allowedThreadIds),
      projectNamePrefix: overrides.discovery?.projectNamePrefix?.trim() || null
    },
    configPath
  };
  validateControllerConfig(runtimeConfig);
  return runtimeConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsedEnv = envSchema.parse(env);
  const codexHome = resolveCodexHomePath(env.CODEX_HOME);
  const configPath = resolveBridgeConfigPath(parsedEnv.BRIDGE_CONFIG_PATH);
  const controllerUserIds = normalizeIdList(
    parsedEnv.DISCORD_CONTROLLER_USER_ID ? [parsedEnv.DISCORD_CONTROLLER_USER_ID] : []
  );
  const bridge = loadBridgeRuntimeConfig(configPath, { controllerUserIds });
  const codexDesktopIpcPath = resolveDesktopIpcPath({
    overridePath: parsedEnv.CODEX_DESKTOP_IPC_PATH ?? null
  }).path;
  const codexDesktopLogRoot = parsedEnv.CODEX_DESKTOP_LOG_ROOT?.trim()
    ? path.resolve(parsedEnv.CODEX_DESKTOP_LOG_ROOT.trim())
    : null;

  return {
    discordBotToken: parsedEnv.DISCORD_BOT_TOKEN,
    discordApplicationId: parsedEnv.DISCORD_APPLICATION_ID,
    discordGuildId: parsedEnv.DISCORD_GUILD_ID,
    codexCommand: parsedEnv.CODEX_COMMAND,
    codexAppServerListenUrl: parsedEnv.CODEX_APP_SERVER_LISTEN_URL,
    codexDesktopIpcPath,
    codexDesktopLogRoot,
    codexDiscoveryPollSeconds: parsedEnv.CODEX_DISCOVERY_POLL_SECONDS,
    codexThreadSourceKinds: parsedEnv.CODEX_THREAD_SOURCE_KINDS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    storePath: path.resolve(parsedEnv.STORE_PATH),
    logLevel: parsedEnv.LOG_LEVEL,
    codexHome,
    bridge
  };
}

export function resolveBridgeConfigPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim()) {
    return path.resolve(explicitPath.trim());
  }
  return path.resolve(process.cwd(), DEFAULT_BRIDGE_CONFIG_PATH);
}

export function loadBridgeRuntimeConfig(
  configPath: string,
  options: { controllerUserIds?: string[]; validateController?: boolean } = {}
): BridgeRuntimeConfig {
  if (!existsSync(configPath)) {
    throw new Error(
      `bridge config not found at ${configPath}. Run \`npm run init\` to create .env and bridge.config.json.`
    );
  }

  const raw = parseBridgeConfigText(readFileSync(configPath, "utf8")) as unknown;
  const parsed = bridgeConfigSchema.parse(raw);
  const preset = parsed.preset ?? "recommended";
  const defaults = PRESET_DEFAULTS[preset];
  const startupBackfill = resolveStartupBackfillConfig(defaults.startupBackfill, parsed.startupBackfill);
  const approvals: BridgeApprovalsConfig = {
    allowFromDiscord: parsed.approvals?.allowFromDiscord ?? true,
    allowedUserIds: normalizeIdList(options.controllerUserIds ?? []),
    mentionApprovers:
      parsed.approvals?.mentionApprovers ?? (parsed.approvals?.allowFromDiscord ?? true),
    approvalTtlMinutes:
      parsed.approvals?.approvalTtlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES
  };
  const runtimeConfig: BridgeRuntimeConfig = {
    preset,
    approvals,
    messageWriteBacks: resolveMessageWriteBackConfig(approvals, defaults.messageWriteBacks, parsed.messageWriteBacks),
    visibility: {
      userMessages: parsed.visibility?.userMessages ?? defaults.visibility.userMessages,
      thinkingMessages: parsed.visibility?.thinkingMessages ?? defaults.visibility.thinkingMessages,
      finalMessages: parsed.visibility?.finalMessages ?? defaults.visibility.finalMessages,
      commands: parsed.visibility?.commands ?? defaults.visibility.commands,
      fileEdits: parsed.visibility?.fileEdits ?? defaults.visibility.fileEdits
    },
    startupBackfill,
    retention: {
      maxTurnsPerThread:
        parsed.retention?.maxTurnsPerThread ?? defaults.retention.maxTurnsPerThread
    },
    ui: {
      commandDisplayMode:
        parsed.ui?.commandDisplayMode ?? defaults.ui.commandDisplayMode,
      commandPreviewMaxLength:
        parsed.ui?.commandPreviewMaxLength ?? defaults.ui.commandPreviewMaxLength,
      enableCommandDetails:
        parsed.ui?.enableCommandDetails ?? defaults.ui.enableCommandDetails,
      detailButtonTtlMinutes:
        parsed.ui?.detailButtonTtlMinutes ?? defaults.ui.detailButtonTtlMinutes,
      showDevDetailButtons:
        parsed.ui?.showDevDetailButtons ?? defaults.ui.showDevDetailButtons
    },
    diagnostics: {
      desktopSteerDumpEnabled:
        parsed.diagnostics?.desktopSteerDumpEnabled ?? defaults.diagnostics.desktopSteerDumpEnabled,
      mirrorTraceEnabled:
        parsed.diagnostics?.mirrorTraceEnabled ?? defaults.diagnostics.mirrorTraceEnabled,
      mirrorTracePath: resolveBridgePath(
        configPath,
        parsed.diagnostics?.mirrorTracePath ?? defaults.diagnostics.mirrorTracePath
      ),
      mirrorTraceMaxBytes:
        parsed.diagnostics?.mirrorTraceMaxBytes ?? defaults.diagnostics.mirrorTraceMaxBytes
    },
    discovery: {
      allowedThreadIds: normalizeIdList(parsed.discovery?.allowedThreadIds ?? defaults.discovery.allowedThreadIds),
      projectNamePrefix:
        parsed.discovery?.projectNamePrefix?.trim() ||
        defaults.discovery.projectNamePrefix
    },
    configPath
  };

  if (options.validateController ?? true) {
    validateControllerConfig(runtimeConfig);
  }
  return runtimeConfig;
}

export function extractBridgeConfigOverrides(config: BridgeRuntimeConfig): BridgeConfigOverrides {
  const defaults = PRESET_DEFAULTS[config.preset];
  const overrides: BridgeConfigOverrides = {};

  const messageWriteBackDefaults = resolveMessageWriteBackConfig(
    config.approvals,
    defaults.messageWriteBacks
  );
  const messageWriteBacks = diffObject(config.messageWriteBacks, messageWriteBackDefaults);
  if (messageWriteBacks) {
    overrides.messageWriteBacks = messageWriteBacks;
  }

  const visibility = diffObject(config.visibility, defaults.visibility);
  if (visibility) {
    overrides.visibility = visibility;
  }

  const startupBackfill = diffObject(config.startupBackfill, defaults.startupBackfill);
  if (startupBackfill) {
    overrides.startupBackfill = startupBackfill;
  }

  const retention = diffObject(config.retention, defaults.retention);
  if (retention) {
    overrides.retention = retention;
  }

  const ui = diffObject(config.ui, defaults.ui);
  if (ui) {
    overrides.ui = ui;
  }

  const diagnostics = diffObject(config.diagnostics, defaults.diagnostics);
  if (diagnostics) {
    overrides.diagnostics = diagnostics;
  }

  const discovery: Partial<BridgeDiscoveryConfig> = {};
  if (config.discovery.allowedThreadIds.join("\n") !== defaults.discovery.allowedThreadIds.join("\n")) {
    discovery.allowedThreadIds = config.discovery.allowedThreadIds;
  }
  if (config.discovery.projectNamePrefix !== defaults.discovery.projectNamePrefix) {
    discovery.projectNamePrefix = config.discovery.projectNamePrefix;
  }
  if (Object.keys(discovery).length > 0) {
    overrides.discovery = discovery;
  }

  return overrides;
}

function resolveMessageWriteBackConfig(
  approvals: BridgeApprovalsConfig,
  defaults: Pick<BridgeMessageWriteBackConfig, "allowFromDiscord">,
  overrides: BridgeMessageWriteBackConfigInput | undefined = undefined
): BridgeMessageWriteBackConfig {
  const allowFromDiscord = overrides?.allowFromDiscord ?? defaults.allowFromDiscord;
  return {
    allowFromDiscord,
    allowedUserIds: approvals.allowedUserIds
  };
}

function validateControllerConfig(config: BridgeRuntimeConfig): void {
  if (
    (config.approvals.allowFromDiscord || config.messageWriteBacks.allowFromDiscord) &&
    config.approvals.allowedUserIds.length !== 1
  ) {
    throw new Error(
      `bridge config is invalid: ${path.basename(config.configPath)} requires exactly one DISCORD_CONTROLLER_USER_ID in .env when Discord actions are enabled`
    );
  }
}

function parseBridgeConfigText(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]!;
    const next = text[index + 1] ?? "";

    if (inLineComment) {
      if (current === "\n" || current === "\r") {
        inLineComment = false;
        result += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (current === "\"") {
        inString = false;
      }
      continue;
    }

    if (current === "\"") {
      inString = true;
      result += current;
      continue;
    }

    if (current === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += current;
  }

  return result;
}

function diffObject<T extends object>(current: T, defaults: T): Partial<T> | undefined {
  const entries = Object.entries(current).filter(
    ([key, value]) => !Object.is(value, defaults[key as keyof T])
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries) as Partial<T>;
}

function resolveStartupBackfillConfig(
  defaults: BridgeStartupBackfillConfig,
  overrides?: {
    maxCodexMessages?: number | undefined;
    leadingEventBudget?: number | undefined;
    trailingEventBudget?: number | undefined;
  }
): BridgeStartupBackfillConfig {
  const explicitMaxCodexMessages = overrides?.maxCodexMessages;
  const leadingEventBudget =
    overrides?.leadingEventBudget ??
    (explicitMaxCodexMessages !== undefined
      ? Math.ceil(explicitMaxCodexMessages / 2)
      : defaults.leadingEventBudget);
  const trailingEventBudget =
    overrides?.trailingEventBudget ??
    (explicitMaxCodexMessages !== undefined
      ? Math.floor(explicitMaxCodexMessages / 2)
      : defaults.trailingEventBudget);
  const maxCodexMessages =
    explicitMaxCodexMessages ??
    (overrides?.leadingEventBudget !== undefined || overrides?.trailingEventBudget !== undefined
      ? leadingEventBudget + trailingEventBudget
      : defaults.maxCodexMessages);

  return {
    maxCodexMessages,
    leadingEventBudget,
    trailingEventBudget
  };
}

function resolveBridgePath(configPath: string, candidatePath: string): string {
  if (path.isAbsolute(candidatePath)) {
    return candidatePath;
  }
  return path.resolve(path.dirname(configPath), candidatePath);
}
