import {
  test,
  assert,
  createBridgeConfigFromPreset,
  createBridgeTestRig
} from "./helpers/bridgeIntegration.js";

test("retention maxTurnsPerThread prunes mirrored messages from older turns", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        retention: {
          maxTurnsPerThread: 2
        }
      }
    )
  });

  store.upsertThreadBridge({
    codexThreadId: "retention_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_retention_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Retention thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  const emitCompleted = async (turnId: string, item: Record<string, unknown>) => {
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "retention_thread",
        turnId,
        item
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await emitCompleted("turn-001", {
      id: "item-1001",
      type: "userMessage",
      content: [{ text: "turn 1 user" }]
    });
    await emitCompleted("turn-001", {
      id: "item-1002",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: "turn 1 assistant" }]
    });
    store.upsertPendingApproval({
      token: "approval_retention_answered",
      requestId: "approval_retention_answered_request",
      threadId: "retention_thread",
      turnId: "turn-001",
      feedbackTurnId: null,
      itemId: "approval_retention_answered_item",
      kind: "toolUserInput",
      sanitizedPreview: "Old answered question",
      cwd: null,
      reason: null,
      availableDecisions: [],
      decisionPayloads: {},
      expiresAt: "2026-04-25T12:00:00.000Z",
      discordMessageId: "approval_msg_retention_answered",
      status: "decisionSent",
      details: "{}",
      createdAt: "2026-04-25T10:00:00.000Z",
      restartDisabledAt: null,
      toolInput: null
    });
    store.upsertPendingApproval({
      token: "approval_retention_pending",
      requestId: "approval_retention_pending_request",
      threadId: "retention_thread",
      turnId: "turn-001",
      feedbackTurnId: null,
      itemId: "approval_retention_pending_item",
      kind: "commandExecution",
      sanitizedPreview: "Old pending approval",
      cwd: null,
      reason: null,
      availableDecisions: ["accept", "decline"],
      decisionPayloads: {},
      expiresAt: "2026-04-25T12:00:00.000Z",
      discordMessageId: "approval_msg_retention_pending",
      status: "pending",
      details: "{}",
      createdAt: "2026-04-25T10:00:01.000Z",
      restartDisabledAt: null,
      toolInput: null
    });

    await emitCompleted("turn-002", {
      id: "item-2001",
      type: "userMessage",
      content: [{ text: "turn 2 user" }]
    });
    await emitCompleted("turn-002", {
      id: "item-2002",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: "turn 2 assistant" }]
    });

    await emitCompleted("turn-003", {
      id: "item-3001",
      type: "userMessage",
      content: [{ text: "turn 3 user" }]
    });
    await emitCompleted("turn-003", {
      id: "item-3002",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: "turn 3 assistant" }]
    });

    const mirrored = store.listMirroredItems("retention_thread");
    const turnIds = [...new Set(mirrored.map((record) => record.turnId).filter((value): value is string => Boolean(value)))];
    assert.deepEqual(turnIds.sort(), ["turn-002", "turn-003"]);
    assert.ok(discord.deletedMessageIds.length >= 1);
    assert.ok(discord.deletedMessageIds.includes("approval_msg_retention_answered"));
    assert.equal(store.findPendingApprovalByToken("approval_retention_answered"), undefined);
    assert.equal(store.findPendingApprovalByToken("approval_retention_pending")?.status, "pending");
    assert.equal(discord.deletedMessageIds.includes("approval_msg_retention_pending"), false);
  } finally {
    await bridge.stop();
  }
});

test("retention maxTurnsPerThread deletes every Discord chunk for split mirrored messages", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        retention: {
          maxTurnsPerThread: 1
        }
      }
    )
  });

  store.upsertThreadBridge({
    codexThreadId: "retention_split_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_retention_split_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Retention split thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  const emitCompleted = async (turnId: string, item: Record<string, unknown>) => {
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "retention_split_thread",
        turnId,
        item
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await emitCompleted("turn-001", {
      id: "item-1001",
      type: "userMessage",
      content: [{ text: "turn 1 user" }]
    });
    await emitCompleted("turn-001", {
      id: "item-1002",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: `turn 1 long assistant ${"split chunk ".repeat(500)}` }]
    });

    const splitRecord = store.getMirroredItem("retention_split_thread", "item-1002");
    assert.ok(splitRecord);
    const splitMessageIds = splitRecord.discordMessageIds ?? [splitRecord.discordMessageId];
    assert.equal(splitMessageIds.length > 1, true);

    await emitCompleted("turn-002", {
      id: "item-2001",
      type: "userMessage",
      content: [{ text: "turn 2 user" }]
    });

    assert.equal(store.getMirroredItem("retention_split_thread", "item-1002"), undefined);
    for (const messageId of splitMessageIds) {
      assert.ok(discord.deletedMessageIds.includes(messageId));
    }
  } finally {
    await bridge.stop();
  }
});

