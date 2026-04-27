export interface ParsedSubagentNotificationEnvelope {
  kind: "subagentNotification";
  childThreadId: string;
  statusText: string | null;
}

export interface ParsedTurnAbortedEnvelope {
  kind: "turnAborted";
  message: string;
}

export type ParsedUserEnvelope =
  | ParsedSubagentNotificationEnvelope
  | ParsedTurnAbortedEnvelope;

export function parseUserEnvelope(text: string): ParsedUserEnvelope | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const subagentMatch = trimmed.match(
    /^<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>$/i
  );
  if (subagentMatch?.[1]) {
    try {
      const payload = JSON.parse(subagentMatch[1]) as Record<string, unknown>;
      const rawChildThreadId =
        (typeof payload.agent_path === "string" && payload.agent_path.trim()) ||
        (typeof payload.agentPath === "string" && payload.agentPath.trim()) ||
        (typeof payload.thread_id === "string" && payload.thread_id.trim()) ||
        (typeof payload.threadId === "string" && payload.threadId.trim()) ||
        null;
      if (!rawChildThreadId) {
        return null;
      }

      const status = payload.status;
      const statusText =
        typeof status === "string"
          ? status.trim()
          : status && typeof status === "object"
            ? (
                (typeof (status as Record<string, unknown>).completed === "string" &&
                  (status as Record<string, unknown>).completed) ||
                (typeof (status as Record<string, unknown>).running === "string" &&
                  (status as Record<string, unknown>).running) ||
                (typeof (status as Record<string, unknown>).message === "string" &&
                  (status as Record<string, unknown>).message) ||
                null
              )
            : null;
      return {
        kind: "subagentNotification",
        childThreadId: rawChildThreadId,
        statusText: statusText ? String(statusText).trim() : null
      };
    } catch {
      return null;
    }
  }

  const turnAbortedMatch = trimmed.match(/^<turn_aborted>\s*([\s\S]*?)\s*<\/turn_aborted>$/i);
  if (turnAbortedMatch) {
    const body = (turnAbortedMatch[1] ?? "").trim();
    return {
      kind: "turnAborted",
      message: body ? `**Turn Aborted**\n${body}` : "**Turn Aborted**"
    };
  }

  return null;
}

export function isConversationUserAnchorText(text: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed && parseUserEnvelope(trimmed) === null);
}
