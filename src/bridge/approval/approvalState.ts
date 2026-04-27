import type { ApprovalStatus } from "../../domain.js";

export function isActionableApprovalStatus(status: ApprovalStatus): boolean {
  return status === "pending" || status === "decisionSent";
}

export function canMarkApprovalStale(status: ApprovalStatus, restartDisabledAt: string | null | undefined = null): boolean {
  return status === "pending" || (status === "decisionSent" && restartDisabledAt != null);
}

export function canApplyResolvedApprovalStatus(
  currentStatus: ApprovalStatus,
  nextStatus: ApprovalStatus
): boolean {
  if (nextStatus !== "approved" && nextStatus !== "rejected" && nextStatus !== "expired") {
    return currentStatus === nextStatus;
  }

  if (currentStatus === nextStatus) {
    return true;
  }

  return currentStatus === "pending" || currentStatus === "decisionSent" || currentStatus === "stale";
}
