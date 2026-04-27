import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { Interface } from "node:readline/promises";
import { parse as parseDotenv } from "dotenv";

export async function loadExistingEnvFile(envPath: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(envPath, "utf8");
    return parseDotenv(content) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function confirmPrompt(
  rl: Interface,
  question: string,
  defaultYes: boolean
): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  const answer = (await rl.question(`${question}${suffix}: `)).trim().toLowerCase();
  if (!answer) {
    return defaultYes;
  }
  return answer === "y" || answer === "yes";
}

export function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function openExternal(url: string): void {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
    return;
  }

  if (process.platform === "darwin") {
    spawn("open", [url], {
      detached: true,
      stdio: "ignore"
    }).unref();
    return;
  }

  spawn("xdg-open", [url], {
    detached: true,
    stdio: "ignore"
  }).unref();
}
