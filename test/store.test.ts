import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { StateStore } from "../src/store/StateStore.js";

test("persists thread bridges and approvals", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-store-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));

  store.upsertThreadBridge({
    codexThreadId: "thr_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "disc_1",
    discordParentChannelId: null,
    statusMessageId: "msg_1",
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Build bridge",
    lastStatusType: "active",
    lastTurnId: "turn_1",
    lastTurnStatus: "in_progress",
    channelKind: "conversation"
  });

  store.upsertPendingApproval({
    token: "token_1",
    requestId: "42",
    threadId: "thr_1",
    turnId: "turn_1",
    itemId: "item_1",
    kind: "commandExecution",
    sanitizedPreview: "npm test",
    cwd: "C:\\repo",
    reason: "Need tests",
    availableDecisions: ["accept", "decline"],
    decisionPayloads: {},
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    discordMessageId: null,
    status: "pending",
    details: "{}",
    createdAt: new Date().toISOString()
  });

  assert.equal(store.getThreadBridge("thr_1")?.discordChannelId, "disc_1");
  assert.equal(store.getThreadBridge("thr_1")?.lastTurnId, "turn_1");
  assert.equal(store.getThreadBridge("thr_1")?.lastTurnStatus, "in_progress");
  assert.equal(store.findPendingApprovalByToken("token_1")?.requestId, "42");

  store.close();
});

test("write-back queue persists FIFO claims and terminal statuses", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-store-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));

  const first = store.createWriteBackQueueItem({
    threadId: "thr_queue",
    discordChannelId: "disc_queue",
    actorUserId: "user_1",
    text: "First queued message"
  });
  const second = store.createWriteBackQueueItem({
    threadId: "thr_queue",
    discordChannelId: "disc_queue",
    actorUserId: "user_1",
    text: "Second queued message"
  });

  assert.equal(store.countPendingWriteBackQueueItems("thr_queue"), 2);
  assert.equal(store.claimNextPendingWriteBackQueueItem("thr_queue")?.id, first.id);
  assert.equal(store.claimNextPendingWriteBackQueueItem("thr_queue")?.id, second.id);
  assert.equal(store.claimNextPendingWriteBackQueueItem("thr_queue"), null);

  store.markWriteBackQueueItemSent(first.id);
  store.markWriteBackQueueItemFailed(second.id, "start failed");

  assert.equal(store.getWriteBackQueueItem(first.id)?.status, "sent");
  assert.ok(store.getWriteBackQueueItem(first.id)?.sentAt);
  assert.equal(store.getWriteBackQueueItem(second.id)?.status, "failed");
  assert.equal(store.getWriteBackQueueItem(second.id)?.error, "start failed");

  store.close();
});

test("pending approvals persist structured tool input selections", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-store-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));

  store.upsertPendingApproval({
    token: "token_tool_input",
    requestId: "request_tool_input",
    threadId: "thr_tool_input",
    turnId: "turn_tool_input",
    itemId: "item_tool_input",
    kind: "toolUserInput",
    sanitizedPreview: "Pick an implementation",
    cwd: null,
    reason: null,
    availableDecisions: [],
    decisionPayloads: {},
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    discordMessageId: "approval_msg_tool_input",
    status: "pending",
    details: "{}",
    createdAt: new Date().toISOString(),
    toolInput: {
      questions: [
        {
          id: "approach",
          header: "Approach",
          question: "Which approach should Codex take?",
          options: [
            { label: "Small patch", description: null },
            { label: "Other", description: null, isOther: true }
          ]
        }
      ],
      selectedAnswers: {}
    }
  });

  const updated = store.setPendingApprovalToolInputSelection(
    "token_tool_input",
    "approach",
    "Small patch"
  );

  assert.equal(updated?.toolInput?.selectedAnswers.approach, "Small patch");
  assert.equal(store.findPendingApprovalByToken("token_tool_input")?.toolInput?.selectedAnswers.approach, "Small patch");

  store.close();
});

