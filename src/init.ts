import { access, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createBridgeConfigFromPreset,
  DEFAULT_APPROVAL_TTL_MINUTES,
  extractBridgeConfigOverrides,
  loadBridgeRuntimeConfig,
  resolveBridgeConfigPath,
  type BridgePreset,
  type BridgeRuntimeConfig
} from "./config.js";
import {
  confirmPrompt,
  loadExistingEnvFile,
  openExternal as openExternalUrl,
  quoteIfNeeded as quoteEnvValueIfNeeded
} from "./util/cliSetup.js";
import { buildDiscordInviteUrl as buildDiscordGuildInviteUrl } from "./util/discordInvite.js";
import { parseCsvIdList } from "./util/idList.js";
import { findCommandOnPath } from "./platform.js";
import { checkDiscordServerAccess } from "./doctor.js";
import {
  DEFAULT_LOCAL_APP_SERVER_LISTEN_URL,
  ensureWindowsStandaloneCodexLauncher,
  formatStandaloneCodexLauncherResult
} from "./codex/CodexCliStandaloneLauncher.js";

const DISCORD_DEVELOPER_PORTAL_URL = "https://discord.com/developers/applications";

interface EnvValues {
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_CONTROLLER_USER_ID: string;
  CODEX_COMMAND: string;
  CODEX_APP_SERVER_LISTEN_URL: string;
  CODEX_DISCOVERY_POLL_SECONDS: string;
  CODEX_THREAD_SOURCE_KINDS: string;
  STORE_PATH: string;
  LOG_LEVEL: string;
  BRIDGE_CONFIG_PATH?: string;
  CODEX_DESKTOP_IPC_PATH?: string;
  CODEX_DESKTOP_LOG_ROOT?: string;
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const envPath = path.join(projectRoot, ".env");
  const existingValues = await loadExistingEnv(envPath);
  const bridgeConfigPath = resolveInitBridgeConfigPath(existingValues);
  const existingBridgeConfig = await loadExistingBridgeConfig(bridgeConfigPath);
  const detectedCodexCommand = await detectCodexCommand();
  const rl = createInterface({ input, output });

