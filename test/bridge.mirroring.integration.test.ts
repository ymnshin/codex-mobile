import {
  test,
  assert,
  mkdtempSync,
  path,
  tmpdir,
  createBridgeConfigFromPreset,
  StateStore,
  FakeCodexAdapter,
  FakeSessionEventTailer,
  createBridgeTestRig,
  createBridgeService,
  FakeDiscordAdapter
} from "./helpers/bridgeIntegration.js";

test("bridge mirrors live Codex agent messages into the Discord chat stream", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_live",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_live",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Live thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thr_live", delta: "Hello from Codex" }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_live",
        turnId: "turn_live",
        item: {
          type: "agentMessage",
          id: "msg_1",
          text: "Hello from Codex. Final answer. See (/C:/Users/Natale/Desktop/projects/codex-mobile/src/bridge/BridgeService.ts)."
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.liveTextMessages[0]?.action, "create");
    assert.match(discord.liveTextMessages[0]?.content ?? "", /^### .*?\*\*Codex\*\*/);
    assert.match(discord.liveTextMessages[0]?.content ?? "", /Hello from Codex/);
    assert.equal(discord.liveTextMessages.at(-1)?.action, "edit");
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /^# .*?\*\*Codex\*\*/);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /Final answer/);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /\*BridgeService\.ts\*/);
    assert.doesNotMatch(discord.liveTextMessages.at(-1)?.content ?? "", /\/C:\/Users\/Natale/i);
    assert.equal(discord.milestoneMessages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("assistant commentary messages are grouped into a single editable Discord message", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_commentary",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_commentary",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Commentary thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_commentary",
        turnId: "turn_commentary",
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          id: "assistant_commentary_1",
          content: [{ type: "output_text", text: "First thought." }]
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_commentary",
        turnId: "turn_commentary",
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          id: "assistant_commentary_2",
          content: [{ type: "output_text", text: "Second thought." }]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.liveTextMessages.length, 2);
    assert.equal(discord.liveTextMessages[0]?.action, "create");
    assert.match(discord.liveTextMessages[0]?.content ?? "", /^### .*?\*\*Codex\*\*/);
    assert.doesNotMatch(discord.liveTextMessages[0]?.content ?? "", /^\s*1\.\s/m);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /First thought\./);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /Second thought\./);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /1\..*First thought\./s);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /2\..*Second thought\./s);
  } finally {
    await bridge.stop();
  }
});

test("desktop approval requests fall back to a direct conversation mapping when no canonical child anchor exists", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_approval",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_thr_parent_approval",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent approval thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  codex.threadDetails.set("thr_parent_approval", {
    id: "thr_parent_approval",
    name: "Parent approval thread",
    preview: "Parent approval thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_parent_approval",
        status: "completed",
        items: [
          {
            id: "item_spawn_child_approval",
            type: "commandExecution",
            collabToolCall: {
              senderThreadId: "thr_parent_approval",
              newThreadId: "thr_child_approval",
              prompt: "Worker prompt"
            }
          }
        ]
      }
    ]
  });
  codex.threadDetails.set("thr_child_approval", {
    id: "thr_child_approval",
    name: "Child approval thread",
    preview: "Child approval thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] }
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleDesktopIpcRequestUpserted({
      threadId: "thr_child_approval",
      requestId: "req_child_approval_1",
      request: {
        method: "item/commandExecution/requestApproval",
        id: "req_child_approval_1",
        params: {
          threadId: "thr_child_approval",
          turnId: "turn_child_approval",
          itemId: "item_child_approval",
          command: "Get-Date -Format o",
          availableDecisions: ["accept", "decline"]
        }
      }
    });

    const childBridge = store.getThreadBridge("thr_child_approval");
    assert.ok(childBridge);
    assert.equal(childBridge?.channelKind, "conversation");
    assert.equal(childBridge?.parentCodexThreadId, null);
    assert.equal(discord.approvalCards[0]?.channelId, childBridge?.discordChannelId ?? null);
  } finally {
    await bridge.stop();
  }
});

test("desktop approval requests attach child threads as Discord subagent threads when child session metadata provides the parent", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_session_meta",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_thr_parent_session_meta",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent session-meta thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  tailer.setParentThread("thr_child_session_meta", "thr_parent_session_meta");
  codex.threadDetails.set("thr_child_session_meta", {
    id: "thr_child_session_meta",
    name: "Child session-meta thread",
    preview: "Child session-meta thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] }
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleDesktopIpcRequestUpserted({
      threadId: "thr_child_session_meta",
      requestId: "req_child_session_meta_1",
      request: {
        method: "item/commandExecution/requestApproval",
        id: "req_child_session_meta_1",
        params: {
          threadId: "thr_child_session_meta",
          turnId: "turn_child_session_meta",
          itemId: "item_child_session_meta",
          command: "Get-Date -Format o",
          availableDecisions: ["accept", "decline"]
        }
      }
    });

    const childBridge = store.getThreadBridge("thr_child_session_meta");
    assert.ok(childBridge);
    assert.equal(childBridge?.channelKind, "subagent");
    assert.equal(childBridge?.parentCodexThreadId, "thr_parent_session_meta");
    assert.equal(childBridge?.discordChannelId, "discord_subagent_1");
    assert.equal(discord.approvalCards[0]?.channelId, "discord_subagent_1");
    assert.equal(discord.threadChannelIds.has("discord_subagent_1"), true);
    assert.equal(discord.conversationChannelIds.has("discord_channel_thr_child_session_meta"), false);
  } finally {
    await bridge.stop();
  }
});

