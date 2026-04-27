import { basenameFromLocalPath, isAbsoluteLocalPath } from "../platform.js";
import { shortThreadId } from "../util/formatting.js";

export interface GroupedDiscordMessageEntry {
  itemId: string;
  sortCursor: string | null;
  content: string;
  detail: string | null;
  detailToken: string | null;
  detailButtonLabel: string | null;
  detailExpiresAt: string | null;
  showDetailButton: boolean;
  devDetail: string | null;
  devDetailToken: string | null;
  devDetailButtonLabel: string | null;
  devDetailExpiresAt: string | null;
  showDevDetailButton: boolean;
}

export function renderGroupedMessage(
  prefix: string,
  entries: GroupedDiscordMessageEntry[]
): string {
  const useNumbering = entries.length > 1;
  const lines = entries.map((entry, index) =>
    useNumbering ? `${index + 1}. ${entry.content}` : entry.content
  );
  return `${prefix}\n${lines.join("\n\n")}`.trim();
}

export function sortGroupedEntries(
  entries: GroupedDiscordMessageEntry[],
  compareItemCursor: (left: string, right: string) => number
): GroupedDiscordMessageEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftCursor = left.entry.sortCursor;
      const rightCursor = right.entry.sortCursor;
      if (leftCursor && rightCursor && leftCursor !== rightCursor) {
        return compareItemCursor(leftCursor, rightCursor);
      }
      if (leftCursor && !rightCursor) {
        return -1;
      }
      if (!leftCursor && rightCursor) {
        return 1;
      }
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}

export function formatMirroredTimestamp(
  timestampMs: number | null | undefined,
  approximate = false
): string {
  if (timestampMs === null || timestampMs === undefined) {
    return "";
  }
  const date = new Date(timestampMs);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return approximate ? `[>${hours}:${minutes}:${seconds}]` : `[${hours}:${minutes}:${seconds}]`;
}

export function formatMirroredNarrativeText(text: string): string {
  if (!text) {
    return text;
  }

  let rendered = stripNarrativeImagePlaceholders(text);

  rendered = rendered.replace(
    /\[[^\]]+\]\((file:\/\/[^\s)]+|\/?[A-Za-z]:[\\/][^)]+|\\\\[^\s)]+|\/[^/\s)]+\/[^\s)]+)\)/giu,
    (match, rawPath: string) => (isAbsoluteLocalPath(rawPath) ? renderItalicFileName(rawPath) : match)
  );

  rendered = rendered.replace(
    /(^|[\s(])(file:\/\/[^\s)]+|\/?[A-Za-z]:[\\/][^\s)]+|\\\\[^\s)]+|\/[^/\s)]+\/[^\s)]+)/giu,
    (match, prefix: string, rawPath: string) =>
      isAbsoluteLocalPath(rawPath) ? `${prefix}${renderItalicFileName(rawPath)}` : match
  );

  return rendered;
}

export function stripNarrativeImagePlaceholders(text: string): string {
  return text
    .replace(/<image>\s*\[image\]\s*<\/image>/gi, "")
    .replace(/^\s*<image>\s*$/gim, "")
    .replace(/^\s*<\/image>\s*$/gim, "")
    .replace(/^\s*\[image\]\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderItalicFileName(rawPath: string): string {
  const basename = basenameFromLocalPath(rawPath.trim()) || rawPath.trim();
  const escaped = basename.replace(/\*/g, "\\*").replace(/_/g, "\\_");
  return `*${escaped}*`;
}

export function normalizeSubagentThreadName(
  candidateName: string | null | undefined,
  threadId: string
): string {
  const fallback = `Sub-agent ${shortThreadId(threadId)}`;
  const trimmed = typeof candidateName === "string" ? candidateName.trim() : "";
  if (!trimmed) {
    return fallback;
  }
  const lower = trimmed.toLowerCase();
  const pathCandidate = trimmed.replace(/^["']/, "");
  const looksLikeCommandPreview =
    trimmed.length > 120 ||
    isAbsoluteLocalPath(pathCandidate) ||
    lower.includes(" -command ") ||
    lower.includes("powershell") ||
    lower.includes("cmd.exe") ||
    lower.includes("bash -") ||
    lower.includes("zsh -") ||
    lower.includes("allow the ");
  if (looksLikeCommandPreview) {
    return fallback;
  }
  return trimmed;
}
