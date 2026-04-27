import { access, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits, type Guild } from "discord.js";
import { loadConfig, type AppConfig } from "./config.js";
import { isMacPlatform, resolveCommandSpawn, resolveDesktopIpcPath, resolveDesktopLogPaths } from "./platform.js";
import { StateStore } from "./store/StateStore.js";
import {
  confirmPrompt,
  loadExistingEnvFile,
  openExternal as openExternalUrl,
  quoteIfNeeded as quoteEnvValueIfNeeded
} from "./util/cliSetup.js";
import { buildDiscordInviteUrl as buildDiscordGuildInviteUrl } from "./util/discordInvite.js";

const REQUIRED_PERMISSION_LABELS = [
  { flag: PermissionFlagsBits.ManageChannels, label: "Manage Channels" },
  { flag: PermissionFlagsBits.ViewChannel, label: "View Channels" },
  { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  { flag: PermissionFlagsBits.SendMessagesInThreads, label: "Send Messages in Threads" },
  { flag: PermissionFlagsBits.CreatePublicThreads, label: "Create Public Threads" },
  { flag: PermissionFlagsBits.ManageThreads, label: "Manage Threads" },
  { flag: PermissionFlagsBits.PinMessages, label: "Pin Messages" },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
  { flag: PermissionFlagsBits.ManageMessages, label: "Manage Messages" },
];

export type EnvKey =
  | "DISCORD_BOT_TOKEN"
  | "DISCORD_APPLICATION_ID"
  | "DISCORD_GUILD_ID"
  | "CODEX_COMMAND"
  | "BRIDGE_CONFIG_PATH";

export interface FixPrompt {
  envKey: EnvKey;
  prompt: string;
  currentValue?: string;
  sensitive?: boolean;
  offerInviteRelaunch?: boolean;
}

export interface DiagnosticResult {
  label: string;
  ok: boolean;
  details: string;
  fixes?: FixPrompt[];
}

const CODEX_COMMAND_HELP_TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  const envPath = path.join(process.cwd(), ".env");

  while (true) {
    const config = tryLoadConfig();
    if (!config) {
      process.exitCode = 1;
      return;
    }

    const results = await runChecks(config);
    const hasFailure = printResults(results);
    printPlatformNotes(config);
    if (!hasFailure) {
      return;
    }

    const changed = await offerInteractiveFixes(envPath, results);
    if (!changed) {
      process.exitCode = 1;
      return;
    }

    console.log("");
    console.log("Updated .env. Re-running diagnostics...");
    console.log("");
  }
}

function tryLoadConfig(): AppConfig | null {
  try {
    return loadConfig();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown configuration error.";
    console.log(`FAIL Environment and bridge config: ${message}`);
    console.log(
      "Fix: run `npm run init` or update `.env` / `bridge.config.json`, then rerun `npm run doctor`.",
    );
    return null;
  }
}

async function runChecks(config: AppConfig): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  results.push({
    label: "Environment and bridge config",
    ok: true,
    details: "Required environment variables and bridge config parsed successfully.",
  });

  const store = new StateStore(config.storePath);
  store.close();
  await access(path.dirname(config.storePath), fsConstants.W_OK);
  results.push({
    label: "SQLite store",
    ok: true,
    details: `Writable store path: ${config.storePath}`,
  });

  results.push(await checkCodexCommand(config.codexCommand));
  results.push(await checkDiscord(config));

  return results;
}

function printResults(results: DiagnosticResult[]): boolean {
  let hasFailure = false;

  for (const result of results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"} ${result.label}: ${result.details}`,
    );
    if (!result.ok) {
      hasFailure = true;
    }
  }

  return hasFailure;
}