test("desktop approval mirroring drains child-thread backlog without recursive session-log scans", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_fast_approval",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_thr_parent_fast_approval",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent fast approval thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_child_fast_approval",
    parentCodexThreadId: "thr_parent_fast_approval",
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_subagent_1",
    discordParentChannelId: "discord_channel_thr_parent_fast_approval",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Euler",
    actorName: "Euler",
    lastStatusType: "idle",
    channelKind: "subagent"
  });
  discord.threadChannelIds.add("discord_subagent_1");

  codex.threadDetails.set("thr_parent_fast_approval", {
    id: "thr_parent_fast_approval",
    name: "Parent fast approval thread",
    preview: "Parent fast approval thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_parent_fast_approval",
        status: "completed",
        items: [
          {
            id: "item_spawn_child_fast_approval",
            type: "commandExecution",
            collabToolCall: {
              senderThreadId: "thr_parent_fast_approval",
              newThreadId: "thr_child_fast_approval",
              prompt: "Worker prompt",
              agentNickname: "Euler"
            }
          }
        ]
      }
    ]
  });
  codex.threadDetails.set("thr_child_fast_approval", {
    id: "thr_child_fast_approval",
    name: "Child fast approval thread",
    preview: "Child fast approval thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] }
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleDesktopIpcRequestUpserted({
      threadId: "thr_child_fast_approval",
      requestId: "req_child_fast_approval_1",
      request: {
        method: "mcpServer/elicitation/request",
        id: "req_child_fast_approval_1",
        params: {
          threadId: "thr_child_fast_approval",
          conversationId: "thr_child_fast_approval",
          options: ["approve"],
          server: "playwright",
          tool: "browser_tabs",
          prompt: "Allow browser tab creation"
        }
      }
    });

    assert.equal(
      tailer.pollThreadCalls.some(
        (call) => call.threadId === "thr_child_fast_approval" && call.allowFilesystemScan === false
      ),
      true
    );
    assert.equal(discord.approvalCards[0]?.channelId, "discord_subagent_1");
  } finally {
    await bridge.stop();
  }
});

test("compatibility discovery without anchored child ownership treats app-server child candidates as top-level conversations", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_discovery",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_thr_parent_discovery",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent discovery thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  codex.threadDetails.set("thr_parent_discovery", {
    id: "thr_parent_discovery",
    name: "Parent discovery thread",
    preview: "Parent discovery thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_parent_discovery",
        status: "completed",
        items: [
          {
            id: "item_spawn_child_discovery",
            type: "commandExecution",
            collabToolCall: {
              senderThreadId: "thr_parent_discovery",
              newThreadId: "thr_child_discovery",
              prompt: "Worker prompt"
            }
          }
        ]
      }
    ]
  });

  const childSummary = {
    id: "thr_child_discovery",
    name: "Child discovery thread",
    preview: "Child discovery thread",
    modelProvider: null,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] }
  };
  codex.threadDetails.set("thr_child_discovery", childSummary);

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).maybeAttachThread(
      {
        summary: childSummary,
        source: "app-server"
      },
      false
    );

    const childBridge = store.getThreadBridge("thr_child_discovery");
    assert.ok(childBridge);
    assert.equal(childBridge?.channelKind, "conversation");
    assert.equal(childBridge?.parentCodexThreadId, null);
    assert.equal(discord.threadChannelIds.size, 0);
  } finally {
    await bridge.stop();
  }
});

test("subagent-to-conversation kind correction deletes the old thread location and reattaches direct children", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "corrected_parent",
    parentCodexThreadId: "old_parent",
    parentAnchorTurnId: "turn_old_parent",
    parentAnchorTurnCursor: "turn:old_parent",
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_wrong_parent_thread",
    discordParentChannelId: "discord_channel_old_parent",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Wrongly attached parent",
    lastStatusType: "idle",
    channelKind: "subagent"
  });
  store.upsertThreadBridge({
    codexThreadId: "corrected_child",
    parentCodexThreadId: "corrected_parent",
    parentAnchorTurnId: "turn_corrected_parent",
    parentAnchorTurnCursor: "turn:corrected_parent",
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_wrong_child_thread",
    discordParentChannelId: "discord_wrong_parent_thread",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Child worker",
    lastStatusType: "idle",
    channelKind: "subagent"
  });
  discord.threadChannelIds.add("discord_wrong_parent_thread");
  discord.threadChannelIds.add("discord_wrong_child_thread");

  codex.metadata.set("corrected_parent", {
    cwd: "C:\\repo",
    repoName: "repo",
    threadName: "Corrected parent",
    parentThreadId: null
  });
  codex.metadata.set("corrected_child", {
    cwd: "C:\\repo",
    repoName: "repo",
    threadName: "Child worker",
    actorName: "Worker",
    parentThreadId: "corrected_parent"
  });
  codex.threadDetails.set("corrected_child", {
    id: "corrected_child",
    name: "Child worker",
    preview: "Child worker",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: []
  });

  try {
    await bridge.hydrateThread(
      "corrected_parent",
      {
        id: "corrected_parent",
        name: "Corrected parent",
        preview: "Corrected parent",
        modelProvider: null,
        createdAt: null,
        updatedAt: null,
        ephemeral: false,
        status: { type: "idle" as const }
      },
      "auto"
    );

    const correctedParent = store.getThreadBridge("corrected_parent");
    const correctedChild = store.getThreadBridge("corrected_child");
    assert.equal(correctedParent?.channelKind, "conversation");
    assert.equal(correctedParent?.discordChannelId, "discord_channel_corrected_parent");
    assert.equal(correctedChild?.parentCodexThreadId, "corrected_parent");
    assert.equal(correctedChild?.discordParentChannelId, "discord_channel_corrected_parent");
    assert.ok(discord.deletedLocationIds.includes("discord_wrong_parent_thread"));
    assert.ok(discord.deletedLocationIds.includes("discord_wrong_child_thread"));
    assert.ok(
      discord.subagentEnsureRequests.some(
        (request) =>
          request.codexThreadId === "corrected_child" &&
          request.parentChannelId === "discord_channel_corrected_parent"
      )
    );
    assert.ok(
      !store
        .listThreadBridges()
        .some(
          (bridgeRecord) =>
            bridgeRecord.discordChannelId === "discord_wrong_parent_thread" ||
            bridgeRecord.discordChannelId === "discord_wrong_child_thread"
        )
    );
  } finally {
    await bridge.stop();
  }
});

test("initial thread hydration redacts Discord-visible thread names before persisting or attaching them", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  try {
    await bridge.hydrateThread(
      "thr_redacted_name",
      {
        id: "thr_redacted_name",
        name: "Deploy sk-live-12345678901234567890 to production",
        preview: "Deploy sk-live-12345678901234567890 to production",
        modelProvider: null,
        createdAt: null,
        updatedAt: null,
        ephemeral: false,
        status: { type: "idle" as const }
      },
      "auto"
    );

    const hydrated = store.getThreadBridge("thr_redacted_name");
    assert.ok(hydrated);
    assert.equal(hydrated.threadName?.includes("sk-live-12345678901234567890"), false);
    assert.match(hydrated.threadName ?? "", /\[redacted\]/);
    assert.equal(discord.conversationEnsureRequests.at(-1)?.title?.includes("sk-live-12345678901234567890"), false);
    assert.match(discord.conversationEnsureRequests.at(-1)?.title ?? "", /\[redacted\]/);
  } finally {
    await bridge.stop();
  }
});

