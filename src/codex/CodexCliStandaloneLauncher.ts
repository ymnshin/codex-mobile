import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { DEFAULT_LOCAL_APP_SERVER_LISTEN_URL } from "../util/codexListenUrl.js";

const MANAGED_MARKER = "codex-mobile-managed";
const HELPER_FILENAME = "codex-mobile-bridge-launcher.cjs";

const ROOT_VALUE_OPTIONS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-C",
  "--cd",
  "--add-dir"
]);

const NONINTERACTIVE_COMMANDS = new Set([
  "app",
  "app-server",
  "apply",
  "cloud",
  "completion",
  "debug",
  "exec",
  "exec-server",
  "features",
  "help",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "plugin",
  "review",
  "sandbox"
]);

export interface StandaloneCodexRemoteTarget {
  listenUrl: string;
  host: string;
  port: number;
}

export interface WindowsStandaloneCodexLauncherPaths {
  binDir: string;
  helperPath: string;
  cmdShimPath: string;
  ps1ShimPath: string;
  packageEntryPath: string;
}

export interface StandaloneCodexLauncherResult {
  status: "installed" | "updated" | "alreadyCurrent" | "skipped";
  reason: string | null;
  paths: WindowsStandaloneCodexLauncherPaths | null;
}

export function resolveStandaloneCodexRemoteTarget(
  listenUrl: string
): StandaloneCodexRemoteTarget | null {
  const trimmed = listenUrl.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "ws:") {
    return null;
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    return null;
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    return null;
  }
  if (parsed.search || parsed.hash) {
    return null;
  }

  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return null;
  }

  return {
    listenUrl: `${parsed.protocol}//${parsed.hostname}:${port}`,
    host: parsed.hostname,
    port
  };
}

export function shouldInjectStandaloneCodexRemote(args: string[]): boolean {
  if (args.some((arg) => isHelpOrVersionArgument(arg) || hasExplicitRemoteArgument(arg))) {
    return false;
  }

  const firstPositional = findFirstStandaloneCodexPositional(args);
  if (firstPositional === null) {
    return true;
  }

  return !NONINTERACTIVE_COMMANDS.has(firstPositional);
}

export function rewriteStandaloneCodexRemoteArgs(args: string[], callerCwd: string): string[] {
  const rewrittenArgs: string[] = [];
  let sawExplicitCd = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      rewrittenArgs.push(...args.slice(index));
      break;
    }

    if (arg === "-C" || arg === "--cd") {
      sawExplicitCd = true;
      rewrittenArgs.push(arg);
      if (index + 1 < args.length) {
        rewrittenArgs.push(resolveRemoteCdArgument(args[index + 1]!, callerCwd));
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--cd=")) {
      sawExplicitCd = true;
      rewrittenArgs.push(`--cd=${resolveRemoteCdArgument(arg.slice("--cd=".length), callerCwd)}`);
      continue;
    }

    rewrittenArgs.push(arg);
  }

  return sawExplicitCd ? rewrittenArgs : ["-C", callerCwd, ...rewrittenArgs];
}

export function resolveWindowsStandaloneCodexLauncherPaths(
  appDataDir: string
): WindowsStandaloneCodexLauncherPaths {
  const binDir = path.join(appDataDir, "npm");
  return {
    binDir,
    helperPath: path.join(binDir, HELPER_FILENAME),
    cmdShimPath: path.join(binDir, "codex.cmd"),
    ps1ShimPath: path.join(binDir, "codex.ps1"),
    packageEntryPath: path.join(binDir, "node_modules", "@openai", "codex", "bin", "codex.js")
  };
}

