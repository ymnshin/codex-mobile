/** Only bounded, non-sensitive categories may cross the queue/status boundary. */
export type QueuePauseReason = "auth" | "usage" | "connection" | "desktop" | "uncertain";
export interface WriteBackAvailability {
  ready: boolean;
  reason?: QueuePauseReason;
  retryAt?: number;
}
export interface QueueRecoveryState {
  reason: QueuePauseReason | null;
  lastFailure: QueuePauseReason | null;
  nextRetryAt: number;
  failures: number;
  lastNotifiedAt: number;
}
export const EMPTY_QUEUE_RECOVERY: QueueRecoveryState = {
  reason: null, lastFailure: null, nextRetryAt: 0, failures: 0, lastNotifiedAt: 0
};

/** An explicit rejection, unlike a disconnected/timeout RPC, did not start a turn. */
export class WriteBackNotDispatchedError extends Error {
  constructor(public readonly reason: Exclude<QueuePauseReason, "uncertain">) {
    super(`Codex write-back unavailable: ${reason}`);
  }
}

export function classifyCodexRejection(error: unknown): "auth" | "usage" | null {
  if (!error || typeof error !== "object") return null;
  const data = error as Record<string, unknown>;
  const info = data.codexErrorInfo ?? (data.data as Record<string, unknown> | undefined)?.codexErrorInfo;
  const name = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : null;
  if (name?.toLowerCase() === "unauthorized") return "auth";
  if (name?.toLowerCase() === "usagelimitexceeded") return "usage";
  return null;
}

/** Never treat an unavailable/null rate window as zero usage. API keys/providers may have no Codex quota. */
export function evaluateAvailability(account: unknown, limits: unknown, now = Date.now()): WriteBackAvailability {
  const auth = account as { account?: { type?: string } | null; requiresOpenaiAuth?: boolean } | null;
  if (!auth || typeof auth.requiresOpenaiAuth !== "boolean") return { ready: false, reason: "connection" };
  if (auth.requiresOpenaiAuth && !auth.account) return { ready: false, reason: "auth" };
  if (!auth.requiresOpenaiAuth || auth.account?.type === "apiKey") return { ready: true };
  const response = limits as { rateLimits?: any; rateLimitsByLimitId?: Record<string, any> } | null;
  const quota = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits;
  if (!quota || (quota.limitId && quota.limitId !== "codex")) return { ready: false, reason: "connection" };
  let checked = false;
  for (const window of [quota.primary, quota.secondary]) {
    if (!window || typeof window.usedPercent !== "number") continue;
    checked = true;
    if (window.usedPercent >= 100) {
      const reset = typeof window.resetsAt === "number" ? window.resetsAt * 1000 : now + 60_000;
      return { ready: false, reason: "usage", retryAt: Math.max(now + 5_000, reset) };
    }
  }
  if (quota.rateLimitReachedType) return { ready: false, reason: "usage", retryAt: now + 60_000 };
  return checked ? { ready: true } : { ready: false, reason: "connection" };
}

export function queueRetryDelay(failures: number, random = Math.random): number {
  return Math.round(Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.max(0, failures - 1))) * (0.8 + random() * 0.4));
}
