import {
  test,
  assert,
  createBridgeConfigFromPreset,
  testApprovalsConfig,
  FakeSessionEventTailer,
  createBridgeTestRig,
  FakeDiscordAdapter
} from "./helpers/bridgeIntegration.js";

test("cold start imports recent unique conversations up to the 25-thread cap and posts status cards immediately", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  const recentNames = [
    "Summarize repo status",
    "Summarize repo status",
    "Review user-facing app",
    "Clarify timeline granularity levels",
    "Assess UI polish needs",
    "Describe restarting assistant thread",
    "Audit repo for bugs and gaps",
    "Build next.js manuscript analyzer",
    "Create a one page pdf",
    "How to pick movies that are more popular",
    "Review the new blockchain folder",
    "Rewrite onboarding copy"
  ];

  codex.threads = recentNames.map((name, index) => ({
    id: `thr_${index + 1}`,
    name,
    preview: name,
    modelProvider: null,
    createdAt: nowSeconds - index * 60,
    updatedAt: nowSeconds - index * 60,
    ephemeral: false,
    status: { type: "idle" as const }
  }));
  codex.threads.push({
    id: "thr_old",
    name: "Very old thread",
    preview: "Very old thread",
    modelProvider: null,
    createdAt: nowSeconds - 72 * 60 * 60,
    updatedAt: nowSeconds - 72 * 60 * 60,
    ephemeral: false,
    status: { type: "idle" as const }
  });

  for (const thread of codex.threads) {
    codex.metadata.set(thread.id, { cwd: "C:\\write", repoName: "write" });
  }

  try {
    await bridge.start();

    const imported = store.listThreadBridgesByKind("conversation");
    assert.equal(imported.length, 11);
    assert.ok(imported.some((record) => record.codexThreadId === "thr_1"));
    assert.ok(!imported.some((record) => record.codexThreadId === "thr_2"));
    assert.ok(!imported.some((record) => record.codexThreadId === "thr_old"));
    assert.equal(discord.statusCardChannelIds.length, 11);
    assert.equal(discord.milestoneMessages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("cold start imports notLoaded threads with missing timestamps as fallback candidates", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  codex.threads = [
    {
      id: "thr_not_loaded_1",
      name: "Not loaded one",
      preview: "Not loaded one",
      modelProvider: null,
      createdAt: null,
      updatedAt: null,
      ephemeral: false,
      status: { type: "notLoaded" as const }
    },
    {
      id: "thr_not_loaded_2",
      name: "Not loaded two",
      preview: "Not loaded two",
      modelProvider: null,
      createdAt: null,
      updatedAt: null,
      ephemeral: false,
      status: { type: "notLoaded" as const }
    },
    {
      id: "thr_not_loaded_3",
      name: "Not loaded three",
      preview: "Not loaded three",
      modelProvider: null,
      createdAt: null,
      updatedAt: null,
      ephemeral: false,
      status: { type: "notLoaded" as const }
    }
  ] as any;

  for (const thread of codex.threads) {
    codex.metadata.set(thread.id, { cwd: "C:\\write", repoName: "write" });
  }

  try {
    await bridge.start();

    const imported = store.listThreadBridgesByKind("conversation");
    assert.equal(imported.length, 3);
    assert.ok(imported.some((record) => record.codexThreadId === "thr_not_loaded_1"));
    assert.ok(imported.some((record) => record.codexThreadId === "thr_not_loaded_2"));
    assert.ok(imported.some((record) => record.codexThreadId === "thr_not_loaded_3"));
    assert.equal(discord.statusCardChannelIds.length, 3);
  } finally {
    await bridge.stop();
  }
});

test("cold start backfills startup history only for the newest five imported local-session threads", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const threads = Array.from({ length: 6 }, (_, index) => ({
    id: `thr_priority_${index + 1}`,
    name: `Unique thread ${index + 1}`,
    preview: `Unique thread ${index + 1}`,
    modelProvider: null,
    createdAt: nowSeconds - index * 60,
    updatedAt: nowSeconds - index * 60,
    ephemeral: false,
    status: { type: "idle" as const }
  }));
  codex.threads = threads;
  tailer.setLocalThreads(
    threads.map((thread) => ({
      threadId: thread.id,
      name: thread.name,
      preview: thread.preview,
      cwd: "C:\\write",
      repoName: "write",
      createdAtMs: (thread.createdAt ?? nowSeconds) * 1000,
      updatedAtMs: (thread.updatedAt ?? nowSeconds) * 1000,
      status: "idle" as const,
      filePath: `${thread.id}.jsonl`,
      sourceKind: "app-server" as const,
      parentThreadId: null,
      actorName: null
    }))
  );

  for (const thread of threads) {
    codex.metadata.set(thread.id, { cwd: "C:\\write", repoName: "write" });
    tailer.setLatestTurnBackfillEvents(thread.id, [
      {
        type: "sessionUserMessage",
        threadId: thread.id,
        turnId: `turn_${thread.id}`,
        timestampMs: (thread.updatedAt ?? nowSeconds) * 1000,
        text: `User ${thread.id}`
      },
      {
        type: "sessionAgentMessage",
        threadId: thread.id,
        turnId: `turn_${thread.id}`,
        timestampMs: (thread.updatedAt ?? nowSeconds) * 1000 + 1,
        text: `Assistant ${thread.id}`,
        phase: "final"
      }
    ]);
  }

  try {
    await bridge.start();

    assert.equal(store.listThreadBridgesByKind("conversation").length, 6);
    assert.equal(
      discord.statusCardChannelIds.length,
      11,
      "the five fully backfilled cold-start threads should get an initial and final status flush, while the deferred sixth thread should only get the initial status card"
    );
    assert.ok(store.listMirroredItems("thr_priority_1").length > 0);
    assert.ok(store.listMirroredItems("thr_priority_2").length > 0);
    assert.ok(store.listMirroredItems("thr_priority_3").length > 0);
    assert.ok(store.listMirroredItems("thr_priority_4").length > 0);
    assert.ok(store.listMirroredItems("thr_priority_5").length > 0);
    assert.equal(store.listMirroredItems("thr_priority_6").length, 0);
  } finally {
    await bridge.stop();
  }
});

test("startup refresh skips mapped threads that Codex now reports as archived", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_archived_mapped",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_archived_mapped",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Archived mapped thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  codex.threadDetails.set("thr_archived_mapped", {
    id: "thr_archived_mapped",
    name: "Archived mapped thread",
    preview: "Archived mapped thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    archived: true,
    status: { type: "idle" as const },
    turns: []
  });

  try {
    await bridge.start();

    assert.deepEqual(codex.readThreadCalls, ["thr_archived_mapped"]);
    assert.equal(discord.statusCardChannelIds.length, 0);
    assert.equal(discord.sentTextMessages.length, 0);
    assert.equal(discord.liveTextMessages.length, 0);
    assert.equal(codex.resumedThreadIds.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("local session event polling does not block on slow Discord event handling", async () => {
  const tailer = new FakeSessionEventTailer();
  class SlowApprovalDiscordAdapter extends FakeDiscordAdapter {
    override async postApprovalCard() {
      return await new Promise<string>(() => undefined);
    }
  }
  const discord = new SlowApprovalDiscordAdapter();
  const { store, bridge } = createBridgeTestRig({
    discord,
    sessionEventTailer: tailer
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_slow_session_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_thr_slow_session_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  tailer.setEvents("thr_slow_session_1", [
    {
      type: "shellApprovalRequested",
      threadId: "thr_slow_session_1",
      callId: "call_slow_1",
      timestampMs: Date.now(),
      command: "Get-Date -Format o",
      cwd: "C:\\repo",
      justification: "Allow a harmless timestamp command.",
      details: "{\"command\":\"Get-Date -Format o\"}"
    }
  ]);

  try {
    const completed = await Promise.race([
      (bridge as any).pollLocalSessionEvents().then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50))
    ]);

    assert.equal(completed, "completed");
    assert.equal(store.listPendingApprovals().length, 1);
  } finally {
    await bridge.stop();
  }
});

test("routine local session polling does not run recursive filesystem scans", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_routine_scan_parent",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_thr_routine_scan_parent",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent",
    lastStatusType: "active",
    channelKind: "conversation"
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_routine_scan_child",
    parentCodexThreadId: "thr_routine_scan_parent",
    parentAnchorTurnId: "turn_parent",
    parentAnchorTurnCursor: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_thread_thr_routine_scan_child",
    discordParentChannelId: "discord_channel_thr_routine_scan_parent",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Child",
    actorName: "Child",
    lastStatusType: "active",
    channelKind: "subagent"
  });
  tailer.setFilesystemScanPollBlocker("thr_routine_scan_child", new Promise<void>(() => undefined));

  const completed = await Promise.race([
    (bridge as any).pollLocalSessionEvents().then(() => "completed"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50))
  ]);

  assert.equal(completed, "completed");
  assert.deepEqual(
    tailer.pollThreadCalls.map((call) => ({
      threadId: call.threadId,
      allowFilesystemScan: call.allowFilesystemScan
    })).sort((left, right) => left.threadId.localeCompare(right.threadId)),
    [
      { threadId: "thr_routine_scan_child", allowFilesystemScan: false },
      { threadId: "thr_routine_scan_parent", allowFilesystemScan: false }
    ]
  );
});

