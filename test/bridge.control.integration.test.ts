import {
  test,
  assert,
  mkdtempSync,
  path,
  tmpdir,
  createBridgeConfigFromPreset,
  Policy,
  StateStore,
  LIVE_E2E_IGNORE_HELPER_COMMANDS_ENV,
  ACCEPT_PROPOSED_PLAN_LABEL,
  TELL_CODEX_DIFFERENTLY_LABEL,
  testApprovalsConfig,
  FakeCodexAdapter,
  FakeSessionEventTailer,
  createBridgeTestRig,
  createBridgeService,
  FakeDesktopIpcClient,
  linkDesktopFeedbackVisibility,
  FakeDiscordAdapter
} from "./helpers/bridgeIntegration.js";

test("bridge routes approval actions to the exact Codex request", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_1",
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

  try {
    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: 42,
      params: {
        itemId: "item_1",
        threadId: "thr_1",
        turnId: "turn_1",
        command: "npm test",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "decline"]
      }
    });

    const approval = store.listPendingApprovals()[0];
    assert.ok(approval);
    const result = await bridge.handleApprovalAction("user_1", approval.token, "accept");

    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [{ requestId: "42", result: { decision: "accept" } }]);
  } finally {
    await bridge.stop();
  }
});

test("concurrent approval and discovery hydration reuse one Discord conversation channel", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  const summary = {
    id: "thr_hydrate_race",
    name: "Main",
    preview: "Main",
    modelProvider: null,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] }
  };
  codex.threads = [summary];
  codex.threadDetails.set("thr_hydrate_race", summary);
  codex.metadata.set("thr_hydrate_race", {
    cwd: "C:\\repo\\write",
    repoName: "write",
    threadName: "Main",
    actorName: null,
    parentThreadId: null
  });

  const createdChannelIds: string[] = [];
  discord.ensureConversationChannel = async (
    codexThreadId: string,
    title?: string,
    categoryId?: string,
    existingDiscordChannelId?: string | null
  ) => {
    discord.conversationEnsureCalls.push(codexThreadId);
    discord.conversationEnsureRequests.push({
      codexThreadId,
      title,
      categoryId,
      existingDiscordChannelId
    });
    if (existingDiscordChannelId && discord.conversationChannelIds.has(existingDiscordChannelId)) {
      return { id: existingDiscordChannelId, created: false };
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
    const id = `discord_racy_channel_${createdChannelIds.length + 1}`;
    createdChannelIds.push(id);
    discord.conversationChannelIds.add(id);
    return { id, created: true };
  };

  try {
    await bridge.start({ skipDiscovery: true });
    await Promise.all([
      (bridge as any).maybeAttachThread(
        {
          summary,
          source: "app-server"
        },
        false,
        true
      ),
      bridge.handleServerRequest({
        method: "mcpServer/elicitation/request",
        id: "mcp_hydrate_race",
        params: {
          threadId: "thr_hydrate_race",
          turnId: "turn_hydrate_race",
          itemId: "item_hydrate_race",
          message: "Allow the test MCP server to run?"
        }
      })
    ]);

    assert.deepEqual(createdChannelIds, ["discord_racy_channel_1"]);
    assert.equal(store.getThreadBridge("thr_hydrate_race")?.discordChannelId, "discord_racy_channel_1");
    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.channelId, "discord_racy_channel_1");
    assert.equal(
      discord.conversationEnsureRequests.some(
        (request) => request.existingDiscordChannelId === "discord_racy_channel_1"
      ),
      true
    );
  } finally {
    await bridge.stop();
  }
});

test("missing Discord approval cards do not crash Desktop approval removal", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_missing_approval_card",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_missing_approval_card",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });
  store.upsertPendingApproval({
    token: "token_missing_approval_card",
    requestId: "request_missing_approval_card",
    threadId: "thr_missing_approval_card",
    turnId: "turn_missing_approval_card",
    feedbackTurnId: "turn_missing_approval_card",
    itemId: "item_missing_approval_card",
    kind: "mcpElicitation",
    sanitizedPreview: "Allow the test MCP server to run?",
    cwd: null,
    reason: null,
    availableDecisions: ["accept", "decline"],
    decisionPayloads: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    discordMessageId: "missing_approval_message",
    status: "pending",
    details: "{}",
    createdAt: new Date().toISOString()
  });
  discord.disableApprovalCard = async () => {
    const error = new Error("Unknown Message") as Error & { code?: number };
    error.code = 10008;
    throw error;
  };

  try {
    await (bridge as any).handleDesktopIpcRequestRemoved({
      threadId: "thr_missing_approval_card",
      requestId: "request_missing_approval_card",
      request: {
        method: "mcpServer/elicitation/request"
      }
    } as never);

    assert.equal(store.findPendingApprovalByRequestId("request_missing_approval_card")?.status, "stale");
  } finally {
    await bridge.stop();
  }
});

test("provider control commands require an authorized Discord actor", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_control_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_control_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  discord.conversationChannelIds.add("discord_channel_control_1");

  try {
    await bridge.start({ providerOnly: true });
    assert.ok(discord.handlers);

    const result = await discord.handlers.onCleanAllCommand({
      userId: "user_2",
      roleIds: [],
      username: "intruder"
    });

    assert.equal(result.ephemeral, true);
    assert.match(result.content, /not allowed to control the Codex bridge/i);
    assert.deepEqual(discord.deletedLocationIds, []);
    assert.ok(store.getThreadBridge("thr_control_1"));
    assert.equal(store.listProjectBridges().length, 1);
  } finally {
    await bridge.stop();
  }
});

test("Discord write-back queue survives restart and drains after the active turn completes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-bridge-"));
  const databasePath = path.join(dir, "bridge.sqlite");
  const seedMappedActiveThread = (store: StateStore) => {
    store.upsertProjectBridge({
      projectKey: "c:\\repo",
      projectName: "repo",
      discordCategoryId: "discord_category_writeback_restart_1",
      createdByBridge: true,
      updatedAt: new Date().toISOString()
    });
    store.upsertThreadBridge({
      codexThreadId: "thr_writeback_restart_1",
      parentCodexThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      discordChannelId: "discord_channel_writeback_restart_1",
      discordParentChannelId: null,
      statusMessageId: null,
      cwd: "C:\\repo",
      repoName: "repo",
      lastSeenAt: new Date().toISOString(),
      attachMode: "manual",
      threadName: "Write-back restart thread",
      lastStatusType: "active",
      lastTurnId: "turn_writeback_restart_active",
      lastTurnStatus: "in_progress",
      channelKind: "conversation"
    });
  };

  const firstStore = new StateStore(databasePath);
  seedMappedActiveThread(firstStore);
  const firstCodex = new FakeCodexAdapter();
  const firstDiscord = new FakeDiscordAdapter();
  const firstBridge = createBridgeService({
    codexAdapter: firstCodex as never,
    provider: firstDiscord as never,
    stateStore: firstStore,
  });

  try {
    await firstBridge.start({ skipDiscovery: true });
    assert.ok(firstDiscord.handlers);

    const queued = await firstDiscord.handlers.onSendCommand(
      {
        userId: "user_1",
        roleIds: [],
        username: "controller"
      },
      "discord_channel_writeback_restart_1",
      "Continue after the current turn finishes.",
      "queue"
    );

    assert.match(queued.content, /Queued for the next turn\. Position 1\./);
    assert.match(queued.content, /> Continue after the current turn finishes\./);
    assert.deepEqual(firstCodex.startTurnRequests, []);
    assert.equal(firstStore.listWriteBackQueueItems("thr_writeback_restart_1")[0]?.status, "pending");
  } finally {
    await firstBridge.stop();
  }

  const secondStore = new StateStore(databasePath);
  const secondCodex = new FakeCodexAdapter();
  const secondDiscord = new FakeDiscordAdapter();
  const secondBridge = createBridgeService({
    codexAdapter: secondCodex as never,
    provider: secondDiscord as never,
    stateStore: secondStore,
  });

  try {
    await secondBridge.start({ skipDiscovery: true });

    secondCodex.emit("notification", {
      method: "turn/completed",
      params: {
        turn: {
          id: "turn_writeback_restart_active",
          status: "completed"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(secondCodex.resumedThreadIds, ["thr_writeback_restart_1"]);
    assert.deepEqual(secondCodex.startTurnRequests, [
      {
        threadId: "thr_writeback_restart_1",
        text: "Continue after the current turn finishes."
      }
    ]);
    assert.equal(secondStore.listWriteBackQueueItems("thr_writeback_restart_1")[0]?.status, "sent");
    assert.deepEqual(
      secondStore
        .listCanonicalThreadEvents("thr_writeback_restart_1", 10)
        .filter((event) => event.eventKind.startsWith("writeBack"))
        .map((event) => event.eventKind),
      ["writeBackQueued", "writeBackSent"]
    );
  } finally {
    await secondBridge.stop();
  }
});

test("session final answer clears stale active state so idle Discord send starts immediately", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_writeback_idle_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_writeback_idle_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_writeback_idle_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Write-back idle thread",
    lastStatusType: "active",
    lastTurnId: "turn_writeback_idle_old",
    lastTurnStatus: "in_progress",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    assert.ok(discord.handlers);

    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_writeback_idle_1",
      turnId: "turn_writeback_idle_old",
      streamOrder: 2,
      timestampMs: Date.now(),
      text: "Done before Discord sends a follow-up.",
      phase: "final_answer",
      eventKey: "evt_writeback_idle_final",
      sourceOrder: "00000002"
    });

    assert.equal(store.getThreadBridge("thr_writeback_idle_1")?.lastStatusType, "idle");
    assert.equal(store.getThreadBridge("thr_writeback_idle_1")?.lastTurnStatus, "completed");

    const result = await discord.handlers.onSendCommand(
      {
        userId: "user_1",
        roleIds: [],
        username: "controller"
      },
      "discord_channel_writeback_idle_1",
      "Start after the visible final answer.",
      "queue"
    );

    assert.match(result.content, /Started a new Codex turn/);
    assert.match(result.content, /> Start after the visible final answer\./);
    assert.deepEqual(codex.startTurnRequests, []);
    assert.equal(desktopIpc.responses[0]?.method, "thread-follower-start-turn");
    assert.equal(desktopIpc.responses[0]?.params.conversationId, "thr_writeback_idle_1");
    assert.deepEqual(desktopIpc.responses[0]?.params.turnStartParams, {
      input: [
        {
          type: "text",
          text: "Start after the visible final answer."
        }
      ],
      attachments: []
    });
    const sent = store.listWriteBackQueueItems("thr_writeback_idle_1")[0];
    assert.equal(sent?.status, "sent");
    assert.equal(store.getThreadBridge("thr_writeback_idle_1")?.lastTurnId, null);
  } finally {
    await bridge.stop();
  }
});

test("session turn-aborted envelope clears stale active state even when behind the live cursor", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_writeback_aborted_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_writeback_aborted_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_writeback_aborted_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Write-back aborted thread",
    lastStatusType: "active",
    lastTurnId: "turn_writeback_aborted_old",
    lastTurnStatus: "in_progress",
    channelKind: "conversation",
    latestMirroredCursor: "session:00000009:evt_writeback_aborted_later"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    assert.ok(discord.handlers);

    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_writeback_aborted_1",
      turnId: "turn_writeback_aborted_old",
      streamOrder: 2,
      timestampMs: Date.now(),
      text:
        "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
      eventKey: "evt_writeback_aborted_old",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });

    assert.equal(store.getThreadBridge("thr_writeback_aborted_1")?.lastStatusType, "idle");
    assert.equal(store.getThreadBridge("thr_writeback_aborted_1")?.lastTurnStatus, "aborted");

    const result = await discord.handlers.onSendCommand(
      {
        userId: "user_1",
        roleIds: [],
        username: "controller"
      },
      "discord_channel_writeback_aborted_1",
      "Start after the aborted turn.",
      "queue"
    );

    assert.match(result.content, /Started a new Codex turn/);
    assert.match(result.content, /> Start after the aborted turn\./);
    assert.deepEqual(codex.startTurnRequests, []);
    assert.equal(desktopIpc.responses[0]?.method, "thread-follower-start-turn");
    assert.equal(desktopIpc.responses[0]?.params.conversationId, "thr_writeback_aborted_1");
    const sent = store.listWriteBackQueueItems("thr_writeback_aborted_1")[0];
    assert.equal(sent?.status, "sent");
  } finally {
    await bridge.stop();
  }
});

test("mirrored proposed plans include Discord accept and feedback actions", async () => {
  const approvalsConfig = testApprovalsConfig("user_1");
  const { store, codex, discord, bridge } = createBridgeTestRig({
    policy: new Policy(approvalsConfig),
    runtimeConfig: createBridgeConfigFromPreset("basic", approvalsConfig)
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_plan_actions_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_plan_actions_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Plan action thread",
    lastStatusType: "active",
    lastTurnId: "turn_plan_actions_1",
    lastTurnStatus: "in_progress",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true, skipRehydrate: true });
    assert.ok(discord.handlers);

    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_plan_actions_1",
      turnId: "turn_plan_actions_1",
      streamOrder: 1,
      timestampMs: Date.now() - 10,
      text: "Please make a small plan.",
      eventKey: "evt_plan_actions_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });
    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_plan_actions_1",
      turnId: "turn_plan_actions_1",
      streamOrder: 2,
      timestampMs: Date.now(),
      text: "<proposed_plan>\n# Small Plan\n\n- Make one small change.\n</proposed_plan>",
      phase: "final_answer",
      eventKey: "evt_plan_actions_final",
      sourceOrder: "00000002"
    });

    const planMessage = discord.liveTextMessages.at(-1);
    assert.deepEqual(planMessage?.actionButtons, [
      ACCEPT_PROPOSED_PLAN_LABEL,
      TELL_CODEX_DIFFERENTLY_LABEL
    ]);
    assert.match(planMessage?.actionCustomIds[0] ?? "", /^codex:plan:/);

    const planAction = store.listProposedPlanActions("thr_plan_actions_1")[0];
    assert.ok(planAction);
    assert.equal(planAction.status, "pending");
    assert.equal(planAction.planText, "# Small Plan\n\n- Make one small change.");

    const result = await discord.handlers.onProposedPlanAction(
      {
        userId: "user_1",
        roleIds: [],
        username: "controller"
      },
      planAction.token,
      "accept"
    );

    assert.match(result.content, /Accepted the proposed plan/);
    assert.doesNotMatch(result.content, /Started a new Codex turn/);
    assert.equal(codex.startTurnRequests.length, 1);
    assert.equal(codex.startTurnRequests[0]?.threadId, "thr_plan_actions_1");
    assert.match(codex.startTurnRequests[0]?.text ?? "", /^PLEASE IMPLEMENT THIS PLAN:\n# Small Plan/);
    assert.doesNotMatch(codex.startTurnRequests[0]?.text ?? "", /<proposed_plan>/);
    assert.equal(store.findProposedPlanActionByToken(planAction.token)?.status, "accepted");
    assert.equal(discord.updatedMessageDetailsButtons.at(-1)?.messageId, planMessage?.messageId);
  } finally {
    await bridge.stop();
  }
});

test("mirrored proposed plans omit Discord actions when approval controls are disabled", async () => {
  const approvalsConfig = {
    allowFromDiscord: false,
    allowedUserIds: ["user_1"],
    mentionApprovers: false
  };
  const { store, discord, bridge } = createBridgeTestRig({
    policy: new Policy(approvalsConfig),
    runtimeConfig: createBridgeConfigFromPreset("basic", approvalsConfig)
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_plan_actions_disabled_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_plan_actions_disabled_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Plan action disabled thread",
    lastStatusType: "active",
    lastTurnId: "turn_plan_actions_disabled_1",
    lastTurnStatus: "in_progress",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true, skipRehydrate: true });
    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_plan_actions_disabled_1",
      turnId: "turn_plan_actions_disabled_1",
      streamOrder: 1,
      timestampMs: Date.now() - 10,
      text: "Please make a small plan.",
      eventKey: "evt_plan_actions_disabled_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });
    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_plan_actions_disabled_1",
      turnId: "turn_plan_actions_disabled_1",
      streamOrder: 2,
      timestampMs: Date.now(),
      text: "<proposed_plan>\n# Small Plan\n\n- Make one small change.\n</proposed_plan>",
      phase: "final_answer",
      eventKey: "evt_plan_actions_disabled_final",
      sourceOrder: "00000002"
    });

    const planMessage = discord.liveTextMessages.at(-1);
    assert.deepEqual(planMessage?.actionButtons, []);
    assert.equal(store.listProposedPlanActions("thr_plan_actions_disabled_1").length, 0);
  } finally {
    await bridge.stop();
  }
});

test("proposed plan feedback steers the original plan turn instead of starting a new turn", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset("basic", testApprovalsConfig("user_1"))
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_plan_feedback_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_plan_feedback_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Plan feedback thread",
    lastStatusType: "active",
    lastTurnId: "turn_plan_feedback_1",
    lastTurnStatus: "in_progress",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true, skipRehydrate: true });
    assert.ok(discord.handlers);

    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_plan_feedback_1",
      turnId: "turn_plan_feedback_1",
      streamOrder: 1,
      timestampMs: Date.now() - 10,
      text: "Please make a small plan.",
      eventKey: "evt_plan_feedback_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });
    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_plan_feedback_1",
      turnId: "turn_plan_feedback_1",
      streamOrder: 2,
      timestampMs: Date.now(),
      text: "<proposed_plan>\n# Small Plan\n\n- Make one small change.\n</proposed_plan>",
      phase: "final_answer",
      eventKey: "evt_plan_feedback_final",
      sourceOrder: "00000002"
    });

    const planAction = store.listProposedPlanActions("thr_plan_feedback_1")[0];
    assert.ok(planAction);
    const planMessage = discord.liveTextMessages.at(-1);

    const result = await discord.handlers.onProposedPlanFeedback(
      {
        userId: "user_1",
        roleIds: [],
        username: "controller"
      },
      planAction.token,
      "Make the plan smaller."
    );

    assert.match(result.content, /Sent plan feedback to Codex/);
    assert.deepEqual(codex.startTurnRequests, []);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_plan_feedback_1",
        expectedTurnId: "turn_plan_feedback_1",
        text: "Please revise the proposed plan based on this feedback:\nMake the plan smaller."
      }
    ]);
    assert.equal(store.findProposedPlanActionByToken(planAction.token)?.status, "feedbackSent");
    assert.equal(discord.updatedMessageDetailsButtons.at(-1)?.messageId, planMessage?.messageId);
  } finally {
    await bridge.stop();
  }
});