test("discovery suppresses a new sub-agent milestone until the parent conversation has mirrored content", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_unanchored",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_thr_parent_unanchored",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent thread",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredCursor: null
  });

  const childSummary = {
    id: "thr_child_unanchored",
    name: "Child thread",
    preview: "Child thread",
    modelProvider: null,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] }
  };
  codex.metadata.set("thr_child_unanchored", {
    cwd: "C:\\repo",
    repoName: "repo",
    parentThreadId: "thr_parent_unanchored"
  });
  codex.threadDetails.set("thr_child_unanchored", childSummary);

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).maybeAttachThread(
      {
        summary: childSummary,
        source: "app-server"
      },
      false
    );

    assert.equal(discord.milestoneMessages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("cold-start discovery mirrors the parent user turn without posting an extra sub-agent attachment milestone", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_parent_startup_anchor",
      name: "Parent thread",
      preview: "Parent thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    },
    {
      id: "thr_child_startup_anchor",
      name: "Child thread",
      preview: "Child thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ] as any;
  codex.metadata.set("thr_parent_startup_anchor", { cwd: "C:\\repo", repoName: "repo" });
  codex.metadata.set("thr_child_startup_anchor", {
    cwd: "C:\\repo",
    repoName: "repo",
    parentThreadId: "thr_parent_startup_anchor",
    actorName: "Hypatia"
  });
  tailer.setLatestTurnBackfillEvents("thr_parent_startup_anchor", [
    {
      type: "sessionUserMessage",
      threadId: "thr_parent_startup_anchor",
      turnId: "turn_parent_startup_anchor",
      streamOrder: 1,
      timestampMs: Date.now() - 5_000,
      text: "Please investigate the failing startup import."
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_parent_startup_anchor",
      turnId: "turn_parent_startup_anchor",
      streamOrder: 2,
      timestampMs: Date.now() - 4_000,
      text: "Reviewing startup discovery now.",
      phase: "commentary"
    }
  ]);

  try {
    await bridge.start();

    const parentBridge = store.getThreadBridge("thr_parent_startup_anchor");
    assert.ok(parentBridge);
    const parentUserMessageIndex = discord.operations.findIndex(
      (operation) =>
        operation.channelId === parentBridge?.discordChannelId &&
        operation.type === "text-send" &&
        operation.content?.includes("Please investigate the failing startup import.")
    );
    assert.ok(parentUserMessageIndex >= 0);
    assert.equal(discord.milestoneMessages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("discovery does not attach recent local sub-agent session threads before app-server catches up when no retained parent-turn anchor exists", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_local_subagent",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_thr_parent_local_subagent",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent local thread",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const nowMs = Date.now();
  tailer.setLocalThreads([
    {
      threadId: "thr_child_local_subagent",
      name: "Run checks",
      preview: "Run checks",
      cwd: "C:\\repo",
      repoName: "repo",
      createdAtMs: nowMs - 1_000,
      updatedAtMs: nowMs,
      status: "active",
      filePath: "C:\\Users\\Natale\\.codex\\sessions\\child.jsonl",
      sourceKind: "app-server",
      parentThreadId: "thr_parent_local_subagent",
      actorName: "Darwin"
    }
  ]);
  codex.threadDetails.set("thr_child_local_subagent", {
    id: "thr_child_local_subagent",
    name: "Run checks",
    preview: "Run checks",
    modelProvider: null,
    createdAt: Math.floor((nowMs - 1_000) / 1000),
    updatedAt: Math.floor(nowMs / 1000),
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] }
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).runDiscoveryCycleInternal(false);

    const childBridge = store.getThreadBridge("thr_child_local_subagent");
    assert.equal(childBridge, undefined);
    assert.equal(discord.threadChannelIds.size, 0);
  } finally {
    await bridge.stop();
  }
});

test("discovery does not wait on unrelated thread queues before completing", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_discovery_scoped",
      name: "Scoped discovery thread",
      preview: "Scoped discovery thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ] as any;
  codex.metadata.set("thr_discovery_scoped", {
    cwd: "C:\\repo",
    repoName: "repo"
  });

  let releaseStuckThreadQueue = () => {};
  const stuckThreadQueue = new Promise<void>((resolve) => {
    releaseStuckThreadQueue = () => resolve();
  });
  const stuckThreadEvent = (bridge as any).enqueueThreadEvent("thr_unrelated_discovery_stuck", async () => {
    await stuckThreadQueue;
  });

  try {
    await bridge.start({ skipDiscovery: true });
    const completion = await Promise.race([
      (bridge as any).runDiscoveryCycleInternal(false).then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100))
    ]);

    assert.equal(completion, "completed");
    const attachedBridge = store.getThreadBridge("thr_discovery_scoped");
    assert.ok(attachedBridge);
    assert.equal(attachedBridge?.threadName, "Scoped discovery thread");
  } finally {
    releaseStuckThreadQueue();
    await stuckThreadEvent;
    await bridge.stop();
  }
});

test("session sub-agent spawn events persist child anchors and eagerly attach the child thread once", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_spawn",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_spawn",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent thread",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    const spawnEvent = {
      type: "sessionSubagentSpawned",
      threadId: "thr_parent_spawn",
      turnId: "turn_parent_spawn",
      childThreadId: "thr_child_spawn",
      childAgentName: "Darwin",
      prompt: "Run read-only checks",
      timestampMs: Date.now(),
      eventKey: "subagent-spawn:thr_child_spawn",
      sourceOrder: "00000001:0000"
    } as const;
    await (bridge as any).handleSessionEvent(spawnEvent);
    await (bridge as any).handleSessionEvent(spawnEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue(new Set(["thr_child_spawn"]));

    const childAnchor = store.getChildThreadAnchor("thr_child_spawn");
    const childAnchorEvents = store
      .listCanonicalThreadEvents("thr_child_spawn", 20)
      .filter((event) => event.eventKind === "childAnchor" && event.itemId === "thr_child_spawn");
    const childBridge = store.getThreadBridge("thr_child_spawn");
    assert.equal(childBridge?.parentCodexThreadId, "thr_parent_spawn");
    assert.equal(childBridge?.channelKind, "subagent");
    assert.equal(childBridge?.discordChannelId, "discord_subagent_1");
    assert.equal(childAnchor?.parentThreadId, "thr_parent_spawn");
    assert.equal(childAnchor?.parentTurnId, "turn_parent_spawn");
    assert.equal(childAnchor?.parentTurnCursor, "turn:turn_parent_spawn");
    assert.equal(childAnchor?.source, "session");
    assert.equal(childAnchorEvents.length, 1);
    assert.equal(discord.subagentEnsureRequests.length, 1);
    assert.equal(discord.threadChannelIds.has("discord_subagent_1"), true);
  } finally {
    await bridge.stop();
  }
});