test("live discovery selection does not run recursive metadata or parent scans", async () => {
  const tailer = new FakeSessionEventTailer();
  const threadId = "thr_live_scan_select";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer
  });

  store.upsertThreadBridge({
    codexThreadId: threadId,
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: `discord_channel_${threadId}`,
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date((nowSeconds + 1) * 1000).toISOString(),
    attachMode: "auto",
    sourceKind: "app-server",
    threadName: "Thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });
  discord.conversationChannelIds.add(`discord_channel_${threadId}`);
  codex.threads = [
    {
      id: threadId,
      name: "Thread",
      preview: "Preview",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.setFilesystemScanMetadataBlocker(threadId, new Promise<void>(() => undefined));
  tailer.setFilesystemScanParentThreadBlocker(threadId, new Promise<void>(() => undefined));

  try {
    await bridge.start({ skipDiscovery: true });

    const completed = await Promise.race([
      (bridge as any).runDiscoveryCycleInternal(false).then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50))
    ]);

    assert.equal(completed, "completed");
    assert.deepEqual(
      codex.resolveMetadataCalls.map((call) => ({
        threadId: call.threadId,
        allowFilesystemScan: call.allowFilesystemScan
      })),
      [{ threadId, allowFilesystemScan: false }]
    );
    assert.deepEqual(
      tailer.resolveParentThreadIdCalls.map((call) => ({
        threadId: call.threadId,
        allowFilesystemScan: call.allowFilesystemScan
      })),
      [{ threadId, allowFilesystemScan: false }]
    );
  } finally {
    await bridge.stop();
  }
});

