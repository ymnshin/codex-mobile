import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createBridgeConfigFromPreset } from "../src/config.js";
import { StateStore } from "../src/store/StateStore.js";
import { DiscordProvider } from "../src/providers/discord/DiscordProvider.js";
import { createBridgeTestRig, createBridgeService, FakeDesktopIpcClient, FakeDiscordAdapter, FakeCodexAdapter,
  testApprovalsConfig } from "./helpers/bridgeIntegration.js";

// Synthetic snowflakes, not live Discord resources.
const CHANNEL = "1111111111111111111";
const MESSAGE = "2222222222222222222";
const MESSAGE2 = "2222222222222222223";
const THREAD = "reaction-thread";
const actor = { userId: "user_1", roleIds: [], username: "controller" };
const runtimeConfig = () => createBridgeConfigFromPreset("recommended", testApprovalsConfig("user_1"), {
  messageWriteBacks: { plainTextChannelIds: [CHANNEL] }, discovery: { allowedThreadIds: [THREAD] }
});
type ReactionCall = [string, string, "📨" | "🤔", boolean];

function createRig(busy = false) {
  const desktop = new FakeDesktopIpcClient();
  const rig = createBridgeTestRig({ runtimeConfig: runtimeConfig(), desktopIpcClient: desktop });
  const reactions: ReactionCall[] = [];
  (rig.discord as any).setInputReaction = async (...args: ReactionCall) => {
    // Neither reaction may happen before the durable source receipt exists.
    assert(rig.store.hasDiscordMessageInput(args[1]));
    reactions.push(args);
  };
  rig.store.upsertThreadBridge({ codexThreadId: THREAD, parentCodexThreadId: null,
    projectKey: "c:\\repo", projectName: "repo", discordChannelId: CHANNEL,
    discordParentChannelId: null, statusMessageId: null, cwd: "C:\\repo", repoName: "repo",
    lastSeenAt: new Date().toISOString(), attachMode: "manual", threadName: "Reaction test",
    lastStatusType: busy ? "active" : "idle", lastTurnId: busy ? "previous_turn" : null,
    lastTurnStatus: busy ? "in_progress" : null, channelKind: "conversation" });
  return { ...rig, desktop, reactions,
    command: (rig.bridge as any).coordinators.providerCommandCoordinator,
    router: (rig.bridge as any).coordinators.notificationRouter };
}

test("receipt follows durable enqueue, thinking waits for confirmed start, duplicates/denials/slash have no source reaction", async () => {
  const r = createRig(true);
  (r.desktop as any).startTurn = async () => ({ result: { turn: { id: "new_turn", status: "inProgress" } } });
  try {
    await r.bridge.start({ skipDiscovery: true });
    await r.discord.handlers!.onSendCommand(actor, CHANNEL, "queued", "queue", MESSAGE);
    assert.deepEqual(r.reactions, [[CHANNEL, MESSAGE, "📨", true]]);
    await r.discord.handlers!.onSendCommand(actor, CHANNEL, "queued", "queue", MESSAGE);
    await r.discord.handlers!.onSendCommand({ ...actor, userId: "other" }, CHANNEL, "rejected", "queue", MESSAGE2);
    await r.discord.handlers!.onSendCommand(actor, "other-channel", "ignored", "queue", MESSAGE2);
    await r.discord.handlers!.onSendCommand(actor, CHANNEL, "slash", "queue");
    assert.equal(r.reactions.length, 1);
    await r.router.handleTurnCompleted("previous_turn", "completed");
    assert.deepEqual(r.reactions, [[CHANNEL, MESSAGE, "📨", true], [CHANNEL, MESSAGE, "🤔", true]]);
    assert.equal(r.store.listWriteBackQueueItems()[0]!.status, "sent");
    await r.command.finishDiscordInputTurn(THREAD, "unrelated_turn");
    assert.equal(r.reactions.length, 2);
    await r.command.finishDiscordInputTurn(THREAD, "new_turn");
    await r.command.finishDiscordInputTurn(THREAD, "new_turn");
    assert.deepEqual(r.reactions[2], [CHANNEL, MESSAGE, "🤔", false]);
    assert.equal(r.reactions.length, 3);
  } finally { await r.bridge.stop(); }
});

test("attempted or failed dispatch and unconfirmed start never receive thinking", async () => {
  for (const outcome of ["failed", "unconfirmed"] as const) {
    const r = createRig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (r.desktop as any).startTurn = async () => {
      await gate;
      if (outcome === "failed") throw new Error("no-client-found");
      return { result: {} };
    };
    try {
      await r.bridge.start({ skipDiscovery: true });
      const pending = r.discord.handlers!.onSendCommand(actor, CHANNEL, "instruction", "queue", MESSAGE);
      await new Promise(setImmediate);
      assert.deepEqual(r.reactions, [[CHANNEL, MESSAGE, "📨", true]]);
      release();
      await pending;
      assert.equal(r.reactions.length, 1);
    } finally { release(); await r.bridge.stop(); }
  }
});

test("reaction adapter failure or absence cannot fail an accepted start", async () => {
  for (const available of [false, true]) {
    const r = createRig();
    (r.discord as any).setInputReaction = available ? async () => { throw new Error("403 sensitive payload"); } : undefined;
    (r.desktop as any).startTurn = async () => ({ result: { turn: { id: "started", status: "inProgress" } } });
    try {
      await r.bridge.start({ skipDiscovery: true });
      const result = await r.discord.handlers!.onSendCommand(actor, CHANNEL, "instruction", "queue", MESSAGE);
      assert.match(result.content, /Started a new Codex turn/);
      assert.equal(r.store.listWriteBackQueueItems()[0]!.status, "sent");
      await r.command.finishDiscordInputTurn(THREAD, "started");
    } finally { await r.bridge.stop(); }
  }
});