test("write-back queue supports pending retraction and restore after failed steer", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-store-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));

  const first = store.createWriteBackQueueItem({
    threadId: "thr_retract",
    discordChannelId: "disc_retract",
    actorUserId: "user_1",
    text: "First"
  });
  const second = store.createWriteBackQueueItem({
    threadId: "thr_retract",
    discordChannelId: "disc_retract",
    actorUserId: "user_1",
    text: "Second"
  });

  assert.equal(store.retractLatestPendingWriteBackQueueItem("thr_retract")?.id, second.id);
  assert.equal(store.getWriteBackQueueItem(second.id)?.status, "retracted");

  const claimed = store.claimWriteBackQueueItem(first.id);
  assert.equal(claimed?.status, "sending");
  store.restoreWriteBackQueueItemPending(first.id, "steer failed");
  assert.equal(store.getWriteBackQueueItem(first.id)?.status, "pending");
  assert.equal(store.getWriteBackQueueItem(first.id)?.error, "steer failed");

  store.close();
});

test("mirrored item message ids are replaced and cleaned up with mirrored items", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-store-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));

  store.upsertMirroredItem({
    threadId: "thr_split",
    itemId: "item_split",
    turnId: "turn_1",
    kind: "agentAnswer",
    discordMessageId: "message_1",
    discordMessageIds: ["message_1", "message_2", "message_2"],
    groupKey: null,
    contentSignature: "sig-1",
    renderedContent: "first chunk",
    timestampMs: 1,
    cursor: "cursor:1",
    turnCursor: "turn:1",
    updatedAt: "2026-04-19T09:30:01.000Z"
  });

  assert.deepEqual(store.listMirroredItemMessageIds("thr_split", "item_split"), [
    "message_1",
    "message_2"
  ]);
  assert.deepEqual(store.getMirroredItem("thr_split", "item_split")?.discordMessageIds, [
    "message_1",
    "message_2"
  ]);

  store.upsertMirroredItem({
    threadId: "thr_split",
    itemId: "item_split",
    turnId: "turn_1",
    kind: "agentAnswer",
    discordMessageId: "message_3",
    discordMessageIds: ["message_3", "message_4"],
    groupKey: null,
    contentSignature: "sig-2",
    renderedContent: "replacement chunk",
    timestampMs: 2,
    cursor: "cursor:2",
    turnCursor: "turn:1",
    updatedAt: "2026-04-19T09:30:02.000Z"
  });

  assert.deepEqual(store.listMirroredItemMessageIds("thr_split", "item_split"), [
    "message_3",
    "message_4"
  ]);

  store.deleteMirroredItem("thr_split", "item_split");
  assert.deepEqual(store.listMirroredItemMessageIds("thr_split", "item_split"), []);

  store.upsertMirroredItem({
    threadId: "thr_split",
    itemId: "item_split_a",
    turnId: "turn_2",
    kind: "user",
    discordMessageId: "message_a",
    discordMessageIds: ["message_a", "message_b"],
    groupKey: null,
    contentSignature: "sig-a",
    renderedContent: "a",
    timestampMs: 3,
    cursor: "cursor:3",
    turnCursor: "turn:2",
    updatedAt: "2026-04-19T09:30:03.000Z"
  });
  store.upsertMirroredItem({
    threadId: "thr_other",
    itemId: "item_other",
    turnId: "turn_other",
    kind: "user",
    discordMessageId: "message_other",
    discordMessageIds: ["message_other"],
    groupKey: null,
    contentSignature: "sig-other",
    renderedContent: "other",
    timestampMs: 4,
    cursor: "cursor:4",
    turnCursor: "turn:other",
    updatedAt: "2026-04-19T09:30:04.000Z"
  });

  store.deleteMirroredItemsByThread("thr_split");
  assert.deepEqual(store.listMirroredItemMessageIds("thr_split", "item_split_a"), []);
  assert.deepEqual(store.listMirroredItemMessageIds("thr_other", "item_other"), ["message_other"]);

  store.close();
});