test("retention maxTurnsPerThread prunes stale subagent threads tied to pruned parent turns", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        retention: {
          maxTurnsPerThread: 2
        }
      }
    )
  });

  store.upsertThreadBridge({
    codexThreadId: "retention_parent_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_retention_parent_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Retention parent",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  store.upsertThreadBridge({
    codexThreadId: "retention_child_old",
    parentCodexThreadId: "retention_parent_thread",
    parentAnchorTurnId: "turn-001",
    parentAnchorTurnCursor: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_thread_retention_child_old",
    discordParentChannelId: "discord_channel_retention_parent_thread",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Old subagent",
    actorName: "Aquinas",
    lastStatusType: "idle",
    channelKind: "subagent"
  });
  store.upsertChildThreadAnchor({
    childThreadId: "retention_child_old",
    parentThreadId: "retention_parent_thread",
    parentTurnId: "turn-001",
    parentTurnCursor: null,
    source: "codex-read",
    updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
  });
  discord.seedThreadStarterNotification(
    "discord_thread_retention_child_old",
    "discord_msg_thread_started_retention_child_old"
  );

  store.upsertThreadBridge({
    codexThreadId: "retention_child_recent",
    parentCodexThreadId: "retention_parent_thread",
    parentAnchorTurnId: "turn-002",
    parentAnchorTurnCursor: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_thread_retention_child_recent",
    discordParentChannelId: "discord_channel_retention_parent_thread",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Recent subagent",
    actorName: "Wegener",
    lastStatusType: "idle",
    channelKind: "subagent"
  });
  store.upsertChildThreadAnchor({
    childThreadId: "retention_child_recent",
    parentThreadId: "retention_parent_thread",
    parentTurnId: "turn-002",
    parentTurnCursor: null,
    source: "codex-read",
    updatedAt: new Date().toISOString()
  });

  const emitCompleted = async (turnId: string, item: Record<string, unknown>) => {
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "retention_parent_thread",
        turnId,
        item
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await emitCompleted("turn-001", {
      id: "item-1001",
      type: "userMessage",
      content: [{ text: "turn 1 user" }]
    });
    await emitCompleted("turn-001", {
      id: "item-1002",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: "turn 1 assistant" }]
    });

    await emitCompleted("turn-002", {
      id: "item-2001",
      type: "userMessage",
      content: [{ text: "turn 2 user" }]
    });
    await emitCompleted("turn-002", {
      id: "item-2002",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: "turn 2 assistant" }]
    });

    await emitCompleted("turn-003", {
      id: "item-3001",
      type: "userMessage",
      content: [{ text: "turn 3 user" }]
    });
    await emitCompleted("turn-003", {
      id: "item-3002",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: "turn 3 assistant" }]
    });

    assert.equal(store.getThreadBridge("retention_child_old"), undefined);
    assert.ok(store.getThreadBridge("retention_child_recent"));
    assert.ok(discord.deletedLocationIds.includes("discord_thread_retention_child_old"));
    assert.ok(discord.deletedMessageIds.includes("discord_msg_thread_started_retention_child_old"));
    assert.equal(discord.deletedLocationIds.includes("discord_thread_retention_child_recent"), false);
  } finally {
    await bridge.stop();
  }
});

test("retention maxTurnsPerThread prunes active subagent threads when their parent turn falls out of retention", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        retention: {
          maxTurnsPerThread: 2
        }
      }
    )
  });

  store.upsertThreadBridge({
    codexThreadId: "retention_parent_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_retention_parent_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Retention parent",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  store.upsertThreadBridge({
    codexThreadId: "retention_child_active_old",
    parentCodexThreadId: "retention_parent_thread",
    parentAnchorTurnId: "turn-001",
    parentAnchorTurnCursor: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_thread_retention_child_active_old",
    discordParentChannelId: "discord_channel_retention_parent_thread",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Active subagent",
    actorName: "Hypatia",
    lastStatusType: "active",
    channelKind: "subagent"
  });

  const emitCompleted = async (turnId: string, item: Record<string, unknown>) => {
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "retention_parent_thread",
        turnId,
        item
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  try {
    await bridge.start({ skipDiscovery: true });

    await emitCompleted("turn-001", {
      id: "item-1001",
      type: "userMessage",
      content: [{ text: "turn 1 user" }]
    });
    await emitCompleted("turn-001", {
      id: "item-1002",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: "turn 1 assistant" }]
    });

    await emitCompleted("turn-002", {
      id: "item-2001",
      type: "userMessage",
      content: [{ text: "turn 2 user" }]
    });
    await emitCompleted("turn-002", {
      id: "item-2002",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: "turn 2 assistant" }]
    });

    await emitCompleted("turn-003", {
      id: "item-3001",
      type: "userMessage",
      content: [{ text: "turn 3 user" }]
    });
    await emitCompleted("turn-003", {
      id: "item-3002",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: "turn 3 assistant" }]
    });

    assert.equal(store.getThreadBridge("retention_child_active_old"), undefined);
    assert.equal(discord.deletedLocationIds.includes("discord_thread_retention_child_active_old"), true);
  } finally {
    await bridge.stop();
  }
});