test("proposed plan feedback starts a follow-up turn when the plan turn already ended", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset("basic", testApprovalsConfig("user_1"))
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_plan_feedback_ended_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_plan_feedback_ended_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Ended plan feedback thread",
    lastStatusType: "idle",
    lastTurnId: "turn_plan_feedback_ended_1",
    lastTurnStatus: "completed",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true, skipRehydrate: true });
    assert.ok(discord.handlers);

    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_plan_feedback_ended_1",
      turnId: "turn_plan_feedback_ended_1",
      streamOrder: 1,
      timestampMs: Date.now() - 10,
      text: "Please make a small plan.",
      eventKey: "evt_plan_feedback_ended_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });
    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_plan_feedback_ended_1",
      turnId: "turn_plan_feedback_ended_1",
      streamOrder: 2,
      timestampMs: Date.now(),
      text: "<proposed_plan>\n# Small Plan\n\n- Make one small change.\n</proposed_plan>",
      phase: "final_answer",
      eventKey: "evt_plan_feedback_ended_final",
      sourceOrder: "00000002"
    });

    const planAction = store.listProposedPlanActions("thr_plan_feedback_ended_1")[0];
    assert.ok(planAction);
    const planMessage = discord.liveTextMessages.at(-1);
    codex.steerErrorsByExpectedTurnId.set(
      "turn_plan_feedback_ended_1",
      new Error("Cannot steer conversation because its active turn already ended")
    );

    const result = await discord.handlers.onProposedPlanFeedback(
      {
        userId: "user_1",
        roleIds: [],
        username: "controller"
      },
      planAction.token,
      "Make the plan smaller."
    );

    assert.match(result.content, /Sent plan feedback to Codex/);
    assert.doesNotMatch(result.content, /Started a new Codex turn/);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_plan_feedback_ended_1",
        expectedTurnId: "turn_plan_feedback_ended_1",
        text: "Please revise the proposed plan based on this feedback:\nMake the plan smaller."
      }
    ]);
    assert.equal(codex.startTurnRequests.length, 1);
    assert.equal(codex.startTurnRequests[0]?.threadId, "thr_plan_feedback_ended_1");
    assert.equal(
      codex.startTurnRequests[0]?.text,
      "Please revise the proposed plan based on this feedback:\nMake the plan smaller."
    );
    assert.equal(store.findProposedPlanActionByToken(planAction.token)?.status, "feedbackSent");
    assert.equal(discord.updatedMessageDetailsButtons.at(-1)?.messageId, planMessage?.messageId);
  } finally {
    await bridge.stop();
  }
});

test("session final answer drains one queued Discord write-back message", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_writeback_drain_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_writeback_drain_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_writeback_drain_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Write-back drain thread",
    lastStatusType: "active",
    lastTurnId: "turn_writeback_drain_old",
    lastTurnStatus: "in_progress",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    assert.ok(discord.handlers);

    const queued = await discord.handlers.onSendCommand(
      {
        userId: "user_1",
        roleIds: [],
        username: "controller"
      },
      "discord_channel_writeback_drain_1",
      "Run after this live turn.",
      "queue"
    );

    assert.match(queued.content, /Queued for the next turn\. Position 1\./);
    assert.match(queued.content, /> Run after this live turn\./);
    assert.deepEqual(codex.startTurnRequests, []);

    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_writeback_drain_1",
      turnId: "turn_writeback_drain_old",
      streamOrder: 2,
      timestampMs: Date.now(),
      text: "Done before draining the queued follow-up.",
      phase: "final_answer",
      eventKey: "evt_writeback_drain_final",
      sourceOrder: "00000002"
    });

    assert.deepEqual(codex.startTurnRequests, []);
    assert.equal(desktopIpc.responses[0]?.method, "thread-follower-start-turn");
    assert.equal(desktopIpc.responses[0]?.params.conversationId, "thr_writeback_drain_1");
    assert.deepEqual(desktopIpc.responses[0]?.params.turnStartParams, {
      input: [
        {
          type: "text",
          text: "Run after this live turn."
        }
      ],
      attachments: []
    });
    assert.equal(store.listWriteBackQueueItems("thr_writeback_drain_1")[0]?.status, "sent");
    assert.equal(store.getThreadBridge("thr_writeback_drain_1")?.lastTurnId, null);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering resumes and steers a tracked thread", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ providerOnly: true });
    (bridge as any).runtime.threadState.set("thr_steer_1", {
      threadId: "thr_steer_1",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Steer thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_steer_1",
      lastTurnStatus: "in_progress"
    });

    const result = await bridge.steerActiveTurnInternally(
      "Do not open the browser; summarize the command instead.",
      "thr_steer_1"
    );

    assert.match(result.content, /Steered active turn/i);
    assert.deepEqual(codex.resumedThreadIds, ["thr_steer_1"]);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_steer_1",
        expectedTurnId: "turn_steer_1",
        text: "Do not open the browser; summarize the command instead."
      }
    ]);
    assert.deepEqual(codex.startTurnRequests, []);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering refuses to start a new turn when the thread is not currently active", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_2",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_2",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_2",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ providerOnly: true });
    const result = await bridge.steerActiveTurnInternally("Please pick up from here.", "thr_steer_2");

    assert.match(result.content, /There is no active Codex turn to steer/i);
    assert.equal(result.ephemeral, true);
    assert.deepEqual(codex.resumedThreadIds, ["thr_steer_2"]);
    assert.deepEqual(codex.steerRequests, []);
    assert.deepEqual(codex.startTurnRequests, []);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering still works after a coarse idle status update while the current turn is still in progress", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_3",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_3",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_3",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    assert.ok(discord.handlers);

    (bridge as any).runtime.threadState.set("thr_steer_3", {
      threadId: "thr_steer_3",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Steer thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active", activeFlags: [] },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_steer_3",
      lastTurnStatus: "in_progress"
    });

    codex.emit("notification", {
      method: "thread/status/changed",
      params: {
        threadId: "thr_steer_3",
        status: { type: "idle" }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal((bridge as any).runtime.threadState.get("thr_steer_3")?.lastTurnStatus, "in_progress");

    const result = await bridge.steerActiveTurnInternally("Keep going on the same turn.", "thr_steer_3");

    assert.match(result.content, /Steered active turn/i);
    assert.deepEqual(codex.resumedThreadIds, ["thr_steer_3"]);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_steer_3",
        expectedTurnId: "turn_steer_3",
        text: "Keep going on the same turn."
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering polls fresh session events before refusing a just-started live turn", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_4",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_4",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_4",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    tailer.setEvents("thr_steer_4", [
      {
        type: "sessionAgentMessage",
        threadId: "thr_steer_4",
        turnId: "turn_steer_4",
        timestampMs: Date.now(),
        streamOrder: 1,
        text: "Fresh commentary that should make the turn steerable.",
        phase: "commentary",
        eventKey: "evt_steer_4_commentary",
        sourceOrder: "00000001:0000"
      }
    ]);

    const result = await bridge.steerActiveTurnInternally(
      "Use the already-active turn instead of refusing.",
      "thr_steer_4"
    );

    assert.match(result.content, /Steered active turn/i);
    assert.deepEqual(codex.resumedThreadIds, ["thr_steer_4"]);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_steer_4",
        expectedTurnId: "turn_steer_4",
        text: "Use the already-active turn instead of refusing."
      }
    ]);
    assert.equal((bridge as any).runtime.threadState.get("thr_steer_4")?.lastTurnStatus, "in_progress");
    assert.equal(tailer.pollThreadCalls.some((call) => call.threadId === "thr_steer_4"), true);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering falls back to thread/read when runtime and session logs do not expose the live turn yet", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_5",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_5",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_5",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  codex.threadDetails.set("thr_steer_5", {
    id: "thr_steer_5",
    name: "Steer thread",
    preview: "Steer thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_steer_5",
        status: "inProgress",
        items: []
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });
    const result = await bridge.steerActiveTurnInternally("Recover the active turn from thread/read.", "thr_steer_5");

    assert.match(result.content, /Steered active turn/i);
    assert.deepEqual(codex.resumedThreadIds, ["thr_steer_5"]);
    assert.deepEqual(codex.readThreadCalls, ["thr_steer_5"]);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_steer_5",
        expectedTurnId: "turn_steer_5",
        text: "Recover the active turn from thread/read."
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering reuses the same shared steering path", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_local_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_local_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_local_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ providerOnly: true });

    (bridge as any).runtime.threadState.set("thr_steer_local_1", {
      threadId: "thr_steer_local_1",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Steer thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active", activeFlags: [] },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_steer_local_1",
      lastTurnStatus: "in_progress"
    });

    const result = await bridge.steerActiveTurnInternally(
      "Keep going on the current turn from the terminal.",
      "thr_steer_local_1"
    );

    assert.match(result.content, /Steered active turn/i);
    assert.deepEqual(codex.resumedThreadIds, ["thr_steer_local_1"]);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_steer_local_1",
        expectedTurnId: "turn_steer_local_1",
        text: "Keep going on the current turn from the terminal."
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering prefers Desktop IPC for active non-CLI threads", async () => {
  const desktopIpcClient = new FakeDesktopIpcClient();
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpcClient as never
  });

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_local_ipc_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_local_ipc_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_local_ipc_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    desktopIpcClient.conversationStates.set("thr_steer_local_ipc_1", {
      id: "thr_steer_local_ipc_1",
      cwd: "C:\\repo",
      updatedAt: 1_777_000_100_000,
      turns: [
        {
          turnId: "turn_steer_local_ipc_1",
          status: "inProgress",
          params: {
            threadId: "thr_steer_local_ipc_1",
            input: [{ type: "text", text: "Keep the Desktop-backed turn active." }],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        }
      ],
      requests: []
    });

    (bridge as any).runtime.threadState.set("thr_steer_local_ipc_1", {
      threadId: "thr_steer_local_ipc_1",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Steer thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active", activeFlags: [] },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_steer_local_ipc_1",
      lastTurnStatus: "in_progress"
    });

    const result = await bridge.steerActiveTurnInternally(
      "Prefer Desktop IPC when the follower is connected.",
      "thr_steer_local_ipc_1"
    );

    assert.match(result.content, /Steered active turn/i);
    assert.deepEqual(codex.steerRequests, []);
    assert.equal(desktopIpcClient.responses.length, 1);
    assert.equal(desktopIpcClient.responses[0]?.method, "thread-follower-steer-turn");
    assert.equal(desktopIpcClient.responses[0]?.params.conversationId, "thr_steer_local_ipc_1");
    assert.equal(desktopIpcClient.responses[0]?.params.expectedTurnId, "turn_steer_local_ipc_1");
    assert.deepEqual(desktopIpcClient.responses[0]?.params.input, [
      {
        type: "text",
        text: "Prefer Desktop IPC when the follower is connected."
      }
    ]);
    assert.deepEqual(desktopIpcClient.responses[0]?.params.attachments, []);
    assert.ok(desktopIpcClient.responses[0]?.params.restoreMessage);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering reuses the cached Desktop turn params for the steer payload", async () => {
  const desktopIpcClient = new FakeDesktopIpcClient();
  desktopIpcClient.conversationStates.set("thr_steer_local_ipc_snapshot_1", {
    id: "thr_steer_local_ipc_snapshot_1",
    cwd: "C:\\repo",
    updatedAt: 1_777_000_000_000,
    latestModel: "gpt-5.4",
    latestReasoningEffort: "high",
    latestCollaborationMode: {
      mode: "default",
      settings: {
        model: "gpt-5.4",
        reasoning_effort: "high",
        developer_instructions: null
      }
    },
    turns: [
      {
        turnId: "turn_steer_local_ipc_snapshot_live",
        status: "inProgress",
        params: {
          threadId: "thr_steer_local_ipc_snapshot_1",
          input: [
            {
              type: "text",
              text: "Continue the current investigation."
            }
          ],
          cwd: "C:\\repo",
          model: null,
          effort: null,
          attachments: [],
          commentAttachments: [],
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["C:\\repo"],
            readOnlyAccess: {
              type: "fullAccess"
            }
          },
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.4",
              reasoning_effort: "high",
              developer_instructions: null
            }
          }
        }
      }
    ],
    requests: []
  });
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpcClient as never
  });

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_local_ipc_snapshot_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_local_ipc_snapshot_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_local_ipc_snapshot_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    (bridge as any).runtime.threadState.set("thr_steer_local_ipc_snapshot_1", {
      threadId: "thr_steer_local_ipc_snapshot_1",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Steer thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active", activeFlags: [] },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_steer_local_ipc_snapshot_stale",
      lastTurnStatus: "in_progress"
    });

    const result = await bridge.steerActiveTurnInternally(
      "Use the Desktop snapshot for this steer.",
      "thr_steer_local_ipc_snapshot_1"
    );

    assert.match(result.content, /Steered active turn/i);
    assert.deepEqual(codex.steerRequests, []);
    assert.equal(desktopIpcClient.responses[0]?.method, "thread-follower-steer-turn");
    assert.equal(desktopIpcClient.responses[0]?.params.conversationId, "thr_steer_local_ipc_snapshot_1");
    assert.equal(desktopIpcClient.responses[0]?.params.expectedTurnId, "turn_steer_local_ipc_snapshot_live");
    assert.deepEqual(desktopIpcClient.responses[0]?.params.input, [
      {
        type: "text",
        text: "Use the Desktop snapshot for this steer."
      }
    ]);
    assert.deepEqual(desktopIpcClient.responses[0]?.params.attachments, []);
    const restoreMessage = desktopIpcClient.responses[0]?.params.restoreMessage as Record<string, unknown>;
    assert.equal(restoreMessage.id, "restore:turn_steer_local_ipc_snapshot_live");
    assert.equal(restoreMessage.text, "Continue the current investigation.");
    assert.equal(restoreMessage.cwd, "C:\\repo");
    assert.equal(restoreMessage.createdAt, 1_777_000_000_000);
    assert.deepEqual(restoreMessage.context, {
      prompt: "Continue the current investigation.",
      workspaceRoots: ["C:\\repo"],
      commentAttachments: [],
      fileAttachments: [],
      imageAttachments: [],
      addedFiles: [],
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.4",
          reasoning_effort: "high",
          developer_instructions: null
        }
      }
    });
    assert.deepEqual(restoreMessage.thread, {
      id: "thr_steer_local_ipc_snapshot_1",
      cwd: "C:\\repo",
      updatedAt: 1_777_000_000,
      turns: [
        {
          id: "turn_steer_local_ipc_snapshot_live",
          status: "inProgress",
          error: null,
          items: [
            {
              id: "turn_steer_local_ipc_snapshot_live:user-message",
              type: "userMessage",
              content: [
                {
                  type: "text",
                  text: "Continue the current investigation."
                }
              ]
            }
          ]
        }
      ]
    });
    assert.equal("rollbackResponse" in restoreMessage, false);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering waits briefly for the first Desktop conversation snapshot", async () => {
  const desktopIpcClient = new FakeDesktopIpcClient();
  desktopIpcClient.waitForConversationState = async (conversationId: string) => ({
    id: conversationId,
    cwd: "C:\\repo",
    updatedAt: 1_778_000_000_000,
    latestModel: "gpt-5.4",
    latestReasoningEffort: "high",
    turns: [
      {
        turnId: "turn_steer_local_ipc_wait_live",
        status: "inProgress",
        params: {
          threadId: conversationId,
          input: [
            {
              type: "text",
              text: "Keep the current turn alive."
            }
          ],
          cwd: "C:\\repo",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["C:\\repo"]
          },
          attachments: [],
          commentAttachments: []
        }
      }
    ],
    requests: []
  });
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpcClient as never
  });

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_local_ipc_wait_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_local_ipc_wait_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_local_ipc_wait_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    (bridge as any).runtime.threadState.set("thr_steer_local_ipc_wait_1", {
      threadId: "thr_steer_local_ipc_wait_1",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Steer thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active", activeFlags: [] },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_steer_local_ipc_wait_stale",
      lastTurnStatus: "in_progress"
    });

    const result = await bridge.steerActiveTurnInternally(
      "Use the waited Desktop snapshot for this steer.",
      "thr_steer_local_ipc_wait_1"
    );

    assert.match(result.content, /Steered active turn/i);
    assert.deepEqual(codex.steerRequests, []);
    assert.equal(desktopIpcClient.responses[0]?.params.expectedTurnId, "turn_steer_local_ipc_wait_live");
    const restoreMessage = desktopIpcClient.responses[0]?.params.restoreMessage as Record<string, unknown>;
    assert.equal(restoreMessage.id, "restore:turn_steer_local_ipc_wait_live");
    assert.equal(restoreMessage.text, "Keep the current turn alive.");
    assert.equal(restoreMessage.cwd, "C:\\repo");
    assert.equal(restoreMessage.createdAt, 1_778_000_000_000);
    assert.deepEqual(
      ((restoreMessage.context as Record<string, unknown>)?.workspaceRoots as unknown[]) ?? null,
      ["C:\\repo"]
    );
    assert.deepEqual(
      ((restoreMessage.thread as Record<string, unknown>)?.turns as unknown[]) ?? null,
      [
        {
          id: "turn_steer_local_ipc_wait_live",
          status: "inProgress",
          error: null,
          items: [
            {
              id: "turn_steer_local_ipc_wait_live:user-message",
              type: "userMessage",
              content: [
                {
                  type: "text",
                  text: "Keep the current turn alive."
                }
              ]
            }
          ]
        }
      ]
    );
    assert.equal("rollbackResponse" in restoreMessage, false);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering reconstructs a Desktop restore snapshot from thread/read when no live Desktop snapshot is available", async () => {
  const desktopIpcClient = new FakeDesktopIpcClient();
  desktopIpcClient.waitForConversationState = async () => null;
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpcClient as never
  });

  codex.threadDetails.set("thr_steer_local_ipc_read_1", {
    id: "thr_steer_local_ipc_read_1",
    name: "Thread",
    preview: "Preview",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "active", activeFlags: [] },
    turns: [
      {
        id: "turn_steer_local_ipc_read_live",
        status: "inProgress",
        error: null,
        items: [
          {
            id: "item_user_turn_steer_local_ipc_read_live",
            type: "userMessage",
            content: [
              {
                type: "text",
                text: "Use the app-server turn items."
              }
            ]
          },
          {
            id: "item_agent_turn_steer_local_ipc_read_live",
            type: "assistantMessage",
            phase: "commentary",
            content: [
              {
                type: "output_text",
                text: "Commentary that keeps the turn active."
              }
            ]
          }
        ]
      }
    ]
  });
  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_local_ipc_read_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_local_ipc_read_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_local_ipc_read_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    (bridge as any).runtime.threadState.set("thr_steer_local_ipc_read_1", {
      threadId: "thr_steer_local_ipc_read_1",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Steer thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active", activeFlags: [] },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_steer_local_ipc_read_stale",
      lastTurnStatus: "in_progress"
    });

    const result = await bridge.steerActiveTurnInternally(
      "Use the thread/read fallback for this steer.",
      "thr_steer_local_ipc_read_1"
    );

    assert.match(result.content, /Steered active turn/i);
    assert.deepEqual(codex.steerRequests, []);
    assert.ok(codex.readThreadCalls.includes("thr_steer_local_ipc_read_1"));
    assert.equal(desktopIpcClient.responses.length, 1);
    assert.equal(desktopIpcClient.responses[0]?.method, "thread-follower-steer-turn");
    assert.equal(desktopIpcClient.responses[0]?.params.conversationId, "thr_steer_local_ipc_read_1");
    assert.equal(desktopIpcClient.responses[0]?.params.expectedTurnId, "turn_steer_local_ipc_read_live");
    assert.ok(desktopIpcClient.responses[0]?.params.restoreMessage);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering reports a Desktop follower failure instead of silently falling back", async () => {
  const desktopIpcClient = new FakeDesktopIpcClient();
  desktopIpcClient.steerError = new Error("TypeError: Cannot read properties of undefined (reading 'workspaceRoots')");
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpcClient as never
  });

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_local_ipc_2",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_local_ipc_2",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_local_ipc_2",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    desktopIpcClient.conversationStates.set("thr_steer_local_ipc_2", {
      id: "thr_steer_local_ipc_2",
      cwd: "C:\\repo",
      updatedAt: 1_779_000_000_000,
      turns: [
        {
          turnId: "turn_steer_local_ipc_2",
          status: "inProgress",
          params: {
            threadId: "thr_steer_local_ipc_2",
            input: [{ type: "text", text: "Keep the Desktop turn active." }],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        }
      ],
      requests: []
    });

    (bridge as any).runtime.threadState.set("thr_steer_local_ipc_2", {
      threadId: "thr_steer_local_ipc_2",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Steer thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active", activeFlags: [] },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_steer_local_ipc_2",
      lastTurnStatus: "in_progress"
    });

    const result = await bridge.steerActiveTurnInternally(
      "Do not claim success when the Desktop follower rejects the steer payload.",
      "thr_steer_local_ipc_2"
    );

    assert.match(result.content, /Failed to steer Codex thread/i);
    assert.deepEqual(codex.steerRequests, []);
    assert.equal(desktopIpcClient.responses.length, 1);
    assert.equal(desktopIpcClient.responses[0]?.method, "thread-follower-steer-turn");
    assert.equal(desktopIpcClient.responses[0]?.params.conversationId, "thr_steer_local_ipc_2");
    assert.equal(desktopIpcClient.responses[0]?.params.expectedTurnId, "turn_steer_local_ipc_2");
    assert.deepEqual(desktopIpcClient.responses[0]?.params.input, [
      {
        type: "text",
        text: "Do not claim success when the Desktop follower rejects the steer payload."
      }
    ]);
    assert.deepEqual(desktopIpcClient.responses[0]?.params.attachments, []);
    assert.ok(desktopIpcClient.responses[0]?.params.restoreMessage);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering can recover the active turn from latest-turn session backfill", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_local_backfill_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_steer_local_backfill_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_local_backfill_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });
  tailer.setLatestTurnBackfillEvents("thr_steer_local_backfill_1", [
    {
      type: "sessionAgentMessage",
      threadId: "thr_steer_local_backfill_1",
      turnId: "turn_steer_local_backfill_1",
      timestampMs: Date.now(),
      text: "Latest-turn backfill commentary.",
      phase: "commentary"
    }
  ]);

  try {
    await bridge.start({ skipDiscovery: true, skipStartupLogFastForward: true });

    const result = await bridge.steerActiveTurnInternally(
      "Recover the active turn from latest-turn session backfill.",
      "thr_steer_local_backfill_1"
    );

    assert.match(result.content, /Steered active turn/i);
    assert.deepEqual(tailer.fastForwardedThreadIds, []);
    assert.deepEqual(codex.readThreadCalls, []);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_steer_local_backfill_1",
        expectedTurnId: "turn_steer_local_backfill_1",
        text: "Recover the active turn from latest-turn session backfill."
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("internal active-turn steering can recover the active turn from persisted bridge state after a restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-bridge-"));
  const databasePath = path.join(dir, "bridge.sqlite");
  const firstStore = new StateStore(databasePath);
  const firstCodex = new FakeCodexAdapter();
  const firstDiscord = new FakeDiscordAdapter();
  const firstBridge = createBridgeService({
    codexAdapter: firstCodex as never,
    provider: firstDiscord as never,
    stateStore: firstStore,
  });

  firstStore.upsertProjectBridge({
    projectKey: "c:\\repo",
    projectName: "repo",
    discordCategoryId: "discord_category_steer_persist_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  firstStore.upsertThreadBridge({
    codexThreadId: "thr_steer_persist_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_steer_persist_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "Steer thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  try {
    await firstBridge.start({ skipDiscovery: true });
    (firstBridge as any).runtime.threadState.set("thr_steer_persist_1", {
      threadId: "thr_steer_persist_1",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Steer thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active", activeFlags: [] },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_steer_persist_1",
      lastTurnStatus: "in_progress"
    });
    (firstBridge as any).persistThreadState(
      (firstBridge as any).runtime.threadState.get("thr_steer_persist_1")
    );
    assert.equal(firstStore.getThreadBridge("thr_steer_persist_1")?.lastTurnId, "turn_steer_persist_1");
    assert.equal(firstStore.getThreadBridge("thr_steer_persist_1")?.lastTurnStatus, "in_progress");
  } finally {
    await firstBridge.stop();
    firstStore.close();
  }

  const secondStore = new StateStore(databasePath);
  const secondCodex = new FakeCodexAdapter();
  const secondDiscord = new FakeDiscordAdapter();
  const secondBridge = createBridgeService({
    codexAdapter: secondCodex as never,
    provider: secondDiscord as never,
    stateStore: secondStore,
  });

  try {
    await secondBridge.start({ skipDiscovery: true });

    const result = await secondBridge.steerActiveTurnInternally(
      "Recover the same active turn after restart.",
      "thr_steer_persist_1"
    );

    assert.match(result.content, /Steered active turn/i);
    assert.deepEqual(secondCodex.resumedThreadIds, ["thr_steer_persist_1"]);
    assert.deepEqual(secondCodex.readThreadCalls, []);
    assert.deepEqual(secondCodex.steerRequests, [
      {
        threadId: "thr_steer_persist_1",
        expectedTurnId: "turn_steer_persist_1",
        text: "Recover the same active turn after restart."
      }
    ]);
  } finally {
    await secondBridge.stop();
    secondStore.close();
  }
});

