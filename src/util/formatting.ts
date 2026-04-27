import path from "node:path";
import type { ApprovalCardView, CodexThreadStatus, DiscordBridgeKind, StatusCardView } from "../domain.js";
import { findNextToolInputQuestionIndex } from "./approvalDecisions.js";
import { escapeDiscordInlineCode, truncateForDiscord } from "./redaction.js";

const DISCORD_NAME_FALLBACK = "codex";

export function shortThreadId(threadId: string): string {
  return threadId.slice(0, 8);
}

export function statusLabel(status: CodexThreadStatus): string {
  if (status.type === "active" && status.activeFlags?.includes("waitingOnApproval")) {
    return "Waiting on approval";
  }
  if (status.type === "active") {
    return "Running";
  }
  if (status.type === "idle") {
    return "Idle";
  }
  if (status.type === "systemError") {
    return "System error";
  }
  return "Stored";
}

export function attentionLabel(status: CodexThreadStatus): string {
  if (status.type === "active" && status.activeFlags?.includes("waitingOnApproval")) {
    return "Needs approval";
  }
  if (status.type === "systemError") {
    return "Needs review";
  }
  if (status.type === "active") {
    return "Monitoring";
  }
  return "None";
}

export function repoNameFromCwd(cwd: string | null): string | null {
  if (!cwd) {
    return null;
  }

  return path.basename(cwd);
}

export function projectNameFromMetadata(cwd: string | null, repoName: string | null): string {
  return repoName ?? repoNameFromCwd(cwd) ?? "No Workspace";
}

export function projectKeyFromMetadata(cwd: string | null, repoName: string | null): string {
  if (cwd) {
    return cwd.trim().toLowerCase();
  }

  if (repoName) {
    return `repo:${repoName.trim().toLowerCase()}`;
  }

  return "no-workspace";
}

export function kindLabel(kind: DiscordBridgeKind): string {
  return kind === "subagent" ? "Sub-agent" : "Conversation";
}

function approvalKindLabel(kind: ApprovalCardView["kind"]): string {
  return kind === "commandExecution"
    ? "Command execution"
    : kind === "fileChange"
      ? "File change"
      : kind === "toolUserInput"
        ? "Codex question"
        : kind === "permissions"
          ? "Permission"
          : "MCP approval";
}

export function renderStatusCard(view: StatusCardView): string {
  const lines = [
    `**${truncateForDiscord(view.title, 100)}**`,
    `Thread: \`${view.shortThreadId}\``,
    `Project: ${truncateForDiscord(view.projectLabel, 100)}`,
    `Last activity: ${view.lastActivityAt ? `<t:${Math.floor(view.lastActivityAt / 1000)}:R>` : "Unknown"}`
  ];

  return lines.join("\n");
}

export function renderApprovalCard(
  view: ApprovalCardView,
  resolutionText?: string | null,
  options: { includeMention?: boolean } = {}
): string {
  const isToolInputCard = view.kind === "toolUserInput" && (view.toolInput?.questions.length ?? 0) > 0;
  const resolvedStatusText = resolutionText?.trim() || null;
  const statusText = resolvedStatusText
    ? resolvedStatusText
    : isToolInputCard && view.actionsEnabled
      ? "Waiting for your answer"
      : view.actionsEnabled
        ? "Waiting for a decision"
      : view.sourceKind === "cli-session"
        ? isToolInputCard
          ? "Answer this in Codex CLI"
          : "Resolve this in Codex CLI"
        : isToolInputCard
          ? "Answer this in Codex Desktop"
          : "Resolve this in Codex Desktop";
  const requestedTime = formatApprovalTime(view.createdAt);
  const actorLabel = truncateForDiscord(view.actorLabel?.trim() || "Codex", 80);
  const lines = [
    `\u{1F6A6} **${actorLabel}**`,
    requestedTime,
    `Status: ${statusText}`,
    `Type: ${approvalKindLabel(view.kind)}`,
    `Preview: \`${escapeDiscordInlineCode(truncateForDiscord(view.sanitizedPreview, 180))}\``
  ];
  if (isToolInputCard) {
    lines.push(...buildToolInputQuestionLines(view, { currentOnly: !resolvedStatusText && view.actionsEnabled }));
  }
  if (!resolvedStatusText) {
    lines.splice(4, 0, `Expires: <t:${Math.floor(view.expiresAt.getTime() / 1000)}:R>`);
  }

  if (options.includeMention && view.mentionText) {
    lines.unshift(view.mentionText);
  }

  lines.push(...buildApprovalContextLines(view, { cwdMaxLength: 180, reasonMaxLength: 300 }));

  return lines.join("\n");
}

function buildToolInputQuestionLines(
  view: ApprovalCardView,
  options: { currentOnly: boolean }
): string[] {
  const toolInput = view.toolInput;
  if (!toolInput) {
    return [];
  }
  const lines: string[] = [];
  const questions = options.currentOnly
    ? toolInput.questions
        .map((question, index) => ({ question, index }))
        .filter(({ index }) => index === findNextToolInputQuestionIndex(toolInput))
    : toolInput.questions.map((question, index) => ({ question, index }));
  const answeredCount = toolInput.questions.filter((question) => {
    const answer = toolInput.selectedAnswers[question.id];
    return typeof answer === "string" && answer.trim().length > 0;
  }).length;

  if (options.currentOnly && toolInput.questions.length > 1) {
    lines.push(`Answered: ${answeredCount} of ${toolInput.questions.length}`);
  }

  for (const { question, index } of questions) {
    const selected = toolInput.selectedAnswers[question.id];
    const prefix = toolInput.questions.length > 1 ? `Question ${index + 1} of ${toolInput.questions.length}` : "Question";
    lines.push(`${prefix}: ${truncateForDiscord(question.question, 240)}`);
    if (selected) {
      lines.push(`Answer: ${truncateForDiscord(selected, 180)}`);
    }
  }
  return lines;
}

export function renderApprovalDetails(view: ApprovalCardView): string {
  const lines = [
    `Thread: \`${view.threadId}\``,
    `Type: ${view.kind}`,
    `Requested: ${view.createdAt.toISOString()}`,
    `Expires: ${view.expiresAt.toISOString()}`
  ];
  lines.push(...buildApprovalContextLines(view, { reasonMaxLength: 600 }));

  lines.push("", truncateForDiscord(view.details, 1800));

  return lines.join("\n");
}

function buildApprovalContextLines(
  view: ApprovalCardView,
  options: { cwdMaxLength?: number; reasonMaxLength: number }
): string[] {
  const lines: string[] = [];
  if (view.cwd) {
    lines.push(
      `CWD: \`${escapeDiscordInlineCode(
        typeof options.cwdMaxLength === "number" ? truncateForDiscord(view.cwd, options.cwdMaxLength) : view.cwd
      )}\``
    );
  }
  if (view.reason) {
    lines.push(`Reason: ${truncateForDiscord(view.reason, options.reasonMaxLength)}`);
  }
  return lines;
}

function formatApprovalTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `[${hours}:${minutes}:${seconds}]`;
}

export function formatDiscordCategoryName(name: string): string {
  return truncateForDiscord(name.trim() || "Codex", 100);
}

export function formatDiscordChannelName(name: string, fallback: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return truncateForDiscord(normalized || fallback || DISCORD_NAME_FALLBACK, 100);
}

export function formatDiscordThreadName(name: string, fallback: string): string {
  const normalized = name.trim() || fallback || "Codex sub-agent";
  return truncateForDiscord(normalized, 100);
}