test("completion before the start reply suppresses late thinking but unrelated completion does not", async () => {
  for (const finishedTurn of ["fast_turn", "unrelated_turn"]) {
    const r = createRig();
    (r.desktop as any).startTurn = async () => {
      await r.router.handleNotification({ method: "turn/completed", params: {
        threadId: THREAD, turn: { id: finishedTurn, status: "completed" }
      }});
      return { result: { turn: { id: "fast_turn", status: "inProgress" } } };
    };
    try {
      await r.bridge.start({ skipDiscovery: true });
      await r.discord.handlers!.onSendCommand(actor, CHANNEL, "instruction", "queue", MESSAGE);
      assert.equal(r.reactions.some((call) => call[2] === "🤔"), finishedTurn !== "fast_turn");
    } finally { await r.bridge.stop(); }
  }
});

test("queued originals and exact-turn completion remain linked after store and bridge reopen", async () => {
  const r = createRig(true);
  await r.bridge.start({ skipDiscovery: true });
  await r.discord.handlers!.onSendCommand(actor, CHANNEL, "first", "queue", MESSAGE);
  await r.discord.handlers!.onSendCommand(actor, CHANNEL, "second", "queue", MESSAGE2);
  const records = r.store.listWriteBackQueueItems();
  r.store.bindDiscordMessageInputTurn(records[0]!.id, "first_turn");
  assert(r.store.claimDiscordInputThinkingReaction(records[0]!.id, true));
  r.store.markWriteBackQueueItemSent(records[0]!.id);
  await r.bridge.stop();
  const reopened = new StateStore(path.join(r.dir, "bridge.sqlite"));
  const provider = new FakeDiscordAdapter();
  const reactions: ReactionCall[] = [];
  (provider as any).setInputReaction = async (...args: ReactionCall) => { reactions.push(args); };
  const service = createBridgeService({ stateStore: reopened, provider: provider as never,
    codexAdapter: new FakeCodexAdapter() as never, runtimeConfig: runtimeConfig() });
  try {
    const command = (service as any).coordinators.providerCommandCoordinator;
    await command.finishDiscordInputTurn(THREAD, "first_turn");
    assert.deepEqual(reactions, [[CHANNEL, MESSAGE, "🤔", false]]);
    assert.equal(reopened.getDiscordMessageIdForQueueItem(records[1]!.id), MESSAGE2);
    assert.equal(reopened.getWriteBackQueueItem(records[1]!.id)!.status, "pending");
    await command.finishDiscordInputTurn(THREAD, "first_turn");
    assert.equal(reactions.length, 1);
  } finally { await service.stop(); }
});

test("legacy source schema gains reaction state without altering the original linkage", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "codex-reaction-schema-")), "state.sqlite");
  const db = new Database(file);
  db.exec("CREATE TABLE discord_message_inputs (message_id TEXT PRIMARY KEY, queue_id INTEGER NOT NULL UNIQUE, turn_id TEXT, echo_item_id TEXT)");
  db.prepare("INSERT INTO discord_message_inputs VALUES (?, 99, 'old_turn', 'old_item')").run(MESSAGE);
  db.close();
  const store = new StateStore(file);
  try {
    assert.equal(store.getDiscordMessageIdForQueueItem(99), MESSAGE);
    assert.equal(store.claimDiscordInputThinkingReaction(99, true), true);
    assert.equal(store.claimDiscordInputThinkingReaction(99, false), true);
    assert.equal(store.claimDiscordInputThinkingReaction(99, true), false);
  } finally { store.close(); }
});

test("Discord reactions use encoded @me routes, serialize per original, and safely absorb permission/deletion failures", async () => {
  const logs: unknown[] = [];
  const provider = new DiscordProvider({ token: "test", applicationId: "app", guildId: "guild",
    messageWriteBacks: { allowFromDiscord: true, allowedUserIds: ["user_1"], plainTextChannelIds: [CHANNEL] }
  }, { warn: (fields: unknown) => { logs.push(fields); } } as never);
  const requests: Array<[string, string]> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  (provider as any).reactionRest.put = async (route: string) => { requests.push(["put", route]); await gate; };
  (provider as any).reactionRest.delete = async (route: string) => { requests.push(["delete", route]); };
  const added = provider.setInputReaction(CHANNEL, MESSAGE, "🤔", true);
  const removed = provider.setInputReaction(CHANNEL, MESSAGE, "🤔", false);
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  release(); await Promise.all([added, removed]);
  assert.deepEqual(requests.map((entry) => entry[0]), ["put", "delete"]);
  assert(requests.every((entry) => entry[1].endsWith(`/${encodeURIComponent("🤔")}/@me`)));
  await provider.setInputReaction("other-channel", MESSAGE, "📨", true);
  assert.equal(requests.length, 2);
  (provider as any).reactionRest.put = async () => { throw new Error("403 token=do-not-log"); };
  (provider as any).reactionRest.delete = async () => { throw new Error("404 original was deleted"); };
  await provider.setInputReaction(CHANNEL, MESSAGE, "📨", true);
  await provider.setInputReaction(CHANNEL, MESSAGE, "🤔", false);
  assert.equal(logs.length, 2);
  assert(!JSON.stringify(logs).includes("do-not-log"));
  assert.equal((provider as any).reactionRest.options.retries, 0);
  assert.equal((provider as any).reactionRest.options.timeout, 2000);
  await provider.stop();
});