test("retention maxTurnsPerThread prunes stale subagent threads even when the parent already fits the retained turn limit", async () => {
  const { store, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        retention: {
          maxTurnsPerThread: 2
        }
      }
    )
  });

  const now = Date.now();
  store.upsertThreadBridge({
    codexThreadId: "retention_parent_limit_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_retention_parent_limit_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(now).toISOString(),
    attachMode: "auto",
    threadName: "Retention parent limit",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  store.upsertMirroredItem({
    threadId: "retention_parent_limit_thread",
    itemId: "turn_002_user",
    turnId: "turn-002",
    kind: "user",
    discordMessageId: "msg_turn_002_user",
    groupKey: "turn-002",
    contentSignature: "turn 2 user",
    renderedContent: "turn 2 user",
    timestampMs: now - 10_000,
    cursor: `${String(now - 10_000).padStart(16, "0")}:00000001:turn_002_user`,
    turnCursor: `${String(now - 10_000).padStart(16, "0")}:turn-002`,
    updatedAt: new Date(now - 10_000).toISOString()
  });
  store.upsertMirroredItem({
    threadId: "retention_parent_limit_thread",
    itemId: "turn_003_user",
    turnId: "turn-003",
    kind: "user",
    discordMessageId: "msg_turn_003_user",
    groupKey: "turn-003",
    contentSignature: "turn 3 user",
    renderedContent: "turn 3 user",
    timestampMs: now - 2_000,
    cursor: `${String(now - 2_000).padStart(16, "0")}:00000001:turn_003_user`,
    turnCursor: `${String(now - 2_000).padStart(16, "0")}:turn-003`,
    updatedAt: new Date(now - 2_000).toISOString()
  });

  store.upsertThreadBridge({
    codexThreadId: "retention_child_limit_pending",
    parentCodexThreadId: "retention_parent_limit_thread",
    parentAnchorTurnId: null,
    parentAnchorTurnCursor: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_thread_retention_child_limit_pending",
    discordParentChannelId: "discord_channel_retention_parent_limit_thread",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(now - 15 * 60_000).toISOString(),
    attachMode: "auto",
    threadName: "Tesla",
    actorName: "Tesla",
    lastStatusType: "idle",
    channelKind: "subagent"
  });
  discord.seedThreadStarterNotification(
    "discord_thread_retention_child_limit_pending",
    "discord_msg_thread_started_retention_child_limit_pending"
  );
  store.upsertPendingApproval({
    token: "retention_child_limit_pending_token",
    requestId: "session-log:call_retention_child_limit_pending",
    threadId: "retention_child_limit_pending",
    turnId: "turn-child-limit-pending",
    itemId: "call_retention_child_limit_pending",
    kind: "commandExecution",
    sanitizedPreview: "Start-Process https://example.com/?probe=retention-child-limit",
    cwd: "C:\\repo",
    reason: "Old pending child approval",
    availableDecisions: [],
    decisionPayloads: {},
    expiresAt: new Date(now + 30_000).toISOString(),
    discordMessageId: "approval_msg_retention_child_limit_pending",
    status: "pending",
    details: "{}",
    createdAt: new Date(now - 15 * 60_000).toISOString()
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await (bridge as any).enforceTurnRetention("retention_parent_limit_thread");

    assert.equal(store.getThreadBridge("retention_child_limit_pending"), undefined);
    assert.equal(store.findPendingApprovalByToken("retention_child_limit_pending_token"), undefined);
    assert.ok(discord.deletedLocationIds.includes("discord_thread_retention_child_limit_pending"));
    assert.ok(discord.deletedMessageIds.includes("discord_msg_thread_started_retention_child_limit_pending"));
  } finally {
    await bridge.stop();
  }
});