test("clearBridgeState recreates the current schema", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-store-"));
  const databasePath = path.join(dir, "bridge.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE mirrored_items (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      discord_message_id TEXT NOT NULL,
      group_key TEXT,
      content_signature TEXT NOT NULL,
      rendered_content TEXT NOT NULL,
      timestamp_ms INTEGER,
      cursor TEXT,
      updated_at TEXT NOT NULL,
      turn_id TEXT,
      turn_cursor TEXT,
      PRIMARY KEY (thread_id, item_id)
    );

    CREATE TABLE mirrored_item_messages (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      discord_message_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      message_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (thread_id, item_id, discord_message_id)
    );
  `);
  legacy.close();

  const store = new StateStore(databasePath);
  store.clearBridgeState();
  store.upsertMirroredItem({
    threadId: "thr_schema",
    itemId: "item_schema",
    turnId: "turn_schema",
    kind: "command",
    discordMessageId: "message_schema_1",
    discordMessageIds: ["message_schema_1", "message_schema_2"],
    groupKey: "commands",
    contentSignature: "sig-schema",
    renderedContent: "Ran 2 commands.",
    timestampMs: 1,
    cursor: "cursor:schema",
    turnCursor: "turn:schema",
    updatedAt: "2026-04-26T10:00:00.000Z"
  });
  assert.deepEqual(store.listMirroredItemMessageIds("thr_schema", "item_schema"), [
    "message_schema_1",
    "message_schema_2"
  ]);
  store.close();

  const current = new Database(databasePath, { readonly: true });
  const columns = (
    current.prepare("PRAGMA table_info(mirrored_item_messages)").all() as Array<{ name: unknown }>
  ).map((row) => String(row.name));
  current.close();
  assert.deepEqual(columns, [
    "thread_id",
    "item_id",
    "discord_message_id",
    "message_order"
  ]);
});

test("lists actionable approvals separately and prunes inactive approvals by age", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-store-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));

  const now = Date.now();
  store.upsertPendingApproval({
    token: "token_pending",
    requestId: "1",
    threadId: "thr_1",
    turnId: "turn_1",
    itemId: "item_1",
    kind: "commandExecution",
    sanitizedPreview: "npm test",
    cwd: "C:\\repo",
    reason: "Need tests",
    availableDecisions: ["accept"],
    decisionPayloads: {},
    expiresAt: new Date(now + 60_000).toISOString(),
    discordMessageId: null,
    status: "pending",
    details: "{}",
    createdAt: new Date(now).toISOString()
  });

  store.upsertPendingApproval({
    token: "token_approved_old",
    requestId: "2",
    threadId: "thr_1",
    turnId: "turn_2",
    itemId: "item_2",
    kind: "commandExecution",
    sanitizedPreview: "npm run build",
    cwd: "C:\\repo",
    reason: "Need build",
    availableDecisions: ["accept"],
    decisionPayloads: {},
    expiresAt: new Date(now - 120_000).toISOString(),
    discordMessageId: null,
    status: "approved",
    details: "{}",
    createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString()
  });

  assert.equal(store.listPendingApprovals().length, 2);
  assert.equal(store.listActionableApprovals().length, 1);
  assert.equal(store.listActionableApprovals()[0]?.token, "token_pending");

  const deleted = store.deleteInactiveApprovalsOlderThan(new Date(now - 60 * 60 * 1000).toISOString());
  assert.equal(deleted, 1);
  assert.equal(store.listPendingApprovals().length, 1);
  assert.equal(store.findPendingApprovalByToken("token_approved_old"), undefined);

  store.close();
});

test("deleteThreadBridge removes thread-local cursors and message details without touching other threads", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-store-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));

  for (const threadId of ["thr_remove", "thr_keep"]) {
    store.upsertThreadBridge({
      codexThreadId: threadId,
      parentCodexThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      discordChannelId: `discord-${threadId}`,
      discordParentChannelId: null,
      statusMessageId: null,
      cwd: "C:\\repo",
      repoName: "repo",
      lastSeenAt: "2026-04-19T10:00:00.000Z",
      attachMode: "auto",
      threadName: threadId,
      lastStatusType: "idle",
      channelKind: "conversation"
    });
    store.upsertSessionLogCursor({
      threadId,
      filePath: `C:\\sessions\\${threadId}.jsonl`,
      byteOffset: 42,
      updatedAt: "2026-04-19T10:00:01.000Z"
    });
    store.upsertMessageDetail({
      token: `detail-${threadId}`,
      threadId,
      kind: "debug",
      title: threadId,
      buttonLabel: "Show details",
      detail: "{}",
      discordMessageId: `message-${threadId}`,
      expiresAt: "2026-04-19T11:00:00.000Z",
      updatedAt: "2026-04-19T10:00:02.000Z"
    });
  }

  store.deleteThreadBridge("thr_remove");

  assert.equal(store.getThreadBridge("thr_remove"), undefined);
  assert.equal(store.getSessionLogCursor("thr_remove"), undefined);
  assert.equal(store.findMessageDetailByToken("detail-thr_remove"), undefined);

  assert.equal(store.getThreadBridge("thr_keep")?.discordChannelId, "discord-thr_keep");
  assert.equal(store.getSessionLogCursor("thr_keep")?.filePath, "C:\\sessions\\thr_keep.jsonl");
  assert.equal(store.findMessageDetailByToken("detail-thr_keep")?.discordMessageId, "message-thr_keep");

  store.close();
});

test("proposed plan action records persist and transition atomically", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-store-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));

  store.upsertProposedPlanAction({
    token: "plan_token_1",
    threadId: "thr_plan",
    turnId: "turn_plan",
    itemId: "item_plan",
    planText: "# Plan\n\nDo the work.",
    status: "pending",
    discordMessageId: "message_plan",
    createdAt: "2026-04-25T09:00:00.000Z",
    updatedAt: "2026-04-25T09:00:00.000Z",
    completedAt: null,
    expiresAt: "2099-04-25T10:00:00.000Z",
    error: null
  });

  assert.equal(store.findProposedPlanActionByToken("plan_token_1")?.planText, "# Plan\n\nDo the work.");
  assert.equal(store.listProposedPlanActions("thr_plan").length, 1);

  const claimed = store.claimPendingProposedPlanAction("plan_token_1");
  assert.equal(claimed?.status, "sending");
  assert.equal(store.claimPendingProposedPlanAction("plan_token_1"), null);

  const completed = store.completeProposedPlanAction("plan_token_1", "feedbackSent");
  assert.equal(completed?.status, "feedbackSent");
  assert.ok(completed?.completedAt);

  store.close();
});

test("canonical thread events preserve insertion order while respecting list limits", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-store-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));

  store.appendCanonicalThreadEvent({
    threadId: "thr_1",
    source: "session",
    eventKind: "content",
    itemKind: "user",
    turnId: "turn_1",
    turnCursor: "cursor:001",
    itemId: "item_1",
    requestId: null,
    summary: "first",
    detail: null,
    createdAt: "2026-04-19T10:10:00.000Z"
  });
  store.appendCanonicalThreadEvent({
    threadId: "thr_1",
    source: "desktop-ipc",
    eventKind: "approvalUpsert",
    itemKind: "approval",
    turnId: "turn_1",
    turnCursor: "cursor:001",
    itemId: "item_approval",
    requestId: "req_1",
    summary: "second",
    detail: null,
    createdAt: "2026-04-19T10:10:01.000Z"
  });
  store.appendCanonicalThreadEvent({
    threadId: "thr_1",
    source: "app-server",
    eventKind: "ignoredHint",
    itemKind: null,
    turnId: "turn_2",
    turnCursor: "cursor:002",
    itemId: null,
    requestId: null,
    summary: "third",
    detail: "hint ignored",
    createdAt: "2026-04-19T10:10:02.000Z"
  });

  const latestTwo = store.listCanonicalThreadEvents("thr_1", 2);
  assert.deepEqual(
    latestTwo.map((record) => ({
      source: record.source,
      eventKind: record.eventKind,
      summary: record.summary,
      turnCursor: record.turnCursor
    })),
    [
      {
        source: "desktop-ipc",
        eventKind: "approvalUpsert",
        summary: "second",
        turnCursor: "cursor:001"
      },
      {
        source: "app-server",
        eventKind: "ignoredHint",
        summary: "third",
        turnCursor: "cursor:002"
      }
    ]
  );

  store.close();
});