function printPlatformNotes(config: AppConfig): void {
  if (!isMacPlatform()) {
    return;
  }

  const ipcResolution = resolveDesktopIpcPath({ overridePath: config.codexDesktopIpcPath });
  const logResolution = resolveDesktopLogPaths(new Date(), {
    overrideRoot: config.codexDesktopLogRoot
  });
  const notes = [
    "INFO macOS support is best-effort and has not been validated with Codex Desktop yet."
  ];

  if (!ipcResolution.path) {
    notes.push(
      `INFO ${ipcResolution.reason ?? "Set CODEX_DESKTOP_IPC_PATH if Desktop approvals do not connect on this machine."}`
    );
  }

  if (!config.codexDesktopLogRoot) {
    notes.push(
      `INFO ${
        logResolution.reason ??
        "If inspect:desktop stays empty on macOS, set CODEX_DESKTOP_LOG_ROOT to your Codex Desktop log root."
      }`
    );
  }

  console.log(notes.join("\n"));
}

export async function checkCodexCommand(
  commandLine: string,
  options: { helpTimeoutMs?: number } = {}
): Promise<DiagnosticResult> {
  const helpTimeoutMs = options.helpTimeoutMs ?? CODEX_COMMAND_HELP_TIMEOUT_MS;
  return new Promise<DiagnosticResult>((resolve) => {
    const resolved = resolveCommandSpawn(commandLine, ["app-server", "--help"], {
      windowsHide: true
    });
    const child = spawn(resolved.command, resolved.args, {
      stdio: "ignore",
      shell: resolved.shell,
      ...(resolved.windowsHide === undefined ? {} : { windowsHide: resolved.windowsHide })
    });

    let settled = false;
    const fixes: FixPrompt[] = [
      {
        envKey: "CODEX_COMMAND",
        prompt: "Paste a corrected CODEX_COMMAND",
        currentValue: commandLine,
      },
    ];
    const finish = (ok: boolean, details: string, options: { fixes?: FixPrompt[]; terminate?: boolean } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      const finalize = () =>
        resolve({
          label: "Codex command",
          ok,
          details,
          ...(options.fixes ? { fixes: options.fixes } : {}),
        });
      if (options.terminate && child.exitCode === null) {
        void terminateProcessTree(child).finally(finalize);
        return;
      }
      finalize();
    };

    child.once("error", (error) => {
      finish(
        false,
        [
          `Failed to launch '${commandLine}': ${error.message}`,
          "Fix: set CODEX_COMMAND to the command or full path that successfully runs `codex app-server --help` in your terminal.",
        ].join("\n"),
        { fixes },
      );
    });

    child.once("exit", (code) => {
      finish(
        code === 0,
        code === 0
            ? "Codex app-server is launchable."
            : [
                `Exit code ${code}.`,
                "Fix: run the same command manually with `app-server --help` and update CODEX_COMMAND if the executable path is wrong.",
              ].join("\n"),
        code === 0 ? {} : { fixes },
      );
    });

    const timeoutId = setTimeout(() => {
      finish(
        false,
        [
          `Timed out waiting for '${commandLine} app-server --help' to exit.`,
          "Fix: run the same command manually with `app-server --help` and update CODEX_COMMAND if the executable path is wrong.",
        ].join("\n"),
        { fixes, terminate: true },
      );
    }, helpTimeoutMs);
    timeoutId.unref();
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid == null) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("error", () => {
        try {
          child.kill();
        } catch {}
        resolve();
      });
      killer.once("exit", () => resolve());
    });
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {}
}

async function checkDiscord(config: AppConfig): Promise<DiagnosticResult> {
  const result = await checkDiscordServerAccess({
    discordBotToken: config.discordBotToken,
    discordServerId: config.discordGuildId,
    controllerUserIds: config.bridge.approvals.allowedUserIds,
    requireControllerUsers: config.bridge.approvals.allowFromDiscord || config.bridge.messageWriteBacks.allowFromDiscord
  });
  if (result.ok || result.label !== "Discord connectivity") {
    return result;
  }

  const fixes = buildDiscordFixesFromMessage(result.errorMessage ?? result.details, config);
  return {
    ...result,
    ...(fixes ? { fixes } : {})
  };
}

