import type { PendingApprovalRecord } from "../../domain.js";

export function buildShellDecisionPayloads(details: string): Record<string, unknown> {
  const prefixRule = extractShellPrefixRule(details);
  if (prefixRule && prefixRule.length > 0) {
    return {
      accept: { decision: "accept" },
      acceptWithExecpolicyAmendment: {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: prefixRule
          }
        }
      },
      decline: { decision: "decline" }
    };
  }

  return {
    accept: { decision: "accept" },
    acceptForSession: { decision: "acceptForSession" },
    decline: { decision: "decline" }
  };
}

export function classifyNativeResolutionStatus(
  method: string,
  response: unknown
): PendingApprovalRecord["status"] {
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    const decision =
      response && typeof response === "object" && "decision" in (response as Record<string, unknown>)
        ? (response as { decision?: unknown }).decision
        : null;
    if (decision === "denied" || decision === "abort") {
      return "rejected";
    }
    return "approved";
  }

  if (method === "mcpServer/elicitation/request") {
    const action =
      response && typeof response === "object" && typeof (response as { action?: unknown }).action === "string"
        ? String((response as { action: string }).action)
        : null;
    return action === "decline" || action === "cancel" ? "rejected" : "approved";
  }

  const decision =
    response && typeof response === "object" && "decision" in (response as Record<string, unknown>)
      ? (response as { decision?: unknown }).decision
      : null;
  if (decision === "decline" || decision === "cancel") {
    return "rejected";
  }
  return "approved";
}

export function formatNativeApprovalResolution(
  method: string,
  response: unknown,
  origin: "Codex" | "Codex Desktop"
): string {
  const location = `in ${origin}`;

  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    const decision =
      response && typeof response === "object" && "decision" in (response as Record<string, unknown>)
        ? (response as { decision?: unknown }).decision
        : null;
    switch (decision) {
      case "approved":
        return `✅ Approved once ${location}`;
      case "approved_for_session":
        return `✅ Approved for session ${location}`;
      case "denied":
        return `⛔ Rejected ${location}`;
      case "abort":
        return `⛔ Cancelled ${location}`;
      default:
        return `✅ Approved ${location}`;
    }
  }

  if (method === "mcpServer/elicitation/request") {
    const action =
      response && typeof response === "object" && typeof (response as { action?: unknown }).action === "string"
        ? String((response as { action: string }).action)
        : null;
    switch (action) {
      case "accept":
        return `✅ Approved once ${location}`;
      case "decline":
        return `⛔ Rejected ${location}`;
      case "cancel":
        return `⛔ Cancelled ${location}`;
      default:
        return `✅ Approved ${location}`;
    }
  }

  const decision =
    response && typeof response === "object" && "decision" in (response as Record<string, unknown>)
      ? (response as { decision?: unknown }).decision
      : null;
  switch (decision) {
    case "accept":
      return `✅ Approved once ${location}`;
    case "acceptForSession":
      return `✅ Approved for session ${location}`;
    case "acceptWithExecpolicyAmendment":
      return `✅ Approved similar actions ${location}`;
    case "decline":
      return `⛔ Rejected ${location}`;
    case "cancel":
      return `⛔ Cancelled ${location}`;
    default:
      return classifyNativeResolutionStatus(method, response) === "rejected"
        ? `⛔ Rejected ${location}`
        : `✅ Approved ${location}`;
  }
}

function extractShellPrefixRule(details: string): string[] | null {
  try {
    const parsed = JSON.parse(details) as { prefix_rule?: unknown };
    if (!Array.isArray(parsed.prefix_rule)) {
      return null;
    }
    const values = parsed.prefix_rule
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry): entry is string => Boolean(entry));
    return values.length > 0 ? values : null;
  } catch {
    return null;
  }
}
