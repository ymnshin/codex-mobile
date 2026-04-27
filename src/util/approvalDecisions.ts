import type { ToolUserInputState } from "../domain.js";
import { truncateForDiscord } from "./redaction.js";

export const DISCORD_BUTTON_LABEL_MAX_LENGTH = 80;
export const DISCORD_BUTTON_CUSTOM_ID_MAX_LENGTH = 100;
const DISCORD_MAX_MESSAGE_BUTTONS = 25;
const APPROVAL_DETAILS_BUTTON_COUNT = 1;
const APPROVAL_FEEDBACK_BUTTON_COUNT = 1;
export const TELL_CODEX_DIFFERENTLY_LABEL = "No, and tell Codex what to do differently";
export const ACCEPT_PROPOSED_PLAN_LABEL = "Accept plan";

export function buildApprovalDecisionCustomId(token: string, decision: string): string {
  return `codex:decision:${token}:${decision}`;
}

export function buildToolInputOptionCustomId(token: string, questionIndex: number, optionIndex: number): string {
  return `codex:input:${token}:${questionIndex}:${optionIndex}`;
}

export function buildToolInputOtherCustomId(token: string, questionIndex: number): string {
  return `codex:input-other:${token}:${questionIndex}`;
}

export function buildToolInputOtherSubmitCustomId(token: string, questionIndex: number): string {
  return `codex:input-other-submit:${token}:${questionIndex}`;
}

export function buildProposedPlanActionCustomId(
  token: string,
  action: "accept" | "feedback"
): string {
  return `codex:plan:${token}:${action}`;
}

export function buildProposedPlanFeedbackSubmitCustomId(token: string): string {
  return `codex:plan-feedback-submit:${token}`;
}

export function formatToolInputOptionLabel(label: string, selected: boolean): string {
  const prefix = selected ? "Selected: " : "";
  return truncateForDiscord(`${prefix}${label.trim() || "Option"}`, DISCORD_BUTTON_LABEL_MAX_LENGTH);
}

export function findNextToolInputQuestionIndex(toolInput: ToolUserInputState): number {
  const unansweredIndex = toolInput.questions.findIndex((question) => {
    const answer = toolInput.selectedAnswers[question.id];
    return typeof answer !== "string" || answer.trim().length === 0;
  });
  if (unansweredIndex >= 0) {
    return unansweredIndex;
  }
  return Math.max(0, toolInput.questions.length - 1);
}

export function formatApprovalDecisionLabel(decision: string): string {
  const normalized = decision.trim();
  if (!normalized) {
    return "Decision";
  }

  switch (normalized) {
    case "accept":
      return "Approve once";
    case "acceptForSession":
      return "Approve for session";
    case "acceptWithExecpolicyAmendment":
      return "Approve similar actions";
    case "decline":
      return "Reject";
    case "cancel":
      return "Cancel";
    default:
      if (/\s/.test(normalized) || /[()]/.test(normalized)) {
        return normalized;
      }
      return normalized
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (match) => match.toUpperCase());
  }
}

export function isNegativeApprovalDecision(decision: string): boolean {
  const normalized = decision.trim().toLowerCase();
  return (
    normalized === "decline" ||
    normalized === "cancel" ||
    normalized.includes("decline") ||
    normalized.includes("reject") ||
    normalized.includes("deny") ||
    normalized.includes("cancel")
  );
}

export function supportsApprovalFeedback(decisions: string[]): boolean {
  return decisions.some((decision) => isNegativeApprovalDecision(decision));
}

export function canRenderDiscordApprovalDecisions(options: {
  token: string;
  decisions: string[];
  includeFeedback: boolean;
}): boolean {
  const maxDecisionCount =
    DISCORD_MAX_MESSAGE_BUTTONS -
    APPROVAL_DETAILS_BUTTON_COUNT -
    (options.includeFeedback ? APPROVAL_FEEDBACK_BUTTON_COUNT : 0);
  if (options.decisions.length === 0 || options.decisions.length > maxDecisionCount) {
    return false;
  }

  return options.decisions.every((decision) => {
    const label = formatApprovalDecisionLabel(decision);
    return (
      label.length <= DISCORD_BUTTON_LABEL_MAX_LENGTH &&
      buildApprovalDecisionCustomId(options.token, decision).length <= DISCORD_BUTTON_CUSTOM_ID_MAX_LENGTH
    );
  });
}

export function canRenderDiscordToolInput(options: {
  token: string;
  toolInput: ToolUserInputState;
}): boolean {
  const questions = options.toolInput.questions;
  if (questions.length === 0) {
    return false;
  }

  for (const [questionIndex, question] of questions.entries()) {
    if (question.options.length === 0 || question.options.length > 5) {
      return false;
    }
    for (const [optionIndex, option] of question.options.entries()) {
      const customId = option.isOther
        ? buildToolInputOtherCustomId(options.token, questionIndex)
        : buildToolInputOptionCustomId(options.token, questionIndex, optionIndex);
      if (customId.length > DISCORD_BUTTON_CUSTOM_ID_MAX_LENGTH) {
        return false;
      }
    }
    if (buildToolInputOtherSubmitCustomId(options.token, questionIndex).length > DISCORD_BUTTON_CUSTOM_ID_MAX_LENGTH) {
      return false;
    }
  }

  return true;
}