export async function checkDiscordServerAccess(options: {
  discordBotToken: string;
  discordServerId: string;
  controllerUserIds?: string[];
  requireControllerUsers?: boolean;
}): Promise<DiagnosticResult & { errorMessage?: string }> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    await client.login(options.discordBotToken);
    await new Promise<void>((resolve) => {
      if (client.isReady()) {
        resolve();
        return;
      }
      client.once("clientReady", () => resolve());
    });

    const guild = await client.guilds.fetch(options.discordServerId);
    const member = await guild.members.fetchMe();
    const missing = REQUIRED_PERMISSION_LABELS.filter(
      (permission) => !member.permissions.has(permission.flag),
    ).map((permission) => permission.label);
    const botRole = member.roles.botRole;
    const missingBotRolePermissions = botRole
      ? REQUIRED_PERMISSION_LABELS.filter(
          (permission) => !botRole.permissions.has(permission.flag),
        ).map((permission) => permission.label)
      : [];

    const invalidControllerUsers = await findMissingGuildUserIds(
      guild,
      options.controllerUserIds ?? []
    );

    if (
      options.requireControllerUsers &&
      invalidControllerUsers.length > 0
    ) {
      const details = [
        "The configured Discord controller user ID was not found in the target server.",
        invalidControllerUsers.length > 0
          ? `Missing user IDs: ${invalidControllerUsers.join(", ")}`
          : null,
        "Fix: update DISCORD_CONTROLLER_USER_ID in .env so it matches a member in this server, then rerun diagnostics."
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n");

      return {
        label: "Discord controller user",
        ok: false,
        details
      };
    }

    if (missing.length > 0) {
      return {
        label: "Discord permissions",
        ok: false,
        details: [
          `Missing permissions: ${missing.join(", ")}`,
          "Fix: open the server settings, find the bot's role, and grant the required permissions. Re-inviting the bot with the generated invite URL can also refresh the requested permissions.",
        ].join("\n"),
      };
    }

    if (!botRole) {
      return {
        label: "Discord bot role",
        ok: false,
        details: "Could not find the bot's managed integration role. Re-authorize the bot on the server, then rerun diagnostics."
      };
    }

    if (missingBotRolePermissions.length > 0) {
      return {
        label: "Discord bot role",
        ok: false,
        details: [
          `The bot integration role '${botRole.name}' is missing permissions: ${missingBotRolePermissions.join(", ")}`,
          "Fix: update the app's server install permissions in the Discord Developer Portal, then re-authorize the bot on the server."
        ].join("\n")
      };
    }

    const probeResult = await runDiscordProbe(guild);
    if (!probeResult.ok) {
      return probeResult;
    }

    return {
      label: "Discord connectivity",
      ok: true,
      details: `Bot can reach server '${guild.name}' and has the server-level permissions needed to create categories, channels, and threads.`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown Discord error.";
    return {
      label: "Discord connectivity",
      ok: false,
      details: explainDiscordFailureForServerId(
        error,
        options.discordServerId,
        await safeListGuilds(client)
      ),
      errorMessage
    };
  } finally {
    client.destroy();
  }
}