test("live subagent refresh does not seed a stable Codex frontier or resume via app-server", async () => {
  const tailer = new FakeSessionEventTailer();
  const parentThreadId = "thr_live_subagent_parent";
  const childThreadId = "thr_live_subagent_child";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer
  });

  store.upsertThreadBridge({
    codexThreadId: parentThreadId,
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: `discord_channel_${parentThreadId}`,
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date((nowSeconds - 60) * 1000).toISOString(),
    attachMode: "auto",
    sourceKind: "app-server",
    threadName: "Parent",
    lastStatusType: "active",
    channelKind: "conversation"
  });
  store.upsertThreadBridge({
    codexThreadId: childThreadId,
    parentCodexThreadId: parentThreadId,
    parentAnchorTurnId: "turn_parent",
    parentAnchorTurnCursor: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: `discord_thread_${childThreadId}`,
    discordParentChannelId: `discord_channel_${parentThreadId}`,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date((nowSeconds - 60) * 1000).toISOString(),
    attachMode: "auto",
    sourceKind: "app-server",
    threadName: "Child",
    actorName: "Child",
    lastStatusType: "idle",
    channelKind: "subagent"
  });
  discord.conversationChannelIds.add(`discord_channel_${parentThreadId}`);
  discord.threadChannelIds.add(`discord_thread_${childThreadId}`);
  codex.threads = [
    {
      id: childThreadId,
      name: "Child",
      preview: "Preview",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set(childThreadId, {
    cwd: "C:\\repo",
    repoName: "repo",
    threadName: "Child",
    actorName: "Child",
    parentThreadId
  });
  codex.setFilesystemScanMetadataBlocker(childThreadId, new Promise<void>(() => undefined));
  codex.setReadThreadBlocker(childThreadId, new Promise<void>(() => undefined));
  codex.resumeDelayMsByThread.set(childThreadId, 10_000);
  discord.setSubagentEnsureBlocker(childThreadId, new Promise<void>(() => undefined));

  try {
    await bridge.start({ skipDiscovery: true });

    const completed = await Promise.race([
      (bridge as any).runDiscoveryCycleInternal(false).then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50))
    ]);

    assert.equal(completed, "completed");
    assert.ok(
      codex.resolveMetadataCalls
        .filter((call) => call.threadId === childThreadId)
        .every((call) => call.allowFilesystemScan === false)
    );
    assert.equal(codex.readThreadCalls.includes(childThreadId), false);
    assert.equal(codex.resumedThreadIds.includes(childThreadId), false);
    assert.equal(discord.subagentEnsureCalls.includes(childThreadId), false);
  } finally {
    await bridge.stop();
  }
});

