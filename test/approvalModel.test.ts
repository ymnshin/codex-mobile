import test from "node:test";
import assert from "node:assert/strict";
import { Policy } from "../src/policy/Policy.js";
import {
  buildApprovalRecordFromServerRequest,
  buildWrappedDecisionPayloads,
  createPendingApprovalRecord,
  extractApprovalPreview,
  formatApprovalDecisionResolution,
  resolveFeedbackDecision
} from "../src/bridge/approval/approvalModel.js";

function createPolicy() {
  const policy = new Policy({
    allowFromDiscord: true,
    allowedUserIds: ["user_1"],
    mentionApprovers: false
  });
  (policy as unknown as { createApprovalToken: () => string }).createApprovalToken = () => "token_approval_1";
  return policy;
}

test("createPendingApprovalRecord sanitizes secrets and preserves timing", () => {
  const policy = createPolicy();
  const createdAtMs = Date.UTC(2026, 3, 19, 12, 0, 0);
  const record = createPendingApprovalRecord(policy, {
    requestId: "42",
    threadId: "thr_1",
    turnId: "turn_1",
    feedbackTurnId: "turn_1",
    itemId: "item_1",
    kind: "commandExecution",
    preview: "token=supersecret sk-live-abcdefghijklmno",
    cwd: "C:\\repo",
    reason: "Authorization: Bearer abcdefghijklmnop",
    availableDecisions: ["accept", "decline"],
    decisionPayloads: {},
    details: "{}",
    createdAtMs
  });

  assert.equal(record.token, "token_approval_1");
  assert.match(record.sanitizedPreview, /\[redacted\]/);
  assert.doesNotMatch(record.sanitizedPreview, /supersecret|sk-live/);
  assert.match(record.reason ?? "", /\[redacted\]/);
  assert.equal(record.createdAt, new Date(createdAtMs).toISOString());
  assert.equal(record.expiresAt, policy.expiresAt(createdAtMs).toISOString());
  assert.equal(record.feedbackTurnId, "turn_1");
});

test("buildApprovalRecordFromServerRequest maps native and wrapped command approvals", () => {
  const helpers = {
    policy: createPolicy(),
    extractStableTimestampMs: () => 1_700_000_000_000,
    resolveThreadIdForRequest: (_requestId: string, params: Record<string, unknown>) =>
      typeof params.conversationId === "string" ? params.conversationId : null
  };

  const wrapped = buildApprovalRecordFromServerRequest(
    {
      method: "item/commandExecution/requestApproval",
      id: 101,
      params: {
        threadId: "thr_wrapped",
        turnId: "turn_wrapped",
        itemId: "item_wrapped",
        command: "npm test",
        cwd: "C:\\repo",
        reason: "Need tests",
        availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "run", "test"] } }, "decline"]
      }
    } as never,
    helpers
  );
  const native = buildApprovalRecordFromServerRequest(
    {
      method: "execCommandApproval",
      id: 102,
      params: {
        conversationId: "thr_native",
        callId: "call_native",
        command: ["npm", "run", "build"],
        cwd: "C:\\repo",
        reason: "Build the project"
      }
    } as never,
    helpers
  );

  assert.equal(wrapped?.threadId, "thr_wrapped");
  assert.equal(wrapped?.feedbackTurnId, "turn_wrapped");
  assert.deepEqual(wrapped?.availableDecisions, ["acceptWithExecpolicyAmendment", "decline"]);
  assert.deepEqual(wrapped?.decisionPayloads.acceptWithExecpolicyAmendment, {
    decision: {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["npm", "run", "test"]
      }
    }
  });
  assert.equal(wrapped?.createdAt, new Date(1_700_000_000_000).toISOString());

  assert.equal(native?.threadId, "thr_native");
  assert.equal(native?.turnId, "call_native");
  assert.equal(native?.feedbackTurnId, null);
  assert.deepEqual(native?.availableDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
  assert.deepEqual(native?.decisionPayloads.acceptForSession, { decision: "approved_for_session" });
});

test("wrapped cancel-only command approvals keep buttons unchanged but expose a hidden feedback decline", () => {
  const helpers = {
    policy: createPolicy(),
    extractStableTimestampMs: () => 1_700_000_000_000,
    resolveThreadIdForRequest: (_requestId: string, params: Record<string, unknown>) =>
      typeof params.conversationId === "string" ? params.conversationId : null
  };

  const wrapped = buildApprovalRecordFromServerRequest(
    {
      method: "item/commandExecution/requestApproval",
      id: 103,
      params: {
        threadId: "thr_wrapped_cancel_only",
        turnId: "turn_wrapped_cancel_only",
        itemId: "item_wrapped_cancel_only",
        command: "\"pwsh\" -Command 'Start-Process https://example.com'",
        cwd: "C:\\repo",
        availableDecisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["pwsh", "-Command", "Start-Process https://example.com"]
            }
          },
          "cancel"
        ]
      }
    } as never,
    helpers
  );

  assert.deepEqual(wrapped?.availableDecisions, ["accept", "acceptWithExecpolicyAmendment", "cancel"]);
  assert.deepEqual(wrapped?.decisionPayloads.decline, { decision: "decline" });
  assert.equal(resolveFeedbackDecision(wrapped!), "decline");
});