test("replayed stable session content appends one canonical event", async () => {
  const { store, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_session_canonical_dedupe",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_session_canonical_dedupe",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Canonical dedupe",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleSessionEvent({
      type: "sessionUserMessage",
      threadId: "thr_session_canonical_dedupe",
      turnId: "turn_session_canonical_dedupe",
      streamOrder: 0,
      timestampMs: 1_700_000_000_000,
      text: "Anchor this turn.",
      eventKey: "line:user-anchor:0",
      sourceOrder: "00000001:0000",
      isSyntheticSubagentInstruction: false
    });
    const commentaryEvent = {
      type: "sessionAgentMessage",
      threadId: "thr_session_canonical_dedupe",
      turnId: "turn_session_canonical_dedupe",
      streamOrder: 1,
      timestampMs: 1_700_000_000_100,
      text: "Repeated commentary from the same stable session event.",
      phase: "commentary",
      eventKey: "line:commentary:0",
      sourceOrder: "00000002:0000"
    } as const;
    await (bridge as any).handleSessionEvent(commentaryEvent);
    await (bridge as any).handleSessionEvent(commentaryEvent);

    const commentaryEvents = store
      .listCanonicalThreadEvents("thr_session_canonical_dedupe", 20)
      .filter(
        (event) =>
          event.eventKind === "content" &&
          event.itemKind === "agentCommentary" &&
          event.itemId === "session:line:commentary:0"
      );
    assert.equal(commentaryEvents.length, 1);
  } finally {
    await bridge.stop();
  }
});

test("approval requests flush earlier session commentary and command activity before posting the approval card", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never,
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      }
    )
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_approval_order",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_thr_approval_order",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Approval order thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true, skipRehydrate: true });
    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_approval_order",
      turnId: "turn_approval_order",
      streamOrder: 0,
      timestampMs: 1_699_999_999_900,
      text: "Please check the approval ordering.",
      eventKey: "evt_approval_order_user",
      sourceOrder: "00000000",
      isSyntheticSubagentInstruction: false
    });
    tailer.setEvents("thr_approval_order", [
      {
        type: "sessionAgentMessage",
        threadId: "thr_approval_order",
        turnId: "turn_approval_order",
        itemId: "item_commentary_before_approval",
        timestampMs: 1_700_000_000_000,
        text: "Commentary before approval",
        phase: "commentary"
      },
      {
        type: "shellCommandCompleted",
        threadId: "thr_approval_order",
        turnId: "turn_approval_order",
        callId: "call_before_approval",
        timestampMs: 1_700_000_000_100,
        command: "Get-Content SKILL.md",
        cwd: "C:\\repo",
        output: "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nOK",
        status: null
      }
    ]);
    await bridge.handleServerRequest({
      method: "tool/requestUserInput",
      id: "req_approval_order_1",
      params: {
        threadId: "thr_approval_order",
        turnId: "turn_approval_order",
        itemId: "item_approval_order",
        questions: [
          {
            id: "question_approval_order",
            question: "Allow the playwright MCP server to run tool \"browser_navigate\"?",
            options: [{ label: "Allow once" }, { label: "Decline" }]
          }
        ]
      }
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 750));
    await (bridge as any).drainThreadEventQueue();

    const operations = discord.operations.filter(
      (entry) => entry.channelId === "discord_channel_thr_approval_order"
    );
    const commentaryIndex = operations.findIndex((entry) =>
      entry.content?.includes("Commentary before approval")
    );
    const commandIndex = operations.findIndex((entry) =>
      entry.content?.includes("Ran 1 command")
    );
    const approvalIndex = operations.findIndex((entry) =>
      entry.type === "approval-create" &&
      entry.preview?.includes("Allow the playwright MCP server to run tool")
    );

    const operationsDump = JSON.stringify(operations, null, 2);
    assert.notEqual(commentaryIndex, -1, operationsDump);
    assert.notEqual(commandIndex, -1, operationsDump);
    assert.notEqual(approvalIndex, -1, operationsDump);
    assert.ok(commentaryIndex < approvalIndex);
    assert.ok(commandIndex < approvalIndex);
  } finally {
    await bridge.stop();
  }
});

test("session subagent spawn does not block parent-thread mirroring while child polling waits", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_spawn_async",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_spawn_async",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent thread",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  codex.metadata.set("thr_child_spawn_async", {
    cwd: "C:\\repo",
    repoName: "repo",
    parentThreadId: "thr_parent_spawn_async",
    actorName: "Euler"
  });
  codex.threadDetails.set("thr_child_spawn_async", {
    id: "thr_child_spawn_async",
    name: "Spawned helper",
    preview: "Spawned helper",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  let releaseChildPoll!: () => void;
  const childPollBlocker = new Promise<void>((resolve) => {
    releaseChildPoll = resolve;
  });
  tailer.setPollBlocker("thr_child_spawn_async", childPollBlocker);

  try {
    await bridge.start({ skipDiscovery: true });

    const handling = (bridge as any).handleSessionEvent({
      type: "sessionSubagentSpawned",
      threadId: "thr_parent_spawn_async",
      turnId: "turn_parent_spawn_async",
      childThreadId: "thr_child_spawn_async",
      childAgentName: "Euler",
      prompt: "Inspect the child thread",
      timestampMs: Date.now(),
      eventKey: "subagent-spawn:thr_child_spawn_async",
      sourceOrder: "00000001:0000"
    });

    const spawnHandlingResult = await Promise.race([
      handling.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 25))
    ]);
    assert.equal(spawnHandlingResult, "resolved");

    await (bridge as any).handleSessionEvent({
      type: "sessionAgentMessage",
      threadId: "thr_parent_spawn_async",
      turnId: "turn_parent_spawn_async",
      timestampMs: Date.now(),
      text: "Parent commentary continued after spawning the child.",
      phase: "commentary",
      eventKey: "evt_parent_commentary_after_spawn",
      sourceOrder: "00000002:0000"
    });

    assert.ok(
      discord.liveTextMessages.some(
        (message) =>
          message.channelId === "discord_channel_parent_spawn_async" &&
          message.content.includes("Parent commentary continued after spawning the child.")
      )
    );
  } finally {
    releaseChildPoll();
    await bridge.stop();
  }
});

