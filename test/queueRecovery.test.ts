import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { StateStore } from "../src/store/StateStore.js";
import { CodexAdapter } from "../src/codex/CodexAdapter.js";
import { evaluateAvailability, queueRetryDelay, WriteBackNotDispatchedError, type WriteBackAvailability } from "../src/codex/WriteBackAvailability.js";
import { createBridgeTestRig, createBridgeConfigFromPreset, FakeDesktopIpcClient, testApprovalsConfig, createLogger } from "./helpers/bridgeIntegration.js";

const THREAD = "queue-recovery-test";
const CHANNEL = "111111111111111111";
const MESSAGE = "222222222222222222";
const actor = { userId: "user_1", roleIds: [], username: "controller" };
function rig(busy = false) {
  const desktop = new FakeDesktopIpcClient();
  const config = createBridgeConfigFromPreset("recommended", testApprovalsConfig(actor.userId), {
    discovery: { allowedThreadIds: [THREAD] }, messageWriteBacks: { plainTextChannelIds: [CHANNEL] }
  });
  const r = createBridgeTestRig({ desktopIpcClient: desktop, runtimeConfig: config });
  r.store.upsertThreadBridge({ codexThreadId: THREAD, parentCodexThreadId: null, projectKey: "test", projectName: "test",
    discordChannelId: CHANNEL, discordParentChannelId: null, statusMessageId: null, cwd: null, repoName: null,
    lastSeenAt: new Date().toISOString(), attachMode: "manual", threadName: "Test",
    lastStatusType: busy ? "active" : "idle", lastTurnId: busy ? "old-turn" : null,
    lastTurnStatus: busy ? "in_progress" : null, channelKind: "conversation" });
  let starts = 0;
  (desktop as any).startTurn = async (_id: string, _params: unknown, beforeDispatch?: () => void) => {
    beforeDispatch?.(); starts++;
    return { result: { turn: { id: `turn-${starts}`, status: "inProgress" } } };
  };
  const command = (r.bridge as any).coordinators.providerCommandCoordinator;
  const resetRetry = () => r.store.setBridgeMetaValue(`queue_recovery:${THREAD}`,
    JSON.stringify({ ...command.getQueueRecovery(THREAD), nextRetryAt: 0 }));
  return { ...r, desktop, command, resetRetry, starts: () => starts,
    send: (text = "test instruction", message = MESSAGE) => r.discord.handlers!.onSendCommand(actor, CHANNEL, text, "queue", message) };
}

test("auth expiry pauses durable pending, requests managed refresh, recovers once, and limits notices", async () => {
  const r = rig();
  let available = false;
  const refreshes: boolean[] = [];
  r.codex.checkWriteBackAvailability = async refresh => { refreshes.push(refresh ?? false); return available ? { ready: true } : { ready: false, reason: "auth" }; };
  try {
    await r.bridge.start({ skipDiscovery: true });
    await r.send();
    assert.equal(r.starts(), 0);
    assert.equal(r.store.listWriteBackQueueItems()[0]!.status, "pending");
    assert.equal(r.command.getQueueRecovery(THREAD).reason, "auth");
    assert.equal(r.discord.sentTextMessages.length, 1);
    r.resetRetry(); await r.command.runQueueWatchdog();
    assert.equal(r.discord.sentTextMessages.length, 1);
    assert(refreshes.includes(true));
    available = true; r.resetRetry(); await r.command.runQueueWatchdog();
    assert.equal(r.starts(), 1);
    assert.equal(r.store.listWriteBackQueueItems()[0]!.status, "sent");
    assert.equal(r.command.getQueueRecovery(THREAD).reason, null);
    await r.send(); await r.command.runQueueWatchdog();
    assert.equal(r.starts(), 1, "redelivery and watchdog must not duplicate a sent item");
  } finally { await r.bridge.stop(); }
});

