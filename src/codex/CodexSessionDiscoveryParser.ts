import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { extractNestedString } from "./codexFsHelpers.js";

export interface ParsedDiscoveredSessionThread {
  threadId: string;
  source: string | null;
  originator: string | null;
  cwd: string | null;
  repoName: string | null;
  name: string | null;
  preview: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  status: "active" | "idle";
  parentThreadId: string | null;
  actorName: string | null;
  sourceSubagentOther: string | null;
}

const SESSION_FILE_THREAD_ID_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export async function parseDiscoveredSessionThread(
  filePath: string,
  fileMtimeMs: number
): Promise<ParsedDiscoveredSessionThread | null> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionMeta: {
    threadId: string | null;
    source: string | null;
    originator: string | null;
    cwd: string | null;
    createdAtMs: number | null;
    parentThreadId: string | null;
    actorName: string | null;
    sourceSubagentOther: string | null;
  } | null = null;
  let firstUserMessage: string | null = null;
  let latestPreview: string | null = null;
  let latestTimestampMs: number | null = null;
  let latestTaskStartedMs: number | null = null;
  let latestTaskCompletedMs: number | null = null;
  const expectedThreadId = extractThreadIdFromSessionFilePath(filePath)?.toLowerCase() ?? null;

  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      const timestampMs = parseTimestampMs(envelope.timestamp);
      latestTimestampMs = Math.max(latestTimestampMs ?? 0, timestampMs ?? 0) || latestTimestampMs;
      const type = typeof envelope.type === "string" ? envelope.type : null;
      const payload =
        envelope.payload && typeof envelope.payload === "object"
          ? (envelope.payload as Record<string, unknown>)
          : null;
      if (!type || !payload) {
        continue;
      }

      if (type === "session_meta") {
        const threadId = typeof payload.id === "string" ? payload.id : null;
        const normalizedThreadId = threadId?.trim().toLowerCase() ?? null;
        const matchesExpectedThreadId = Boolean(
          expectedThreadId && normalizedThreadId === expectedThreadId
        );
        if (sessionMeta && !matchesExpectedThreadId) {
          continue;
        }
        const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
        sessionMeta = {
          threadId,
          source: typeof payload.source === "string" ? payload.source : null,
          originator: typeof payload.originator === "string" ? payload.originator : null,
          cwd,
          createdAtMs: parseTimestampMs(payload.timestamp) ?? timestampMs,
          parentThreadId:
            extractNestedString(payload, [
              "source",
              "subagent",
              "thread_spawn",
              "parent_thread_id"
            ]) ??
            extractNestedString(payload, [
              "source",
              "subagent",
              "threadSpawn",
              "parentThreadId"
            ]) ??
            (typeof payload.forked_from_id === "string" ? payload.forked_from_id : null),
          actorName: (
            (typeof payload.agent_nickname === "string" && payload.agent_nickname.trim()) ||
            extractNestedString(payload, [
              "source",
              "subagent",
              "thread_spawn",
              "agent_nickname"
            ]) ||
            extractNestedString(payload, [
              "source",
              "subagent",
              "threadSpawn",
              "agentNickname"
            ])
          ) ?? null,
          sourceSubagentOther: extractNestedString(payload, [
            "source",
            "subagent",
            "other"
          ])
        };
        continue;
      }

      if (type === "response_item") {
        if (payload.type === "message" && payload.role === "user") {
          const text = normalizeDiscoveryMessageText(extractResponseMessageText(payload.content));
          if (text) {
            firstUserMessage ??= text;
            latestPreview = text;
          }
        } else if (payload.type === "message" && payload.role === "assistant" && !latestPreview) {
          latestPreview = normalizeDiscoveryMessageText(extractResponseMessageText(payload.content));
        }
        continue;
      }

      if (type === "event_msg") {
        const eventType = typeof payload.type === "string" ? payload.type : null;
        if (eventType === "user_message" && typeof payload.message === "string") {
          const message = normalizeDiscoveryMessageText(payload.message);
          if (!message) {
            continue;
          }
          firstUserMessage ??= message;
          latestPreview = message;
          continue;
        }
        if (eventType === "agent_message" && typeof payload.message === "string" && !latestPreview) {
          latestPreview = normalizeDiscoveryMessageText(payload.message);
          continue;
        }
        if (eventType === "task_started") {
          latestTaskStartedMs = Math.max(latestTaskStartedMs ?? 0, timestampMs ?? 0) || latestTaskStartedMs;
          continue;
        }
        if (eventType === "task_complete") {
          latestTaskCompletedMs = Math.max(latestTaskCompletedMs ?? 0, timestampMs ?? 0) || latestTaskCompletedMs;
        }
      }
    }
  } finally {
    lines.close();
    stream.close();
  }

  if (!sessionMeta?.threadId) {
    return null;
  }

  const repoName = sessionMeta.cwd ? path.basename(sessionMeta.cwd) : null;
  const createdAtMs = sessionMeta.createdAtMs ?? latestTimestampMs ?? fileMtimeMs;
  const updatedAtMs = latestTimestampMs ?? fileMtimeMs;
  const status =
    latestTaskStartedMs && (!latestTaskCompletedMs || latestTaskStartedMs > latestTaskCompletedMs)
      ? "active"
      : "idle";
  const preview = latestPreview ? latestPreview.trim() : null;

  const isCliSession = sessionMeta.source === "cli" || sessionMeta.originator === "codex-tui";

  return {
    threadId: sessionMeta.threadId,
    source: sessionMeta.source,
    originator: sessionMeta.originator,
    cwd: sessionMeta.cwd,
    repoName,
    name: isCliSession ? (firstUserMessage ? firstUserMessage.trim() : preview) : null,
    preview,
    createdAtMs,
    updatedAtMs,
    status,
    parentThreadId: sessionMeta.parentThreadId ?? null,
    actorName: sessionMeta.actorName ?? null,
    sourceSubagentOther: sessionMeta.sourceSubagentOther ?? null
  };
}

function extractThreadIdFromSessionFilePath(filePath: string): string | null {
  const fileName = path.basename(filePath);
  const match = fileName.match(SESSION_FILE_THREAD_ID_PATTERN);
  return match?.[1] ?? null;
}

function extractResponseMessageText(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const text = value
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
        ? String((entry as { text: string }).text)
        : ""
    )
    .join("\n")
    .trim();
  return text || null;
}

function normalizeDiscoveryMessageText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  if (isInjectedInstructionBlock(trimmed)) {
    return null;
  }

  return trimmed;
}

function isInjectedInstructionBlock(text: string): boolean {
  return (
    text.startsWith("<INSTRUCTIONS>") ||
    text.startsWith("<environment_context>") ||
    (text.includes("AGENTS.md instructions for") &&
      (text.includes("<INSTRUCTIONS>") || text.includes("<environment_context>")))
  );
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
