import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelType, GatewayIntentBits, MessageType } from "discord.js";
import { DiscordProvider } from "../src/providers/discord/DiscordProvider.js";
import { createLogger } from "../src/logger.js";
import { createBridgeConfigFromPreset } from "../src/config.js";
import { StateStore } from "../src/store/StateStore.js";
import { createBridgeTestRig, FakeDesktopIpcClient, testApprovalsConfig } from "./helpers/bridgeIntegration.js";

const CHANNEL = "1111111111111111111";
const MESSAGE = "1552964055646343999";
const THREAD = "plain-test-thread";

function providerHarness(enabled = true) {
  const calls: unknown[][] = [];
  const replies: Array<{ content: string }> = [];
  const provider = new DiscordProvider({
    token: "test", applicationId: "app", guildId: "guild",
    messageWriteBacks: { allowFromDiscord: true, allowedUserIds: ["controller"],
      ...(enabled ? { plainTextChannelIds: [CHANNEL] } : {}) }
  }, createLogger("silent"));
  const internal = provider as any;
  internal.messageListeningSince = 100;
  internal.handlers = { onSendCommand: async (...args: unknown[]) => {
    calls.push(args); return { content: "Started a new Codex turn.\n> original" };
  }};
  const message = {
    id: MESSAGE, channelId: CHANNEL, guildId: "guild", channel: { type: ChannelType.GuildText },
    author: { id: "controller", username: "controller", bot: false },
    webhookId: null, system: false, partial: false, type: MessageType.Default,
    editedTimestamp: null, createdTimestamp: 101, content: "Do the next step.",
    attachments: new Map(), stickers: new Map(), inGuild: () => true,
    reply: async (payload: { content: string }) => { replies.push(payload); }
  };
  return { internal, message, calls, replies };
}

test("plain text is opt-in and adds only guild-message/content intents", () => {
  const disabled = providerHarness(false);
  const enabled = providerHarness();
  assert(!disabled.internal.client.options.intents.has(GatewayIntentBits.MessageContent));
  assert(enabled.internal.client.options.intents.has(GatewayIntentBits.MessageContent));
  assert(enabled.internal.client.options.intents.has(GatewayIntentBits.GuildMessages));
  assert(!enabled.internal.client.options.intents.has(GatewayIntentBits.GuildMembers));
  const defaults = createBridgeConfigFromPreset("recommended", testApprovalsConfig("controller"));
  assert.equal(defaults.messageWriteBacks.plainTextChannelIds, undefined);
});

test("plain text uses the existing send handler in queue mode with its source ID and no success echo", async () => {
  const { internal, message, calls, replies } = providerHarness();
  await internal.handlePlainTextMessage(message);
  assert.deepEqual(calls, [[{ userId: "controller", roleIds: [], username: "controller" },
    CHANNEL, message.content, "queue", MESSAGE]]);
  assert.deepEqual(replies, []);
});

test("plain text ignores unauthorized, bot, webhook, system, DM, other guild/channel/thread, old and edited input", async () => {
  const variants = [
    { author: { id: "someone-else", username: "other", bot: false } },
    { author: { id: "controller", username: "controller", bot: true } },
    { webhookId: "webhook" }, { system: true }, { partial: true },
    { inGuild: () => false }, { guildId: "other-guild" }, { channelId: "other-channel" },
    { channel: { type: ChannelType.PublicThread } }, { type: MessageType.ChannelPinnedMessage },
    { createdTimestamp: 99 }, { editedTimestamp: 102 }, { content: "  " }
  ];
  for (const variant of variants) {
    const { internal, message, calls, replies } = providerHarness();
    await internal.handlePlainTextMessage({ ...message, ...variant });
    assert.equal(calls.length, 0, JSON.stringify(variant));
    assert.equal(replies.length, 0);
  }
  const disabled = providerHarness(false);
  await disabled.internal.handlePlainTextMessage(disabled.message);
  assert.equal(disabled.calls.length, 0);
});