test("live conversation refresh reuses a stable mapped Discord channel", async () => {
  const tailer = new FakeSessionEventTailer();
  const threadId = "thr_live_conversation_reuse";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer
  });

  store.upsertThreadBridge({
    codexThreadId: threadId,
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: `discord_channel_${threadId}`,
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date((nowSeconds - 60) * 1000).toISOString(),
    attachMode: "auto",
    sourceKind: "app-server",
    threadName: "Stable Parent",
    actorName: "Codex",
    lastStatusType: "active",
    channelKind: "conversation"
  });
  discord.conversationChannelIds.add(`discord_channel_${threadId}`);
  codex.threads = [
    {
      id: threadId,
      name: "Stable Parent",
      preview: "Preview",
      modelProvider: null,
      createdAt: nowSeconds - 60,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set(threadId, {
    cwd: "C:\\repo",
    repoName: "repo",
    threadName: "Stable Parent",
    actorName: null,
    parentThreadId: null
  });
  codex.setFilesystemScanMetadataBlocker(threadId, new Promise<void>(() => undefined));

  let providerEnsureCalled = false;
  discord.ensureConversationChannel = (async () => {
    providerEnsureCalled = true;
    await new Promise<void>(() => undefined);
    return { id: `discord_channel_${threadId}`, created: false };
  }) as typeof discord.ensureConversationChannel;

  try {
    await bridge.start({ skipDiscovery: true });

    const completed = await Promise.race([
      (bridge as any).runDiscoveryCycleInternal(false).then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50))
    ]);

    assert.equal(completed, "completed");
    assert.equal(providerEnsureCalled, false);
    assert.ok(
      codex.resolveMetadataCalls
        .filter((call) => call.threadId === threadId)
        .every((call) => call.allowFilesystemScan === false)
    );
  } finally {
    await bridge.stop();
  }
});