test("usage limit waits until reset/recheck and preserves FIFO", async () => {
  const r = rig();
  let health: WriteBackAvailability = { ready: false, reason: "usage", retryAt: Date.now() + 60_000 };
  r.codex.checkWriteBackAvailability = async () => health;
  try {
    await r.bridge.start({ skipDiscovery: true });
    await r.send("first"); await r.send("second", "222222222222222223");
    assert.equal(r.starts(), 0);
    health = { ready: true }; await r.command.runQueueWatchdog();
    assert.equal(r.starts(), 0, "future retry deadline is respected");
    r.resetRetry(); await r.command.runQueueWatchdog();
    assert.deepEqual(r.store.listWriteBackQueueItems().map(row => row.status), ["sent", "pending"]);
    r.codex.threadDetails.set(THREAD, { status: { type: "idle" }, turns: [{ id: "turn-1", status: "completed" }] });
    await r.command.runQueueWatchdog();
    assert.equal(r.starts(), 2);
    assert.deepEqual(r.store.listWriteBackQueueItems().map(row => row.status), ["sent", "sent"]);
  } finally { await r.bridge.stop(); }
});

test("missed completion is repaired only from the exact terminal turn, never active or unrelated evidence", async () => {
  const r = rig(true);
  try {
    await r.bridge.start({ skipDiscovery: true }); await r.send();
    for (const details of [
      { status: { type: "active" }, turns: [{ id: "old-turn", status: "inProgress" }] },
      { status: { type: "idle" }, turns: [{ id: "different-turn", status: "completed" }] },
      { status: { type: "notLoaded" }, turns: [] }
    ]) { r.codex.threadDetails.set(THREAD, details); await r.command.runQueueWatchdog(); assert.equal(r.starts(), 0); }
    r.codex.threadDetails.set(THREAD, { status: { type: "idle" }, turns: [{ id: "old-turn", status: "completed" }] });
    await r.command.runQueueWatchdog(); assert.equal(r.starts(), 1);
    assert.equal(r.codex.resumedThreadIds.length, 0, "watchdog reads without taking Desktop ownership");
  } finally { await r.bridge.stop(); }
});

for (const reason of ["auth", "usage", "desktop"] as const) {
  test(`explicit ${reason} rejection stays pending; safe retry sends only once after recovery`, async () => {
    const r = rig(); let attempts = 0;
    (r.desktop as any).startTurn = async () => { attempts++; throw new WriteBackNotDispatchedError(reason); };
    try {
      await r.bridge.start({ skipDiscovery: true }); await r.send();
      assert.equal(r.store.listWriteBackQueueItems()[0]!.status, "pending");
      assert.equal(attempts, 1);
      (r.desktop as any).startTurn = async () => { attempts++; return { result: { turn: { id: "accepted", status: "inProgress" } } }; };
      r.resetRetry(); await r.command.runQueueWatchdog(); await r.command.runQueueWatchdog();
      assert.equal(attempts, 2);
      assert.equal(r.store.listWriteBackQueueItems()[0]!.status, "sent");
    } finally { await r.bridge.stop(); }
  });
}

test("ambiguous start never retries even when healthy; controller status/retry/retract are scoped", async () => {
  const r = rig(); let attempts = 0;
  (r.desktop as any).startTurn = async (_id: string, _params: unknown, beforeDispatch: () => void) => {
    beforeDispatch(); attempts++; throw new Error("connection lost with sensitive detail");
  };
  try {
    await r.bridge.start({ skipDiscovery: true }); await r.send();
    await r.send("next", "222222222222222223");
    await r.command.runQueueWatchdog();
    assert.equal(attempts, 1);
    assert.deepEqual(r.store.listWriteBackQueueItems().map(row => row.status), ["uncertain", "pending"]);
    const denied = await r.discord.handlers!.onRetryCommand!({ ...actor, userId: "other" }, CHANNEL);
    assert.match(denied.content, /not allowed/);
    const status = await r.discord.handlers!.onStatusCommand(actor);
    assert.match(status.content, /uncertain: 1/); assert.doesNotMatch(status.content, /sensitive|test instruction/);
    await r.discord.handlers!.onRetryCommand!(actor, CHANNEL); assert.equal(attempts, 1);
    await r.discord.handlers!.onRetractCommand(actor, "another-channel");
    assert.equal(r.store.listWriteBackQueueItems()[0]!.status, "uncertain");
    await r.discord.handlers!.onRetractCommand(actor, CHANNEL);
    assert.equal(r.store.listWriteBackQueueItems()[0]!.status, "retracted");
    assert(r.discord.sentTextMessages.every(row => !row.content.includes("sensitive")));
  } finally { await r.bridge.stop(); }
});