test("approval actions are claimed before the Codex response resolves", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_claim_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_claim_1",
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

  try {
    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: 43,
      params: {
        itemId: "item_claim_1",
        threadId: "thr_claim_1",
        turnId: "turn_claim_1",
        command: "npm test",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "decline"]
      }
    });

    const approval = store.listPendingApprovals()[0];
    assert.ok(approval);
    codex.responseDelayMsByRequest.set("43", 25);

    const first = bridge.handleApprovalAction("user_1", approval.token, "accept");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await bridge.handleApprovalAction("user_1", approval.token, "accept");
    const firstResult = await first;

    assert.equal(firstResult.content, "");
    assert.match(second.content, /no longer active/i);
    assert.equal(second.ephemeral, true);
    assert.deepEqual(codex.responses, [{ requestId: "43", result: { decision: "accept" } }]);
    assert.equal(store.findPendingApprovalByRequestId("43")?.status, "decisionSent");
  } finally {
    await bridge.stop();
  }
});

test("approval feedback is claimed before the Codex response resolves and steers into the active turn", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_feedback_claim_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_feedback_claim_1",
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

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/started",
      params: {
        threadId: "thr_feedback_claim_1",
        turnId: "turn_feedback_claim_1",
        item: {
          id: "item_feedback_claim_1",
          type: "message",
          role: "assistant",
          phase: "commentary",
          text: "Thinking..."
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: 78,
      params: {
        itemId: "item_feedback_claim_approval",
        threadId: "thr_feedback_claim_1",
        turnId: "turn_feedback_claim_1",
        command: "npm test",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "decline"]
      }
    });

    const approval = store.listPendingApprovals()[0];
    assert.ok(approval);
    codex.responseDelayMsByRequest.set("78", 25);

    const first = bridge.handleApprovalFeedback("user_1", approval.token, "Focus on the failing tests.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await bridge.handleApprovalFeedback("user_1", approval.token, "Focus on the failing tests.");
    const firstResult = await first;

    assert.equal(firstResult.content, "");
    assert.match(second.content, /no longer active/i);
    assert.equal(second.ephemeral, true);
    assert.deepEqual(codex.responses, [{ requestId: "78", result: { decision: "decline" } }]);
    assert.deepEqual(codex.resumedThreadIds, ["thr_feedback_claim_1"]);
    assert.deepEqual(codex.startTurnRequests, []);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_feedback_claim_1",
        expectedTurnId: "turn_feedback_claim_1",
        text: "Focus on the failing tests."
      }
    ]);
    assert.equal(store.findPendingApprovalByRequestId("78")?.status, "decisionSent");
  } finally {
    await bridge.stop();
  }
});

test("approval feedback falls back to a follow-up turn when no steerable turn id exists", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_feedback_fallback_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_feedback_fallback_1",
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

  try {
    await bridge.handleServerRequest({
      method: "execCommandApproval",
      id: 79,
      params: {
        conversationId: "thr_feedback_fallback_1",
        callId: "call_feedback_fallback_1",
        command: ["npm", "test"],
        cwd: "C:\\repo",
        reason: "Need a fallback approval"
      }
    } as never);

    const approval = store.listPendingApprovals()[0];
    assert.ok(approval);
    assert.equal(approval.feedbackTurnId, null);

    const result = await bridge.handleApprovalFeedback("user_1", approval.token, "Use a safer command.");

  assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [{ requestId: "79", result: { decision: "denied" } }]);
    assert.deepEqual(codex.steerRequests, []);
    assert.deepEqual(codex.resumedThreadIds, ["thr_feedback_fallback_1"]);
    assert.deepEqual(codex.startTurnRequests, [
      {
        threadId: "thr_feedback_fallback_1",
        text: "Use a safer command."
      }
    ]);
    assert.equal(store.findPendingApprovalByRequestId("79")?.status, "decisionSent");
  } finally {
    await bridge.stop();
  }
});

test("specific Discord approval text is preserved when the app-server later confirms the request", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_confirmed_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_confirmed_1",
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

  try {
    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: 142,
      params: {
        itemId: "item_confirmed_1",
        threadId: "thr_confirmed_1",
        turnId: "turn_confirmed_1",
        command: "npm test",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "decline"]
      }
    });

    const approval = store.listPendingApprovals()[0];
    assert.ok(approval);

    const result = await bridge.handleApprovalAction("user_1", approval.token, "accept");
    assert.equal(result.content, "");
    assert.equal(discord.disabledApprovalCards.length, 1);
    assert.match(discord.disabledApprovalCards[0]?.resolutionText ?? "", /Approved once in Discord/i);

    codex.emit("notification", {
      method: "serverRequest/resolved",
      params: {
        requestId: "142"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(store.findPendingApprovalByRequestId("142")?.status, "approved");
    assert.equal(discord.disabledApprovalCards.length, 1);
    assert.match(discord.disabledApprovalCards[0]?.resolutionText ?? "", /Approved once in Discord/i);
  } finally {
    await bridge.stop();
  }
});

test("approval feedback rejects the request and steers the same thread turn when a feedback anchor exists", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_feedback_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_feedback_1",
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

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/started",
      params: {
        threadId: "thr_feedback_1",
        turnId: "turn_feedback_1",
        item: {
          id: "item_feedback_1",
          type: "message",
          role: "assistant",
          phase: "commentary",
          text: "Thinking..."
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: 77,
      params: {
        itemId: "item_feedback_approval",
        threadId: "thr_feedback_1",
        turnId: "turn_feedback_1",
        command: "npm test",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "decline"]
      }
    });

    const approval = store.listPendingApprovals()[0];
    assert.ok(approval);

    const result = await bridge.handleApprovalFeedback("user_1", approval.token, "Focus on failing tests first.");

    assert.equal(result.content, "");
    assert.deepEqual(codex.resumedThreadIds, ["thr_feedback_1"]);
    assert.deepEqual(codex.startTurnRequests, []);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_feedback_1",
        expectedTurnId: "turn_feedback_1",
        text: "Focus on failing tests first."
      }
    ]);
    assert.deepEqual(codex.responses, [{ requestId: "77", result: { decision: "decline" } }]);
  } finally {
    await bridge.stop();
  }
});

test("approval feedback steers the anchored turn even if runtime lastTurnId drifts", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_feedback_drift_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_feedback_drift_1",
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

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/started",
      params: {
        threadId: "thr_feedback_drift_1",
        turnId: "turn_feedback_drift_original",
        item: {
          id: "item_feedback_drift_original",
          type: "message",
          role: "assistant",
          phase: "commentary",
          text: "Thinking..."
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: 79,
      params: {
        itemId: "item_feedback_drift_approval",
        threadId: "thr_feedback_drift_1",
        turnId: "turn_feedback_drift_original",
        command: "npm test",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "decline"]
      }
    });

    codex.emit("notification", {
      method: "item/started",
      params: {
        threadId: "thr_feedback_drift_1",
        turnId: "turn_feedback_drift_newer",
        item: {
          id: "item_feedback_drift_newer",
          type: "message",
          role: "assistant",
          phase: "commentary",
          text: "A later turn is now active."
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const approval = store.listPendingApprovals()[0];
    assert.ok(approval);

    const result = await bridge.handleApprovalFeedback("user_1", approval.token, "Focus on the failing tests first.");

    assert.equal(result.content, "");
    assert.deepEqual(codex.resumedThreadIds, ["thr_feedback_drift_1"]);
    assert.deepEqual(codex.startTurnRequests, []);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_feedback_drift_1",
        expectedTurnId: "turn_feedback_drift_original",
        text: "Focus on the failing tests first."
      }
    ]);
    assert.deepEqual(codex.responses, [{ requestId: "79", result: { decision: "decline" } }]);
  } finally {
    await bridge.stop();
  }
});

test("approval feedback starts a follow-up turn even when the approval has no feedback turn anchor", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_feedback_native_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_feedback_native_1",
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

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/started",
      params: {
        threadId: "thr_feedback_native_1",
        turnId: "turn_feedback_native_runtime",
        item: {
          id: "item_feedback_native_runtime",
          type: "message",
          role: "assistant",
          phase: "commentary",
          text: "Thinking..."
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await bridge.handleServerRequest({
      method: "execCommandApproval",
      id: 80,
      params: {
        callId: "call_feedback_native",
        command: ["npm", "test"],
        conversationId: "thr_feedback_native_1",
        cwd: "C:\\repo",
        parsedCmd: [],
        reason: "Run tests"
      }
    });

    const approval = store.listPendingApprovals()[0];
    assert.ok(approval);
    assert.equal(approval.feedbackTurnId, null);

    const result = await bridge.handleApprovalFeedback("user_1", approval.token, "Focus on the failing tests first.");

    assert.equal(result.content, "");
    assert.deepEqual(codex.resumedThreadIds, ["thr_feedback_native_1"]);
    assert.deepEqual(codex.startTurnRequests, [
      {
        threadId: "thr_feedback_native_1",
        text: "Focus on the failing tests first."
      }
    ]);
    assert.deepEqual(codex.responses, [{ requestId: "80", result: { decision: "denied" } }]);
  } finally {
    await bridge.stop();
  }
});

test("cli-session shell placeholders upgrade in place when a native exec approval later arrives through app-server", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_cli_exec_upgrade_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_cli_exec_upgrade_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "CLI thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "cli-session"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleSessionEvent({
      type: "shellApprovalRequested",
      threadId: "thr_cli_exec_upgrade_1",
      turnId: "turn_cli_exec_upgrade_1",
      callId: "call_cli_exec_upgrade_1",
      timestampMs: Date.now(),
      command: "Get-Date -Format o",
      cwd: "C:\\repo",
      justification: "Allow a harmless timestamp command.",
      prefixRule: null,
      details: JSON.stringify({ command: "Get-Date -Format o" })
    });

    assert.equal(discord.approvalCards.length, 1);
    assert.deepEqual(discord.approvalCards[0]?.decisions, []);

    const placeholder = store.findPendingApprovalByItem(
      "thr_cli_exec_upgrade_1",
      "call_cli_exec_upgrade_1",
      "commandExecution"
    );
    assert.ok(placeholder);
    assert.match(placeholder.requestId, /^session-log:/);

    await bridge.handleServerRequest({
      method: "execCommandApproval",
      id: 901,
      params: {
        callId: "call_cli_exec_upgrade_1",
        command: ["Get-Date", "-Format", "o"],
        conversationId: "thr_cli_exec_upgrade_1",
        cwd: "C:\\repo",
        parsedCmd: [],
        reason: "Allow a harmless timestamp command."
      }
    } as never);

    const approval = store.findPendingApprovalByItem(
      "thr_cli_exec_upgrade_1",
      "call_cli_exec_upgrade_1",
      "commandExecution"
    );
    assert.ok(approval);
    assert.equal(store.listPendingApprovals().length, 1);
    assert.equal(approval.token, placeholder.token);
    assert.equal(approval.requestId, "901");
    assert.equal(approval.turnId, "turn_cli_exec_upgrade_1");
    assert.equal(approval.feedbackTurnId, "turn_cli_exec_upgrade_1");
    assert.deepEqual(approval.availableDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
    assert.equal(discord.approvalCards.length, 2);
    assert.equal(discord.approvalCards[1]?.existingMessageId, "approval_msg_1");
    assert.equal(discord.approvalCards[1]?.token, placeholder.token);
    assert.deepEqual(discord.approvalCards[1]?.decisions, ["accept", "acceptForSession", "decline", "cancel"]);

    const result = await bridge.handleApprovalAction("user_1", approval.token, "acceptForSession");

    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [{ requestId: "901", result: { decision: "approved_for_session" } }]);
  } finally {
    await bridge.stop();
  }
});

test("cli-session shell placeholders upgrade in place when native exec approval omits conversationId", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_cli_exec_missing_conversation_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_cli_exec_missing_conversation_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "CLI thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "cli-session"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleSessionEvent({
      type: "shellApprovalRequested",
      threadId: "thr_cli_exec_missing_conversation_1",
      turnId: "turn_cli_exec_missing_conversation_1",
      callId: "call_cli_exec_missing_conversation_1",
      timestampMs: Date.now(),
      command: "Get-Date -Format o",
      cwd: "C:\\repo",
      justification: "Allow a harmless timestamp command.",
      prefixRule: null,
      details: JSON.stringify({ command: "Get-Date -Format o" })
    });

    const placeholder = store.findPendingApprovalByItem(
      "thr_cli_exec_missing_conversation_1",
      "call_cli_exec_missing_conversation_1",
      "commandExecution"
    );
    assert.ok(placeholder);
    assert.match(placeholder.requestId, /^session-log:/);

    await bridge.handleServerRequest({
      method: "execCommandApproval",
      id: 903,
      params: {
        callId: "call_cli_exec_missing_conversation_1",
        command: ["Get-Date", "-Format", "o"],
        cwd: "C:\\repo",
        parsedCmd: [],
        reason: "Allow a harmless timestamp command."
      }
    } as never);

    const approval = store.findPendingApprovalByItem(
      "thr_cli_exec_missing_conversation_1",
      "call_cli_exec_missing_conversation_1",
      "commandExecution"
    );
    assert.ok(approval);
    assert.equal(store.listPendingApprovals().length, 1);
    assert.equal(approval.token, placeholder.token);
    assert.equal(approval.requestId, "903");
    assert.equal(approval.turnId, "turn_cli_exec_missing_conversation_1");
    assert.equal(approval.feedbackTurnId, "turn_cli_exec_missing_conversation_1");
    assert.deepEqual(approval.availableDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
    assert.equal(discord.approvalCards.length, 2);
    assert.equal(discord.approvalCards[1]?.existingMessageId, "approval_msg_1");
    assert.equal(discord.approvalCards[1]?.token, placeholder.token);
    assert.deepEqual(discord.approvalCards[1]?.decisions, ["accept", "acceptForSession", "decline", "cancel"]);

    const result = await bridge.handleApprovalAction("user_1", approval.token, "acceptForSession");

    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [{ requestId: "903", result: { decision: "approved_for_session" } }]);
  } finally {
    await bridge.stop();
  }
});

