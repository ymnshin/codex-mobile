import type {
  CodexThreadSummary,
  ThreadBridgeRecord,
  ThreadRuntimeState
} from "../domain.js";
import {
  formatDiscordChannelName,
  projectKeyFromMetadata,
  shortThreadId
} from "../util/formatting.js";
import { redactSensitiveText, truncateForDiscord } from "../util/redaction.js";

const TURN_ABORTED_ENVELOPE_PATTERN = /^<turn_aborted>\s*[\s\S]*?\s*<\/turn_aborted>$/i;
const CODEX_AUTO_REVIEW_SOURCE_SUBAGENT_OTHER = "guardian";
const CODEX_AUTO_REVIEW_THREAD_PREFIX =
  "the following is the codex agent history whose request action you are assessing";

export interface ResolvedThreadMetadataShape {
  cwd: string | null;
  repoName: string | null;
  threadName?: string | null;
  sourceSubagentOther?: string | null;
  originator?: string | null;
  source?: string | null;
}

export interface ThreadNamingCandidate {
  summary: CodexThreadSummary;
  source: "app-server" | "cli-session";
  resolvedMetadata?: ResolvedThreadMetadataShape | null;
}

export function buildStartupDeduplicationKey(
  thread: CodexThreadSummary,
  metadata: ResolvedThreadMetadataShape
): string {
  const projectKey = projectKeyFromMetadata(metadata.cwd, metadata.repoName);
  const fallback = `thread-${shortThreadId(thread.id)}`;
  const preferredName =
    pickPreferredThreadName(metadata.threadName, thread.name, thread.preview) ?? fallback;
  const channelName = formatDiscordChannelName(
    sanitizeThreadNameForDiscord(preferredName),
    fallback
  );
  return `${projectKey}::${channelName}`;
}

export function sanitizeThreadNameForDiscord(rawName: string): string {
  return truncateForDiscord(redactSensitiveText(rawName.trim()), 90);
}

function normalizeThreadNameCandidate(rawName: string | null | undefined): string | null {
  if (typeof rawName !== "string") {
    return null;
  }

  const trimmed = rawName.trim();
  if (!trimmed) {
    return null;
  }

  if (TURN_ABORTED_ENVELOPE_PATTERN.test(trimmed)) {
    return null;
  }

  const normalized = trimmed
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "aborted by user") {
    return null;
  }

  if (
    normalized.startsWith("the user interrupted the previous turn on purpose.") ||
    (normalized.startsWith("turn aborted") && normalized.includes("the user interrupted"))
  ) {
    return null;
  }

  return trimmed;
}

export function pickPreferredThreadName(...rawNames: Array<string | null | undefined>): string | null {
  for (const rawName of rawNames) {
    const normalized = normalizeThreadNameCandidate(rawName);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeSyntheticThreadText(rawText: string | null | undefined): string | null {
  if (typeof rawText !== "string") {
    return null;
  }

  const normalized = rawText
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalized || null;
}

export function isCodexAutoReviewThreadText(rawText: string | null | undefined): boolean {
  const normalized = normalizeSyntheticThreadText(rawText);
  if (!normalized) {
    return false;
  }

  return normalized.startsWith(CODEX_AUTO_REVIEW_THREAD_PREFIX);
}

export function isCodexAutoReviewThreadSource(rawSource: string | null | undefined): boolean {
  return rawSource?.trim().toLowerCase() === CODEX_AUTO_REVIEW_SOURCE_SUBAGENT_OTHER;
}

export function isCodexAutoReviewThread(
  summary: Pick<CodexThreadSummary, "name" | "preview">,
  metadata: {
    threadName?: string | null;
    sourceSubagentOther?: string | null;
  } | null | undefined
): boolean {
  if (isCodexAutoReviewThreadSource(metadata?.sourceSubagentOther)) {
    return true;
  }

  return [
    metadata?.threadName,
    summary.name,
    summary.preview
  ].some((value) => isCodexAutoReviewThreadText(value));
}

export function resolveAuthoritativeThreadName(
  summary: CodexThreadSummary,
  metadata: { threadName?: string | null },
  sourceKind: "app-server" | "cli-session"
): string | null {
  if (sourceKind === "cli-session") {
    return null;
  }

  const metadataName = pickPreferredThreadName(metadata.threadName);
  if (metadataName) {
    return metadataName;
  }

  return pickPreferredThreadName(summary.name);
}

export function resolveProgressThreadName(
  candidate: ThreadNamingCandidate,
  existing: ThreadBridgeRecord | null,
  current: ThreadRuntimeState | null,
  cachedMetadata: ResolvedThreadMetadataShape | null
): string | null {
  const effectiveSourceKind = candidate.source;
  const metadata = candidate.resolvedMetadata ?? cachedMetadata ?? null;
  const authoritativeName = metadata
    ? resolveAuthoritativeThreadName(candidate.summary, metadata, effectiveSourceKind)
    : null;
  const rawName = pickPreferredThreadName(
    authoritativeName,
    current?.name,
    existing?.threadName,
    candidate.summary.name,
    candidate.summary.preview
  );
  if (!rawName) {
    return null;
  }
  return sanitizeThreadNameForDiscord(rawName);
}
