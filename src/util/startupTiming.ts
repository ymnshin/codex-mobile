import { performance } from "node:perf_hooks";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

export function isStartupTimingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CODEX_DEV_STARTUP_TIMING?.trim().toLowerCase() ?? "";
  return TRUTHY_VALUES.has(value);
}

export function startupTimingNow(): number {
  return performance.now();
}

export function formatStartupTimingMs(durationMs: number): string {
  if (!Number.isFinite(durationMs)) {
    return "n/a";
  }
  if (durationMs >= 100) {
    return `${durationMs.toFixed(0)}ms`;
  }
  return `${durationMs.toFixed(1)}ms`;
}