test("cli-session feedback rejections are not overwritten as approved by later shell completions", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_cli_feedback_completion_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_cli_feedback_completion_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "CLI feedback thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "cli-session"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleSessionEvent({
      type: "shellApprovalRequested",
      threadId: "thr_cli_feedback_completion_1",
      turnId: "turn_cli_feedback_completion_1",
      callId: "call_cli_feedback_completion_1",
      timestampMs: Date.now(),
      command: "Start-Process https://example.com",
      cwd: "C:\\repo",
      justification: "Open example.com?",
      prefixRule: null,
      details: JSON.stringify({ command: "Start-Process https://example.com" })
    });

    await bridge.handleServerRequest({
      method: "execCommandApproval",
      id: 905,
      params: {
        callId: "call_cli_feedback_completion_1",
        command: ["Start-Process", "https://example.com"],
        conversationId: "thr_cli_feedback_completion_1",
        cwd: "C:\\repo",
        parsedCmd: [],
        reason: "Open example.com?"
      }
    } as never);

    const approval = store.findPendingApprovalByItem(
      "thr_cli_feedback_completion_1",
      "call_cli_feedback_completion_1",
      "commandExecution"
    );
    assert.ok(approval);

    const result = await bridge.handleApprovalFeedback(
      "user_1",
      approval.token,
      "Do not open the browser; summarize the command instead."
    );

    assert.equal(result.content, "");
    assert.equal(discord.disabledApprovalCards.length, 1);
    assert.match(
      discord.disabledApprovalCards[0]?.resolutionText ?? "",
      /Rejected in Discord with feedback/i
    );

    await bridge.handleSessionEvent({
      type: "shellCommandCompleted",
      threadId: "thr_cli_feedback_completion_1",
      callId: "call_cli_feedback_completion_1",
      timestampMs: Date.now() + 1_000,
      command: "Start-Process https://example.com",
      cwd: "C:\\repo",
      output: "exec command rejected by user",
      status: "declined"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.disabledApprovalCards.length, 1);
    assert.match(
      discord.disabledApprovalCards[0]?.resolutionText ?? "",
      /Rejected in Discord with feedback/i
    );
  } finally {
    await bridge.stop();
  }
});

test("deferred native exec approvals replay when a matching cli-session shell placeholder arrives later", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_cli_exec_deferred_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_cli_exec_deferred_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "CLI thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "cli-session"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest({
      method: "execCommandApproval",
      id: 904,
      params: {
        callId: "call_cli_exec_deferred_1",
        command: ["Get-Date", "-Format", "o"],
        cwd: "C:\\repo",
        parsedCmd: [],
        reason: "Allow a harmless timestamp command."
      }
    } as never);

    assert.equal(store.listPendingApprovals().length, 0);

    await bridge.handleSessionEvent({
      type: "shellApprovalRequested",
      threadId: "thr_cli_exec_deferred_1",
      turnId: "turn_cli_exec_deferred_1",
      callId: "call_cli_exec_deferred_1",
      timestampMs: Date.now(),
      command: "Get-Date -Format o",
      cwd: "C:\\repo",
      justification: "Allow a harmless timestamp command.",
      prefixRule: null,
      details: JSON.stringify({ command: "Get-Date -Format o" })
    });

    const approval = store.findPendingApprovalByItem(
      "thr_cli_exec_deferred_1",
      "call_cli_exec_deferred_1",
      "commandExecution"
    );
    assert.ok(approval);
    assert.equal(approval.requestId, "904");
    assert.equal(approval.turnId, "turn_cli_exec_deferred_1");
    assert.equal(approval.feedbackTurnId, "turn_cli_exec_deferred_1");
    assert.deepEqual(approval.availableDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
    assert.equal(discord.approvalCards.length, 2);
    assert.deepEqual(discord.approvalCards[0]?.decisions, []);
    assert.equal(discord.approvalCards[1]?.existingMessageId, "approval_msg_1");
    assert.deepEqual(discord.approvalCards[1]?.decisions, ["accept", "acceptForSession", "decline", "cancel"]);

    const result = await bridge.handleApprovalAction("user_1", approval.token, "accept");

    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [{ requestId: "904", result: { decision: "approved" } }]);
  } finally {
    await bridge.stop();
  }
});

test("cli-session shell placeholders preserve the session turn anchor when a native exec approval later arrives", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_cli_exec_feedback_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_cli_exec_feedback_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "CLI feedback thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "cli-session"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleSessionEvent({
      type: "shellApprovalRequested",
      threadId: "thr_cli_exec_feedback_1",
      turnId: "turn_cli_exec_feedback_1",
      callId: "call_cli_exec_feedback_1",
      timestampMs: Date.now(),
      command: "Start-Process https://example.com",
      cwd: "C:\\repo",
      justification: "Open example.com for testing.",
      prefixRule: null,
      details: JSON.stringify({ command: "Start-Process https://example.com" })
    });

    await bridge.handleServerRequest({
      method: "execCommandApproval",
      id: 902,
      params: {
        callId: "call_cli_exec_feedback_1",
        command: ["Start-Process", "https://example.com"],
        conversationId: "thr_cli_exec_feedback_1",
        cwd: "C:\\repo",
        parsedCmd: [],
        reason: "Open example.com for testing."
      }
    } as never);

    const approval = store.findPendingApprovalByItem(
      "thr_cli_exec_feedback_1",
      "call_cli_exec_feedback_1",
      "commandExecution"
    );
    assert.ok(approval);
    assert.equal(approval.feedbackTurnId, "turn_cli_exec_feedback_1");

    const result = await bridge.handleApprovalFeedback(
      "user_1",
      approval.token,
      "Do not open the browser; summarize what the command would do."
    );

    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [{ requestId: "902", result: { decision: "denied" } }]);
    assert.deepEqual(codex.resumedThreadIds, ["thr_cli_exec_feedback_1"]);
    assert.deepEqual(codex.startTurnRequests, []);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_cli_exec_feedback_1",
        expectedTurnId: "turn_cli_exec_feedback_1",
        text: "Do not open the browser; summarize what the command would do."
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("tool/requestUserInput approvals round-trip exact option payloads", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_tool_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_tool_1",
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

  try {
    await bridge.handleServerRequest({
      method: "item/tool/requestUserInput",
      id: 77,
      params: {
        threadId: "thr_tool_1",
        turnId: "turn_tool_1",
        itemId: "item_tool_1",
        questions: [
          {
            id: "mcp_tool_call_approval_call_abc123",
            question: "This app tool needs approval.",
            options: [
              { label: "Allow once" },
              { label: "Allow for this session" },
              { label: "Decline" }
            ]
          }
        ]
      }
    });

    assert.equal(discord.approvalCards.length, 1);
    assert.deepEqual(discord.approvalCards[0]?.decisions, [
      "Allow once",
      "Allow for this session",
      "Decline"
    ]);

    const approval = store.findPendingApprovalByItem("thr_tool_1", "item_tool_1", "toolUserInput");
    assert.ok(approval);
    assert.equal(
      approval.toolInput?.questions[0]?.options.at(-1)?.label,
      TELL_CODEX_DIFFERENTLY_LABEL
    );
    assert.equal(approval.toolInput?.questions[0]?.options.at(-1)?.isOther, true);
    const result = await bridge.handleApprovalAction("user_1", approval.token, "Allow for this session");

    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [
      {
        requestId: "77",
        result: {
          answers: {
            mcp_tool_call_approval_call_abc123: {
              answers: ["Allow for this session"]
            }
          }
        }
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("tool/requestUserInput multi-question prompts collect Discord answers before submitting", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_tool_multi_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_tool_multi_1",
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

  try {
    await bridge.handleServerRequest({
      method: "item/tool/requestUserInput",
      id: "multi_tool_request_1",
      params: {
        threadId: "thr_tool_multi_1",
        turnId: "turn_tool_multi_1",
        itemId: "item_tool_multi_1",
        questions: [
          {
            id: "scope",
            question: "Which scope should Codex use?",
            options: [{ label: "Minimal" }, { label: "Broad" }]
          },
          {
            id: "tests",
            question: "How much verification?",
            options: [{ label: "Unit only" }, { label: "Full suite" }]
          }
        ]
      }
    });

    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.toolInputQuestionCount, 2);
    assert.deepEqual(discord.approvalCards[0]?.decisions, []);

    const approval = store.findPendingApprovalByItem("thr_tool_multi_1", "item_tool_multi_1", "toolUserInput");
    assert.ok(approval);
    assert.equal(approval.toolInput?.questions.length, 2);

    const first = await bridge.handleToolInputOption("user_1", approval.token, 0, 1);
    assert.equal(first.content, "");
    assert.deepEqual(codex.responses, []);
    assert.equal(store.findPendingApprovalByToken(approval.token)?.toolInput?.selectedAnswers.scope, "Broad");
    assert.equal(discord.approvalCards.at(-1)?.existingMessageId, "approval_msg_1");
    assert.deepEqual(discord.approvalCards.at(-1)?.toolInputSelections, { scope: "Broad" });

    const second = await bridge.handleToolInputOption("user_1", approval.token, 1, 1);
    assert.equal(second.content, "");
    assert.deepEqual(codex.responses, [
      {
        requestId: "multi_tool_request_1",
        result: {
          answers: {
            scope: { answers: ["Broad"] },
            tests: { answers: ["Full suite"] }
          }
        }
      }
    ]);
    assert.equal(store.findPendingApprovalByToken(approval.token)?.status, "decisionSent");
    assert.equal(discord.disabledApprovalCards.at(-1)?.resolutionText, "Answered in Discord");
  } finally {
    await bridge.stop();
  }
});

test("tool/requestUserInput Other option submits modal text", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_tool_other_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_tool_other_1",
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

  try {
    await bridge.handleServerRequest({
      method: "item/tool/requestUserInput",
      id: "other_tool_request_1",
      params: {
        threadId: "thr_tool_other_1",
        turnId: "turn_tool_other_1",
        itemId: "item_tool_other_1",
        questions: [
          {
            id: "preference",
            question: "What should Codex do?",
            options: [{ label: "Default" }, { label: "Other", isOther: true }]
          }
        ]
      }
    });

    const approval = store.findPendingApprovalByItem("thr_tool_other_1", "item_tool_other_1", "toolUserInput");
    assert.ok(approval);

    const result = await bridge.handleToolInputOther(
      "user_1",
      approval.token,
      0,
      "Use the smallest patch that preserves behavior."
    );

    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [
      {
        requestId: "other_tool_request_1",
        result: {
          answers: {
            preference: {
              answers: ["Use the smallest patch that preserves behavior."]
            }
          }
        }
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("desktop IPC command approvals surface exec-policy decisions and route approval clicks back through IPC", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_ipc_cmd_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_ipc_cmd_1",
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

  try {
    await bridge.start({ skipDiscovery: true });

    desktopIpc.emit("requestUpserted", {
      threadId: "thr_ipc_cmd_1",
      requestId: "108",
      request: {
        method: "item/commandExecution/requestApproval",
        id: 108,
        params: {
          threadId: "thr_ipc_cmd_1",
          turnId: "turn_ipc_cmd_1",
          itemId: "call_ipc_cmd_1",
          reason: "Allow this harmless command?",
          command: "\"pwsh\" -Command 'Get-Date -Format s'",
          cwd: "C:\\repo",
          availableDecisions: [
            "accept",
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ["pwsh", "-Command", "Get-Date -Format s"]
              }
            },
            "cancel"
          ]
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.approvalCards.length, 1);
    assert.deepEqual(discord.approvalCards[0]?.decisions, ["accept", "acceptWithExecpolicyAmendment", "cancel"]);

    const approval = store.findPendingApprovalByItem("thr_ipc_cmd_1", "call_ipc_cmd_1", "commandExecution");
    assert.ok(approval);
    const result = await bridge.handleApprovalAction("user_1", approval.token, "acceptWithExecpolicyAmendment");

    assert.equal(result.content, "");
    assert.deepEqual(desktopIpc.responses, [
      {
        method: "thread-follower-command-approval-decision",
        params: {
          conversationId: "thr_ipc_cmd_1",
          requestId: "108",
          decision: {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["pwsh", "-Command", "Get-Date -Format s"]
            }
          }
        }
      }
    ]);
    assert.deepEqual(codex.responses, []);
  } finally {
    await bridge.stop();
  }
});

test("app-server command approvals for remote CLI threads do not route approval clicks through Desktop IPC", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_remote_cli_cmd_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_remote_cli_cmd_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Remote CLI thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "app-server"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: 701,
      params: {
        threadId: "thr_remote_cli_cmd_1",
        turnId: "turn_remote_cli_cmd_1",
        itemId: "call_remote_cli_cmd_1",
        reason: "Open example.com?",
        command: "\"pwsh\" -Command 'Start-Process https://example.com'",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "decline"]
      }
    } as never);

    const approval = store.findPendingApprovalByItem("thr_remote_cli_cmd_1", "call_remote_cli_cmd_1", "commandExecution");
    assert.ok(approval);

    const result = await bridge.handleApprovalAction("user_1", approval.token, "accept");

    assert.equal(result.content, "");
    assert.deepEqual(desktopIpc.responses, []);
    assert.deepEqual(codex.responses, [{ requestId: "701", result: { decision: "accept" } }]);
  } finally {
    await bridge.stop();
  }
});

test("desktop IPC feedback on cancel-only command approvals declines in Desktop and steers the anchored approval turn", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_ipc_feedback_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_ipc_feedback_1",
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

  try {
    await bridge.start({ skipDiscovery: true });
    linkDesktopFeedbackVisibility(desktopIpc, codex, 600);

    desktopIpc.conversationStates.set("thr_ipc_feedback_1", {
      id: "thr_ipc_feedback_1",
      cwd: "C:\\repo",
      updatedAt: 1_779_000_000_000,
      turns: [
        {
          turnId: "turn_ipc_feedback_1",
          status: "complete",
          params: {
            threadId: "thr_ipc_feedback_1",
            input: [
              {
                type: "text",
                text: "Original approval turn."
              }
            ],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        },
        {
          turnId: "turn_ipc_feedback_newer",
          status: "inProgress",
          params: {
            threadId: "thr_ipc_feedback_1",
            input: [
              {
                type: "text",
                text: "A newer turn should not capture approval feedback."
              }
            ],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        }
      ],
      requests: []
    });

    desktopIpc.emit("requestUpserted", {
      threadId: "thr_ipc_feedback_1",
      requestId: "208",
      request: {
        method: "item/commandExecution/requestApproval",
        id: 208,
        params: {
          threadId: "thr_ipc_feedback_1",
          turnId: "turn_ipc_feedback_1",
          itemId: "call_ipc_feedback_1",
          reason: "Allow this browser command?",
          command: "\"pwsh\" -Command 'Start-Process https://example.com'",
          cwd: "C:\\repo",
          availableDecisions: ["accept", "cancel"]
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const approval = store.findPendingApprovalByItem("thr_ipc_feedback_1", "call_ipc_feedback_1", "commandExecution");
    assert.ok(approval);

    const result = await bridge.handleApprovalFeedback("user_1", approval.token, "Do not open the browser; summarize the command instead.");

    assert.equal(result.content, "");
    assert.equal(desktopIpc.responses.length, 2);
    assert.deepEqual(desktopIpc.responses[0], {
      method: "thread-follower-command-approval-decision",
      params: {
        conversationId: "thr_ipc_feedback_1",
        requestId: "208",
        decision: "decline"
      }
    });
    assert.equal(desktopIpc.responses[1]?.method, "thread-follower-steer-turn");
    assert.equal(desktopIpc.responses[1]?.params.expectedTurnId, "turn_ipc_feedback_1");
    assert.deepEqual(codex.steerRequests, []);
    assert.deepEqual(codex.resumedThreadIds, ["thr_ipc_feedback_1"]);
    assert.deepEqual(codex.startTurnRequests, []);
  } finally {
    await bridge.stop();
  }
});

test("desktop-backed app-server approvals still steer through the Desktop follower when Desktop conversation state exists", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_desktop_feedback_via_appserver_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_desktop_feedback_via_appserver_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Desktop app-server feedback thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    sourceKind: "app-server"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    linkDesktopFeedbackVisibility(desktopIpc, codex);

    desktopIpc.conversationStates.set("thr_desktop_feedback_via_appserver_1", {
      id: "thr_desktop_feedback_via_appserver_1",
      cwd: "C:\\repo",
      updatedAt: 1_779_000_100_000,
      turns: [
        {
          turnId: "turn_desktop_feedback_via_appserver_1",
          status: "complete",
          params: {
            threadId: "thr_desktop_feedback_via_appserver_1",
            input: [
              {
                type: "text",
                text: "Original desktop-backed approval turn."
              }
            ],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        }
      ],
      requests: []
    });

    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: 709,
      params: {
        threadId: "thr_desktop_feedback_via_appserver_1",
        turnId: "turn_desktop_feedback_via_appserver_1",
        itemId: "call_desktop_feedback_via_appserver_1",
        reason: "Open example.com?",
        command: "\"pwsh\" -Command 'Start-Process https://example.com'",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "cancel"]
      }
    } as never);

    const approval = store.findPendingApprovalByItem(
      "thr_desktop_feedback_via_appserver_1",
      "call_desktop_feedback_via_appserver_1",
      "commandExecution"
    );
    assert.ok(approval);

    const result = await bridge.handleApprovalFeedback(
      "user_1",
      approval.token,
      "Do not open the browser; summarize the command instead."
    );

    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, []);
    assert.deepEqual(codex.steerRequests, []);
    assert.deepEqual(codex.resumedThreadIds, ["thr_desktop_feedback_via_appserver_1"]);
    assert.equal(desktopIpc.responses.length, 2);
    assert.deepEqual(desktopIpc.responses[0], {
      method: "thread-follower-command-approval-decision",
      params: {
        conversationId: "thr_desktop_feedback_via_appserver_1",
        requestId: "709",
        decision: "decline"
      }
    });
    assert.equal(desktopIpc.responses[1]?.method, "thread-follower-steer-turn");
    assert.equal(desktopIpc.responses[1]?.params.expectedTurnId, "turn_desktop_feedback_via_appserver_1");
  } finally {
    await bridge.stop();
  }
});