test("live discovery does not block on slow queued session mirroring", async () => {
  const tailer = new FakeSessionEventTailer();
  class SlowMirrorDiscordAdapter extends FakeDiscordAdapter {
    private releaseWrite: (() => void) | null = null;
    private readonly writeBlocker = new Promise<void>((resolve) => {
      this.releaseWrite = resolve;
    });

    releaseQueuedWrite() {
      this.releaseWrite?.();
    }

    override async upsertLiveTextMessage(
      channelId: string,
      messageId: string | null,
      content: string,
      options: { detailButtons?: Array<{ label: string }> } = {}
    ) {
      await this.writeBlocker;
      return super.upsertLiveTextMessage(channelId, messageId, content, options);
    }

    override async sendTextMessage(
      channelId: string,
      content: string,
      options: { detailButtons?: Array<{ label: string }> } = {}
    ) {
      await this.writeBlocker;
      return super.sendTextMessage(channelId, content, options);
    }
  }
  const discord = new SlowMirrorDiscordAdapter();
  const threadId = "thr_live_slow_queue";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { store, codex, bridge } = createBridgeTestRig({
    discord,
    sessionEventTailer: tailer
  });

  store.upsertThreadBridge({
    codexThreadId: threadId,
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: `discord_channel_${threadId}`,
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  discord.conversationChannelIds.add(`discord_channel_${threadId}`);
  codex.threads = [
    {
      id: threadId,
      name: "Thread",
      preview: "Preview",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.threadDetails.set(threadId, {
    id: threadId,
    name: "Thread",
    preview: "Preview",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  try {
    await bridge.start({ skipDiscovery: true });
    tailer.setEvents(threadId, [
      {
        type: "sessionUserMessage",
        threadId,
        turnId: "turn_live_slow_queue",
        timestampMs: Date.now(),
        text: "message that should mirror after discovery returns",
        sourceOrder: "1",
        eventKey: "line:1:0",
        streamOrder: 0
      }
    ]);

    const completed = await Promise.race([
      (bridge as any).runDiscoveryCycle(false).then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50))
    ]);

    assert.equal(completed, "completed");
    assert.equal(discord.liveTextMessages.length + discord.sentTextMessages.length, 0);

    discord.releaseQueuedWrite();
    await (bridge as any).drainThreadEventQueue(new Set([threadId]));

    assert.equal(discord.liveTextMessages.length + discord.sentTextMessages.length, 1);
  } finally {
    discord.releaseQueuedWrite();
    await bridge.stop();
  }
});

test("when a project category is full, the bridge evicts the oldest mapped conversation before adding a new one", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  for (let index = 1; index <= 20; index += 1) {
    const threadId = `old_${index}`;
    const channelId = `discord_channel_${threadId}`;
    discord.conversationChannelIds.add(channelId);
    store.upsertThreadBridge({
      codexThreadId: threadId,
      parentCodexThreadId: null,
      projectKey: "c:\\write",
      projectName: "write",
      discordChannelId: channelId,
      discordParentChannelId: null,
      statusMessageId: null,
      cwd: "C:\\write",
      repoName: "write",
      lastSeenAt: new Date(Date.now() - (21 - index) * 60_000).toISOString(),
      attachMode: "auto",
      threadName: `Old ${index}`,
      lastStatusType: "idle",
      channelKind: "conversation"
    });
  }

  codex.threads = [
    {
      id: "new_thread",
      name: "Brand new thread",
      preview: "Brand new thread",
      modelProvider: null,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("new_thread", { cwd: "C:\\write", repoName: "write" });

  try {
    await bridge.start();

    assert.ok(discord.deletedLocationIds.includes("discord_channel_old_1"));
    assert.equal(discord.conversationChannelIds.size, 20);
    assert.ok(store.getThreadBridge("new_thread"));
    assert.equal(store.getThreadBridge("old_1"), undefined);
  } finally {
    await bridge.stop();
  }
});

test("terminal clean deletes bridge-managed Discord structure and clears local state", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertProjectBridge({
    projectKey: "c:\\write",
    projectName: "write",
    discordCategoryId: "discord_category_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "old_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_old_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Old thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  discord.conversationChannelIds.add("discord_channel_old_thread");
  discord.discoveredChannelIds.add("discord_channel_old_thread");
  discord.discoveredCategoryIds.add("discord_category_1");

  try {
    await bridge.start();
    const progress: string[] = [];
    const result = await bridge.cleanBridgeState((message) => {
      progress.push(message);
    });

    assert.equal(result.deletedLocations, 1);
    assert.equal(result.deletedCategories, 1);
    assert.match(progress[0] ?? "", /Found 1 mapped Discord locations/);
    assert.ok(progress.some((message) => /Deleting mapped location 1\/1/.test(message)));
    assert.ok(progress.some((message) => /Found 0 orphaned channels and 1 categories/.test(message)));
    assert.match(progress.at(-1) ?? "", /Done\. Deleted 1 channels\/threads and 1 categories\./);
    assert.ok(discord.deletedLocationIds.includes("discord_channel_old_thread"));
    assert.ok(discord.deletedLocationIds.includes("discord_category_1"));
    assert.equal(store.listThreadBridges().length, 0);
    assert.equal(store.listProjectBridges().length, 0);
  } finally {
    await bridge.stop();
  }
});

test("terminal clean does not seed category deletion from unowned project bridges", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertProjectBridge({
    projectKey: "c:\\manual",
    projectName: "manual",
    discordCategoryId: "discord_category_1",
    createdByBridge: false,
    updatedAt: new Date().toISOString()
  });

  try {
    await bridge.start();
    const result = await bridge.cleanBridgeState();

    assert.equal(result.deletedLocations, 0);
    assert.equal(result.deletedCategories, 0);
    assert.ok(!discord.deletedLocationIds.includes("discord_category_1"));
    assert.equal(store.listProjectBridges().length, 0);
  } finally {
    await bridge.stop();
  }
});

test("terminal clean can delete discovered bridge-managed Discord channels even when local mappings are empty", async () => {
  const { discord, bridge } = createBridgeTestRig();

  discord.discoveredChannelIds.add("discord_channel_orphaned");
  discord.discoveredCategoryIds.add("discord_category_orphaned");

  try {
    await bridge.start({ skipDiscovery: true });
    const result = await bridge.cleanBridgeState();

    assert.equal(result.deletedLocations, 1);
    assert.equal(result.deletedCategories, 1);
    assert.ok(discord.deletedLocationIds.includes("discord_channel_orphaned"));
    assert.ok(discord.deletedLocationIds.includes("discord_category_orphaned"));
  } finally {
    await bridge.stop();
  }
});

test("mapped-only terminal clean skips global Discord orphan discovery", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertProjectBridge({
    projectKey: "e2e::c:\\write",
    projectName: "e2e-run write",
    discordCategoryId: "discord_category_e2e",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  discord.discoveredChannelIds.add("discord_channel_live_bridge");
  discord.discoveredCategoryIds.add("discord_category_live_bridge");

  try {
    await bridge.start({ skipDiscovery: true });
    const progress: string[] = [];
    const result = await bridge.cleanBridgeState((message) => progress.push(message), {
      discoverOrphans: false
    });

    assert.equal(result.deletedLocations, 0);
    assert.equal(result.deletedCategories, 1);
    assert.ok(discord.deletedLocationIds.includes("discord_category_e2e"));
    assert.ok(!discord.deletedLocationIds.includes("discord_channel_live_bridge"));
    assert.ok(!discord.deletedLocationIds.includes("discord_category_live_bridge"));
    assert.ok(progress.some((message) => /Skipping global orphan scan/.test(message)));
  } finally {
    await bridge.stop();
  }
});

test("scoped mapped-only clean does not trust polluted mapped channel ids outside the e2e scope", async () => {
  const { store, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      testApprovalsConfig("user_1"),
      {
        discovery: {
          allowedThreadIds: ["runner_thread"],
          projectNamePrefix: "e2e-run"
        }
      }
    )
  });

  store.upsertProjectBridge({
    projectKey: "e2e-run::c:\\write",
    projectName: "e2e-run write",
    discordCategoryId: "discord_category_e2e",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "runner_thread",
    parentCodexThreadId: null,
    projectKey: "e2e-run::c:\\write",
    projectName: "e2e-run write",
    discordChannelId: "discord_channel_live_bridge",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Runner thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  discord.conversationChannelIds.add("discord_channel_live_bridge");
  discord.discoveredChannelIds.add("discord_channel_e2e_scoped");

  try {
    await bridge.start({ skipDiscovery: true });
    const progress: string[] = [];
    const result = await bridge.cleanBridgeState((message) => progress.push(message), {
      discoverOrphans: false
    });

    assert.equal(result.deletedLocations, 1);
    assert.equal(result.deletedCategories, 1);
    assert.ok(discord.deletedLocationIds.includes("discord_channel_e2e_scoped"));
    assert.ok(discord.deletedLocationIds.includes("discord_category_e2e"));
    assert.ok(!discord.deletedLocationIds.includes("discord_channel_live_bridge"));
    assert.deepEqual(discord.discoverBridgeManagedLocationsCalls.at(-1), {
      seedCategoryIds: ["discord_category_e2e"],
      options: {
        restrictToSeedCategories: true,
        requiredScope: "e2e-run"
      }
    });
    assert.ok(progress.some((message) => /Skipping direct mapped-location deletion/.test(message)));
  } finally {
    await bridge.stop();
  }
});