async function runDiscordProbe(guild: Guild): Promise<DiagnosticResult> {
  const suffix = Date.now().toString(36);
  let categoryId: string | null = null;
  let channelId: string | null = null;

  try {
    const category = await guild.channels.create({
      name: `codex-mobile-doctor-${suffix}`,
      type: ChannelType.GuildCategory,
      reason: "Codex mobile doctor permission probe"
    });
    categoryId = category.id;

    const channel = await guild.channels.create({
      name: `doctor-${suffix}`,
      type: ChannelType.GuildText,
      parent: category.id,
      reason: "Codex mobile doctor permission probe"
    });
    channelId = channel.id;

    const message = await channel.send("Codex mobile doctor probe");

    try {
      await message.pin("Codex mobile doctor permission probe");
    } catch (error) {
      return {
        label: "Discord live probe",
        ok: false,
        details: [
          `Bot could create a category and channel in server '${guild.name}', but it could not pin a message there: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
          "Fix: in Discord Developer Portal -> Installation -> server install permissions, make sure both 'Pin Messages' and 'Manage Messages' are selected, then re-authorize the app on the server."
        ].join("\n")
      };
    }

    try {
      const thread = await channel.threads.create({
        name: `doctor-thread-${suffix}`,
        type: ChannelType.PublicThread,
        autoArchiveDuration: 60,
        reason: "Codex mobile doctor permission probe"
      });
      await thread.send("Codex mobile thread probe");
    } catch (error) {
      return {
        label: "Discord live probe",
        ok: false,
        details: [
          `Bot could create a channel in server '${guild.name}', but it could not create or write to a public thread: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
          "Fix: in Discord Developer Portal -> Installation -> server install permissions, make sure 'Create Public Threads', 'Send Messages in Threads', and 'Manage Threads' are selected, then re-authorize the app on the server."
        ].join("\n")
      };
    }

    return {
      label: "Discord live probe",
      ok: true,
      details: "Bot can create categories, channels, pin a status message, and create/write to a public thread."
    };
  } catch (error) {
    return {
      label: "Discord live probe",
      ok: false,
      details: [
        `Bot could not complete the Discord write probe: ${error instanceof Error ? error.message : "Unknown error"}`,
        "Fix: ensure the bot has the required server install permissions, re-authorize it on the server, and rerun diagnostics."
      ].join("\n")
    };
  } finally {
    if (channelId) {
      await guild.channels.delete(channelId, "Codex mobile doctor cleanup").catch(() => {});
    }
    if (categoryId) {
      await guild.channels.delete(categoryId, "Codex mobile doctor cleanup").catch(() => {});
    }
  }
}

interface SafeGuildListResult {
  guilds: Array<{ id: string; name: string }>;
  error: string | null;
}

async function safeListGuilds(client: Client): Promise<SafeGuildListResult> {
  try {
    const guildCollection = await client.guilds.fetch();
    return {
      guilds: [...guildCollection.values()].map((guild) => ({
        id: guild.id,
        name: guild.name,
      })),
      error: null
    };
  } catch (error) {
    return {
      guilds: [],
      error: error instanceof Error ? error.message : "Unknown Discord API error while listing servers."
    };
  }
}

function buildDiscordFixesFromMessage(
  message: string,
  config: AppConfig,
): FixPrompt[] | undefined {
  if (/Unknown Guild|Missing Access/i.test(message)) {
    return [
      {
        envKey: "DISCORD_GUILD_ID",
        prompt: "Paste the corrected Discord server ID",
        currentValue: config.discordGuildId,
        offerInviteRelaunch: true,
      },
    ];
  }

  if (/Unauthorized|invalid token|TOKEN_INVALID/i.test(message)) {
    return [
      {
        envKey: "DISCORD_BOT_TOKEN",
        prompt: "Paste a corrected DISCORD_BOT_TOKEN",
        sensitive: true,
      },
    ];
  }

  return undefined;
}

async function findMissingGuildUserIds(guild: Guild, userIds: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const userId of userIds) {
    const exists = await guild.members
      .fetch(userId)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      missing.push(userId);
    }
  }
  return missing;
}

function explainDiscordFailureForServerId(
  error: unknown,
  serverId: string,
  guildList: SafeGuildListResult,
): string {
  const message =
    error instanceof Error ? error.message : "Unknown Discord error.";
  const guilds = guildList.guilds;
  const guildSection =
    guilds.length > 0
      ? [
          "The bot can currently see these servers:",
          ...guilds
            .slice(0, 10)
            .map((guild) => `- ${guild.name} (${guild.id})`),
        ].join("\n")
      : guildList.error
        ? [
            "Doctor could not list the bot's servers after the Discord check failed.",
            `Server-list error: ${guildList.error}`,
            "This can happen when Codex is running commands in a restricted sandbox with no Discord network access. If `npm run doctor` passes in your normal terminal, prefer that result."
          ].join("\n")
      : "The bot currently sees 0 servers. This usually means the bot was not added to any server yet.";

  if (/Unknown Guild/i.test(message)) {
    return [
      message,
      `This typically happens when Discord could not find a server with ID ${serverId} that this bot can access. FIX:`,
      "1. Make sure you completed the bot invite and selected the correct server.",
      "2. In Discord, right-click the server itself and copy the Server ID again.",
      "3. Paste the corrected ID below, or update `.env` and rerun `npm run doctor`.",
      guildSection,
    ].join("\n");
  }

  if (/Missing Access/i.test(message)) {
    return [
      message,
      "Fix: the bot token is valid, but the bot cannot access that server.",
      "1. Re-open the generated invite URL.",
      "2. Choose the correct Discord server.",
      "3. Authorize the bot, then rerun diagnostics.",
      guildSection,
    ].join("\n");
  }

  if (/Unauthorized|invalid token|TOKEN_INVALID/i.test(message)) {
    return [
      message,
      "Fix: copy the bot token again from the Discord Developer Portal -> Bot page, update DISCORD_BOT_TOKEN, and rerun diagnostics.",
    ].join("\n");
  }

  return [
    message,
    "Fix: verify the bot token, server ID, and bot invite, then rerun diagnostics.",
    guildSection,
  ].join("\n");
}