test("app-notification child polling does not block parent hinted session polls", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_app_async",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_app_async",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent thread",
    actorName: "Codex",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  codex.metadata.set("thr_child_app_async", {
    cwd: "C:\\repo",
    repoName: "repo",
    parentThreadId: "thr_parent_app_async",
    actorName: "Turing"
  });
  codex.threadDetails.set("thr_child_app_async", {
    id: "thr_child_app_async",
    name: "Turing",
    preview: "Turing",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  let releaseChildPoll!: () => void;
  const childPollBlocker = new Promise<void>((resolve) => {
    releaseChildPoll = resolve;
  });
  tailer.setPollBlocker("thr_child_app_async", childPollBlocker);

  try {
    await bridge.start({ skipDiscovery: true });

    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_parent_app_async",
        turnId: "turn_parent_app_async",
        item: {
          id: "item_spawn_child_app_async",
          type: "commandExecution",
          collabToolCall: {
            senderThreadId: "thr_parent_app_async",
            newThreadId: "thr_child_app_async",
            prompt: "Inspect the child thread",
            agentNickname: "Turing"
          }
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue(new Set(["thr_parent_app_async"]));

    tailer.setEvents("thr_parent_app_async", [
      {
        type: "sessionUserMessage",
        threadId: "thr_parent_app_async",
        turnId: "turn_parent_app_async",
        timestampMs: Date.now(),
        streamOrder: 1,
        text: "Continue the live parent-thread check."
      },
      {
        type: "sessionAgentMessage",
        threadId: "thr_parent_app_async",
        turnId: "turn_parent_app_async",
        timestampMs: Date.now(),
        streamOrder: 2,
        text: "Parent commentary continued while the child was still loading.",
        phase: "commentary",
        eventKey: "evt_parent_app_async_commentary",
        sourceOrder: "00000002:0000"
      }
    ]);

    codex.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thr_parent_app_async",
        turnId: "turn_parent_app_async",
        itemId: "item_parent_app_async_commentary",
        delta: "Parent commentary delta."
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue(new Set(["thr_parent_app_async"]));

    const parentPollCalls = tailer.pollThreadCalls.filter(
      (call) => call.threadId === "thr_parent_app_async" && call.allowFilesystemScan === false
    );
    assert.ok(parentPollCalls.length >= 2);
    assert.ok(
      discord.sentTextMessages.some(
        (message) =>
          message.channelId === "discord_channel_parent_app_async" &&
          message.content.includes("Continue the live parent-thread check.")
      )
    );
  } finally {
    releaseChildPoll();
    await bridge.stop();
  }
});

test("session-preferred hinted polls rerun when multiple live notifications arrive before the first poll catches the new turn", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_live_turn_repoll",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_live_turn_repoll",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent thread",
    actorName: "Codex",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  let parentPollCount = 0;
  tailer.pollThread = (async (
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ) => {
    const call: {
      threadId: string;
      allowFilesystemScan?: boolean;
    } = { threadId };
    if (options.allowFilesystemScan !== undefined) {
      call.allowFilesystemScan = options.allowFilesystemScan;
    }
    tailer.pollThreadCalls.push(call);

    if (threadId !== "thr_parent_live_turn_repoll") {
      return [];
    }

    parentPollCount += 1;
    if (parentPollCount === 1) {
      return [];
    }

    if (parentPollCount === 2) {
      return [
        {
          type: "sessionUserMessage",
          threadId: "thr_parent_live_turn_repoll",
          turnId: "turn_parent_live_turn_repoll",
          timestampMs: Date.now(),
          streamOrder: 1,
          text: "rerun the usual live test",
          eventKey: "evt_parent_live_user",
          sourceOrder: "00000001:0000"
        },
        {
          type: "sessionAgentMessage",
          threadId: "thr_parent_live_turn_repoll",
          turnId: "turn_parent_live_turn_repoll",
          timestampMs: Date.now() + 1,
          streamOrder: 2,
          text: "I’m rerunning the live subagent-heavy bridge check against the current build.",
          phase: "commentary",
          eventKey: "evt_parent_live_commentary",
          sourceOrder: "00000002:0000"
        }
      ];
    }

    return [];
  }) as typeof tailer.pollThread;

  try {
    await bridge.start({ skipDiscovery: true });

    codex.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thr_parent_live_turn_repoll",
        turnId: "turn_parent_live_turn_repoll",
        itemId: "item_parent_live_turn_repoll_a",
        delta: "first live delta"
      }
    });
    codex.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thr_parent_live_turn_repoll",
        turnId: "turn_parent_live_turn_repoll",
        itemId: "item_parent_live_turn_repoll_b",
        delta: "second live delta"
      }
    });
    codex.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thr_parent_live_turn_repoll",
        turnId: "turn_parent_live_turn_repoll",
        itemId: "item_parent_live_turn_repoll_c",
        delta: "third live delta"
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue(new Set(["thr_parent_live_turn_repoll"]));

    const parentPollCalls = tailer.pollThreadCalls.filter(
      (call) => call.threadId === "thr_parent_live_turn_repoll" && call.allowFilesystemScan === false
    );
    assert.equal(parentPollCalls.length, 2);
    assert.ok(
      discord.sentTextMessages.some(
        (message) =>
          message.channelId === "discord_channel_parent_live_turn_repoll" &&
          message.content.includes("rerun the usual live test")
      )
    );
    assert.ok(
      discord.liveTextMessages.some(
        (message) =>
          message.channelId === "discord_channel_parent_live_turn_repoll" &&
          message.content.includes("I’m rerunning the live subagent-heavy bridge check")
      )
    );
  } finally {
    await bridge.stop();
  }
});

test("approval cards are disabled when Codex resolves the request", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_resolved",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_resolved",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Resolved approval thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  try {
    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: 99,
      params: {
        itemId: "approval_item_1",
        threadId: "thr_resolved",
        turnId: "turn_resolved",
        command: "npm test",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "decline"]
      }
    });

    codex.emit("notification", {
      method: "serverRequest/resolved",
      params: {
        requestId: "99"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const approval = store.findPendingApprovalByRequestId("99");
    assert.equal(approval?.status, "approved");
    assert.equal(discord.disabledApprovalCards.length, 1);
    assert.match(discord.disabledApprovalCards[0]?.resolutionText ?? "", /Decision handled in Codex/i);
  } finally {
    await bridge.stop();
  }
});

