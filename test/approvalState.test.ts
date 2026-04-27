import test from "node:test";
import assert from "node:assert/strict";
import {
  canApplyResolvedApprovalStatus,
  canMarkApprovalStale,
  isActionableApprovalStatus
} from "../src/bridge/approval/approvalState.js";

test("approvalState identifies actionable and stale-eligible statuses", () => {
  assert.equal(isActionableApprovalStatus("pending"), true);
  assert.equal(isActionableApprovalStatus("decisionSent"), true);
  assert.equal(isActionableApprovalStatus("approved"), false);

  assert.equal(canMarkApprovalStale("pending"), true);
  assert.equal(canMarkApprovalStale("decisionSent", null), false);
  assert.equal(canMarkApprovalStale("decisionSent", new Date().toISOString()), true);
});

test("approvalState only applies resolved statuses from allowed transitions", () => {
  assert.equal(canApplyResolvedApprovalStatus("pending", "approved"), true);
  assert.equal(canApplyResolvedApprovalStatus("decisionSent", "rejected"), true);
  assert.equal(canApplyResolvedApprovalStatus("stale", "expired"), true);
  assert.equal(canApplyResolvedApprovalStatus("approved", "rejected"), false);
  assert.equal(canApplyResolvedApprovalStatus("approved", "approved"), true);
  assert.equal(canApplyResolvedApprovalStatus("approved", "decisionSent"), false);
});