  try {
    console.log("");
    console.log("Codex-to-Discord Bridge init");
    console.log("");
    console.log("This wizard will:");
    console.log("- help you create or choose a Discord server");
    console.log("- help you create or open a Discord bot");
    console.log("- invite the bot to that server with the required permissions");
    console.log("- customize the bridge experience");
    console.log("- verify the configuration before the bridge starts");
    console.log("");
    console.log("Platform support:");
    console.log("- Windows is the primary developed and tested platform");
    console.log("- macOS is best-effort and not yet validated with Codex Desktop");
    console.log("");
    await rl.question("Press Enter to start the guided setup...");

    const envValues: EnvValues = {
      DISCORD_APPLICATION_ID: existingValues.DISCORD_APPLICATION_ID || "",
      DISCORD_BOT_TOKEN: existingValues.DISCORD_BOT_TOKEN || "",
      DISCORD_GUILD_ID: existingValues.DISCORD_GUILD_ID || "",
      DISCORD_CONTROLLER_USER_ID: existingValues.DISCORD_CONTROLLER_USER_ID || "",
      CODEX_COMMAND: existingValues.CODEX_COMMAND || detectedCodexCommand || "codex",
      CODEX_APP_SERVER_LISTEN_URL:
        existingValues.CODEX_APP_SERVER_LISTEN_URL || DEFAULT_LOCAL_APP_SERVER_LISTEN_URL,
      CODEX_DISCOVERY_POLL_SECONDS: existingValues.CODEX_DISCOVERY_POLL_SECONDS || "5",
      CODEX_THREAD_SOURCE_KINDS: existingValues.CODEX_THREAD_SOURCE_KINDS || "vscode,cli",
      STORE_PATH: existingValues.STORE_PATH || "./data/codex-discord-bridge.sqlite",
      LOG_LEVEL: existingValues.LOG_LEVEL || "info"
    };
    const existingBridgeConfigPathOverride =
      existingValues.BRIDGE_CONFIG_PATH?.trim() || process.env.BRIDGE_CONFIG_PATH?.trim() || "";
    if (existingBridgeConfigPathOverride) {
      envValues.BRIDGE_CONFIG_PATH = existingBridgeConfigPathOverride;
    }
    if (existingValues.CODEX_DESKTOP_IPC_PATH?.trim()) {
      envValues.CODEX_DESKTOP_IPC_PATH = existingValues.CODEX_DESKTOP_IPC_PATH.trim();
    }
    if (existingValues.CODEX_DESKTOP_LOG_ROOT?.trim()) {
      envValues.CODEX_DESKTOP_LOG_ROOT = existingValues.CODEX_DESKTOP_LOG_ROOT.trim();
    }

    await waitForStep(
      rl,
      "Discord server",
      "If you do not already have a Discord server for this bridge, create one now in Discord: click the '+' in the left sidebar, choose 'Create My Own', choose a private option such as 'For me and my friends', and name it something like 'Codex Bridge'."
    );

    await waitForStep(
      rl,
      "Developer Mode",
      "In Discord, turn on Developer Mode if it is not already enabled: User Settings -> Developer -> Developer Mode, or User Settings -> Advanced -> Developer Mode."
    );

    envValues.DISCORD_GUILD_ID = await promptStepValue(
      rl,
      "Server ID",
      "Right-click your server and copy the server ID.",
      "Discord server ID",
      envValues.DISCORD_GUILD_ID
    );

    console.log("");
    console.log(`Discord Developer Portal: ${DISCORD_DEVELOPER_PORTAL_URL}`);
    console.log("Next, you will create or open the Discord bot that the bridge uses to post updates and receive commands.");
    if (await confirm(rl, "Open the Discord Developer Portal now?", true)) {
      openExternal(DISCORD_DEVELOPER_PORTAL_URL);
    }

    await waitForStep(
      rl,
      "Discord Developer Portal",
      "If Discord shows 'What brings you to the Developer Portal?', choose 'Build a Bot', then click 'Continue to Portal'."
    );

    await waitForStep(
      rl,
      "Discord application",
      "If you land in a dashboard without an app yet, create a new application named something like 'Codex Mobile Bridge'."
    );

    envValues.DISCORD_APPLICATION_ID = await promptStepValue(
      rl,
      "General Information",
      "On 'General Information', copy the 'Application ID'.",
      "Discord application ID",
      envValues.DISCORD_APPLICATION_ID
    );

    await waitForStep(
      rl,
      "Bot page",
      "Open the 'Bot' page in the left sidebar. Click 'Add Bot' if Discord asks; if the bot already exists, continue to the next step."
    );

    await waitForStep(
      rl,
      "Installation page",
      [
        "Open the 'Installation' page in the left sidebar.",
        "Make sure server installs are enabled.",
        "For server install scopes, include both 'bot' and 'applications.commands'.",
        "For server install permissions, select exactly these:",
        "- Create Public Threads",
        "- Manage Channels",
        "- Manage Messages",
        "- Manage Threads",
        "- Pin Messages",
        "- Read Message History",
        "- Send Messages",
        "- Send Messages in Threads",
        "- View Channels",
        "Keep 'Requires OAuth2 Code Grant' off."
      ].join("\n")
    );

    envValues.DISCORD_BOT_TOKEN = await promptStepValue(
      rl,
      "Bot token",
      "Under the bot section, use 'Reset Token' or 'Copy' to get the bot token.",
      "Discord bot token",
      envValues.DISCORD_BOT_TOKEN
    );

    const inviteUrl = buildDiscordInviteUrl(envValues.DISCORD_APPLICATION_ID);
    console.log("");
    console.log("Bot invite:");
    console.log("Invite the bot to the Discord server you want to use for this bridge.");
    console.log("The invite page will ask you to choose a server, approve the requested permissions, and authorize the bot.");
    console.log("");
    console.log("Invite URL:");
    console.log(inviteUrl);

    if (await confirm(rl, "Open this invite URL now?", true)) {
      openExternal(inviteUrl);
    }

    await rl.question("Press Enter after the bot is authorized...");

    await verifyDiscordServerPermissions(rl, envValues, inviteUrl);

    envValues.DISCORD_CONTROLLER_USER_ID = await promptStepValue(
      rl,
      "Controller user ID",
      "Right-click your own profile and copy your user ID. This one user will be allowed to approve actions and send messages from Discord.",
      "Controller Discord user ID",
      envValues.DISCORD_CONTROLLER_USER_ID
    );
    const controllerUserIds = normalizeCsvIds(envValues.DISCORD_CONTROLLER_USER_ID);

    const preset = await promptChoice<BridgePreset>(
      rl,
      "Behavior preset",
      "Choose the default bridge behavior preset",
      [
        {
          value: "basic",
          label: "basic",
          description:
            "Mirroring + grouped command/file activity + approval responses, without Discord message write-back"
        },
        {
          value: "recommended",
          label: "recommended",
          description:
            "basic + `/codex send`, queue/retract, and steering write-back"
        },
        {
          value: "full",
          label: "full",
          description:
            "recommended + ungrouped command/file activity and detail buttons"
        }
      ],
      existingBridgeConfig?.preset ?? "recommended"
    );

    let bridgeConfig = createBridgeConfigFromPreset(
      preset,
      {
        allowFromDiscord:
          existingBridgeConfig?.approvals.allowFromDiscord ?? true,
        mentionApprovers:
          existingBridgeConfig?.approvals.mentionApprovers ??
          (existingBridgeConfig?.approvals.allowFromDiscord ?? true),
        allowedUserIds: controllerUserIds,
        ...(existingBridgeConfig?.approvals.approvalTtlMinutes !== undefined
          ? { approvalTtlMinutes: existingBridgeConfig.approvals.approvalTtlMinutes }
          : {})
      },
      existingBridgeConfig ? extractBridgeConfigOverrides(existingBridgeConfig) : undefined,
      bridgeConfigPath
    );

    envValues.CODEX_COMMAND = await promptStepValue(
      rl,
      "Codex command",
      "Confirm the command this machine should use to launch Codex app-server.",
      "Codex command",
      envValues.CODEX_COMMAND
    );

    await writeEnvFile(envPath, envValues);
    await writeBridgeConfigFile(bridgeConfigPath, bridgeConfig);
    console.log("");
    console.log(`Updated ${envPath}`);
    console.log(`Updated ${bridgeConfigPath}`);
    console.log(
      formatStandaloneCodexLauncherResult(
        await ensureWindowsStandaloneCodexLauncher({
          listenUrl: envValues.CODEX_APP_SERVER_LISTEN_URL
        })
      )
    );

    console.log("");
    console.log("Running diagnostics...");
    await delay(1000);
    const doctorPassed = await runLocalNodeScript(new URL("./doctor.js", import.meta.url));

    if (!doctorPassed) {
      console.log("");
      console.log("Diagnostics found issues. Fix the problems shown above, then run `npm run doctor` again.");
      return;
    }

    console.log("");
    console.log("Setup is complete.");
    console.log("- run `npm run doctor` any time you change config");
    console.log("- when you are ready, start the bridge yourself with `npm start`");
    console.log("- recommended with Codex Desktop: add this project to the app, open a chat for this project, and run `npm start` there while you work in other Codex projects");
    console.log("- after the bridge has stopped, use `/codex cleanall` from Discord or run `npm run clean` locally to remove bridge-managed Discord channels/threads and local state");
    console.log("- edit bridge.config.json any time you want to customize the behavior further");
    console.log("- see bridge.config.example.jsonc for a commented explanation of each option");
    console.log("- keep Codex Desktop and the bridge running on this machine when you want Discord mirroring/control");
    console.log("- on macOS, CODEX_DESKTOP_IPC_PATH and CODEX_DESKTOP_LOG_ROOT can override unverified Desktop discovery");
  } finally {
    rl.close();
  }
}

