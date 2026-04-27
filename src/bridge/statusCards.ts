import type { CodexThreadStatus, StatusCardView, ThreadRuntimeState } from "../domain.js";
import { attentionLabel, kindLabel, shortThreadId, statusLabel } from "../util/formatting.js";
import { sanitizeThreadNameForDiscord } from "./threadMetadata.js";

export function buildStatusCardView(state: ThreadRuntimeState): StatusCardView {
  return {
    threadId: state.threadId,
    title: sanitizeThreadNameForDiscord(state.name ?? state.preview ?? "Codex conversation"),
    shortThreadId: shortThreadId(state.threadId),
    kindLabel: kindLabel(state.channelKind),
    parentShortThreadId: state.parentThreadId ? shortThreadId(state.parentThreadId) : null,
    projectLabel: state.projectName,
    statusLabel: statusLabel(state.status),
    attentionLabel: attentionLabel(state.status),
    workspaceLabel: state.repoName ?? state.cwd ?? "Unknown",
    lastActivityAt: state.lastActivityAt,
    latestCommandPreview: state.latestCommandPreview,
    latestAgentMessage: state.latestAgentMessage
  };
}

export function deserializeStatus(statusType: string | null): CodexThreadStatus {
  if (statusType === "active") return { type: "active", activeFlags: [] };
  if (statusType === "idle" || statusType === "systemError") return { type: statusType };
  return { type: "notLoaded" };
}