test("completed command executions are grouped into a single editable Discord message", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset(
      "full",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        ui: {
          commandDisplayMode: "full"
        }
      }
    )
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_command_group",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_command_group",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Command group thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_command_group",
        turnId: "turn_command_group",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "npm run build",
          status: "completed"
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_command_group",
        turnId: "turn_command_group",
        item: {
          type: "commandExecution",
          id: "cmd_2",
          command: "npm run test",
          status: "completed"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.liveTextMessages.length, 2);
    assert.equal(discord.liveTextMessages[0]?.action, "create");
    assert.match(discord.liveTextMessages[0]?.content ?? "", /\*\*Codex\*\*/);
    assert.doesNotMatch(discord.liveTextMessages[0]?.content ?? "", /^\s*1\.\s/m);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /1\. `npm run build`/);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /2\. `npm run test`/);
    assert.deepEqual(discord.liveTextMessages.at(-1)?.detailButtons ?? [], []);
  } finally {
    await bridge.stop();
  }
});

test("default command display mode mirrors command and file activity as a single summary message", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_activity_summary",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_activity_summary",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Activity summary thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_activity_summary",
        turnId: "turn_activity_summary",
        item: {
          type: "commandExecution",
          id: "cmd_summary_1",
          command: "npm run build",
          status: "completed"
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_activity_summary",
        turnId: "turn_activity_summary",
        item: {
          type: "fileChange",
          id: "file_summary_1",
          status: "completed",
          changes: [{ path: "src/a.ts", kind: "modified" }]
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_activity_summary",
        turnId: "turn_activity_summary",
        item: {
          type: "commandExecution",
          id: "cmd_summary_2",
          command: "npm run test",
          status: "completed"
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const latest = discord.liveTextMessages.at(-1)?.content ?? "";
    assert.match(latest, /\*\*Codex\*\*/);
    assert.match(latest, /Edited 1 file, ran 2 commands/);
    assert.deepEqual(discord.liveTextMessages.at(-1)?.detailButtons ?? [], []);
  } finally {
    await bridge.stop();
  }
});

test("activity summary starts a new Discord message after commentary in the same turn", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_activity_summary_boundary",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_activity_summary_boundary",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Activity summary boundary thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleLocalShellCommandCompleted({
      type: "shellCommandCompleted",
      threadId: "thr_activity_summary_boundary",
      turnId: "turn_activity_summary_boundary",
      callId: "call_summary_boundary_1",
      streamOrder: 1,
      timestampMs: Date.now(),
      command: "npm run build",
      cwd: "C:\\repo",
      output: "Exit code: 0",
      status: null,
      eventKey: "evt_summary_boundary_command_1",
      sourceOrder: "00000001"
    });
    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_activity_summary_boundary",
      turnId: "turn_activity_summary_boundary",
      streamOrder: 2,
      timestampMs: Date.now() + 1,
      text: "I checked the build and will inspect tests next.",
      phase: "commentary",
      eventKey: "evt_summary_boundary_commentary",
      sourceOrder: "00000002"
    });
    await (bridge as any).handleLocalShellCommandCompleted({
      type: "shellCommandCompleted",
      threadId: "thr_activity_summary_boundary",
      turnId: "turn_activity_summary_boundary",
      callId: "call_summary_boundary_2",
      streamOrder: 3,
      timestampMs: Date.now() + 2,
      command: "npm test",
      cwd: "C:\\repo",
      output: "Exit code: 0",
      status: null,
      eventKey: "evt_summary_boundary_command_2",
      sourceOrder: "00000003"
    });

    const commandSummaryCreates = discord.liveTextMessages.filter(
      (message) => message.action === "create" && /Ran 1 command/.test(message.content)
    );
    assert.equal(commandSummaryCreates.length, 2);
    assert.equal(
      discord.liveTextMessages.filter((message) => message.action === "edit" && /Ran 2 commands/.test(message.content)).length,
      0
    );
  } finally {
    await bridge.stop();
  }
});

test("activity summary omits zero-value command or file segments", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_activity_zero",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_activity_zero",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Activity zero thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_activity_zero",
        turnId: "turn_activity_zero",
        item: {
          type: "commandExecution",
          id: "cmd_only_1",
          command: "npm run build",
          status: "completed"
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const commandOnly = discord.liveTextMessages.at(-1)?.content ?? "";
    assert.match(commandOnly, /Ran 1 command/);
    assert.doesNotMatch(commandOnly, /0 files/);

    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_activity_zero",
        turnId: "turn_activity_zero",
        item: {
          type: "fileChange",
          id: "file_only_1",
          status: "completed",
          changes: [{ path: "src/a.ts", kind: "modified" }]
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const combined = discord.liveTextMessages.at(-1)?.content ?? "";
    assert.match(combined, /Edited 1 file, ran 1 command/);
  } finally {
    await bridge.stop();
  }
});

test("activity summary splits created, edited, deleted, then commands", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_activity_split",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_activity_split",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Activity split thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_activity_split",
        turnId: "turn_activity_split",
        item: {
          type: "commandExecution",
          id: "cmd_split_1",
          command: "npm run build",
          status: "completed"
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_activity_split",
        turnId: "turn_activity_split",
        item: {
          type: "fileChange",
          id: "file_split_1",
          status: "completed",
          changes: [
            { path: "src/new.ts", kind: "added" },
            { path: "src/edit.ts", kind: "modified" },
            { path: "src/old.ts", kind: "deleted" }
          ]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const latest = discord.liveTextMessages.at(-1)?.content ?? "";
    assert.match(latest, /Created 1 file, edited 1 file, deleted 1 file, ran 1 command/);
  } finally {
    await bridge.stop();
  }
});