async function verifyDiscordServerPermissions(
  rl: Interface,
  envValues: EnvValues,
  inviteUrl: string
): Promise<void> {
  while (true) {
    console.log("");
    console.log("Checking bot permissions on this server...");
    console.log("This creates and removes a temporary category, channel, and thread to verify the bot can run the bridge.");
    const result = await checkDiscordServerAccess({
      discordBotToken: envValues.DISCORD_BOT_TOKEN,
      discordServerId: envValues.DISCORD_GUILD_ID
    });
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.label}: ${result.details}`);
    if (result.ok) {
      return;
    }

    console.log("");
    console.log("Fix the bot invite or server permissions before continuing.");
    if (await confirm(rl, "Open the bot invite URL again?", true)) {
      openExternal(inviteUrl);
    }
    if (!(await confirm(rl, "Check bot permissions again now?", true))) {
      return;
    }
  }
}

async function loadExistingEnv(envPath: string): Promise<Partial<EnvValues>> {
  try {
    await access(envPath, fsConstants.F_OK);
    return (await loadExistingEnvFile(envPath)) as Partial<EnvValues>;
  } catch {
    return {};
  }
}

export function resolveInitBridgeConfigPath(existingValues: Partial<EnvValues>): string {
  return resolveBridgeConfigPath(existingValues.BRIDGE_CONFIG_PATH || process.env.BRIDGE_CONFIG_PATH);
}

export async function loadExistingBridgeConfig(configPath: string): Promise<BridgeRuntimeConfig | null> {
  try {
    await access(configPath, fsConstants.F_OK);
  } catch {
    return null;
  }
  return loadBridgeRuntimeConfig(configPath, { validateController: false });
}

async function promptRequired(
  rl: Interface,
  label: string,
  defaultValue?: string
): Promise<string> {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    const value = answer || defaultValue || "";
    if (value) {
      return value;
    }
    console.log(`${label} is required.`);
  }
}

async function promptStepValue(
  rl: Interface,
  stepTitle: string,
  instruction: string,
  label: string,
  defaultValue?: string
): Promise<string> {
  console.log("");
  console.log(`${stepTitle}:`);
  console.log(instruction);
  return promptRequired(rl, label, defaultValue);
}

async function waitForStep(rl: Interface, stepTitle: string, instruction: string): Promise<void> {
  console.log("");
  console.log(`${stepTitle}:`);
  console.log(instruction);
  await rl.question("Press Enter when done...");
}

async function promptChoice<T extends string>(
  rl: Interface,
  stepTitle: string,
  instruction: string,
  choices: Array<{ value: T; label: string; description: string }>,
  defaultValue: T
): Promise<T> {
  console.log("");
  console.log(`${stepTitle}:`);
  console.log(instruction);
  choices.forEach((choice, index) => {
    const defaultMarker = choice.value === defaultValue ? " (default)" : "";
    console.log(`${index + 1}. ${choice.label}${defaultMarker} - ${choice.description}`);
  });

  while (true) {
    const answer = (await rl.question(`Choose 1-${choices.length} [${choices.findIndex((choice) => choice.value === defaultValue) + 1}]: `)).trim();
    if (!answer) {
      return defaultValue;
    }

    const index = Number.parseInt(answer, 10);
    if (Number.isFinite(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1]!.value;
    }

    const byLabel = choices.find((choice) => choice.value === answer || choice.label === answer);
    if (byLabel) {
      return byLabel.value;
    }

    console.log("Choose one of the listed options.");
  }
}

async function confirm(
  rl: Interface,
  question: string,
  defaultYes: boolean
): Promise<boolean> {
  return confirmPrompt(rl, question, defaultYes);
}

async function detectCodexCommand(): Promise<string | null> {
  return findCommandOnPath("codex");
}

async function writeEnvFile(envPath: string, values: EnvValues): Promise<void> {
  const lines = [
    `DISCORD_BOT_TOKEN=${values.DISCORD_BOT_TOKEN}`,
    `DISCORD_APPLICATION_ID=${values.DISCORD_APPLICATION_ID}`,
    `DISCORD_GUILD_ID=${values.DISCORD_GUILD_ID}`,
    `DISCORD_CONTROLLER_USER_ID=${values.DISCORD_CONTROLLER_USER_ID}`,
    `CODEX_COMMAND=${quoteIfNeeded(values.CODEX_COMMAND)}`,
    `CODEX_APP_SERVER_LISTEN_URL=${quoteIfNeeded(values.CODEX_APP_SERVER_LISTEN_URL)}`,
    `CODEX_DISCOVERY_POLL_SECONDS=${values.CODEX_DISCOVERY_POLL_SECONDS}`,
    `CODEX_THREAD_SOURCE_KINDS=${values.CODEX_THREAD_SOURCE_KINDS}`,
    `STORE_PATH=${quoteIfNeeded(values.STORE_PATH)}`,
    `LOG_LEVEL=${values.LOG_LEVEL}`
  ];

  if (values.BRIDGE_CONFIG_PATH?.trim()) {
    lines.push(`BRIDGE_CONFIG_PATH=${quoteIfNeeded(values.BRIDGE_CONFIG_PATH)}`);
  }
  if (values.CODEX_DESKTOP_IPC_PATH?.trim()) {
    lines.push(`CODEX_DESKTOP_IPC_PATH=${quoteIfNeeded(values.CODEX_DESKTOP_IPC_PATH)}`);
  }
  if (values.CODEX_DESKTOP_LOG_ROOT?.trim()) {
    lines.push(`CODEX_DESKTOP_LOG_ROOT=${quoteIfNeeded(values.CODEX_DESKTOP_LOG_ROOT)}`);
  }

  await writeFile(envPath, `${lines.join("\n")}\n`, "utf8");
}

async function writeBridgeConfigFile(configPath: string, config: BridgeRuntimeConfig): Promise<void> {
  await writeFile(configPath, `${renderBridgeConfigFile(config)}\n`, "utf8");
}

function normalizeCsvIds(raw: string): string[] {
  return parseCsvIdList(raw);
}

function quoteIfNeeded(value: string): string {
  return quoteEnvValueIfNeeded(value);
}

function buildDiscordInviteUrl(applicationId: string): string {
  return buildDiscordGuildInviteUrl(applicationId);
}

export function renderBridgeConfigFile(config: BridgeRuntimeConfig): string {
  const overrides = extractBridgeConfigOverrides(config);
  const outputConfig: Record<string, unknown> = {
    preset: config.preset,
    approvals: {
      allowFromDiscord: config.approvals.allowFromDiscord,
      mentionApprovers: config.approvals.mentionApprovers,
      ...(config.approvals.approvalTtlMinutes !== undefined &&
      config.approvals.approvalTtlMinutes !== DEFAULT_APPROVAL_TTL_MINUTES
        ? { approvalTtlMinutes: config.approvals.approvalTtlMinutes }
        : {})
    }
  };

  if (overrides.messageWriteBacks) {
    outputConfig.messageWriteBacks = overrides.messageWriteBacks;
  }
  if (overrides.visibility) {
    outputConfig.visibility = overrides.visibility;
  }
  if (overrides.startupBackfill) {
    outputConfig.startupBackfill = overrides.startupBackfill;
  }
  if (overrides.retention) {
    outputConfig.retention = overrides.retention;
  }
  if (overrides.ui) {
    outputConfig.ui = overrides.ui;
  }
  if (overrides.diagnostics) {
    outputConfig.diagnostics = overrides.diagnostics;
  }
  if (overrides.discovery) {
    outputConfig.discovery = overrides.discovery;
  }

  return JSON.stringify(
    outputConfig,
    null,
    2
  );
}

async function runLocalNodeScript(scriptUrl: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(scriptUrl)], {
      stdio: "inherit",
      windowsHide: true
    });

    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function openExternal(url: string): void {
  openExternalUrl(url);
}

const runningAsEntryPoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (runningAsEntryPoint) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