export async function ensureWindowsStandaloneCodexLauncher(options: {
  listenUrl: string;
  appDataDir?: string;
  platform?: NodeJS.Platform;
}): Promise<StandaloneCodexLauncherResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      status: "skipped",
      reason: "Standalone Codex CLI launcher integration is only managed on Windows.",
      paths: null
    };
  }

  const remoteTarget = resolveStandaloneCodexRemoteTarget(options.listenUrl);
  if (!remoteTarget) {
    return {
      status: "skipped",
      reason:
        "Standalone Codex CLI approvals require CODEX_APP_SERVER_LISTEN_URL to be a local ws://127.0.0.1:<port> listener.",
      paths: null
    };
  }

  const appDataDir = options.appDataDir?.trim() || process.env.APPDATA?.trim() || "";
  if (!appDataDir) {
    return {
      status: "skipped",
      reason: "APPDATA is not set, so the global Codex npm shims cannot be reconciled.",
      paths: null
    };
  }

  const paths = resolveWindowsStandaloneCodexLauncherPaths(appDataDir);
  try {
    await access(paths.packageEntryPath, fsConstants.F_OK);
  } catch {
    return {
      status: "skipped",
      reason: `Could not find the global @openai/codex entry at ${paths.packageEntryPath}.`,
      paths
    };
  }

  await mkdir(paths.binDir, { recursive: true });

  const nextFiles = [
    {
      path: paths.helperPath,
      content: renderWindowsStandaloneCodexLauncherHelper(remoteTarget)
    },
    {
      path: paths.cmdShimPath,
      content: renderWindowsStandaloneCodexCmdShim()
    },
    {
      path: paths.ps1ShimPath,
      content: renderWindowsStandaloneCodexPowerShellShim()
    }
  ];

  let changedExisting = false;
  let wroteNew = false;
  for (const file of nextFiles) {
    const existing = await readTextFileOrNull(file.path);
    if (existing === file.content) {
      continue;
    }
    if (existing === null) {
      wroteNew = true;
    } else {
      changedExisting = true;
    }
    await writeFile(file.path, file.content, "utf8");
  }

  return {
    status: changedExisting ? "updated" : wroteNew ? "installed" : "alreadyCurrent",
    reason: null,
    paths
  };
}

export function formatStandaloneCodexLauncherResult(result: StandaloneCodexLauncherResult): string {
  switch (result.status) {
    case "installed":
      return "Installed the Windows standalone Codex launcher integration for remote CLI approvals.";
    case "updated":
      return "Updated the Windows standalone Codex launcher integration for remote CLI approvals.";
    case "alreadyCurrent":
      return "Windows standalone Codex launcher integration is already current.";
    case "skipped":
    default:
      return result.reason ?? "Skipped Windows standalone Codex launcher integration.";
  }
}