test("buildApprovalRecordFromServerRequest maps file, permission, and MCP approvals", () => {
  const helpers = {
    policy: createPolicy(),
    extractStableTimestampMs: () => 1_700_000_100_000,
    resolveThreadIdForRequest: (requestId: string, params: Record<string, unknown>) =>
      typeof params.conversationId === "string"
        ? params.conversationId
        : requestId === "301"
          ? "thr_permissions"
          : requestId === "302"
            ? "thr_mcp"
            : null
  };

  const fileChange = buildApprovalRecordFromServerRequest(
    {
      method: "item/fileChange/requestApproval",
      id: 201,
      params: {
        threadId: "thr_file",
        turnId: "turn_file",
        itemId: "item_file",
        reason: "Apply patch",
        availableDecisions: ["accept", "decline"]
      }
    } as never,
    helpers
  );
  const applyPatch = buildApprovalRecordFromServerRequest(
    {
      method: "applyPatchApproval",
      id: 202,
      params: {
        conversationId: "thr_patch",
        callId: "call_patch",
        grantRoot: "C:\\repo",
        reason: "Patch files"
      }
    } as never,
    helpers
  );
  const permissions = buildApprovalRecordFromServerRequest(
    {
      method: "item/permissions/requestApproval",
      id: 301,
      params: {
        itemId: "",
        turnId: "",
        cwd: "C:\\repo",
        prompt: "Grant filesystem access?",
        availableDecisions: ["accept", "decline"]
      }
    } as never,
    helpers
  );
  const permissionsMissing = buildApprovalRecordFromServerRequest(
    {
      method: "item/permissions/requestApproval",
      id: 999,
      params: {
        availableDecisions: ["accept"]
      }
    } as never,
    helpers
  );
  const mcp = buildApprovalRecordFromServerRequest(
    {
      method: "mcpServer/elicitation/request",
      id: 302,
      params: {
        prompt: "Allow browser navigation?",
        reason: "Need browser access"
      }
    } as never,
    helpers
  );

  assert.equal(fileChange?.kind, "fileChange");
  assert.equal(fileChange?.feedbackTurnId, "turn_file");
  assert.equal(applyPatch?.cwd, "C:\\repo");
  assert.equal(applyPatch?.feedbackTurnId, null);
  assert.equal(permissions?.threadId, "thr_permissions");
  assert.equal(permissions?.itemId, "permission:301");
  assert.equal(permissions?.turnId, "permission:301");
  assert.equal(permissions?.feedbackTurnId, null);
  assert.equal(permissionsMissing, null);
  assert.equal(mcp?.threadId, "thr_mcp");
  assert.equal(mcp?.itemId, "mcp-elicitation:302");
  assert.deepEqual(mcp?.availableDecisions, ["accept", "acceptWithExecpolicyAmendment", "cancel"]);
  assert.deepEqual(mcp?.decisionPayloads.decline, { action: "decline", _meta: null });
});

test("approval helpers normalize decisions, previews, feedback, and display text", () => {
  assert.deepEqual(
    buildWrappedDecisionPayloads(
      ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } }, {}, ""],
      ["accept", "decline"]
    ),
    {
      availableDecisions: ["accept", "acceptWithExecpolicyAmendment"],
      decisionPayloads: {
        accept: { decision: "accept" },
        acceptWithExecpolicyAmendment: {
          decision: {
            acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] }
          }
        }
      }
    }
  );
  assert.deepEqual(buildWrappedDecisionPayloads({}, ["accept", "decline"]), {
    availableDecisions: ["accept", "decline"],
    decisionPayloads: {
      accept: { decision: "accept" },
      decline: { decision: "decline" }
    }
  });

  assert.equal(
    extractApprovalPreview({ question: "Proceed?", reason: "fallback" }, "Default approval text"),
    "Proceed?"
  );
  assert.equal(extractApprovalPreview({}, "Default approval text"), "Default approval text");

  assert.equal(
    resolveFeedbackDecision({
      decisionPayloads: { decline: { decision: "decline" } },
      availableDecisions: [],
      token: "",
      requestId: "",
      threadId: "",
      turnId: "",
      feedbackTurnId: null,
      itemId: "",
      kind: "commandExecution",
      sanitizedPreview: "",
      cwd: null,
      reason: null,
      expiresAt: new Date().toISOString(),
      discordMessageId: null,
      status: "pending",
      details: "{}",
      createdAt: new Date().toISOString()
    }),
    "decline"
  );
  assert.equal(
    resolveFeedbackDecision({
      decisionPayloads: {},
      availableDecisions: ["cancel"],
      token: "",
      requestId: "",
      threadId: "",
      turnId: "",
      feedbackTurnId: null,
      itemId: "",
      kind: "commandExecution",
      sanitizedPreview: "",
      cwd: null,
      reason: null,
      expiresAt: new Date().toISOString(),
      discordMessageId: null,
      status: "pending",
      details: "{}",
      createdAt: new Date().toISOString()
    }),
    "cancel"
  );
  assert.throws(
    () =>
      resolveFeedbackDecision({
        decisionPayloads: {},
        availableDecisions: ["accept"],
        token: "",
        requestId: "",
        threadId: "",
        turnId: "",
        itemId: "",
        kind: "commandExecution",
        sanitizedPreview: "",
        cwd: null,
        reason: null,
        expiresAt: new Date().toISOString(),
        discordMessageId: null,
        status: "pending",
        details: "{}",
        createdAt: new Date().toISOString()
      }),
    /does not support rejecting/
  );

  assert.match(formatApprovalDecisionResolution("accept", "Discord"), /Approved once in Discord/);
  assert.match(
    formatApprovalDecisionResolution("acceptWithExecpolicyAmendment", "terminal"),
    /Approved similar actions from terminal/
  );
  assert.match(
    formatApprovalDecisionResolution("somethingElse", "Codex"),
    /Decision sent in Codex: somethingElse/
  );
});