test("desktop approval feedback keeps steering anchored to the original approval turn even when a newer Desktop turn exists", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_ipc_feedback_stale_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_ipc_feedback_stale_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "IPC feedback stale turn thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "app-server"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    linkDesktopFeedbackVisibility(desktopIpc, codex);

    desktopIpc.conversationStates.set("thr_ipc_feedback_stale_1", {
      id: "thr_ipc_feedback_stale_1",
      cwd: "C:\\repo",
      updatedAt: 1_779_000_200_000,
      turns: [
        {
          turnId: "turn_ipc_feedback_stale_original",
          status: "complete",
          params: {
            threadId: "thr_ipc_feedback_stale_1",
            input: [
              {
                type: "text",
                text: "Original approval turn."
              }
            ],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        },
        {
          turnId: "turn_ipc_feedback_stale_active",
          status: "inProgress",
          params: {
            threadId: "thr_ipc_feedback_stale_1",
            input: [
              {
                type: "text",
                text: "The current Desktop turn should receive the feedback."
              }
            ],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        }
      ],
      requests: []
    });

    codex.steerErrorsByExpectedTurnId.set(
      "turn_ipc_feedback_stale_original",
      new Error("Cannot steer conversation because its active turn already ended")
    );

    desktopIpc.emit("requestUpserted", {
      threadId: "thr_ipc_feedback_stale_1",
      requestId: "209",
      request: {
        method: "item/commandExecution/requestApproval",
        id: 209,
        params: {
          threadId: "thr_ipc_feedback_stale_1",
          turnId: "turn_ipc_feedback_stale_original",
          itemId: "call_ipc_feedback_stale_1",
          reason: "Allow this browser command?",
          command: "\"pwsh\" -Command 'Start-Process https://example.com'",
          cwd: "C:\\repo",
          availableDecisions: ["accept", "cancel"]
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const approval = store.findPendingApprovalByItem(
      "thr_ipc_feedback_stale_1",
      "call_ipc_feedback_stale_1",
      "commandExecution"
    );
    assert.ok(approval);

    const result = await bridge.handleApprovalFeedback(
      "user_1",
      approval.token,
      "Do not open the browser; summarize the command instead."
    );

    assert.equal(result.content, "");
    assert.deepEqual(codex.steerRequests, []);
    assert.deepEqual(codex.resumedThreadIds, ["thr_ipc_feedback_stale_1"]);
    assert.equal(desktopIpc.responses.length, 2);
    assert.deepEqual(desktopIpc.responses[0], {
      method: "thread-follower-command-approval-decision",
      params: {
        conversationId: "thr_ipc_feedback_stale_1",
        requestId: "209",
        decision: "decline"
      }
    });
    assert.equal(desktopIpc.responses[1]?.method, "thread-follower-steer-turn");
    assert.equal(desktopIpc.responses[1]?.params.expectedTurnId, "turn_ipc_feedback_stale_original");
  } finally {
    await bridge.stop();
  }
});

test("desktop approval feedback keeps the original anchored Desktop turn even when app-server steer candidates would fail", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_ipc_feedback_stale_desktop_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_ipc_feedback_stale_desktop_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "IPC feedback stale Desktop fallback thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "app-server"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    linkDesktopFeedbackVisibility(desktopIpc, codex);

    desktopIpc.conversationStates.set("thr_ipc_feedback_stale_desktop_1", {
      id: "thr_ipc_feedback_stale_desktop_1",
      cwd: "C:\\repo",
      updatedAt: 1_779_000_300_000,
      turns: [
        {
          turnId: "turn_ipc_feedback_stale_desktop_original",
          status: "complete",
          params: {
            threadId: "thr_ipc_feedback_stale_desktop_1",
            input: [{ type: "text", text: "Original approval turn." }],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        },
        {
          turnId: "turn_ipc_feedback_stale_desktop_active",
          status: "inProgress",
          params: {
            threadId: "thr_ipc_feedback_stale_desktop_1",
            input: [{ type: "text", text: "Current active turn." }],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        }
      ],
      requests: []
    });

    codex.steerErrorsByExpectedTurnId.set(
      "turn_ipc_feedback_stale_desktop_original",
      new Error("Cannot steer conversation because its active turn already ended")
    );
    codex.steerErrorsByExpectedTurnId.set(
      "turn_ipc_feedback_stale_desktop_active",
      new Error("active-turn recovery still failed through app-server")
    );

    desktopIpc.emit("requestUpserted", {
      threadId: "thr_ipc_feedback_stale_desktop_1",
      requestId: "210",
      request: {
        method: "item/commandExecution/requestApproval",
        id: 210,
        params: {
          threadId: "thr_ipc_feedback_stale_desktop_1",
          turnId: "turn_ipc_feedback_stale_desktop_original",
          itemId: "call_ipc_feedback_stale_desktop_1",
          reason: "Allow this browser command?",
          command: "\"pwsh\" -Command 'Start-Process https://example.com'",
          cwd: "C:\\repo",
          availableDecisions: ["accept", "cancel"]
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const approval = store.findPendingApprovalByItem(
      "thr_ipc_feedback_stale_desktop_1",
      "call_ipc_feedback_stale_desktop_1",
      "commandExecution"
    );
    assert.ok(approval);

    const result = await bridge.handleApprovalFeedback(
      "user_1",
      approval.token,
      "Do not open the browser; summarize the command instead."
    );

    assert.equal(result.content, "");
    assert.deepEqual(codex.steerRequests, []);
    assert.deepEqual(codex.resumedThreadIds, ["thr_ipc_feedback_stale_desktop_1"]);
    assert.equal(desktopIpc.responses.length, 2);
    assert.deepEqual(desktopIpc.responses[0], {
      method: "thread-follower-command-approval-decision",
      params: {
        conversationId: "thr_ipc_feedback_stale_desktop_1",
        requestId: "210",
        decision: "decline"
      }
    });
    assert.equal(desktopIpc.responses[1]?.method, "thread-follower-steer-turn");
    assert.equal(desktopIpc.responses[1]?.params.conversationId, "thr_ipc_feedback_stale_desktop_1");
    assert.equal(desktopIpc.responses[1]?.params.expectedTurnId, "turn_ipc_feedback_stale_desktop_original");
    assert.deepEqual(desktopIpc.responses[1]?.params.input, [
      {
        type: "text",
        text: "Do not open the browser; summarize the command instead."
      }
    ]);
    assert.ok(desktopIpc.responses[1]?.params.restoreMessage);
  } finally {
    await bridge.stop();
  }
});

test("desktop approval feedback reconstructs Desktop restore state from thread/read after the live snapshot disappears", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_ipc_feedback_captured_state_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_ipc_feedback_captured_state_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "IPC feedback captured state thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "app-server"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    linkDesktopFeedbackVisibility(desktopIpc, codex);

    desktopIpc.conversationStates.set("thr_ipc_feedback_captured_state_1", {
      id: "thr_ipc_feedback_captured_state_1",
      cwd: "C:\\repo",
      updatedAt: 1_779_000_350_000,
      turns: [
        {
          turnId: "turn_ipc_feedback_captured_original",
          status: "complete",
          params: {
            threadId: "thr_ipc_feedback_captured_state_1",
            input: [{ type: "text", text: "Original approval turn." }],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        },
        {
          turnId: "turn_ipc_feedback_captured_active",
          status: "inProgress",
          params: {
            threadId: "thr_ipc_feedback_captured_state_1",
            input: [{ type: "text", text: "Current active Desktop turn." }],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        }
      ],
      requests: []
    });
    desktopIpc.ownerClientIdsByThread.set("thr_ipc_feedback_captured_state_1", "desktop-owner-client");

    codex.steerErrorsByExpectedTurnId.set(
      "turn_ipc_feedback_captured_original",
      new Error("Cannot steer conversation because its active turn already ended")
    );
    codex.steerErrorsByExpectedTurnId.set(
      "turn_ipc_feedback_captured_active",
      new Error("app-server fallback should not run when pre-decline Desktop context was captured")
    );

    const originalSendCommandApprovalDecision = desktopIpc.sendCommandApprovalDecision.bind(desktopIpc);
    desktopIpc.sendCommandApprovalDecision = async (conversationId: string, requestId: string, decision: unknown) => {
      await originalSendCommandApprovalDecision(conversationId, requestId, decision);
      desktopIpc.conversationStates.delete(conversationId);
      desktopIpc.ownerClientIdsByThread.delete(conversationId);
    };

    desktopIpc.emit("requestUpserted", {
      threadId: "thr_ipc_feedback_captured_state_1",
      requestId: "2101",
      request: {
        method: "item/commandExecution/requestApproval",
        id: 2101,
        params: {
          threadId: "thr_ipc_feedback_captured_state_1",
          turnId: "turn_ipc_feedback_captured_original",
          itemId: "call_ipc_feedback_captured_state_1",
          reason: "Allow this browser command?",
          command: "\"pwsh\" -Command 'Start-Process https://example.com'",
          cwd: "C:\\repo",
          availableDecisions: ["accept", "cancel"]
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const approval = store.findPendingApprovalByItem(
      "thr_ipc_feedback_captured_state_1",
      "call_ipc_feedback_captured_state_1",
      "commandExecution"
    );
    assert.ok(approval);

    const result = await bridge.handleApprovalFeedback(
      "user_1",
      approval.token,
      "Do not open the browser; summarize the command instead."
    );

    assert.equal(result.content, "");
    assert.deepEqual(codex.steerRequests, []);
    assert.deepEqual(codex.resumedThreadIds, ["thr_ipc_feedback_captured_state_1"]);
    assert.equal(desktopIpc.responses.length, 2);
    assert.deepEqual(desktopIpc.responses[0], {
      method: "thread-follower-command-approval-decision",
      params: {
        conversationId: "thr_ipc_feedback_captured_state_1",
        requestId: "2101",
        decision: "decline"
      }
    });
    assert.equal(desktopIpc.responses[1]?.method, "thread-follower-steer-turn");
    assert.equal(desktopIpc.responses[1]?.params.conversationId, "thr_ipc_feedback_captured_state_1");
    assert.equal(desktopIpc.responses[1]?.params.expectedTurnId, "turn_ipc_feedback_captured_original");
  } finally {
    await bridge.stop();
  }
});

test("desktop approval feedback reports failure instead of falling back to app-server steer when the Desktop follower steer fails", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_ipc_feedback_followup_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_ipc_feedback_followup_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "IPC feedback follow-up thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "app-server"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    desktopIpc.conversationStates.set("thr_ipc_feedback_followup_1", {
      id: "thr_ipc_feedback_followup_1",
      cwd: "C:\\repo",
      updatedAt: 1_779_000_400_000,
      turns: [
        {
          turnId: "turn_ipc_feedback_followup_original",
          status: "complete",
          params: {
            threadId: "thr_ipc_feedback_followup_1",
            input: [{ type: "text", text: "Original approval turn." }],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        },
        {
          turnId: "turn_ipc_feedback_followup_active",
          status: "inProgress",
          params: {
            threadId: "thr_ipc_feedback_followup_1",
            input: [{ type: "text", text: "Current active turn." }],
            cwd: "C:\\repo",
            attachments: [],
            commentAttachments: [],
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["C:\\repo"]
            }
          }
        }
      ],
      requests: []
    });

    codex.steerErrorsByExpectedTurnId.set(
      "turn_ipc_feedback_followup_original",
      new Error("Cannot steer conversation because its active turn already ended")
    );
    codex.steerErrorsByExpectedTurnId.set(
      "turn_ipc_feedback_followup_active",
      new Error("active-turn recovery still failed through app-server")
    );
    desktopIpc.steerError = new Error("Timed out waiting for Codex Desktop IPC response to thread-follower-steer-turn.");

    desktopIpc.emit("requestUpserted", {
      threadId: "thr_ipc_feedback_followup_1",
      requestId: "211",
      request: {
        method: "item/commandExecution/requestApproval",
        id: 211,
        params: {
          threadId: "thr_ipc_feedback_followup_1",
          turnId: "turn_ipc_feedback_followup_original",
          itemId: "call_ipc_feedback_followup_1",
          reason: "Allow this browser command?",
          command: "\"pwsh\" -Command 'Start-Process https://example.com'",
          cwd: "C:\\repo",
          availableDecisions: ["accept", "cancel"]
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const approval = store.findPendingApprovalByItem(
      "thr_ipc_feedback_followup_1",
      "call_ipc_feedback_followup_1",
      "commandExecution"
    );
    assert.ok(approval);

    const result = await bridge.handleApprovalFeedback(
      "user_1",
      approval.token,
      "Do not open the browser; summarize the command instead."
    );

    assert.match(result.content, /could not deliver/i);
    assert.equal(result.ephemeral, true);
    assert.deepEqual(codex.steerRequests, []);
    assert.deepEqual(codex.startTurnRequests, []);
    assert.deepEqual(codex.resumedThreadIds, ["thr_ipc_feedback_followup_1"]);
    assert.equal(desktopIpc.responses.length, 2);
    assert.deepEqual(desktopIpc.responses[0], {
      method: "thread-follower-command-approval-decision",
      params: {
        conversationId: "thr_ipc_feedback_followup_1",
        requestId: "211",
        decision: "decline"
      }
    });
    assert.equal(desktopIpc.responses[1]?.method, "thread-follower-steer-turn");
    assert.equal(desktopIpc.responses[1]?.params.expectedTurnId, "turn_ipc_feedback_followup_original");
  } finally {
    await bridge.stop();
  }
});

test("cli-session approval feedback falls back to a follow-up turn when anchored steer delivery fails", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_cli_feedback_followup_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_cli_feedback_followup_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "CLI feedback follow-up thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "cli-session"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/started",
      params: {
        threadId: "thr_cli_feedback_followup_1",
        turnId: "turn_cli_feedback_followup_original",
        item: {
          id: "item_cli_feedback_followup_original",
          type: "message",
          role: "assistant",
          phase: "commentary",
          text: "Thinking..."
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.steerErrorsByExpectedTurnId.set(
      "turn_cli_feedback_followup_original",
      new Error("CLI steer delivery failed")
    );

    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: 212,
      params: {
        itemId: "item_cli_feedback_followup_approval",
        threadId: "thr_cli_feedback_followup_1",
        turnId: "turn_cli_feedback_followup_original",
        command: "npm test",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "decline"]
      }
    });

    const approval = store.findPendingApprovalByItem(
      "thr_cli_feedback_followup_1",
      "item_cli_feedback_followup_approval",
      "commandExecution"
    );
    assert.ok(approval);

    const result = await bridge.handleApprovalFeedback(
      "user_1",
      approval.token,
      "Do not run the command; summarize it instead."
    );

    assert.equal(result.content, "");
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_cli_feedback_followup_1",
        expectedTurnId: "turn_cli_feedback_followup_original",
        text: "Do not run the command; summarize it instead."
      }
    ]);
    assert.deepEqual(codex.startTurnRequests, [
      {
        threadId: "thr_cli_feedback_followup_1",
        text: "Do not run the command; summarize it instead."
      }
    ]);
    assert.deepEqual(codex.resumedThreadIds, [
      "thr_cli_feedback_followup_1",
      "thr_cli_feedback_followup_1"
    ]);
  } finally {
    await bridge.stop();
  }
});

test("app-server cancel-only command approvals for remote CLI threads reject with feedback and keep steering on the app-server path", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_remote_cli_feedback_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_remote_cli_feedback_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Remote CLI feedback thread",
    lastStatusType: "active",
    channelKind: "conversation",
    sourceKind: "app-server"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: 702,
      params: {
        threadId: "thr_remote_cli_feedback_1",
        turnId: "turn_remote_cli_feedback_1",
        itemId: "call_remote_cli_feedback_1",
        reason: "Open example.com?",
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
    } as never);

    const approval = store.findPendingApprovalByItem(
      "thr_remote_cli_feedback_1",
      "call_remote_cli_feedback_1",
      "commandExecution"
    );
    assert.ok(approval);

    const result = await bridge.handleApprovalFeedback(
      "user_1",
      approval.token,
      "Do not open the browser; explain what the command would do."
    );

    assert.equal(result.content, "");
    assert.deepEqual(desktopIpc.responses, []);
    assert.deepEqual(codex.responses, [{ requestId: "702", result: { decision: "decline" } }]);
    assert.deepEqual(codex.resumedThreadIds, ["thr_remote_cli_feedback_1"]);
    assert.deepEqual(codex.steerRequests, [
      {
        threadId: "thr_remote_cli_feedback_1",
        expectedTurnId: "turn_remote_cli_feedback_1",
        text: "Do not open the browser; explain what the command would do."
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("desktop IPC browser-style tool approvals show up in Discord and route selected answers back through IPC", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_ipc_tool_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_ipc_tool_1",
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

  try {
    await bridge.start({ skipDiscovery: true });

    desktopIpc.emit("requestUpserted", {
      threadId: "thr_ipc_tool_1",
      requestId: "browser_nav_approval_1",
      request: {
        method: "item/tool/requestUserInput",
        id: "browser_nav_approval_1",
        params: {
          turnId: "turn_ipc_tool_1",
          itemId: "item_ipc_tool_1",
          questions: [
            {
              id: "browser_nav_question_1",
              question: "Allow browser navigation?",
              options: [{ label: "Allow once" }, { label: "Decline" }]
            }
          ]
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.approvalCards.length, 1);
    assert.deepEqual(discord.approvalCards[0]?.decisions, ["Allow once", "Decline"]);
    assert.equal(discord.approvalCards[0]?.toolInputQuestionCount, 1);

    const approval = store.findPendingApprovalByItem("thr_ipc_tool_1", "item_ipc_tool_1", "toolUserInput");
    assert.ok(approval);
    const result = await bridge.handleToolInputOption("user_1", approval.token, 0, 0);

    assert.equal(result.content, "");
    assert.deepEqual(desktopIpc.responses, [
      {
        method: "thread-follower-submit-user-input",
        params: {
          conversationId: "thr_ipc_tool_1",
          requestId: "browser_nav_approval_1",
          response: {
            answers: {
              browser_nav_question_1: {
                answers: ["Allow once"]
              }
            }
          }
        }
      }
    ]);
    assert.deepEqual(codex.responses, []);
  } finally {
    await bridge.stop();
  }
});

test("tool input prompts with long labels stay answerable and preserve full payloads", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_tool_limit_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_tool_limit_1",
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

  try {
    await bridge.start({ skipDiscovery: true });
    const longLabel = `Allow once ${"x".repeat(90)}`;
    await (bridge as any).handleSessionEvent({
      type: "nativeQuestionRequested",
      threadId: "thr_tool_limit_1",
      requestId: "92",
      questionCount: 1,
      timestampMs: Date.now()
    });

    await bridge.handleServerRequest({
      method: "item/tool/requestUserInput",
      id: 92,
      params: {
        turnId: "turn_tool_limit_1",
        itemId: "item_tool_limit_1",
        questions: [
          {
            id: "browser_nav_approval_limit",
            question: "Allow browser navigation?",
            options: [{ label: longLabel }, { label: "Decline" }]
          }
        ]
      }
    });

    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.toolInputQuestionCount, 1);

    const approval = store.findPendingApprovalByItem("thr_tool_limit_1", "item_tool_limit_1", "toolUserInput");
    assert.ok(approval);
    assert.deepEqual(approval.availableDecisions, [longLabel, "Decline"]);
    assert.equal(approval.reason, null);

    const result = await bridge.handleToolInputOption("user_1", approval.token, 0, 0);

    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [
      {
        requestId: "92",
        result: {
          answers: {
            browser_nav_approval_limit: {
              answers: [longLabel]
            }
          }
        }
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("tool input prompts that exceed Discord component limits remain read-only", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_tool_too_many_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_tool_too_many_1",
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

  try {
    await bridge.handleServerRequest({
      method: "item/tool/requestUserInput",
      id: "too_many_tool_request_1",
      params: {
        threadId: "thr_tool_too_many_1",
        turnId: "turn_tool_too_many_1",
        itemId: "item_tool_too_many_1",
        questions: [
          {
            id: "choice",
            question: "Pick one option.",
            options: [
              { label: "One" },
              { label: "Two" },
              { label: "Three" },
              { label: "Four" },
              { label: "Five" },
              { label: "Six" }
            ]
          }
        ]
      }
    });

    const approval = store.findPendingApprovalByItem(
      "thr_tool_too_many_1",
      "item_tool_too_many_1",
      "toolUserInput"
    );
    assert.ok(approval);
    assert.equal(approval.toolInput, null);
    assert.deepEqual(approval.availableDecisions, []);
    assert.equal(
      approval.reason,
      "This tool prompt can't be answered safely from Discord. Complete it in Codex Desktop."
    );
    assert.deepEqual(codex.responses, []);
  } finally {
    await bridge.stop();
  }
});

test("specific Discord approval text is preserved when Desktop later logs the native resolution", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, discord, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_ipc_confirmed_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_ipc_confirmed_1",
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

  try {
    await bridge.start({ skipDiscovery: true });

    desktopIpc.emit("requestUpserted", {
      threadId: "thr_ipc_confirmed_1",
      requestId: "208",
      request: {
        method: "item/commandExecution/requestApproval",
        id: 208,
        params: {
          threadId: "thr_ipc_confirmed_1",
          turnId: "turn_ipc_confirmed_1",
          itemId: "call_ipc_confirmed_1",
          reason: "Allow this harmless command?",
          command: "\"pwsh\" -Command 'Get-Date -Format s'",
          cwd: "C:\\repo",
          availableDecisions: ["accept", "decline", "cancel"]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const approval = store.findPendingApprovalByItem(
      "thr_ipc_confirmed_1",
      "call_ipc_confirmed_1",
      "commandExecution"
    );
    assert.ok(approval);

    const result = await bridge.handleApprovalAction("user_1", approval.token, "accept");
    assert.equal(result.content, "");
    assert.equal(discord.disabledApprovalCards.length, 1);
    assert.match(discord.disabledApprovalCards[0]?.resolutionText ?? "", /Approved once in Discord/i);

    await bridge.handleSessionEvent({
      type: "nativeApprovalResolved",
      threadId: "thr_ipc_confirmed_1",
      requestId: "208",
      method: "execCommandApproval",
      timestampMs: Date.now(),
      response: { decision: "approved" }
    });

    assert.equal(store.findPendingApprovalByRequestId("208")?.status, "approved");
    assert.equal(discord.disabledApprovalCards.length, 1);
    assert.match(discord.disabledApprovalCards[0]?.resolutionText ?? "", /Approved once in Discord/i);
  } finally {
    await bridge.stop();
  }
});

test("tool/requestUserInput resolves the thread from a native desktop question hint when threadId is missing", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_tool_hint_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_tool_hint_1",
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

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleSessionEvent({
      type: "nativeQuestionRequested",
      threadId: "thr_tool_hint_1",
      requestId: "91",
      questionCount: 1,
      timestampMs: Date.now()
    });

    await bridge.handleServerRequest({
      method: "item/tool/requestUserInput",
      id: 91,
      params: {
        turnId: "turn_tool_hint_1",
        itemId: "item_tool_hint_1",
        questions: [
          {
            id: "browser_nav_approval",
            question: "Allow browser navigation?",
            options: [{ label: "Allow once" }, { label: "Decline" }]
          }
        ]
      }
    });

    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.channelId, "discord_channel_tool_hint_1");
    assert.deepEqual(discord.approvalCards[0]?.decisions, ["Allow once", "Decline"]);

    const approval = store.findPendingApprovalByItem("thr_tool_hint_1", "item_tool_hint_1", "toolUserInput");
    assert.ok(approval);
    const result = await bridge.handleApprovalAction("user_1", approval.token, "Allow once");

    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [
      {
        requestId: "91",
        result: {
          answers: {
            browser_nav_approval: {
              answers: ["Allow once"]
            }
          }
        }
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("missing-thread MCP approvals stay deferred even when there is only one recent mapped thread", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_mcp_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_mcp_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(Date.now() - 30_000).toISOString(),
    attachMode: "auto",
    threadName: "Thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest({
      method: "mcpServer/elicitation/request",
      id: 123,
      params: {
        message: "Allow Browser navigate to open this page?",
        mode: "url",
        url: "https://example.com"
      }
    });

    assert.equal(discord.approvalCards.length, 0);
    assert.equal(store.findPendingApprovalByRequestId("123"), undefined);

    tailer.setDesktopEvents([
      {
        type: "nativeQuestionRequested",
        threadId: "thr_mcp_1",
        requestId: "123",
        questionCount: 1,
        timestampMs: Date.now()
      }
    ]);
    await bridge.pollDesktopApprovalEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue();

    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.channelId, "discord_channel_mcp_1");
    assert.deepEqual(discord.approvalCards[0]?.decisions, [
      "accept",
      "acceptWithExecpolicyAmendment",
      "cancel"
    ]);

    const approval = store.findPendingApprovalByItem("thr_mcp_1", "mcp-elicitation:123", "mcpElicitation");
    assert.ok(approval);
    const result = await bridge.handleApprovalAction("user_1", approval.token, "acceptWithExecpolicyAmendment");

    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [
      {
        requestId: "123",
        result: {
          action: "accept",
          content: {},
          _meta: null
        }
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("ambiguous missing-thread MCP approvals stay deferred until an explicit thread hint arrives", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_mcp_ambiguous_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_mcp_ambiguous_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(Date.now() - 30_000).toISOString(),
    attachMode: "auto",
    threadName: "Thread one",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_mcp_ambiguous_2",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_mcp_ambiguous_2",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(Date.now() - 20_000).toISOString(),
    attachMode: "auto",
    threadName: "Thread two",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest({
      method: "mcpServer/elicitation/request",
      id: "req_mcp_ambiguous_1",
      params: {
        message: "Allow Browser navigate to open this page?",
        mode: "url",
        url: "https://example.com"
      }
    });

    assert.equal(discord.approvalCards.length, 0);
    assert.equal(store.findPendingApprovalByRequestId("req_mcp_ambiguous_1"), undefined);

    tailer.setDesktopEvents([
      {
        type: "nativeQuestionRequested",
        threadId: "thr_mcp_ambiguous_2",
        requestId: "req_mcp_ambiguous_1",
        questionCount: 1,
        timestampMs: Date.now()
      }
    ]);
    await bridge.pollDesktopApprovalEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue();

    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.channelId, "discord_channel_mcp_ambiguous_2");
    assert.ok(store.findPendingApprovalByItem("thr_mcp_ambiguous_2", "mcp-elicitation:req_mcp_ambiguous_1", "mcpElicitation"));
  } finally {
    await bridge.stop();
  }
});

test("app-server MCP approvals wait for local thread hints and mirror onto the spawned subagent thread", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_mcp_hint",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_mcp_hint",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(Date.now() - 30_000).toISOString(),
    attachMode: "auto",
    threadName: "Parent thread",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  tailer.setParentThread("thr_child_mcp_hint", "thr_parent_mcp_hint");
  codex.metadata.set("thr_child_mcp_hint", {
    cwd: "C:\\repo",
    repoName: "repo",
    parentThreadId: "thr_parent_mcp_hint",
    actorName: "Ramanujan"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    tailer.setDesktopEvents([
      {
        type: "nativeQuestionRequested",
        threadId: "thr_child_mcp_hint",
        requestId: "req_child_mcp_hint_1",
        questionCount: 1,
        timestampMs: Date.now()
      }
    ]);

    await bridge.handleServerRequest({
      method: "mcpServer/elicitation/request",
      id: "req_child_mcp_hint_1",
      params: {
        message: "Allow the playwright MCP server to run tool \"browser_navigate\"?",
        mode: "url",
        url: "https://example.com"
      }
    });

    const childBridge = store.getThreadBridge("thr_child_mcp_hint");
    assert.ok(childBridge);
    assert.equal(childBridge?.channelKind, "subagent");
    assert.equal(childBridge?.parentCodexThreadId, "thr_parent_mcp_hint");
    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.channelId, "discord_subagent_1");
    assert.equal(discord.conversationChannelIds.has("discord_channel_thr_child_mcp_hint"), false);
  } finally {
    await bridge.stop();
  }
});

test("app-server subagent spawn hints do not create child threads until a session spawn anchors the child", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_app_spawn_child_init",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_app_spawn_child_init",
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

  codex.metadata.set("thr_child_app_spawn_child_init", {
    cwd: "C:\\repo",
    repoName: "repo",
    parentThreadId: "thr_parent_app_spawn_child_init",
    actorName: "Lagrange"
  });
  codex.threadDetails.set("thr_child_app_spawn_child_init", {
    id: "thr_child_app_spawn_child_init",
    name: "Lagrange",
    preview: "Lagrange",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  const approvalCommand = "Start-Process https://example.com/?probe=child-app-shell";
  tailer.setEvents("thr_child_app_spawn_child_init", [
    {
      type: "sessionAgentMessage",
      threadId: "thr_child_app_spawn_child_init",
      turnId: "turn_child_app_spawn_child_init",
      timestampMs: Date.now(),
      streamOrder: 1,
      text: "Loading the child-thread browser probe now.",
      phase: "commentary",
      eventKey: "evt_child_app_spawn_commentary",
      sourceOrder: "00000001:0000"
    },
    {
      type: "shellApprovalRequested",
      threadId: "thr_child_app_spawn_child_init",
      callId: "call_child_app_spawn_shell",
      timestampMs: Date.now() + 1,
      command: approvalCommand,
      cwd: "C:\\repo",
      justification: "Open the child-thread probe URL.",
      prefixRule: null,
      details: JSON.stringify({ command: approvalCommand })
    }
  ]);

  try {
    await bridge.start({ skipDiscovery: true });

    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_parent_app_spawn_child_init",
        turnId: "turn_parent_app_spawn_child_init",
        item: {
          id: "item_spawn_child_app_init",
          type: "commandExecution",
          collabToolCall: {
            senderThreadId: "thr_parent_app_spawn_child_init",
            newThreadId: "thr_child_app_spawn_child_init",
            prompt: "Probe the child thread",
            agentNickname: "Lagrange"
          }
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue(new Set(["thr_parent_app_spawn_child_init"]));

    assert.equal(
      tailer.pollThreadCalls.some(
        (call) =>
          call.threadId === "thr_parent_app_spawn_child_init" && call.allowFilesystemScan === false
      ),
      true
    );
    assert.equal(
      tailer.pollThreadCalls.some(
        (call) =>
          call.threadId === "thr_child_app_spawn_child_init" && call.allowFilesystemScan === false
      ),
      false
    );
    assert.equal(store.getThreadBridge("thr_child_app_spawn_child_init"), undefined);
    assert.equal(store.getChildThreadAnchor("thr_child_app_spawn_child_init"), null);
    assert.equal(discord.liveTextMessages.some((message) => message.content.includes("child-thread browser probe")), false);
    assert.equal(discord.approvalCards.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("session-driven child anchors eagerly hydrate without blocking later parent commentary", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_spawn_queue",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_spawn_queue",
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

  codex.metadata.set("thr_child_spawn_queue", {
    cwd: "C:\\repo",
    repoName: "repo",
    parentThreadId: "thr_parent_spawn_queue",
    actorName: "Sagan"
  });
  codex.threadDetails.set("thr_child_spawn_queue", {
    id: "thr_child_spawn_queue",
    name: "Sagan",
    preview: "Sagan",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  let releaseChildHydrate: () => void = () => {};
  const childHydrateBlocker = new Promise<void>((resolve) => {
    releaseChildHydrate = resolve;
  });
  const originalEnsureSubagentThread = discord.ensureSubagentThread.bind(discord);
  discord.ensureSubagentThread = async (
    codexThreadId?: string,
    title?: string,
    parentChannelId?: string,
    existingDiscordChannelId?: string | null
  ) => {
    if (codexThreadId === "thr_child_spawn_queue") {
      await childHydrateBlocker;
    }
    return originalEnsureSubagentThread(codexThreadId, title, parentChannelId, existingDiscordChannelId);
  };

  try {
    await bridge.start({ skipDiscovery: true });
    const now = Date.now();
    tailer.setEvents("thr_parent_spawn_queue", [
      {
        type: "sessionUserMessage",
        threadId: "thr_parent_spawn_queue",
        turnId: "turn_parent_spawn_queue",
        timestampMs: now,
        streamOrder: 1,
        text: "Run the child worker now.",
        eventKey: "line:1:0",
        sourceOrder: "0000000000000001:0000",
        isSyntheticSubagentInstruction: false
      },
      {
        type: "sessionSubagentSpawned",
        threadId: "thr_parent_spawn_queue",
        turnId: "turn_parent_spawn_queue",
        childThreadId: "thr_child_spawn_queue",
        childAgentName: "Sagan",
        prompt: "Inspect the worker queue",
        timestampMs: now + 1,
        eventKey: "line:2:0",
        sourceOrder: "0000000000000002:0000"
      },
      {
        type: "sessionAgentMessage",
        threadId: "thr_parent_spawn_queue",
        turnId: "turn_parent_spawn_queue",
        timestampMs: now + 2,
        streamOrder: 3,
        text: "Parent commentary should still mirror while the child hydrate is blocked.",
        phase: "commentary",
        eventKey: "line:3:0",
        sourceOrder: "0000000000000003:0000"
      }
    ]);
    await bridge.pollLocalSessionEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue(new Set(["thr_parent_spawn_queue"]));

    const parentMirrored = store
      .listMirroredItems("thr_parent_spawn_queue")
      .some((record) => record.renderedContent.includes("Parent commentary should still mirror"));
    assert.equal(parentMirrored, true);
    assert.equal(store.getThreadBridge("thr_child_spawn_queue"), undefined);
    assert.equal(discord.subagentEnsureRequests.length, 0);
    assert.equal(
      tailer.pollThreadCalls.some(
        (call) => call.threadId === "thr_child_spawn_queue" && call.allowFilesystemScan === false
      ),
      false
    );
    const childAnchor = store.getChildThreadAnchor("thr_child_spawn_queue");
    assert.equal(childAnchor?.parentThreadId, "thr_parent_spawn_queue");
    assert.equal(childAnchor?.parentTurnId, "turn_parent_spawn_queue");
    assert.equal(childAnchor?.parentTurnCursor, "turn:turn_parent_spawn_queue");
    assert.equal(childAnchor?.source, "session");

    releaseChildHydrate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue(new Set(["thr_child_spawn_queue"]));

    const childBridge = store.getThreadBridge("thr_child_spawn_queue");
    assert.equal(childBridge?.parentCodexThreadId, "thr_parent_spawn_queue");
    assert.equal(childBridge?.channelKind, "subagent");
    assert.equal(childBridge?.actorName, "Sagan");
    assert.equal(discord.subagentEnsureRequests.length, 1);
    assert.equal(discord.threadChannelIds.has("discord_subagent_1"), true);
    assert.equal(
      tailer.pollThreadCalls.some(
        (call) => call.threadId === "thr_child_spawn_queue" && call.allowFilesystemScan === false
      ),
      true
    );
  } finally {
    releaseChildHydrate();
    await bridge.stop();
  }
});

test("app-server approval hint recovery does not wait on unrelated thread queues", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_mcp_hint_scoped",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_mcp_hint_scoped",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(Date.now() - 30_000).toISOString(),
    attachMode: "auto",
    threadName: "Parent thread",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  tailer.setParentThread("thr_child_mcp_hint_scoped", "thr_parent_mcp_hint_scoped");
  codex.metadata.set("thr_child_mcp_hint_scoped", {
    cwd: "C:\\repo",
    repoName: "repo",
    parentThreadId: "thr_parent_mcp_hint_scoped",
    actorName: "Ramanujan"
  });

  let releaseStuckThreadQueue = () => {};
  const stuckThreadQueue = new Promise<void>((resolve) => {
    releaseStuckThreadQueue = () => resolve();
  });
  const stuckThreadEvent = (bridge as any).enqueueThreadEvent("thr_unrelated_stuck", async () => {
    await stuckThreadQueue;
  });

  try {
    await bridge.start({ skipDiscovery: true });
    tailer.setDesktopEvents([
      {
        type: "nativeQuestionRequested",
        threadId: "thr_child_mcp_hint_scoped",
        requestId: "req_child_mcp_hint_scoped_1",
        questionCount: 1,
        timestampMs: Date.now()
      }
    ]);

    const completion = await Promise.race([
      bridge.handleServerRequest({
        method: "mcpServer/elicitation/request",
        id: "req_child_mcp_hint_scoped_1",
        params: {
          message: "Allow the playwright MCP server to run tool \"browser_navigate\"?",
          mode: "url",
          url: "https://example.com"
        }
      }).then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100))
    ]);

    assert.equal(completion, "completed");
    const childBridge = store.getThreadBridge("thr_child_mcp_hint_scoped");
    assert.ok(childBridge);
    assert.equal(childBridge?.channelKind, "subagent");
    assert.equal(childBridge?.parentCodexThreadId, "thr_parent_mcp_hint_scoped");
    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.channelId, "discord_subagent_1");
  } finally {
    releaseStuckThreadQueue();
    await stuckThreadEvent;
    await bridge.stop();
  }
});

test("MCP feedback still sends a decline decision when reject is hidden as a primary button", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_mcp_feedback_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_mcp_feedback_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(Date.now() - 30_000).toISOString(),
    attachMode: "auto",
    threadName: "Thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest({
      method: "mcpServer/elicitation/request",
      id: 322,
      params: {
        threadId: "thr_mcp_feedback_1",
        message: "Allow this MCP action?",
        mode: "url",
        url: "https://example.com"
      }
    });

    const approval = store.findPendingApprovalByRequestId("322");
    assert.ok(approval);
    assert.deepEqual(approval.availableDecisions, ["accept", "acceptWithExecpolicyAmendment", "cancel"]);

    const result = await bridge.handleApprovalFeedback("user_1", approval.token, "Do not run this right now.");
    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [
      {
        requestId: "322",
        result: {
          action: "decline",
          _meta: null
        }
      }
    ]);
    assert.match(discord.disabledApprovalCards[0]?.resolutionText ?? "", /Rejected in Discord/i);
  } finally {
    await bridge.stop();
  }
});

test("resolved approvals are not reposted when the same request is replayed", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_resolved_mcp_replay",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_resolved_mcp_replay",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Resolved replay thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const request = {
    method: "mcpServer/elicitation/request" as const,
    id: 124,
    params: {
      threadId: "thr_resolved_mcp_replay",
      turnId: "turn_resolved_replay",
      itemId: "mcp-elicitation:124",
      message: "Allow a resolved MCP request to replay?"
    }
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest(request);
    const approval = store.findPendingApprovalByRequestId("124");
    assert.ok(approval);
    store.setPendingApprovalStatus(approval.token, "approved");

    await bridge.handleServerRequest(request);

    assert.equal(discord.approvalCards.length, 1);
    assert.equal(store.findPendingApprovalByRequestId("124")?.status, "approved");
  } finally {
    await bridge.stop();
  }
});

test("replayed approval requests preserve their original token so existing Discord buttons still resolve", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_replayed_approval",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_replayed_approval",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Replayed approval thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const request = {
    method: "item/commandExecution/requestApproval" as const,
    id: 126,
    params: {
      itemId: "item_replayed_approval",
      threadId: "thr_replayed_approval",
      turnId: "turn_replayed_approval",
      command: "Start-Process https://example.com",
      cwd: "C:\\repo",
      availableDecisions: ["accept", "decline"]
    }
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest(request);
    const firstApproval = store.findPendingApprovalByRequestId("126");
    assert.ok(firstApproval);
    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.token, firstApproval.token);
    assert.equal(discord.approvalCards[0]?.existingMessageId, null);

    await bridge.handleServerRequest(request);
    const replayedApproval = store.findPendingApprovalByRequestId("126");
    assert.ok(replayedApproval);
    assert.equal(replayedApproval.token, firstApproval.token);
    assert.equal(discord.approvalCards.length, 2);
    assert.equal(discord.approvalCards[1]?.token, firstApproval.token);
    assert.equal(discord.approvalCards[1]?.existingMessageId, "approval_msg_1");

    const details = await bridge.handleApprovalDetails("user_1", firstApproval.token);
    assert.equal(details.ephemeral, true);
    assert.match(details.content, /Start-Process https:\/\/example.com/);

    const result = await bridge.handleApprovalAction("user_1", firstApproval.token, "accept");
    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [{ requestId: "126", result: { decision: "accept" } }]);
  } finally {
    await bridge.stop();
  }
});

test("startup restart-disabled approvals replay with the same request id instead of being ignored", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_restart_replayed_approval",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_restart_replayed_approval",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Restart replay thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const request = {
    method: "item/commandExecution/requestApproval" as const,
    id: "restart_replay_1",
    params: {
      itemId: "item_restart_replay_1",
      threadId: "thr_restart_replayed_approval",
      turnId: "turn_restart_replay_1",
      command: "Start-Process https://example.com",
      cwd: "C:\\repo",
      availableDecisions: ["accept", "decline"]
    }
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest(request);
    const firstApproval = store.findPendingApprovalByRequestId("restart_replay_1");
    assert.ok(firstApproval);
    assert.equal(discord.approvalCards.length, 1);

    await (bridge as any).rehydrateState();
    const restartDisabledApproval = store.findPendingApprovalByRequestId("restart_replay_1");
    assert.ok(restartDisabledApproval);
    assert.equal(restartDisabledApproval.status, "pending");
    assert.ok(restartDisabledApproval.restartDisabledAt);
    assert.equal(discord.staleApprovalCards.length, 1);
    assert.equal(discord.staleApprovalCards[0]?.token, firstApproval.token);

    await bridge.handleServerRequest(request);
    const replayedApproval = store.findPendingApprovalByRequestId("restart_replay_1");
    assert.ok(replayedApproval);
    assert.equal(replayedApproval.token, firstApproval.token);
    assert.equal(replayedApproval.restartDisabledAt, null);
    assert.equal(discord.approvalCards.length, 2);
    assert.equal(discord.approvalCards[1]?.existingMessageId, "approval_msg_1");
    assert.equal(discord.approvalCards[1]?.token, firstApproval.token);
  } finally {
    await bridge.stop();
  }
});

test("same-request approval replays fully refresh stored metadata while preserving token and message binding", async () => {
  const { store, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_refresh_replayed_approval",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_refresh_replayed_approval",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Refresh replay thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const firstRequest = {
    method: "item/commandExecution/requestApproval" as const,
    id: "refresh_replay_1",
    params: {
      itemId: "item_refresh_replay_old",
      threadId: "thr_refresh_replayed_approval",
      turnId: "turn_refresh_replay_old",
      command: "Start-Process https://example.com",
      cwd: "C:\\repo",
      availableDecisions: ["accept", "decline"]
    }
  };
  const replayedRequest = {
    ...firstRequest,
    params: {
      ...firstRequest.params,
      itemId: "item_refresh_replay_new",
      turnId: "turn_refresh_replay_new",
      command: "Start-Process https://example.com --again",
      cwd: "C:\\repo\\nested"
    }
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest(firstRequest);
    const firstApproval = store.findPendingApprovalByRequestId("refresh_replay_1");
    assert.ok(firstApproval);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await bridge.handleServerRequest(replayedRequest);

    const refreshedApproval = store.findPendingApprovalByRequestId("refresh_replay_1");
    assert.ok(refreshedApproval);
    assert.equal(refreshedApproval.token, firstApproval.token);
    assert.equal(refreshedApproval.discordMessageId, "approval_msg_1");
    assert.equal(refreshedApproval.turnId, "turn_refresh_replay_new");
    assert.equal(refreshedApproval.itemId, "item_refresh_replay_new");
    assert.equal(refreshedApproval.cwd, "C:\\repo\\nested");
    assert.match(refreshedApproval.sanitizedPreview, /--again/);
    assert.notEqual(refreshedApproval.createdAt, firstApproval.createdAt);
  } finally {
    await bridge.stop();
  }
});

test("new command approvals with a reused itemId create a fresh card when the old request is already resolved", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_reused_command_item",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_reused_command_item",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Reused command approval thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const firstRequest = {
    method: "item/commandExecution/requestApproval" as const,
    id: "reuse_command_1",
    params: {
      threadId: "thr_reused_command_item",
      turnId: "turn_reused_command_item",
      itemId: "call_reused_command_item",
      reason: "Allow this command?",
      command: "Start-Process https://example.com",
      cwd: "C:\\repo",
      availableDecisions: ["accept", "decline"]
    }
  };
  const secondRequest = {
    ...firstRequest,
    id: "reuse_command_2"
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest(firstRequest);
    const firstApproval = store.findPendingApprovalByRequestId("reuse_command_1");
    assert.ok(firstApproval);
    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.token, firstApproval.token);
    assert.equal(discord.approvalCards[0]?.existingMessageId, null);

    const result = await bridge.handleApprovalAction("user_1", firstApproval.token, "accept");
    assert.equal(result.content, "");
    codex.emit("notification", {
      method: "serverRequest/resolved",
      params: {
        requestId: "reuse_command_1"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.findPendingApprovalByRequestId("reuse_command_1")?.status, "approved");

    await bridge.handleServerRequest(secondRequest);
    const secondApproval = store.findPendingApprovalByRequestId("reuse_command_2");
    assert.ok(secondApproval);
    assert.notEqual(secondApproval.token, firstApproval.token);
    assert.equal(discord.approvalCards.length, 2);
    assert.equal(discord.approvalCards[1]?.token, secondApproval.token);
    assert.equal(discord.approvalCards[1]?.existingMessageId, null);
  } finally {
    await bridge.stop();
  }
});

test("replayed tool approval requests preserve their original token and message binding", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_replayed_tool_approval",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_replayed_tool_approval",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Replayed tool approval thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const request = {
    method: "item/tool/requestUserInput" as const,
    id: "tool_replay_1",
    params: {
      threadId: "thr_replayed_tool_approval",
      turnId: "turn_replayed_tool_approval",
      itemId: "item_replayed_tool_approval",
      questions: [
        {
          id: "tool_replay_question_1",
          question: "Allow browser navigation?",
          options: [{ label: "Allow once" }, { label: "Decline" }]
        }
      ]
    }
  };
  const replayedRequest = {
    ...request,
    params: {
      ...request.params,
      turnId: "turn_replayed_tool_approval_2",
      itemId: "item_replayed_tool_approval_2",
      questions: [
        {
          id: "tool_replay_question_1",
          question: "Allow browser navigation again?",
          options: [{ label: "Allow once" }, { label: "Decline" }]
        }
      ]
    }
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest(request);
    const firstApproval = store.findPendingApprovalByItem(
      "thr_replayed_tool_approval",
      "item_replayed_tool_approval",
      "toolUserInput"
    );
    assert.ok(firstApproval);
    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.token, firstApproval.token);
    assert.equal(discord.approvalCards[0]?.existingMessageId, null);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await bridge.handleServerRequest(replayedRequest);
    const replayedApproval = store.findPendingApprovalByRequestId("tool_replay_1");
    assert.ok(replayedApproval);
    assert.equal(replayedApproval.token, firstApproval.token);
    assert.equal(replayedApproval.itemId, "item_replayed_tool_approval_2");
    assert.equal(replayedApproval.turnId, "turn_replayed_tool_approval_2");
    assert.notEqual(replayedApproval.createdAt, firstApproval.createdAt);
    assert.equal(discord.approvalCards.length, 2);
    assert.equal(discord.approvalCards[1]?.token, firstApproval.token);
    assert.equal(discord.approvalCards[1]?.existingMessageId, "approval_msg_1");

    const details = await bridge.handleApprovalDetails("user_1", firstApproval.token);
    assert.equal(details.ephemeral, true);
    assert.match(details.content, /Allow browser navigation again/);

    const result = await bridge.handleApprovalAction("user_1", firstApproval.token, "Allow once");
    assert.equal(result.content, "");
    assert.deepEqual(codex.responses, [
      {
        requestId: "tool_replay_1",
        result: {
          answers: {
            tool_replay_question_1: {
              answers: ["Allow once"]
            }
          }
        }
      }
    ]);
  } finally {
    await bridge.stop();
  }
});

test("startup restart-disabled decision-sent approvals clear the restart marker on same-request replay and still allow late resolution", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_restart_decision_sent",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_restart_decision_sent",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Restart decision-sent thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const request = {
    method: "item/commandExecution/requestApproval" as const,
    id: "restart_decision_sent_1",
    params: {
      itemId: "item_restart_decision_sent_1",
      threadId: "thr_restart_decision_sent",
      turnId: "turn_restart_decision_sent_1",
      command: "npm test",
      cwd: "C:\\repo",
      availableDecisions: ["accept", "decline"]
    }
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest(request);
    const approval = store.findPendingApprovalByRequestId("restart_decision_sent_1");
    assert.ok(approval);

    const result = await bridge.handleApprovalAction("user_1", approval.token, "accept");
    assert.equal(result.content, "");
    assert.equal(store.findPendingApprovalByRequestId("restart_decision_sent_1")?.status, "decisionSent");

    await (bridge as any).rehydrateState();
    const restartDisabledApproval = store.findPendingApprovalByRequestId("restart_decision_sent_1");
    assert.ok(restartDisabledApproval?.restartDisabledAt);
    assert.equal(restartDisabledApproval?.status, "decisionSent");

    await bridge.handleServerRequest(request);
    const replayedApproval = store.findPendingApprovalByRequestId("restart_decision_sent_1");
    assert.ok(replayedApproval);
    assert.equal(replayedApproval.status, "decisionSent");
    assert.equal(replayedApproval.restartDisabledAt, null);
    assert.equal(discord.approvalCards.at(-1)?.existingMessageId, "approval_msg_1");

    codex.emit("notification", {
      method: "serverRequest/resolved",
      params: {
        requestId: "restart_decision_sent_1"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(store.findPendingApprovalByRequestId("restart_decision_sent_1")?.status, "approved");
  } finally {
    await bridge.stop();
  }
});

test("new tool approvals with a reused itemId create a fresh card when the old request is already resolved", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_reused_tool_item",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_reused_tool_item",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Reused tool approval thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const firstRequest = {
    method: "item/tool/requestUserInput" as const,
    id: "tool_reuse_1",
    params: {
      threadId: "thr_reused_tool_item",
      turnId: "turn_reused_tool_item",
      itemId: "item_reused_tool_item",
      questions: [
        {
          id: "tool_reuse_question",
          question: "Allow browser navigation?",
          options: [{ label: "Allow once" }, { label: "Decline" }]
        }
      ]
    }
  };
  const secondRequest = {
    ...firstRequest,
    id: "tool_reuse_2"
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest(firstRequest);
    const firstApproval = store.findPendingApprovalByRequestId("tool_reuse_1");
    assert.ok(firstApproval);
    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.token, firstApproval.token);
    assert.equal(discord.approvalCards[0]?.existingMessageId, null);

    const result = await bridge.handleApprovalAction("user_1", firstApproval.token, "Allow once");
    assert.equal(result.content, "");
    codex.emit("notification", {
      method: "serverRequest/resolved",
      params: {
        requestId: "tool_reuse_1"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.findPendingApprovalByRequestId("tool_reuse_1")?.status, "approved");

    await bridge.handleServerRequest(secondRequest);
    const secondApproval = store.findPendingApprovalByRequestId("tool_reuse_2");
    assert.ok(secondApproval);
    assert.notEqual(secondApproval.token, firstApproval.token);
    assert.equal(discord.approvalCards.length, 2);
    assert.equal(discord.approvalCards[1]?.token, secondApproval.token);
    assert.equal(discord.approvalCards[1]?.existingMessageId, null);
  } finally {
    await bridge.stop();
  }
});

test("desktop request removal marks mirrored approvals non-actionable and blocks reposting the same request", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, discord, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_removed_desktop_request",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_removed_desktop_request",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Desktop removal thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const request = {
    method: "mcpServer/elicitation/request" as const,
    id: 125,
    params: {
      threadId: "thr_removed_desktop_request",
      turnId: "turn_removed_desktop_request",
      itemId: "mcp-elicitation:125",
      message: "Allow a removed desktop request to replay?"
    }
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest(request);
    desktopIpc.emit("requestRemoved", {
      threadId: "thr_removed_desktop_request",
      requestId: "125",
      request
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue();

    assert.equal(store.findPendingApprovalByRequestId("125")?.status, "stale");
    assert.equal(discord.disabledApprovalCards.length, 1);
    assert.match(discord.disabledApprovalCards[0]?.resolutionText ?? "", /No longer pending in Codex Desktop/);

    await bridge.handleServerRequest(request);
    assert.equal(discord.approvalCards.length, 1);
  } finally {
    await bridge.stop();
  }
});

test("desktop request removal converts restart-disabled pending approvals to real stale", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, discord, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_restart_removed_desktop_request",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_restart_removed_desktop_request",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Restart removal thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const request = {
    method: "mcpServer/elicitation/request" as const,
    id: "restart_removed_desktop_request",
    params: {
      threadId: "thr_restart_removed_desktop_request",
      turnId: "turn_restart_removed_desktop_request",
      itemId: "mcp-elicitation:restart_removed_desktop_request",
      message: "Allow a removed desktop request after restart?"
    }
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest(request);
    await (bridge as any).rehydrateState();
    const restartDisabledApproval = store.findPendingApprovalByRequestId("restart_removed_desktop_request");
    assert.ok(restartDisabledApproval?.restartDisabledAt);
    assert.equal(restartDisabledApproval?.status, "pending");

    desktopIpc.emit("requestRemoved", {
      threadId: "thr_restart_removed_desktop_request",
      requestId: "restart_removed_desktop_request",
      request
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue();

    const removedApproval = store.findPendingApprovalByRequestId("restart_removed_desktop_request");
    assert.equal(removedApproval?.status, "stale");
    assert.equal(removedApproval?.restartDisabledAt ?? null, null);
    assert.match(discord.disabledApprovalCards.at(-1)?.resolutionText ?? "", /No longer pending in Codex Desktop/);
  } finally {
    await bridge.stop();
  }
});

test("desktop request removal does not downgrade decision-sent approvals and late resolution still wins", async () => {
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_decision_sent_desktop_request",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_decision_sent_desktop_request",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Decision-sent thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const request = {
    method: "item/commandExecution/requestApproval" as const,
    id: 1260,
    params: {
      itemId: "item_decision_sent_desktop_request",
      threadId: "thr_decision_sent_desktop_request",
      turnId: "turn_decision_sent_desktop_request",
      command: "npm test",
      cwd: "C:\\repo",
      availableDecisions: ["accept", "decline"]
    }
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest(request);
    const approval = store.findPendingApprovalByRequestId("1260");
    assert.ok(approval);

    const result = await bridge.handleApprovalAction("user_1", approval.token, "accept");
    assert.equal(result.content, "");
    assert.equal(store.findPendingApprovalByRequestId("1260")?.status, "decisionSent");

    desktopIpc.emit("requestRemoved", {
      threadId: "thr_decision_sent_desktop_request",
      requestId: "1260",
      request
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue();

    assert.equal(store.findPendingApprovalByRequestId("1260")?.status, "decisionSent");
    assert.equal(discord.disabledApprovalCards.length, 1);
    assert.match(discord.disabledApprovalCards[0]?.resolutionText ?? "", /Approved once in Discord/i);

    codex.emit("notification", {
      method: "serverRequest/resolved",
      params: {
        requestId: "1260"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(store.findPendingApprovalByRequestId("1260")?.status, "approved");
    assert.equal(discord.disabledApprovalCards.length, 1);
  } finally {
    await bridge.stop();
  }
});

test("session log shell approvals are mirrored to Discord approval cards", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  codex.threads = [
    {
      id: "thr_session_1",
      name: "Session thread",
      preview: "Session thread",
      modelProvider: null,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_session_1", { cwd: "C:\\repo", repoName: "repo" });
  try {
    await bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_session_1",
      turnId: "turn_session_anchor_1",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Please run the timestamp command.",
      eventKey: "evt_session_anchor_1",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });
    tailer.setEvents("thr_session_1", [
      {
        type: "shellApprovalRequested",
        threadId: "thr_session_1",
        callId: "call_approval_1",
        timestampMs: Date.now() + 1,
        command: "Get-Date -Format o",
        cwd: "C:\\repo",
        justification: "Allow a harmless timestamp command.",
        details: "{\"command\":\"Get-Date -Format o\"}"
      }
    ]);
    await (bridge as any).pollLocalSessionEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.preview, "Get-Date -Format o");
    assert.deepEqual(discord.approvalCards[0]?.decisions, []);
    const approval = store.findPendingApprovalByItem("thr_session_1", "call_approval_1", "commandExecution");
    assert.ok(approval);
    assert.deepEqual(approval.availableDecisions, []);
  } finally {
    await bridge.stop();
  }
});

test("live e2e helper commands do not change command summary counts", async () => {
  const previousIgnoreFlag = process.env[LIVE_E2E_IGNORE_HELPER_COMMANDS_ENV];
  process.env[LIVE_E2E_IGNORE_HELPER_COMMANDS_ENV] = "1";

  const tailer = new FakeSessionEventTailer();
  const { store, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never,
    runtimeConfig: createBridgeConfigFromPreset("recommended", testApprovalsConfig("user_1"), {
      ui: {
        commandDisplayMode: "summary"
      }
    })
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_live_e2e_ignore",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_live_e2e_ignore",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Live e2e ignore thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_live_e2e_ignore",
      turnId: "turn_live_e2e_ignore",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Run the live e2e command summary scenario.",
      eventKey: "evt_live_e2e_ignore_anchor",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });
    tailer.setEvents("thr_live_e2e_ignore", [
      {
        type: "shellCommandCompleted",
        threadId: "thr_live_e2e_ignore",
        callId: "call_live_e2e_one",
        turnId: "turn_live_e2e_ignore",
        timestampMs: Date.now() + 1,
        command: "Write-Output \"LIVE_E2E command-one\"",
        cwd: "C:\\repo",
        output: "LIVE_E2E command-one",
        status: null,
        eventKey: "shell-command:call_live_e2e_one",
        sourceOrder: "00000002"
      },
      {
        type: "shellCommandCompleted",
        threadId: "thr_live_e2e_ignore",
        callId: "call_live_e2e_two",
        turnId: "turn_live_e2e_ignore",
        timestampMs: Date.now() + 2,
        command: "Write-Output \"LIVE_E2E command-two\"",
        cwd: "C:\\repo",
        output: "LIVE_E2E command-two",
        status: null,
        eventKey: "shell-command:call_live_e2e_two",
        sourceOrder: "00000003"
      },
      {
        type: "shellCommandCompleted",
        threadId: "thr_live_e2e_ignore",
        callId: "call_live_e2e_helper",
        turnId: "turn_live_e2e_ignore",
        timestampMs: Date.now() + 3,
        command: "npm run e2e-live -- verify commands.summary --run-id discord-basic-002",
        cwd: "C:\\repo",
        output: "FAIL live e2e verification.",
        status: "exit 1",
        eventKey: "shell-command:call_live_e2e_helper",
        sourceOrder: "00000004"
      },
      {
        type: "shellCommandCompleted",
        threadId: "thr_live_e2e_ignore",
        callId: "call_live_e2e_wait",
        turnId: "turn_live_e2e_ignore",
        timestampMs: Date.now() + 4,
        command: "Start-Sleep -Seconds 10",
        cwd: "C:\\repo",
        output: "",
        status: null,
        eventKey: "shell-command:call_live_e2e_wait",
        sourceOrder: "00000005"
      }
    ]);

    await (bridge as any).pollLocalSessionEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rendered = discord.liveTextMessages.map((entry) => entry.content).join("\n");
    assert.match(rendered, /Ran 2 commands/);
    assert.doesNotMatch(rendered, /Ran 3 commands/);
    assert.doesNotMatch(rendered, /Ran 4 commands/);
    assert.doesNotMatch(rendered, /npm run e2e-live/);
    assert.doesNotMatch(rendered, /Start-Sleep/);
    const mirroredCommands = store
      .listMirroredItems("thr_live_e2e_ignore")
      .filter((item) => item.kind === "command");
    assert.equal(mirroredCommands.length, 2);
    assert.equal(store.getThreadBridge("thr_live_e2e_ignore")?.latestMirroredCursor?.includes("call_live_e2e_wait"), true);
  } finally {
    if (previousIgnoreFlag === undefined) {
      delete process.env[LIVE_E2E_IGNORE_HELPER_COMMANDS_ENV];
    } else {
      process.env[LIVE_E2E_IGNORE_HELPER_COMMANDS_ENV] = previousIgnoreFlag;
    }
    await bridge.stop();
  }
});

test("desktop-connected subagent threads still mirror session-log shell approvals before native IPC catches up", async () => {
  const tailer = new FakeSessionEventTailer();
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never,
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_shell_subagent",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_shell_subagent",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent shell subagent",
    lastStatusType: "active",
    channelKind: "conversation"
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_child_shell_subagent",
    parentCodexThreadId: "thr_parent_shell_subagent",
    parentAnchorTurnId: "turn_parent_shell_subagent",
    parentAnchorTurnCursor: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_thread_shell_subagent",
    discordParentChannelId: "discord_channel_parent_shell_subagent",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Child shell subagent",
    actorName: "Halley",
    lastStatusType: "active",
    channelKind: "subagent"
  });
  discord.threadChannelIds.add("discord_thread_shell_subagent");

  try {
    await bridge.start({ skipDiscovery: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    tailer.setEvents("thr_child_shell_subagent", [
      {
        type: "shellApprovalRequested",
        threadId: "thr_child_shell_subagent",
        callId: "call_child_shell_approval",
        timestampMs: Date.now() + 1,
        command: "Start-Process https://example.com/?probe=child-shell",
        cwd: "C:\\repo",
        justification: "Open the child-thread probe URL.",
        prefixRule: null,
        details: JSON.stringify({ command: "Start-Process https://example.com/?probe=child-shell" })
      }
    ]);

    await (bridge as any).pollLocalSessionEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue(new Set(["thr_child_shell_subagent"]));

    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.channelId, "discord_thread_shell_subagent");
    assert.equal(
      discord.approvalCards[0]?.preview,
      "Start-Process https://example.com/?probe=child-shell"
    );
    assert.deepEqual(discord.approvalCards[0]?.decisions, []);
    const approval = store.findPendingApprovalByItem(
      "thr_child_shell_subagent",
      "call_child_shell_approval",
      "commandExecution"
    );
    assert.ok(approval);
    assert.equal(approval.requestId, "session-log:call_child_shell_approval");
    assert.deepEqual(approval.availableDecisions, []);
  } finally {
    await bridge.stop();
  }
});

test("subagent session-log shell placeholders do not downgrade actionable app-server approvals", async () => {
  const tailer = new FakeSessionEventTailer();
  const desktopIpc = new FakeDesktopIpcClient();
  const { store, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never,
    desktopIpcClient: desktopIpc as never
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_subagent_approval_race",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_subagent_approval_race",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent approval race",
    lastStatusType: "active",
    channelKind: "conversation"
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_child_subagent_approval_race",
    parentCodexThreadId: "thr_parent_subagent_approval_race",
    parentAnchorTurnId: "turn_parent_subagent_approval_race",
    parentAnchorTurnCursor: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_thread_subagent_approval_race",
    discordParentChannelId: "discord_channel_parent_subagent_approval_race",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Child approval race",
    actorName: "Plato",
    lastStatusType: "active",
    channelKind: "subagent"
  });
  discord.threadChannelIds.add("discord_thread_subagent_approval_race");

  const command = "Start-Process https://example.com/?probe=child-approval-race";

  try {
    await bridge.start({ skipDiscovery: true });

    await bridge.handleServerRequest({
      method: "item/commandExecution/requestApproval",
      id: "app_child_approval_race",
      params: {
        itemId: "call_child_approval_race",
        threadId: "thr_child_subagent_approval_race",
        turnId: "turn_child_subagent_approval_race",
        command,
        cwd: "C:\\repo",
        availableDecisions: ["accept", "decline"]
      }
    });

    const firstApproval = store.findPendingApprovalByItem(
      "thr_child_subagent_approval_race",
      "call_child_approval_race",
      "commandExecution"
    );
    assert.ok(firstApproval);
    assert.equal(firstApproval.requestId, "app_child_approval_race");
    assert.deepEqual(firstApproval.availableDecisions, ["accept", "decline"]);
    assert.deepEqual(discord.approvalCards.at(-1)?.decisions, ["accept", "decline"]);

    tailer.setEvents("thr_child_subagent_approval_race", [
      {
        type: "shellApprovalRequested",
        threadId: "thr_child_subagent_approval_race",
        callId: "call_child_approval_race",
        timestampMs: Date.now() + 1,
        command,
        cwd: "C:\\repo",
        justification: "Open the child-thread probe URL.",
        prefixRule: null,
        details: JSON.stringify({ command })
      }
    ]);

    await (bridge as any).pollLocalSessionEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue(new Set(["thr_child_subagent_approval_race"]));

    const finalApproval = store.findPendingApprovalByItem(
      "thr_child_subagent_approval_race",
      "call_child_approval_race",
      "commandExecution"
    );
    assert.ok(finalApproval);
    assert.equal(finalApproval.token, firstApproval.token);
    assert.equal(finalApproval.requestId, "app_child_approval_race");
    assert.deepEqual(finalApproval.availableDecisions, ["accept", "decline"]);
    assert.equal(
      store.findPendingApprovalByRequestId("session-log:call_child_approval_race"),
      undefined
    );
    assert.equal(discord.approvalCards.at(-1)?.existingMessageId, "approval_msg_1");
    assert.equal(discord.approvalCards.at(-1)?.token, firstApproval.token);
    assert.deepEqual(discord.approvalCards.at(-1)?.decisions, ["accept", "decline"]);
  } finally {
    await bridge.stop();
  }
});

test("desktop native command approvals upgrade shell placeholders into interactive Discord cards", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  codex.threads = [
    {
      id: "thr_native_shell_1",
      name: "Native shell thread",
      preview: "Native shell thread",
      modelProvider: null,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_native_shell_1", { cwd: "C:\\repo", repoName: "repo" });
  try {
    await bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_native_shell_1",
      turnId: "turn_native_shell_anchor",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Please run the timestamp command.",
      eventKey: "evt_native_shell_anchor",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });
    tailer.setEvents("thr_native_shell_1", [
      {
        type: "shellApprovalRequested",
        threadId: "thr_native_shell_1",
        callId: "call_native_shell_1",
        timestampMs: Date.now() + 1,
        command: "Get-Date -Format o",
        cwd: "C:\\repo",
        justification: "Allow a harmless timestamp command.",
        prefixRule: null,
        details: JSON.stringify({ command: "Get-Date -Format o" })
      }
    ]);
    await (bridge as any).pollLocalSessionEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));
    tailer.setDesktopEvents([
      {
        type: "nativeCommandApprovalRequested",
        threadId: "thr_native_shell_1",
        requestId: "68",
        timestampMs: Date.now() + 1000
      }
    ]);

    await (bridge as any).pollDesktopApprovalEvents();
    await new Promise((resolve) => setTimeout(resolve, 750));
    await (bridge as any).drainThreadEventQueue();

    const approval = store.findPendingApprovalByItem("thr_native_shell_1", "call_native_shell_1", "commandExecution");
    assert.ok(approval);
    assert.equal(approval.requestId, "68");
    assert.deepEqual(approval.availableDecisions, ["accept", "acceptForSession", "decline"]);
    assert.deepEqual(discord.approvalCards.at(-1)?.decisions, ["accept", "acceptForSession", "decline"]);
  } finally {
    await bridge.stop();
  }
});

test("desktop native command approvals keep ambiguous shell placeholders read-only and create a standalone interactive card", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  codex.threads = [
    {
      id: "thr_native_shell_ambiguous",
      name: "Native shell ambiguous thread",
      preview: "Native shell ambiguous thread",
      modelProvider: null,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_native_shell_ambiguous", { cwd: "C:\\repo", repoName: "repo" });

  try {
    await bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_native_shell_ambiguous",
      turnId: "turn_native_shell_ambiguous_anchor",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Please run two timestamp commands.",
      eventKey: "evt_native_shell_ambiguous_anchor",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });
    tailer.setEvents("thr_native_shell_ambiguous", [
      {
        type: "shellApprovalRequested",
        threadId: "thr_native_shell_ambiguous",
        callId: "call_native_shell_ambiguous_1",
        timestampMs: Date.now() + 1,
        command: "Get-Date -Format o",
        cwd: "C:\\repo",
        justification: "Allow the first timestamp command.",
        prefixRule: null,
        details: JSON.stringify({ command: "Get-Date -Format o" })
      },
      {
        type: "shellApprovalRequested",
        threadId: "thr_native_shell_ambiguous",
        callId: "call_native_shell_ambiguous_2",
        timestampMs: Date.now() + 2,
        command: "Get-Date -Format o",
        cwd: "C:\\repo",
        justification: "Allow the second timestamp command.",
        prefixRule: null,
        details: JSON.stringify({ command: "Get-Date -Format o" })
      }
    ]);
    await (bridge as any).pollLocalSessionEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));

    tailer.setDesktopEvents([
      {
        type: "nativeCommandApprovalRequested",
        threadId: "thr_native_shell_ambiguous",
        requestId: "680",
        timestampMs: Date.now() + 1000
      }
    ]);
    await (bridge as any).pollDesktopApprovalEvents();
    await new Promise((resolve) => setTimeout(resolve, 750));
    await (bridge as any).drainThreadEventQueue();

    const placeholderOne = store.findPendingApprovalByItem(
      "thr_native_shell_ambiguous",
      "call_native_shell_ambiguous_1",
      "commandExecution"
    );
    const placeholderTwo = store.findPendingApprovalByItem(
      "thr_native_shell_ambiguous",
      "call_native_shell_ambiguous_2",
      "commandExecution"
    );
    const standaloneApproval = store.findPendingApprovalByRequestId("680");

    assert.ok(placeholderOne);
    assert.ok(placeholderTwo);
    assert.ok(standaloneApproval);
    assert.match(placeholderOne.requestId, /^session-log:/);
    assert.match(placeholderTwo.requestId, /^session-log:/);
    assert.deepEqual(placeholderOne.availableDecisions, []);
    assert.deepEqual(placeholderTwo.availableDecisions, []);
    assert.equal(standaloneApproval.itemId, "native-command:680");
    assert.deepEqual(standaloneApproval.availableDecisions, ["accept", "acceptForSession", "decline"]);
    assert.deepEqual(discord.approvalCards.at(-1)?.decisions, ["accept", "acceptForSession", "decline"]);
    assert.equal(discord.approvalCards.length, 3);
  } finally {
    await bridge.stop();
  }
});

test("desktop native command approvals do not upgrade stale shell placeholders and create a standalone interactive card", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  codex.threads = [
    {
      id: "thr_native_shell_stale",
      name: "Native shell stale thread",
      preview: "Native shell stale thread",
      modelProvider: null,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_native_shell_stale", { cwd: "C:\\repo", repoName: "repo" });

  try {
    await bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_native_shell_stale",
      turnId: "turn_native_shell_stale_anchor",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Please run the timestamp command later.",
      eventKey: "evt_native_shell_stale_anchor",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });
    tailer.setEvents("thr_native_shell_stale", [
      {
        type: "shellApprovalRequested",
        threadId: "thr_native_shell_stale",
        callId: "call_native_shell_stale_1",
        timestampMs: Date.now() + 1,
        command: "Get-Date -Format o",
        cwd: "C:\\repo",
        justification: "Allow a harmless timestamp command.",
        prefixRule: null,
        details: JSON.stringify({ command: "Get-Date -Format o" })
      }
    ]);
    await (bridge as any).pollLocalSessionEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const placeholder = store.findPendingApprovalByItem(
      "thr_native_shell_stale",
      "call_native_shell_stale_1",
      "commandExecution"
    );
    assert.ok(placeholder);
    store.refreshPendingApprovalRecord(placeholder.token, {
      ...placeholder,
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    });

    tailer.setDesktopEvents([
      {
        type: "nativeCommandApprovalRequested",
        threadId: "thr_native_shell_stale",
        requestId: "681",
        timestampMs: Date.now()
      }
    ]);
    await (bridge as any).pollDesktopApprovalEvents();
    await new Promise((resolve) => setTimeout(resolve, 750));
    await (bridge as any).drainThreadEventQueue();

    const stalePlaceholder = store.findPendingApprovalByItem(
      "thr_native_shell_stale",
      "call_native_shell_stale_1",
      "commandExecution"
    );
    const standaloneApproval = store.findPendingApprovalByRequestId("681");

    assert.ok(stalePlaceholder);
    assert.ok(standaloneApproval);
    assert.match(stalePlaceholder.requestId, /^session-log:/);
    assert.deepEqual(stalePlaceholder.availableDecisions, []);
    assert.equal(standaloneApproval.itemId, "native-command:681");
    assert.deepEqual(standaloneApproval.availableDecisions, ["accept", "acceptForSession", "decline"]);
    assert.deepEqual(discord.approvalCards.at(-1)?.decisions, ["accept", "acceptForSession", "decline"]);
    assert.equal(discord.approvalCards.length, 2);
  } finally {
    await bridge.stop();
  }
});

test("session log shell command completions mirror the command and resolve the mirrored approval card", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  codex.threads = [
    {
      id: "thr_session_2",
      name: "Session thread",
      preview: "Session thread",
      modelProvider: null,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_session_2", { cwd: "C:\\repo", repoName: "repo" });
  try {
    await bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_session_2",
      turnId: "turn_session_anchor_2",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Please run the timestamp command.",
      eventKey: "evt_session_anchor_2",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });
    tailer.setEvents("thr_session_2", [
      {
        type: "shellApprovalRequested",
        threadId: "thr_session_2",
        callId: "call_approval_2",
        timestampMs: Date.now() + 1,
        command: "Get-Date -Format o",
        cwd: "C:\\repo",
        justification: "Allow a harmless timestamp command.",
        details: "{\"command\":\"Get-Date -Format o\"}"
      }
    ]);
    await (bridge as any).pollLocalSessionEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));

    tailer.setEvents("thr_session_2", [
      {
        type: "shellCommandCompleted",
        threadId: "thr_session_2",
        callId: "call_approval_2",
        timestampMs: Date.now() + 1000,
        command: "Get-Date -Format o",
        cwd: "C:\\repo",
        output: "Exit code: 0\nWall time: 0.2 seconds\nOutput:\n2026-04-05T09:00:00.0000000+02:00",
        status: null
      }
    ]);

    await (bridge as any).pollLocalSessionEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(
      discord.liveTextMessages.some(
        (entry) =>
          entry.channelId === "discord_channel_thr_session_2" &&
          entry.content.includes("🛠️ **Codex**") &&
          entry.content.includes("Ran 1 command")
      )
    );
    assert.equal(discord.disabledApprovalCards.length, 1);
    assert.equal(store.findPendingApprovalByItem("thr_session_2", "call_approval_2", "commandExecution")?.status, "approved");
  } finally {
    await bridge.stop();
  }
});

