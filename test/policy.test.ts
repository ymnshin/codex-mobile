import test from "node:test";
import assert from "node:assert/strict";
import { Policy } from "../src/policy/Policy.js";

test("Discord actor role ids do not authorize control actions", () => {
  const policy = new Policy({
    allowFromDiscord: true,
    allowedUserIds: ["user_1"],
    mentionApprovers: true
  });

  assert.equal(
    policy.isAuthorizedActor({
      userId: "user_2",
      roleIds: ["role_1", "role_2"],
      username: "tester"
    }),
    false
  );

  assert.equal(
    policy.isAuthorizedActor({
      userId: "user_1",
      roleIds: ["role_2"],
      username: "tester"
    }),
    true
  );
});

test("policy blocks Discord approvals when approvals are disabled", () => {
  const policy = new Policy({
    allowFromDiscord: false,
    allowedUserIds: ["user_1"],
    mentionApprovers: false
  });

  assert.throws(() => policy.ensureApprovalsEnabled(), /disabled/i);
});

test("policy gates approval responses and message write-backs with one controller user", () => {
  const policy = new Policy(
    {
      allowFromDiscord: true,
      allowedUserIds: ["user_1"],
      mentionApprovers: false
    },
    {
      allowFromDiscord: true,
      allowedUserIds: ["writer_1"]
    }
  );

  assert.doesNotThrow(() => policy.ensureApprovalsEnabled());
  assert.equal(
    policy.isAuthorizedMessageWriteBackActor({
      userId: "user_1",
      roleIds: [],
      username: "controller"
    }),
    true
  );
  assert.doesNotThrow(() => policy.ensureMessageWriteBackAuthorized({
    userId: "user_1",
    roleIds: [],
    username: "controller"
  }));
  assert.throws(
    () =>
      policy.ensureMessageWriteBackAuthorized({
        userId: "writer_1",
        roleIds: [],
        username: "writer"
      }),
    /not allowed to send Codex messages/i
  );
});

test("approval expiry defaults to 30 minutes", () => {
  const policy = new Policy({
    allowFromDiscord: true,
    allowedUserIds: ["user_1"],
    mentionApprovers: false
  });

  const createdAtMs = Date.UTC(2026, 3, 16, 12, 0, 0);
  assert.equal(
    policy.expiresAt(createdAtMs).toISOString(),
    new Date(createdAtMs + 30 * 60 * 1000).toISOString()
  );
});