test("activity summary counts unique edited files within the same block", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_activity_unique",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_activity_unique",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Activity unique thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_activity_unique",
        turnId: "turn_activity_unique",
        item: {
          type: "commandExecution",
          id: "cmd_unique_1",
          command: "npm run build",
          status: "completed"
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_activity_unique",
        turnId: "turn_activity_unique",
        item: {
          type: "fileChange",
          id: "file_unique_1",
          status: "completed",
          changes: [{ path: "src/shared.ts", kind: "modified" }]
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_activity_unique",
        turnId: "turn_activity_unique",
        item: {
          type: "fileChange",
          id: "file_unique_2",
          status: "completed",
          changes: [{ path: "src/shared.ts", kind: "modified" }]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const latest = discord.liveTextMessages.at(-1)?.content ?? "";
    assert.match(latest, /Edited 1 file, ran 1 command/);
    assert.doesNotMatch(latest, /Edited 2 files/);
  } finally {
    await bridge.stop();
  }
});

test("grouped command messages only show details buttons for truncated commands", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset("full", {
      allowFromDiscord: true,
      allowedUserIds: ["user_1"],
    }, {
      ui: {
        commandDisplayMode: "full",
        commandPreviewMaxLength: 45
      }
    })
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_command_buttons",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_command_buttons",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Command buttons thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  codex.threadDetails.set("thr_command_buttons", {
    id: "thr_command_buttons",
    name: "Command buttons thread",
    preview: "Command buttons thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_command_buttons",
        status: "completed",
        items: [
          {
            type: "commandExecution",
            id: "cmd_short",
            command: "npm run build",
            status: "completed"
          },
          {
            type: "commandExecution",
            id: "cmd_long",
            command: "Get-Content src\\bridge\\BridgeService.ts | Select-Object -Skip 1100 -First 260",
            status: "completed"
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_command_buttons",
        turnId: "turn_command_buttons",
        item: {
          type: "commandExecution",
          id: "cmd_long",
          command: "Get-Content src\\bridge\\BridgeService.ts | Select-Object -Skip 1100 -First 260",
          status: "completed"
        }
      }
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((discord.liveTextMessages.at(-1)?.content ?? "").includes("2. `Get-Content")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(discord.liveTextMessages.length >= 1);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /1\. `npm run build`/);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /2\. `Get-Content src\\bridge\\BridgeService\.ts/);
    assert.deepEqual(discord.liveTextMessages.at(-1)?.detailButtons ?? [], ["Cmd 2"]);
  } finally {
    await bridge.stop();
  }
});

test("completed file changes are grouped into a single editable Discord message", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset(
      "full",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        ui: {
          commandDisplayMode: "full"
        }
      }
    )
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_file_group",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_file_group",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "File group thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_file_group",
        turnId: "turn_file_group",
        item: {
          type: "fileChange",
          id: "file_1",
          status: "completed",
          changes: [{ path: "src/a.ts", kind: "modified" }]
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_file_group",
        turnId: "turn_file_group",
        item: {
          type: "fileChange",
          id: "file_2",
          status: "completed",
          changes: [{ path: "src/b.ts", kind: "added" }]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.liveTextMessages.length, 2);
    assert.equal(discord.liveTextMessages[0]?.action, "create");
    assert.match(discord.liveTextMessages[0]?.content ?? "", /^\S+ \*\*Codex\*\*/);
    assert.doesNotMatch(discord.liveTextMessages[0]?.content ?? "", /^\s*1\.\s/m);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /src\/a\.ts/);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /src\/b\.ts/);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /1\..*src\/a\.ts/s);
    assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /2\..*src\/b\.ts/s);
  } finally {
    await bridge.stop();
  }
});

test("grouped commentary messages do not resume editing an old Discord message after restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-bridge-"));
  const databasePath = path.join(dir, "bridge.sqlite");
  const threadId = "thr_group_resume";

  const seedStore = new StateStore(databasePath);
  const seedCodex = new FakeCodexAdapter();
  const seedDiscord = new FakeDiscordAdapter();
  const seedBridge = createBridgeService({
    codexAdapter: seedCodex as never,
    provider: seedDiscord as never,
    stateStore: seedStore,
  });

  seedStore.upsertThreadBridge({
    codexThreadId: threadId,
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_group_resume",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Grouped commentary thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await seedBridge.start({ skipDiscovery: true });
    seedCodex.emit("notification", {
      method: "item/completed",
      params: {
        threadId,
        turnId: "turn_group_resume",
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          id: "item-1001",
          content: [{ type: "output_text", text: "Old grouped commentary." }]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    await seedBridge.stop();
  }

  const resumeStore = new StateStore(databasePath);
  const resumeCodex = new FakeCodexAdapter();
  const resumeDiscord = new FakeDiscordAdapter();
  const resumeBridge = createBridgeService({
    codexAdapter: resumeCodex as never,
    provider: resumeDiscord as never,
    stateStore: resumeStore,
  });

  try {
    await resumeBridge.start({ skipDiscovery: true });
    resumeCodex.emit("notification", {
      method: "item/completed",
      params: {
        threadId,
        turnId: "turn_group_resume",
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          id: "item-1002",
          content: [{ type: "output_text", text: "Fresh grouped commentary." }]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(resumeDiscord.liveTextMessages.length, 1);
    assert.equal(resumeDiscord.liveTextMessages[0]?.action, "create");
    assert.match(resumeDiscord.liveTextMessages[0]?.content ?? "", /Fresh grouped commentary/);
  } finally {
    await resumeBridge.stop();
  }
});

test("edited Codex messages update the existing Discord messages", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_edit_updates",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_edit_updates",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Edit updates thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_edit_updates",
        turnId: "turn_edit_updates",
        item: {
          type: "userMessage",
          id: "item-1001",
          content: [{ type: "text", text: "Original prompt" }]
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_edit_updates",
        turnId: "turn_edit_updates",
        item: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          id: "item-1002",
          content: [{ type: "output_text", text: "Original answer" }]
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_edit_updates",
        turnId: "turn_edit_updates",
        item: {
          type: "userMessage",
          id: "item-1001",
          content: [{ type: "text", text: "Updated prompt" }]
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_edit_updates",
        turnId: "turn_edit_updates",
        item: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          id: "item-1002",
          content: [{ type: "output_text", text: "Updated answer" }]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.sentTextMessages.length, 1);
    assert.match(discord.sentTextMessages[0]?.content ?? "", /Original prompt/);
    assert.ok(
      discord.liveTextMessages.some(
        (message) =>
          message.messageId === discord.sentTextMessages[0]?.messageId &&
          message.action === "edit" &&
          /Updated prompt/.test(message.content)
      )
    );
    assert.equal(
      discord.liveTextMessages.filter((message) => /Updated answer/.test(message.content)).length,
      1
    );
  } finally {
    await bridge.stop();
  }
});

test("assistant completion pre-syncs the current turn so the user prompt is mirrored first", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  store.upsertThreadBridge({
    codexThreadId: "thr_presync",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_presync",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Pre-sync thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  codex.threadDetails.set("thr_presync", {
    id: "thr_presync",
    name: "Pre-sync thread",
    preview: "Pre-sync thread",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_presync",
        createdAt: nowSeconds,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_presync",
            createdAt: nowSeconds,
            content: [{ type: "text", text: "Please add timestamps." }]
          },
          {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            id: "assistant_presync",
            createdAt: nowSeconds + 1,
            content: [{ type: "output_text", text: "Timestamps are added." }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_presync",
        turnId: "turn_presync",
        item: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          id: "assistant_presync",
          createdAt: nowSeconds + 1,
          content: [{ type: "output_text", text: "Timestamps are added." }]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.sentTextMessages.length, 1);
    assert.match(discord.sentTextMessages[0]?.content ?? "", /Please add timestamps/);
    const finalMessage = discord.liveTextMessages.find((message) => /Timestamps are added/.test(message.content));
    assert.ok(finalMessage);
    assert.match(finalMessage?.content ?? "", /^# .*?\*\*Codex\*\*\n\[[0-9:]{8}\] Timestamps are added./);
  } finally {
    await bridge.stop();
  }
});

test("bridge mirrors completed user messages into the Discord chat stream", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_user",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_user",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_user",
        turnId: "turn_user",
        item: {
          type: "userMessage",
          id: "user_msg_1",
          createdAt: nowSeconds,
          content: [
            {
              type: "text",
              text: "Please review the onboarding flow in (/C:/Users/Natale/Desktop/projects/codex-mobile/test/bridge.integration.test.ts)."
            }
          ]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.sentTextMessages.length, 1);
    const mirrored = discord.sentTextMessages[0]?.content ?? "";
    assert.match(mirrored, /^# .*?\*\*You\*\*\n\[[0-9:]{8}\] Please review the onboarding flow/i);
    assert.doesNotMatch(mirrored, /^# .*onboarding flow.*$/m);
    assert.match(mirrored, /\*bridge\.integration\.test\.ts\*/);
    assert.doesNotMatch(mirrored, /\/C:\/Users\/Natale/i);
  } finally {
    await bridge.stop();
  }
});

test("session sub-agent notification envelopes are not mirrored as raw user text and do not create child ownership directly", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_parent",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_parent",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent thread",
    lastStatusType: "idle",
      channelKind: "conversation"
  });

  try {
    const nowMs = Date.now();
    codex.threadDetails.set("thr_child", {
      id: "thr_child",
      name: "Worker child",
      preview: "Worker child",
      modelProvider: null,
      createdAt: Math.floor(nowMs / 1000),
      updatedAt: Math.floor(nowMs / 1000),
      ephemeral: false,
      status: { type: "idle" as const }
    });
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleSessionEvent({
      type: "sessionUserMessage",
      threadId: "thr_parent",
      turnId: "turn_parent",
      timestampMs: nowMs,
      text: '<subagent_notification>{"agent_path":"thr_child","status":{"completed":"Worker finished."}}</subagent_notification>'
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue(new Set(["thr_parent"]));

    assert.equal(store.getThreadBridge("thr_child"), undefined);
    assert.equal(store.getChildThreadAnchor("thr_child"), null);
    assert.equal(discord.threadChannelIds.has("discord_subagent_1"), false);

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.doesNotMatch(mirrored, /subagent_notification/i);
    assert.doesNotMatch(mirrored, /agent_path/i);
  } finally {
    await bridge.stop();
  }
});

test("session sub-agent notification envelopes do not reattach stale readable child threads from older activity", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_stale",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_parent_stale",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent stale thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const nowMs = Date.now();
  codex.threadDetails.set("thr_child_stale", {
    id: "thr_child_stale",
    name: "Stale child",
    preview: "Stale child",
    modelProvider: null,
    createdAt: Math.floor((nowMs - 10 * 60_000) / 1000),
    updatedAt: Math.floor((nowMs - 10 * 60_000) / 1000),
    ephemeral: false,
    status: { type: "idle" as const }
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleSessionEvent({
      type: "sessionUserMessage",
      threadId: "thr_parent_stale",
      turnId: "turn_parent_stale",
      timestampMs: nowMs,
      text: '<subagent_notification>{"agent_path":"thr_child_stale","status":{"completed":"Old worker finished."}}</subagent_notification>'
    });

    assert.equal(store.getThreadBridge("thr_child_stale"), undefined);
    assert.equal(discord.threadChannelIds.size, 0);
  } finally {
    await bridge.stop();
  }
});

test("session sub-agent notification envelopes do not reattach unreadable child threads", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_unreadable",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_parent_unreadable",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent unreadable thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  codex.readThreadErrors.set("thr_child_unreadable", new Error("thread not loaded"));

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleSessionEvent({
      type: "sessionUserMessage",
      threadId: "thr_parent_unreadable",
      turnId: "turn_parent_unreadable",
      timestampMs: Date.now(),
      text: '<subagent_notification>{"agent_path":"thr_child_unreadable","status":{"completed":"Old worker finished."}}</subagent_notification>'
    });

    assert.equal(store.getThreadBridge("thr_child_unreadable"), undefined);
    assert.equal(discord.threadChannelIds.size, 0);
  } finally {
    await bridge.stop();
  }
});

test("session turn_aborted envelopes render as cleaned final messages", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_abort",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_abort",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Abort thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleSessionEvent({
      type: "sessionUserMessage",
      threadId: "thr_abort",
      turnId: "turn_abort",
      timestampMs: Date.now(),
      text: "<turn_aborted>The user interrupted this run.</turn_aborted>"
    });

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.match(mirrored, /Turn Aborted/);
    assert.doesNotMatch(mirrored, /<turn_aborted>/);
    assert.doesNotMatch(mirrored, /<\/turn_aborted>/);
  } finally {
    await bridge.stop();
  }
});

test("duplicate same-turn user messages from different session event ids are mirrored once", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_dupe",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_dupe",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Duplicate thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleSessionEvent({
      type: "sessionUserMessage",
      eventKey: "response-message:item-1",
      sourceOrder: "0000000000000001:0001",
      threadId: "thr_dupe",
      turnId: "turn_dupe",
      timestampMs: Date.now(),
      text: "Run the exact same request twice."
    });
    await (bridge as any).handleSessionEvent({
      type: "sessionUserMessage",
      eventKey: "event-msg:item-2",
      sourceOrder: "0000000000000002:0002",
      threadId: "thr_dupe",
      turnId: "turn_dupe",
      timestampMs: Date.now() + 1000,
      text: "Run the exact same request twice.\n<image>\n[image]\n</image>"
    });

    assert.equal(discord.sentTextMessages.length, 1);
    assert.match(discord.sentTextMessages[0]?.content ?? "", /Run the exact same request twice\./);
    assert.doesNotMatch(discord.sentTextMessages[0]?.content ?? "", /<image>|\[image\]/i);
  } finally {
    await bridge.stop();
  }
});