test("restart recovers expired pre-dispatch leases but quarantines ambiguous and legacy claims", () => {
  for (const phase of ["safe", "dispatched", "legacy"] as const) {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "queue-lease-")), "db.sqlite");
    let store = new StateStore(file);
    const first = store.createWriteBackQueueItem({ threadId: THREAD, discordChannelId: CHANNEL, actorUserId: actor.userId, text: "first" });
    store.createWriteBackQueueItem({ threadId: THREAD, discordChannelId: CHANNEL, actorUserId: actor.userId, text: "second" });
    store.claimNextPendingWriteBackQueueItem(THREAD);
    if (phase === "dispatched") store.markWriteBackDispatchStarted(first.id);
    store.setBridgeMetaValue(`queue_recovery:${THREAD}`, JSON.stringify({ reason: "auth", lastNotifiedAt: 123 }));
    store.close();
    if (phase === "legacy") { const db = new Database(file); db.prepare("UPDATE write_back_queue SET lease_expires_at = NULL").run(); db.close(); }
    store = new StateStore(file);
    try {
      store.recoverExpiredWriteBackClaims(THREAD, Date.now() + 121_000);
      assert.equal(store.getWriteBackQueueItem(first.id)!.status, phase === "safe" ? "pending" : "uncertain");
      assert.equal(store.claimNextPendingWriteBackQueueItem(THREAD)?.id ?? null, phase === "safe" ? first.id : null);
      assert.equal(JSON.parse(store.getBridgeMetaValue(`queue_recovery:${THREAD}`)!).lastNotifiedAt, 123);
    } finally { store.close(); }
  }
});

test("parallel drain attempts share one claim; notification failure cannot lose input", async () => {
  const r = rig();
  r.codex.checkWriteBackAvailability = async () => ({ ready: false, reason: "connection" });
  r.discord.sendTextMessage = async () => { throw new Error("permission denied"); };
  try {
    await r.bridge.start({ skipDiscovery: true }); await r.send();
    assert.equal(r.store.listWriteBackQueueItems()[0]!.status, "pending");
    r.codex.checkWriteBackAvailability = async () => ({ ready: true }); r.resetRetry();
    await Promise.all([r.command.drainNextQueuedWriteBackMessage(THREAD), r.command.drainNextQueuedWriteBackMessage(THREAD)]);
    assert.equal(r.starts(), 1);
  } finally { await r.bridge.stop(); }
});

test("availability ignores unrelated quotas, detects auth/null windows, and jitter stays bounded", () => {
  const account = { requiresOpenaiAuth: true, account: { type: "chatgpt" } };
  assert.deepEqual(evaluateAvailability({ requiresOpenaiAuth: true, account: null }, {}), { ready: false, reason: "auth" });
  assert.equal(evaluateAvailability({ requiresOpenaiAuth: false, account: null }, null).ready, true);
  assert.equal(evaluateAvailability({ requiresOpenaiAuth: true, account: { type: "apiKey" } }, null).ready, true);
  assert.equal(evaluateAvailability(account, { rateLimits: { primary: null, secondary: null } }).reason, "connection");
  assert.equal(evaluateAvailability(account, { rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 50 } }, unrelated: { primary: { usedPercent: 100 } }
  } }).ready, true);
  const paused = evaluateAvailability(account, { rateLimits: { primary: { usedPercent: 100, resetsAt: 200 } } }, 100_000);
  assert.equal(paused.reason, "usage"); assert.equal(paused.retryAt, 200_000);
  assert.equal(queueRetryDelay(1, () => 0), 4000);
  assert(queueRetryDelay(100, () => 1) <= 360_000);
});

test("Codex health RPC uses bounded account/read refresh and account/rateLimits/read without exposing account", async () => {
  const adapter = new CodexAdapter("codex", createLogger("silent"), process.cwd());
  const calls: Array<{ method: string; params: unknown }> = [];
  (adapter as any).start = async () => {};
  (adapter as any).request = async (method: string, params: unknown, options: { timeoutMs: number }) => {
    assert.equal(options.timeoutMs, 10_000); calls.push({ method, params });
    return method === "account/read" ? { requiresOpenaiAuth: true, account: { type: "chatgpt", email: "fixture@example.invalid" } }
      : { rateLimits: { primary: { usedPercent: 20 } } };
  };
  assert.deepEqual(await adapter.checkWriteBackAvailability(true), { ready: true });
  assert.deepEqual(calls, [{ method: "account/read", params: { refreshToken: true } }, { method: "account/rateLimits/read", params: {} }]);
});
