import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { parseCommandString } from "./util/command.js";

const WINDOWS_DESKTOP_IPC_PATH = "\\\\.\\pipe\\codex-ipc";

export interface ResolvedCommandSpawn {
  command: string;
  args: string[];
  shell: boolean;
  windowsHide?: boolean;
}

export interface DesktopIpcPathResolution {
  path: string | null;
  source: "override" | "windows-default" | "unresolved";
  reason: string | null;
}

export interface DesktopLogPathResolution {
  roots: string[];
  directories: string[];
  source: "override" | "windows-default" | "mac-default" | "unresolved";
  reason: string | null;
}

export interface PlatformOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function isWindowsPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function isMacPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

export function resolveCodexHomePath(
  explicitPath?: string | null,
  homeDir = homedir()
): string {
  const trimmed = explicitPath?.trim();
  return trimmed ? path.resolve(trimmed) : path.join(homeDir, ".codex");
}

export function resolveCommandSpawn(
  commandLine: string,
  extraArgs: string[] = [],
  options: { platform?: NodeJS.Platform; windowsHide?: boolean } = {}
): ResolvedCommandSpawn {
  const platform = options.platform ?? process.platform;
  const windowsHide = isWindowsPlatform(platform) ? (options.windowsHide ?? true) : undefined;

  if (isWindowsPlatform(platform)) {
    const quotedArgs = extraArgs.map(quoteCommandArgument).join(" ");
    const command = `${commandLine} ${quotedArgs}`.trim();
    return {
      command,
      args: [],
      shell: true,
      ...(windowsHide === undefined ? {} : { windowsHide })
    };
  }

  const { command, args } = parseCommandString(commandLine);
  return {
    command,
    args: [...args, ...extraArgs],
    shell: false,
    ...(windowsHide === undefined ? {} : { windowsHide })
  };
}

export async function findCommandOnPath(
  commandName: string,
  options: { platform?: NodeJS.Platform } = {}
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const locator = isWindowsPlatform(platform) ? "where" : "which";

  return new Promise((resolve) => {
    const child = spawn(locator, [commandName], {
      stdio: ["ignore", "pipe", "ignore"],
      ...(isWindowsPlatform(platform) ? { windowsHide: true } : {})
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      const firstLine = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      resolve(firstLine ?? null);
    });
  });
}

export function normalizeLocalPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }

  const withoutScheme = trimFileUrlPrefix(trimmed);
  const slashNormalized = withoutScheme.replace(/\\/g, "/");
  return slashNormalized.replace(/^\/([A-Za-z]:\/)/, "$1");
}

export function isAbsoluteLocalPath(input: string): boolean {
  const normalized = normalizeLocalPath(input);
  return isWindowsDrivePath(normalized) || isUncPath(normalized) || isPosixAbsolutePath(normalized);
}

export function basenameFromLocalPath(input: string): string {
  const normalized = normalizeLocalPath(input);
  return path.posix.basename(normalized) || normalized;
}

export function normalizePathForComparison(input: string): string {
  const normalized = normalizeLocalPath(input);
  if (isWindowsDrivePath(normalized) || isUncPath(normalized)) {
    return normalized.toLowerCase();
  }
  return normalized;
}

export function resolveDesktopIpcPath(
  options: PlatformOptions & { overridePath?: string | null } = {}
): DesktopIpcPathResolution {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const override = options.overridePath?.trim() || env.CODEX_DESKTOP_IPC_PATH?.trim() || "";

  if (override) {
    return {
      path: override,
      source: "override",
      reason: null
    };
  }

  if (isWindowsPlatform(platform)) {
    return {
      path: WINDOWS_DESKTOP_IPC_PATH,
      source: "windows-default",
      reason: null
    };
  }

  if (isMacPlatform(platform)) {
    return {
      path: null,
      source: "unresolved",
      reason:
        "Codex Desktop IPC path is not yet verified on macOS. Set CODEX_DESKTOP_IPC_PATH to try Desktop approvals on this machine."
    };
  }

  return {
    path: null,
    source: "unresolved",
    reason: "Codex Desktop IPC is only configured on Windows today."
  };
}

export function resolveDesktopLogPaths(
  date = new Date(),
  options: PlatformOptions & { overrideRoot?: string | null } = {}
): DesktopLogPathResolution {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const pathModule = getPlatformPathModule(platform);
  const override = options.overrideRoot?.trim() || env.CODEX_DESKTOP_LOG_ROOT?.trim() || "";

  const roots = override
    ? [resolveFilesystemPath(override, platform)]
    : isWindowsPlatform(platform)
      ? [
          pathModule.join(
            env.LOCALAPPDATA?.trim() || pathModule.join(homeDir, "AppData", "Local"),
            "Codex",
            "Logs"
          )
        ]
      : isMacPlatform(platform)
        ? [
            pathModule.join(homeDir, "Library", "Logs", "Codex"),
            pathModule.join(homeDir, "Library", "Application Support", "Codex", "Logs")
          ]
        : [];

  const dateParts = [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ];

  return {
    roots,
    directories: roots.map((root) => pathModule.join(root, ...dateParts)),
    source: override
      ? "override"
      : isWindowsPlatform(platform)
        ? "windows-default"
        : isMacPlatform(platform)
          ? "mac-default"
          : "unresolved",
    reason:
      roots.length > 0
        ? null
        : isMacPlatform(platform)
          ? "Codex Desktop log discovery is best-effort on macOS. Set CODEX_DESKTOP_LOG_ROOT if inspect:desktop cannot find your Codex Desktop logs."
          : "Codex Desktop log discovery is only configured on Windows today."
  };
}

function quoteCommandArgument(value: string): string {
  if (!value || /[\s"]/u.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

function trimFileUrlPrefix(input: string): string {
  if (!/^file:\/\//iu.test(input)) {
    return input;
  }

  try {
    const url = new URL(input);
    const pathname = decodeURIComponent(url.pathname);
    return url.host ? `//${url.host}${pathname}` : pathname;
  } catch {
    return input.replace(/^file:\/\//iu, "");
  }
}

function isWindowsDrivePath(input: string): boolean {
  return /^[A-Za-z]:\//.test(input);
}

function isUncPath(input: string): boolean {
  return /^\/\/[^/]+\/[^/]+/.test(input);
}

function isPosixAbsolutePath(input: string): boolean {
  return input.startsWith("/") && !/^\/[A-Za-z]:\//.test(input);
}

function getPlatformPathModule(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return isWindowsPlatform(platform) ? path.win32 : path.posix;
}

function resolveFilesystemPath(candidatePath: string, platform = process.platform): string {
  const pathModule = getPlatformPathModule(platform);
  return pathModule.isAbsolute(candidatePath) ? candidatePath : pathModule.resolve(candidatePath);
}