test("plain text rejects attachments without fetching them and gives short queue/error responses", async () => {
  const h = providerHarness();
  await h.internal.handlePlainTextMessage({ ...h.message, attachments: new Map([["id", {}]]) });
  assert.equal(h.calls.length, 0);
  assert.match(h.replies[0]!.content, /文字だけ/);
  h.internal.handlers.onSendCommand = async () => ({ content: "Queued for the next turn. Position 1.\n> secret original" });
  await h.internal.handlePlainTextMessage(h.message);
  assert.equal(h.replies[1]!.content, "受付しました。現在の処理が終わり次第、順番に開始し、返答をここに送ります。");
  h.internal.handlers.onSendCommand = async () => ({ content: "Failed to start Codex turn. no-client-found" });
  await h.internal.handlePlainTextMessage(h.message);
  assert.match(h.replies[2]!.content, /no-client-found/);
});

test("Discord source receipt and queue insertion are atomic and dedupe survives store reopen", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "codex-plain-")), "state.sqlite");
  const input = { threadId: THREAD, discordChannelId: CHANNEL, actorUserId: "controller", text: "hello" };
  let store = new StateStore(file);
  const first = store.createDiscordMessageQueueItemOnce(MESSAGE, input)!;
  assert.equal(store.createDiscordMessageQueueItemOnce(MESSAGE, input), null);
  assert.equal(store.listWriteBackQueueItems().length, 1);
  store.bindDiscordMessageInputTurn(first.id, "turn_exact");
  assert(store.claimDiscordMessageEcho(THREAD, "turn_exact", "hello", "original_item"));
  assert(store.claimDiscordMessageEcho(THREAD, "turn_exact", "hello", "original_item"));
  assert(!store.claimDiscordMessageEcho(THREAD, "different-turn", "hello", "original_item"));
  assert(!store.claimDiscordMessageEcho(THREAD, "turn_exact", "different text", "steer_item"));
  assert(!store.claimDiscordMessageEcho(THREAD, "turn_exact", "hello", "another_item"));
  store.close();
  store = new StateStore(file);
  try {
    assert.equal(store.createDiscordMessageQueueItemOnce(MESSAGE, input), null);
    assert.equal(store.listWriteBackQueueItems().length, 1);
    assert(store.claimDiscordMessageEcho(THREAD, "turn_exact", "hello", "original_item"));
    // A failed queue insertion rolls back its receipt, so it can be submitted correctly.
    assert.throws(() => store.createDiscordMessageQueueItemOnce("3333333333333333330", { ...input, text: null as never }));
    assert.equal(store.hasDiscordMessageInput("3333333333333333330"), false);
  } finally { store.close(); }
});