test("native approvals are not overwritten as approved by later local shell completions", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  codex.threads = [
    {
      id: "thr_native_reject_1",
      name: "Native reject thread",
      preview: "Native reject thread",
      modelProvider: null,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_native_reject_1", { cwd: "C:\\repo", repoName: "repo" });
  tailer.setEvents("thr_native_reject_1", [
    {
      type: "shellApprovalRequested",
      threadId: "thr_native_reject_1",
      callId: "call_native_reject_1",
      timestampMs: Date.now(),
      command: "Get-ComputerInfo -Property OsName",
      cwd: "C:\\repo",
      justification: "Allow a harmless elevated PowerShell command.",
      prefixRule: null,
      details: JSON.stringify({ command: "Get-ComputerInfo -Property OsName" })
    }
  ]);

  try {
    await bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    tailer.setDesktopEvents([
      {
        type: "nativeCommandApprovalRequested",
        threadId: "thr_native_reject_1",
        requestId: "81",
        timestampMs: Date.now() + 1000
      }
    ]);

    await (bridge as any).pollDesktopApprovalEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const approval = store.findPendingApprovalByItem("thr_native_reject_1", "call_native_reject_1", "commandExecution");
    assert.ok(approval);
    assert.equal(approval.requestId, "81");

    store.setPendingApprovalStatus(approval.token, "rejected");
    tailer.setEvents("thr_native_reject_1", [
      {
        type: "shellCommandCompleted",
        threadId: "thr_native_reject_1",
        callId: "call_native_reject_1",
        timestampMs: Date.now() + 2000,
        command: "Get-ComputerInfo -Property OsName",
        cwd: "C:\\repo",
        output: "Exit code: 0\nWall time: 0.2 seconds\nOutput:\nMicrosoft Windows 11 Pro",
        status: null
      }
    ]);

    await (bridge as any).pollLocalSessionEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bridge as any).drainThreadEventQueue();

    assert.equal(
      store.findPendingApprovalByItem("thr_native_reject_1", "call_native_reject_1", "commandExecution")?.status,
      "rejected"
    );
  } finally {
    await bridge.stop();
  }
});
