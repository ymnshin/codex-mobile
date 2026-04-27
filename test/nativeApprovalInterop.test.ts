import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShellDecisionPayloads,
  classifyNativeResolutionStatus,
  formatNativeApprovalResolution
} from "../src/bridge/approval/nativeApprovalInterop.js";

test("buildShellDecisionPayloads uses exec-policy amendment when prefix_rule is present", () => {
  const payloads = buildShellDecisionPayloads(
    JSON.stringify({ prefix_rule: ["npm", "run", "test"], ignored: true })
  );

  assert.deepEqual(payloads, {
    accept: { decision: "accept" },
    acceptWithExecpolicyAmendment: {
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["npm", "run", "test"]
        }
      }
    },
    decline: { decision: "decline" }
  });
});

test("buildShellDecisionPayloads falls back when prefix_rule is missing or invalid", () => {
  assert.deepEqual(buildShellDecisionPayloads("not json"), {
    accept: { decision: "accept" },
    acceptForSession: { decision: "acceptForSession" },
    decline: { decision: "decline" }
  });

  assert.deepEqual(buildShellDecisionPayloads(JSON.stringify({ prefix_rule: ["", 42, "   "] })), {
    accept: { decision: "accept" },
    acceptForSession: { decision: "acceptForSession" },
    decline: { decision: "decline" }
  });
});

test("classifyNativeResolutionStatus handles shell, MCP, and generic approvals", () => {
  assert.equal(
    classifyNativeResolutionStatus("execCommandApproval", { decision: "approved" }),
    "approved"
  );
  assert.equal(
    classifyNativeResolutionStatus("applyPatchApproval", { decision: "denied" }),
    "rejected"
  );
  assert.equal(
    classifyNativeResolutionStatus("mcpServer/elicitation/request", { action: "decline" }),
    "rejected"
  );
  assert.equal(
    classifyNativeResolutionStatus("item/commandExecution/requestApproval", { decision: "cancel" }),
    "rejected"
  );
  assert.equal(
    classifyNativeResolutionStatus("item/commandExecution/requestApproval", { decision: "accept" }),
    "approved"
  );
});

test("formatNativeApprovalResolution formats explicit and fallback states", () => {
  assert.match(
    formatNativeApprovalResolution("execCommandApproval", { decision: "approved_for_session" }, "Codex Desktop"),
    /Approved for session in Codex Desktop/
  );
  assert.match(
    formatNativeApprovalResolution("applyPatchApproval", { decision: "abort" }, "Codex Desktop"),
    /Cancelled in Codex Desktop/
  );
  assert.match(
    formatNativeApprovalResolution("mcpServer/elicitation/request", { action: "accept" }, "Codex"),
    /Approved once in Codex/
  );
  assert.match(
    formatNativeApprovalResolution("item/commandExecution/requestApproval", { decision: "acceptWithExecpolicyAmendment" }, "Codex"),
    /Approved similar actions in Codex/
  );
  assert.match(
    formatNativeApprovalResolution("item/commandExecution/requestApproval", { decision: "decline" }, "Codex"),
    /Rejected in Codex/
  );
  assert.match(
    formatNativeApprovalResolution("item/commandExecution/requestApproval", { decision: "something-else" }, "Codex"),
    /Approved in Codex/
  );
});
