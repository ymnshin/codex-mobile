import type { CodexCollabToolCall, CodexItem } from "../../domain.js";
export type {
  ParsedSubagentNotificationEnvelope,
  ParsedTurnAbortedEnvelope,
  ParsedUserEnvelope
} from "../../util/userEnvelopes.js";
export {
  isConversationUserAnchorText,
  parseUserEnvelope
} from "../../util/userEnvelopes.js";

export function extractCollabToolCall(item: CodexItem): CodexCollabToolCall | null {
  const raw =
    typeof item === "object" && item
      ? ((item as Record<string, unknown>).collabToolCall as Record<string, unknown> | undefined)
      : undefined;
  if (!raw) return null;
  const senderThreadId = typeof raw.senderThreadId === "string" ? raw.senderThreadId : null;
  const receiverThreadId = typeof raw.receiverThreadId === "string" ? raw.receiverThreadId : null;
  const newThreadId = typeof raw.newThreadId === "string" ? raw.newThreadId : null;
  const agentNickname =
    typeof raw.newAgentNickname === "string"
      ? raw.newAgentNickname
      : typeof raw.agentNickname === "string"
        ? raw.agentNickname
        : null;
  if (!senderThreadId && !receiverThreadId && !newThreadId) return null;
  return {
    senderThreadId: senderThreadId ?? receiverThreadId ?? newThreadId ?? "",
    receiverThreadId,
    newThreadId,
    agentNickname,
    prompt: typeof raw.prompt === "string" ? raw.prompt : null,
    agentStatus: typeof raw.agentStatus === "string" ? raw.agentStatus : null
  };
}