function renderWindowsStandaloneCodexLauncherHelper(target: StandaloneCodexRemoteTarget): string {
  return `#!/usr/bin/env node
"use strict";
// ${MANAGED_MARKER}
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REMOTE_LISTEN_URL = ${JSON.stringify(target.listenUrl)};
const REMOTE_HOST = ${JSON.stringify(target.host)};
const REMOTE_PORT = ${target.port};
const HELPER_MARKER = ${JSON.stringify(MANAGED_MARKER)};
const ROOT_VALUE_OPTIONS = new Set(${JSON.stringify([...ROOT_VALUE_OPTIONS])});
const NONINTERACTIVE_COMMANDS = new Set(${JSON.stringify([...NONINTERACTIVE_COMMANDS])});
const TARGET_SCRIPT_PATH = path.join(__dirname, "node_modules", "@openai", "codex", "bin", "codex.js");

function hasExplicitRemoteArgument(arg) {
  return (
    arg === "--remote" ||
    arg.startsWith("--remote=") ||
    arg === "--remote-auth-token-env" ||
    arg.startsWith("--remote-auth-token-env=")
  );
}

function isHelpOrVersionArgument(arg) {
  return arg === "-h" || arg === "--help" || arg === "-V" || arg === "--version";
}

function findFirstPositional(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      return null;
    }
    if (arg.startsWith("--")) {
      const separatorIndex = arg.indexOf("=");
      const flag = separatorIndex >= 0 ? arg.slice(0, separatorIndex) : arg;
      if (ROOT_VALUE_OPTIONS.has(flag) && separatorIndex < 0) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (ROOT_VALUE_OPTIONS.has(arg)) {
        index += 1;
      }
      continue;
    }
    return arg;
  }
  return null;
}

function shouldInjectStandaloneRemote(args) {
  if (process.env.CODEX_MOBILE_BYPASS_REMOTE === "1") {
    return false;
  }
  if (args.some((arg) => isHelpOrVersionArgument(arg) || hasExplicitRemoteArgument(arg))) {
    return false;
  }
  const firstPositional = findFirstPositional(args);
  if (firstPositional === null) {
    return true;
  }
  return !NONINTERACTIVE_COMMANDS.has(firstPositional);
}

function resolveRemoteCdArgument(value, callerCwd) {
  return path.isAbsolute(value) ? value : path.resolve(callerCwd, value);
}

function rewriteRemoteArgs(args, callerCwd) {
  const rewrittenArgs = [];
  let sawExplicitCd = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      rewrittenArgs.push(...args.slice(index));
      break;
    }
    if (arg === "-C" || arg === "--cd") {
      sawExplicitCd = true;
      rewrittenArgs.push(arg);
      if (index + 1 < args.length) {
        rewrittenArgs.push(resolveRemoteCdArgument(args[index + 1], callerCwd));
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--cd=")) {
      sawExplicitCd = true;
      rewrittenArgs.push(\`--cd=\${resolveRemoteCdArgument(arg.slice("--cd=".length), callerCwd)}\`);
      continue;
    }
    rewrittenArgs.push(arg);
  }
  return sawExplicitCd ? rewrittenArgs : ["-C", callerCwd, ...rewrittenArgs];
}

function probeBridge(timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: REMOTE_HOST, port: REMOTE_PORT });
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      clearTimeout(timeoutId);
      resolve(value);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    const timeoutId = setTimeout(() => finish(false), timeoutMs);
    timeoutId.unref();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const injectRemote = shouldInjectStandaloneRemote(args) && (await probeBridge());
  const finalArgs = injectRemote
    ? ["--remote", REMOTE_LISTEN_URL, ...rewriteRemoteArgs(args, process.cwd())]
    : args;
  const child = spawn(process.execPath, [TARGET_SCRIPT_PATH, ...finalArgs], {
    stdio: "inherit",
    windowsHide: false,
    env: { ...process.env, CODEX_MOBILE_MANAGED_LAUNCHER: HELPER_MARKER }
  });

  child.once("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;
}

function renderWindowsStandaloneCodexCmdShim(): string {
  return `@ECHO OFF
REM ${MANAGED_MARKER}
SETLOCAL
node "%~dp0${HELPER_FILENAME}" %*
EXIT /B %ERRORLEVEL%
`;
}

function renderWindowsStandaloneCodexPowerShellShim(): string {
  return `#!/usr/bin/env pwsh
# ${MANAGED_MARKER}
$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $scriptDir "${HELPER_FILENAME}") @args
exit $LASTEXITCODE
`;
}

async function readTextFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export { DEFAULT_LOCAL_APP_SERVER_LISTEN_URL };

function resolveRemoteCdArgument(value: string, callerCwd: string): string {
  return path.isAbsolute(value) ? value : path.resolve(callerCwd, value);
}

function hasExplicitRemoteArgument(arg: string): boolean {
  return (
    arg === "--remote" ||
    arg.startsWith("--remote=") ||
    arg === "--remote-auth-token-env" ||
    arg.startsWith("--remote-auth-token-env=")
  );
}

function isHelpOrVersionArgument(arg: string): boolean {
  return arg === "-h" || arg === "--help" || arg === "-V" || arg === "--version";
}

function findFirstStandaloneCodexPositional(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      return null;
    }
    if (arg.startsWith("--")) {
      const separatorIndex = arg.indexOf("=");
      const flag = separatorIndex >= 0 ? arg.slice(0, separatorIndex) : arg;
      if (ROOT_VALUE_OPTIONS.has(flag) && separatorIndex < 0) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (ROOT_VALUE_OPTIONS.has(arg)) {
        index += 1;
      }
      continue;
    }
    return arg;
  }
  return null;
}
