import type { PendingApprovalRecord } from "../../domain.js";
import type { StateStore } from "../../store/StateStore.js";
import { isReadOnlySessionLogApprovalPlaceholder } from "./approvalPlaceholders.js";
import { isActionableApprovalStatus } from "./approvalState.js";

export function resolveReusableRequestApprovalRecord(
  existingByRequest: PendingApprovalRecord | null | undefined
): {
  reusableExisting: PendingApprovalRecord | null;
  shouldIgnoreReplay: boolean;
} {
  if (!existingByRequest) {
    return {
      reusableExisting: null,
      shouldIgnoreReplay: false
    };
  }

  if (!isActionableApprovalStatus(existingByRequest.status)) {
    return {
      reusableExisting: null,
      shouldIgnoreReplay: true
    };
  }

  return {
    reusableExisting: existingByRequest,
    shouldIgnoreReplay: false
  };
}

export function persistEffectiveApprovalRecord(
  stateStore: StateStore,
  nextRecord: PendingApprovalRecord,
  existing: PendingApprovalRecord | null | undefined
): PendingApprovalRecord {
  if (!existing) {
    stateStore.upsertPendingApproval(nextRecord);
    return nextRecord;
  }

  if (
    isActionableApprovalStatus(existing.status) &&
    hasDiscordWriteBackActions(existing) &&
    isReadOnlySessionLogApprovalPlaceholder(nextRecord)
  ) {
    return existing;
  }

  const effectiveRecord: PendingApprovalRecord = {
    ...nextRecord,
    token: existing.token,
    discordMessageId: existing.discordMessageId,
    status: existing.status === "decisionSent" ? existing.status : nextRecord.status,
    restartDisabledAt: null,
    toolInput:
      nextRecord.toolInput && existing.toolInput
        ? {
            ...nextRecord.toolInput,
            selectedAnswers: existing.toolInput.selectedAnswers
          }
        : (nextRecord.toolInput ?? null)
  };
  stateStore.refreshPendingApprovalRecord(existing.token, effectiveRecord);
  return effectiveRecord;
}

function hasDiscordWriteBackActions(record: PendingApprovalRecord): boolean {
  return (
    record.availableDecisions.length > 0 ||
    (record.kind === "toolUserInput" &&
      (record.toolInput?.questions.length ?? 0) > 0 &&
      record.reason === null)
  );
}