async function offerInteractiveFixes(
  envPath: string,
  results: DiagnosticResult[],
): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    return false;
  }

  const fixes = dedupeFixes(results.flatMap((result) => result.fixes ?? []));
  if (fixes.length === 0) {
    return false;
  }

  const rl = createInterface({ input, output });
  let changed = false;
  const envValues = await loadExistingEnv(envPath);

  try {
    for (const fix of fixes) {
      console.log("");
      if (fix.offerInviteRelaunch) {
        const applicationId = envValues.DISCORD_APPLICATION_ID;
        if (
          applicationId &&
          (await confirm(
            rl,
            "Open the bot invite URL again before updating this value?",
            true,
          ))
        ) {
          openExternal(buildDiscordInviteUrl(applicationId));
          console.log("Reopened the bot invite page in your browser.");
        }
      }
      const displayCurrent =
        fix.sensitive || !fix.currentValue ? "" : ` [${fix.currentValue}]`;
      const answer = (
        await rl.question(`${fix.prompt}${displayCurrent}: `)
      ).trim();
      if (!answer) {
        continue;
      }

      await updateEnvValue(envPath, fix.envKey, answer);
      changed = true;
    }
  } finally {
    rl.close();
  }

  return changed;
}

function dedupeFixes(fixes: FixPrompt[]): FixPrompt[] {
  const seen = new Set<string>();
  const unique: FixPrompt[] = [];

  for (const fix of fixes) {
    if (seen.has(fix.envKey)) {
      continue;
    }
    seen.add(fix.envKey);
    unique.push(fix);
  }

  return unique;
}

async function updateEnvValue(
  envPath: string,
  key: EnvKey,
  value: string,
): Promise<void> {
  const existing = await loadExistingEnv(envPath);
  existing[key] = value;

  const orderedKeys: EnvKey[] = [
    "DISCORD_BOT_TOKEN",
    "DISCORD_APPLICATION_ID",
    "DISCORD_GUILD_ID",
    "CODEX_COMMAND",
    "BRIDGE_CONFIG_PATH",
  ];
  const otherKeys = Object.keys(existing).filter(
    (entry) => !orderedKeys.includes(entry as EnvKey),
  );

  const lines = [...orderedKeys, ...otherKeys]
    .filter((entry, index, array) => array.indexOf(entry) === index)
    .filter((entry) => existing[entry])
    .map((entry) => `${entry}=${quoteIfNeeded(existing[entry] ?? "")}`);

  await writeFile(envPath, `${lines.join("\n")}\n`, "utf8");
}

async function loadExistingEnv(
  envPath: string,
): Promise<Record<string, string>> {
  return loadExistingEnvFile(envPath);
}

function quoteIfNeeded(value: string): string {
  return quoteEnvValueIfNeeded(value);
}

function buildDiscordInviteUrl(applicationId: string): string {
  return buildDiscordGuildInviteUrl(applicationId);
}

async function confirm(
  rl: Interface,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  return confirmPrompt(rl, question, defaultYes);
}

function openExternal(url: string): void {
  openExternalUrl(url);
}

const isDirectExecution =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