test("plain text stays in the existing busy-thread queue, rejects duplicates and leaves slash sends available", async () => {
  const runtimeConfig = createBridgeConfigFromPreset("recommended", testApprovalsConfig("user_1"), {
    messageWriteBacks: { plainTextChannelIds: [CHANNEL] }, discovery: { allowedThreadIds: [THREAD] }
  });
  const desktop = new FakeDesktopIpcClient();
  const { store, discord, bridge, codex } = createBridgeTestRig({ runtimeConfig, desktopIpcClient: desktop });
  store.upsertThreadBridge({ codexThreadId: THREAD, parentCodexThreadId: null,
    projectKey: "c:\\repo", projectName: "repo", discordChannelId: CHANNEL,
    discordParentChannelId: null, statusMessageId: null, cwd: "C:\\repo", repoName: "repo",
    lastSeenAt: new Date().toISOString(), attachMode: "manual", threadName: "Plain input",
    lastStatusType: "active", lastTurnId: "active_turn", lastTurnStatus: "in_progress", channelKind: "conversation" });
  try {
    await bridge.start({ skipDiscovery: true });
    const actor = { userId: "user_1", roleIds: [], username: "controller" };
    const [first, duplicate] = await Promise.all([
      discord.handlers!.onSendCommand(actor, CHANNEL, "Plain instruction", "queue", MESSAGE),
      discord.handlers!.onSendCommand(actor, CHANNEL, "Plain instruction", "queue", MESSAGE)
    ]);
    assert.match(first.content, /Queued for the next turn/);
    assert.equal(duplicate.content, "");
    assert.equal(store.listWriteBackQueueItems().length, 1);
    assert.deepEqual(codex.startTurnRequests, []);
    assert.deepEqual(desktop.responses, []);
    const rejected = await discord.handlers!.onSendCommand({ ...actor, userId: "other" }, CHANNEL, "bad", "queue", "3333333333333333331");
    assert.match(rejected.content, /not allowed/);
    const wrongMode = await discord.handlers!.onSendCommand(actor, CHANNEL, "bad", "steer", "3333333333333333332");
    assert.match(wrongMode.content, /not enabled/);
    const slash = await discord.handlers!.onSendCommand(actor, CHANNEL, "Slash instruction", "queue");
    assert.match(slash.content, /Queued for the next turn/);
    assert.equal(store.listWriteBackQueueItems().length, 2);
    const original = store.listWriteBackQueueItems()[0]!;
    store.bindDiscordMessageInputTurn(original.id, "plain_turn");
    const publisher = (bridge as any).coordinators.mirrorPublisher;
    await publisher.publishCompletedUserMessage(THREAD, "original_item", "Plain instruction", Date.now(), false, "plain:1", "plain_turn");
    assert.equal(discord.sentTextMessages.length, 0);
    await publisher.publishCompletedUserMessage(THREAD, "steer_item", "Distinct user steer in the same turn", Date.now(), false, "plain:2", "plain_turn");
    assert(discord.sentTextMessages.some((message) => message.content.includes("Distinct user steer in the same turn")));
  } finally { await bridge.stop(); }
});

test("idle plain input starts through the existing Desktop route once and records only the returned turn", async () => {
  const runtimeConfig = createBridgeConfigFromPreset("recommended", testApprovalsConfig("user_1"), {
    messageWriteBacks: { plainTextChannelIds: [CHANNEL] }, discovery: { allowedThreadIds: [THREAD] }
  });
  const desktop = new FakeDesktopIpcClient();
  let starts = 0;
  (desktop as any).startTurn = async (threadId: string, params: Record<string, unknown>) => {
    starts++;
    assert.equal(threadId, THREAD);
    assert.deepEqual(params.input, [{ type: "text", text: "Idle plain instruction" }]);
    return { result: { turn: { id: "returned_turn" } } };
  };
  const { store, discord, bridge, codex } = createBridgeTestRig({ runtimeConfig, desktopIpcClient: desktop });
  store.upsertThreadBridge({ codexThreadId: THREAD, parentCodexThreadId: null,
    projectKey: "c:\\repo", projectName: "repo", discordChannelId: CHANNEL,
    discordParentChannelId: null, statusMessageId: null, cwd: "C:\\repo", repoName: "repo",
    lastSeenAt: new Date().toISOString(), attachMode: "manual", threadName: "Plain input",
    lastStatusType: "idle", lastTurnId: null, lastTurnStatus: null, channelKind: "conversation" });
  try {
    await bridge.start({ skipDiscovery: true });
    const actor = { userId: "user_1", roleIds: [], username: "controller" };
    const first = await discord.handlers!.onSendCommand(actor, CHANNEL, "Idle plain instruction", "queue", MESSAGE);
    assert.match(first.content, /Started a new Codex turn/);
    const duplicate = await discord.handlers!.onSendCommand(actor, CHANNEL, "Idle plain instruction", "queue", MESSAGE);
    assert.equal(duplicate.content, "");
    assert.equal(starts, 1);
    assert.deepEqual(codex.startTurnRequests, []);
    assert(store.claimDiscordMessageEcho(THREAD, "returned_turn", "Idle plain instruction", "original_item"));
    assert(!store.claimDiscordMessageEcho(THREAD, "unrelated_turn", "Idle plain instruction", "other_item"));
  } finally { await bridge.stop(); }
});
