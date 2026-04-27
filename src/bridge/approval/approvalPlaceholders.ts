import type { PendingApprovalRecord } from "../../domain.js";
import { isActionableApprovalStatus } from "./approvalState.js";

export function isReadOnlySessionLogApprovalPlaceholder(record: PendingApprovalRecord): boolean {
  return (
    record.requestId.startsWith("session-log:") &&
    record.availableDecisions.length === 0 &&
    (record.toolInput?.questions.length ?? 0) === 0
  );
}

export function isActionableReadOnlySessionLogApprovalPlaceholder(record: PendingApprovalRecord): boolean {
  return (
    isReadOnlySessionLogApprovalPlaceholder(record) &&
    isActionableApprovalStatus(record.status)
  );
}

export function isPendingReadOnlySessionLogApprovalPlaceholder(record: PendingApprovalRecord): boolean {
  return isReadOnlySessionLogApprovalPlaceholder(record) && record.status === "pending";
}

export function isRestartEnabledActionableReadOnlySessionLogApprovalPlaceholder(
  record: PendingApprovalRecord
): boolean {
  return (
    isActionableReadOnlySessionLogApprovalPlaceholder(record) &&
    record.restartDisabledAt === null
  );
}

export function isRestartEnabledPendingReadOnlySessionLogApprovalPlaceholder(
  record: PendingApprovalRecord
): boolean {
  return (
    isPendingReadOnlySessionLogApprovalPlaceholder(record) &&
    record.restartDisabledAt === null
  );
}
