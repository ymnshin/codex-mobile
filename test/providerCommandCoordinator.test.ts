import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Policy } from "../src/policy/Policy.js";
import { ProviderCommandCoordinator } from "../src/bridge/commands/ProviderCommandCoordinator.js";
import { DesktopSteerPayloadBuilder } from "../src/bridge/commands/DesktopSteerPayloadBuilder.js";

function createPolicy(
  messageWriteBacks = {
    allowFromDiscord: true,
    allowedUserIds: ["user_1"]
  },
  approvals = {
    allowFromDiscord: true,
    allowedUserIds: ["user_1"],
    mentionApprovers: false
  }
) {
  return new Policy(approvals, messageWriteBacks);
}

function createBridge(
  threadId: string,
  channelId: string,
  sourceKind: "app-server" | "cli-session" = "app-server"
) {
  return {
    codexThreadId: threadId,
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: channelId,
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto" as const,
    threadName: "Bridge thread",
    lastStatusType: "active",
    channelKind: "conversation" as const,
    sourceKind
  };
}

function createHarness(options: {
  messageWriteBacks?: Parameters<typeof createPolicy>[0];
  approvals?: Parameters<typeof createPolicy>[1];
  desktopIpcClient?: unknown;
  metadata?: Map<
    string,
    {
      cwd: string | null;
      repoName: string | null;
      threadName: string | null;
      actorName: string | null;
      parentThreadId: string | null;
      sourceSubagentOther: string | null;
      originator: string | null;
      source: string | null;
    }
  >;
} = {}) {
  const bridges = new Map<string, ReturnType<typeof createBridge>>();
  const warnings: string[] = [];
  const readThreadCalls: string[] = [];
  const resumeThreadCalls: string[] = [];
  const steerTurnCalls: Array<{ threadId: string; turnId: string; text: string }> = [];
  const startTurnCalls: Array<{ threadId: string; text: string }> = [];
  const canonicalEvents: Array<{
    threadId: string;
    eventKind: string;
    itemKind?: string | null;
    turnId?: string | null;
    summary: string | null;
  }> = [];
  const writeBackQueue: Array<{
    id: number;
    threadId: string;
    discordChannelId: string;
    actorUserId: string;
    text: string;
    status: "pending" | "sending" | "sent" | "failed" | "retracted";
    createdAt: string;
    updatedAt: string;
    sentAt: string | null;
    error: string | null;
  }> = [];
  let nextWriteBackQueueId = 1;
  const queueCalls: string[] = [];
  const flushCalls: string[] = [];
  const clearQueuedCalls: string[] = [];
  const cleanupThreadCalls: string[] = [];
  const progressMessages: string[] = [];
  let resetCalled = false;

  const context = {
    policy: createPolicy(options.messageWriteBacks, options.approvals),
    runtimeConfig: {
      messageWriteBacks:
        options.messageWriteBacks ?? {
          allowFromDiscord: true,
          allowedUserIds: ["user_1"]
        }
    },
    stateStore: {
      getThreadBridge: (threadId: string) => bridges.get(threadId),
      findThreadBridgeByDiscordChannelId: (channelId: string) =>
        [...bridges.values()].find((bridge) => bridge.discordChannelId === channelId) ?? null,
      listThreadBridgesByKind: (kind: string) =>
        [...bridges.values()].filter((bridge) => bridge.channelKind === kind),
      appendCanonicalThreadEvent: (record: {
        threadId: string;
        eventKind: string;
        itemKind?: string | null;
        turnId?: string | null;
        summary?: string | null;
      }) => {
        canonicalEvents.push({
          threadId: record.threadId,
          eventKind: record.eventKind,
          itemKind: record.itemKind ?? null,
          turnId: record.turnId ?? null,
          summary: record.summary ?? null
        });
      },
      listCanonicalThreadEvents: (threadId: string, limit: number) =>
        canonicalEvents.filter((event) => event.threadId === threadId).slice(-limit),
      createWriteBackQueueItem: (input: {
        threadId: string;
        discordChannelId: string;
        actorUserId: string;
        text: string;
      }) => {
        const now = new Date().toISOString();
        const record = {
          id: nextWriteBackQueueId++,
          status: "pending" as const,
          createdAt: now,
          updatedAt: now,
          sentAt: null,
          error: null,
          ...input
        };
        writeBackQueue.push(record);
        return record;
      },
      getWriteBackQueueItem: (id: number) => writeBackQueue.find((record) => record.id === id),
      listWriteBackQueueItems: (threadId: string) =>
        writeBackQueue.filter((record) => record.threadId === threadId),
      countPendingWriteBackQueueItems: (threadId: string) =>
        writeBackQueue.filter((record) => record.threadId === threadId && record.status === "pending").length,
      claimNextPendingWriteBackQueueItem: (threadId: string) => {
        const record = writeBackQueue.find((entry) => entry.threadId === threadId && entry.status === "pending") ?? null;
        if (record) {
          record.status = "sending";
          record.updatedAt = new Date().toISOString();
          record.error = null;
        }
        return record;
      },
      claimWriteBackQueueItem: (id: number) => {
        const record = writeBackQueue.find((entry) => entry.id === id && entry.status === "pending") ?? null;
        if (record) {
          record.status = "sending";
          record.updatedAt = new Date().toISOString();
          record.error = null;
        }
        return record;
      },
      markWriteBackQueueItemSent: (id: number) => {
        const record = writeBackQueue.find((entry) => entry.id === id);
        if (record) {
          record.status = "sent";
          record.sentAt = new Date().toISOString();
          record.updatedAt = record.sentAt;
          record.error = null;
        }
      },
      markWriteBackQueueItemFailed: (id: number, error: string) => {
        const record = writeBackQueue.find((entry) => entry.id === id);
        if (record) {
          record.status = "failed";
          record.updatedAt = new Date().toISOString();
          record.error = error;
        }
      },
      markWriteBackQueueItemRetracted: (id: number) => {
        const record = writeBackQueue.find((entry) => entry.id === id && entry.status === "pending") ?? null;
        if (record) {
          record.status = "retracted";
          record.updatedAt = new Date().toISOString();
        }
        return record;
      },
      retractLatestPendingWriteBackQueueItem: (threadId: string) => {
        const record =
          writeBackQueue
            .filter((entry) => entry.threadId === threadId && entry.status === "pending")
            .sort((left, right) => right.id - left.id)[0] ?? null;
        if (record) {
          record.status = "retracted";
          record.updatedAt = new Date().toISOString();
        }
        return record;
      },
      restoreWriteBackQueueItemPending: (id: number, error: string | null) => {
        const record = writeBackQueue.find((entry) => entry.id === id && entry.status === "sending");
        if (record) {
          record.status = "pending";
          record.updatedAt = new Date().toISOString();
          record.error = error;
        }
      }
    },
    codexAdapter: {
      readThread: async (threadId: string) => {
        readThreadCalls.push(threadId);
        return {
          id: threadId,
          name: `Thread ${threadId}`,
          preview: "preview",
          modelProvider: null,
          createdAt: null,
          updatedAt: null,
          ephemeral: false,
          status: { type: "idle" as const }
        };
      },
      resumeThread: async (threadId: string) => {
      resumeThreadCalls.push(threadId);
      },
      steerTurn: async (threadId: string, turnId: string, text: string) => {
        steerTurnCalls.push({ threadId, turnId, text });
      },
      startTurn: async (threadId: string, text: string) => {
        startTurnCalls.push({ threadId, text });
      },
      resolveMetadata: async (threadId: string) => {
        return (
          options.metadata?.get(threadId) ?? {
            cwd: null,
            repoName: null,
            threadName: null,
            actorName: null,
            parentThreadId: null,
            sourceSubagentOther: null,
            originator: null,
            source: null
          }
        );
      }
    },
    ...(options.desktopIpcClient ? { desktopIpcClient: options.desktopIpcClient } : {}),
    provider: {
      detachDiscordLocation: async () => undefined
    },
    logger: {
      debug: () => undefined,
      warn: (_payload: unknown, message: string) => {
        warnings.push(message);
      }
    }
  };

  const runtime = {
    threadEventChains: new Map<string, Promise<void>>(),
    threadState: new Map<string, { status: { type: "active" | "idle"; activeFlags?: string[] } }>()
  };

  const deps = {
    clearQueuedStatusUpdate: (threadId: string) => {
      clearQueuedCalls.push(threadId);
    },
    cleanupThread: async (threadId: string) => {
      cleanupThreadCalls.push(threadId);
      bridges.delete(threadId);
      return 2;
    },
    drainThreadEventQueue: async () => undefined,
    detachThread: (threadId: string) => {
      const existing = bridges.get(threadId) ?? null;
      bridges.delete(threadId);
      return existing;
    },
    flushStatusUpdate: async (threadId: string) => {
      flushCalls.push(threadId);
    },
    hydrateThread: async (threadId: string) => {
      if (!bridges.has(threadId)) {
        bridges.set(threadId, createBridge(threadId, `discord_${threadId}`));
      }
      return { bridge: bridges.get(threadId) } as never;
    },
    pollThreadSessionEvents: async () => undefined,
    persistThreadState: () => undefined,
    printProgress: (message: string) => {
      progressMessages.push(message);
    },
    readLatestTurnBackfillTurnId: async () => null,
    queueStatusUpdate: (threadId: string) => {
      queueCalls.push(threadId);
    },
    resetBridge: async () => {
      resetCalled = true;
      bridges.clear();
      return { deletedCategories: 1, deletedLocations: 3 };
    }
  };

  return {
    bridges,
    warnings,
    readThreadCalls,
    resumeThreadCalls,
    steerTurnCalls,
    startTurnCalls,
    canonicalEvents,
    writeBackQueue,
    queueCalls,
    flushCalls,
    clearQueuedCalls,
    cleanupThreadCalls,
    progressMessages,
    get resetCalled() {
      return resetCalled;
    },
    coordinator: new ProviderCommandCoordinator(context as never, runtime as never, deps)
  };
}

const authorizedActor = { userId: "user_1", roleIds: [], username: "tester" };
const unauthorizedActor = { userId: "user_2", roleIds: [], username: "tester" };

function createDesktopSteerPayloadBuilder(options: { configPath?: string; dumpEnabled?: boolean } = {}) {
  const progressMessages: string[] = [];
  const runtimeConfig = {
    configPath: options.configPath ?? path.join(tmpdir(), "bridge.config.json"),
    diagnostics: {
      desktopSteerDumpEnabled: options.dumpEnabled ?? false
    }
  };
  const builder = new DesktopSteerPayloadBuilder({
    logger: {
      info: () => undefined,
      warn: () => undefined
    } as never,
    runtimeConfig: runtimeConfig as never,
    printProgress: (message) => {
      progressMessages.push(message);
    }
  });
  return { builder, progressMessages, runtimeConfig };
}

test("ProviderCommandCoordinator rejects unauthorized command actors", async () => {
  const harness = createHarness();
  const result = await harness.coordinator.handleStatusCommand(unauthorizedActor);

  assert.equal(result.ephemeral, true);
  assert.match(result.content, /not allowed to control the Codex bridge/i);
});

test("ProviderCommandCoordinator gates message write-backs separately from bridge commands", async () => {
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: false,
      allowedUserIds: ["user_1"]
    }
  });

  const status = await harness.coordinator.handleStatusCommand(authorizedActor);
  const send = await harness.coordinator.handleSendCommand(authorizedActor, "discord_missing", "Start work.", "queue");

  assert.equal(status.content, "No Codex conversations are mapped yet.");
  assert.equal(send.ephemeral, true);
  assert.match(send.content, /message write-backs are disabled/i);
});

test("ProviderCommandCoordinator gates proposed-plan actions with approval controls", async () => {
  const harness = createHarness({
    approvals: {
      allowFromDiscord: false,
      allowedUserIds: ["user_1"],
      mentionApprovers: false
    }
  });

  const result = await harness.coordinator.handleProposedPlanAction(authorizedActor, "plan_token", "accept");

  assert.equal(result.ephemeral, true);
  assert.match(result.content, /approvals are disabled/i);
});

test("ProviderCommandCoordinator reports mapped status rows with runtime labels", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_12345678", createBridge("thread_12345678", "discord_thread"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_12345678",
    {
      status: { type: "active", activeFlags: ["waitingOnApproval"] }
    }
  );

  const result = await harness.coordinator.handleStatusCommand(authorizedActor);

  assert.match(result.content, /thread_1/);
  assert.match(result.content, /Waiting on approval/);
  assert.match(result.content, /<#discord_thread>/);
});

test("ProviderCommandCoordinator reports when no conversations are mapped", async () => {
  const harness = createHarness();
  const result = await harness.coordinator.handleStatusCommand(authorizedActor);

  assert.equal(result.content, "No Codex conversations are mapped yet.");
});

test("ProviderCommandCoordinator resolves mapped short thread ids shown by status", async () => {
  const harness = createHarness();
  harness.bridges.set(
    "019dcd46-3b51-7691-8d37-d501e704503b",
    createBridge("019dcd46-3b51-7691-8d37-d501e704503b", "discord_short_detach")
  );
  harness.bridges.set(
    "019dcd55-0000-7000-8000-000000000000",
    createBridge("019dcd55-0000-7000-8000-000000000000", "discord_short_clean")
  );

  const detach = await harness.coordinator.handleDetachCommand(authorizedActor, "019dcd46");
  const clean = await harness.coordinator.handleCleanIdCommand(authorizedActor, "019dcd55");

  assert.equal(
    detach.content,
    "Detached Codex thread `019dcd46-3b51-7691-8d37-d501e704503b` from <#discord_short_detach>."
  );
  assert.deepEqual(harness.clearQueuedCalls, ["019dcd46-3b51-7691-8d37-d501e704503b"]);
  assert.equal(harness.bridges.has("019dcd46-3b51-7691-8d37-d501e704503b"), false);
  assert.equal(
    clean.content,
    "Cleaned Codex thread `019dcd55-0000-7000-8000-000000000000`. Deleted 2 Discord location(s)."
  );
  assert.deepEqual(harness.cleanupThreadCalls, ["019dcd55-0000-7000-8000-000000000000"]);
});

test("ProviderCommandCoordinator rejects ambiguous short mapped thread ids", async () => {
  const harness = createHarness();
  harness.bridges.set(
    "019dcd46-0000-7000-8000-000000000001",
    createBridge("019dcd46-0000-7000-8000-000000000001", "discord_ambiguous_1")
  );
  harness.bridges.set(
    "019dcd46-0000-7000-8000-000000000002",
    createBridge("019dcd46-0000-7000-8000-000000000002", "discord_ambiguous_2")
  );

  const result = await harness.coordinator.handleDetachCommand(authorizedActor, "019dcd46");

  assert.equal(result.ephemeral, true);
  assert.match(result.content, /matches multiple mapped conversations/i);
  assert.match(result.content, /019dcd46-0000-7000-8000-000000000001/);
  assert.match(result.content, /019dcd46-0000-7000-8000-000000000002/);
  assert.equal(harness.bridges.size, 2);
});

test("ProviderCommandCoordinator attaches existing mappings by queueing a status update", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_attach_existing", createBridge("thread_attach_existing", "discord_existing"));

  const result = await harness.coordinator.handleAttachCommand(authorizedActor, "thread_attach_existing");

  assert.equal(result.content, "Attached Codex thread `thread_attach_existing` to <#discord_existing>.");
  assert.deepEqual(harness.readThreadCalls, ["thread_attach_existing"]);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_attach_existing"]);
  assert.deepEqual(harness.queueCalls, ["thread_attach_existing"]);
  assert.deepEqual(harness.flushCalls, []);
});

test("ProviderCommandCoordinator attaches new mappings by flushing the initial status", async () => {
  const harness = createHarness();

  const result = await harness.coordinator.handleAttachCommand(authorizedActor, "thread_attach_new");

  assert.equal(result.content, "Attached Codex thread `thread_attach_new` to <#discord_thread_attach_new>.");
  assert.deepEqual(harness.readThreadCalls, ["thread_attach_new"]);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_attach_new"]);
  assert.deepEqual(harness.queueCalls, []);
  assert.deepEqual(harness.flushCalls, ["thread_attach_new"]);
});

test("ProviderCommandCoordinator detaches mappings even when Discord cleanup throws", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_detach", createBridge("thread_detach", "discord_detach"));
  (harness.coordinator as unknown as { context: { provider: { detachDiscordLocation: () => Promise<void> } } }).context.provider.detachDiscordLocation =
    async () => {
      throw new Error("discord detach failed");
    };

  const result = await harness.coordinator.handleDetachCommand(authorizedActor, "thread_detach");

  assert.equal(result.content, "Detached Codex thread `thread_detach` from <#discord_detach>.");
  assert.deepEqual(harness.clearQueuedCalls, ["thread_detach"]);
  assert.equal(harness.bridges.has("thread_detach"), false);
  assert.equal(harness.warnings.length, 1);
});

test("ProviderCommandCoordinator cleans one mapping or the whole bridge", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_clean", createBridge("thread_clean", "discord_clean"));

  const cleanOne = await harness.coordinator.handleCleanIdCommand(authorizedActor, "thread_clean");
  const cleanAll = await harness.coordinator.handleCleanAllCommand(authorizedActor);

  assert.equal(
    cleanOne.content,
    "Cleaned Codex thread `thread_clean`. Deleted 2 Discord location(s)."
  );
  assert.equal(
    cleanAll.content,
    "Cleaned the bridge. Deleted 3 Discord location(s) and 1 category."
  );
  assert.deepEqual(harness.cleanupThreadCalls, ["thread_clean"]);
  assert.equal(harness.resetCalled, true);
});

test("ProviderCommandCoordinator returns help text", async () => {
  const harness = createHarness();
  const result = await harness.coordinator.handleHelpCommand(authorizedActor);

  assert.match(result.content, /\/codex help/);
  assert.match(result.content, /\/codex attach <thread_id>/);
});

test("ProviderCommandCoordinator internal steering steers an in-progress turn even if coarse status is idle", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_steer", createBridge("thread_steer", "discord_steer"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_steer",
    {
      threadId: "thread_steer",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
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
    }
  );

  const result = await harness.coordinator.steerActiveTurnInternally("Do not run the command.", "thread_steer");

  assert.match(result.content, /Steered active turn/i);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_steer"]);
  assert.deepEqual(harness.steerTurnCalls, [
    {
      threadId: "thread_steer",
      turnId: "turn_steer_1",
      text: "Do not run the command."
    }
  ]);
  assert.deepEqual(harness.startTurnCalls, []);
});

test("ProviderCommandCoordinator internal steering refuses when no active turn is tracked", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_idle", createBridge("thread_idle", "discord_idle"));

  const result = await harness.coordinator.steerActiveTurnInternally("Please continue.", "thread_idle");

  assert.match(result.content, /There is no active Codex turn to steer/i);
  assert.equal(result.ephemeral, true);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_idle"]);
  assert.deepEqual(harness.steerTurnCalls, []);
  assert.deepEqual(harness.startTurnCalls, []);
});

test("ProviderCommandCoordinator internal steering steers an active turn without Discord command routing", async () => {
  const harness = createHarness();
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_local_steer",
    {
      threadId: "thread_local_steer",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_local_steer_1",
      lastTurnStatus: "in_progress"
    }
  );

  const result = await harness.coordinator.steerActiveTurnInternally("Keep the same active turn.", "thread_local_steer");

  assert.match(result.content, /Steered active turn/i);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_local_steer"]);
  assert.deepEqual(harness.steerTurnCalls, [
    {
      threadId: "thread_local_steer",
      turnId: "turn_local_steer_1",
      text: "Keep the same active turn."
    }
  ]);
});

test("ProviderCommandCoordinator send command starts a turn immediately when idle", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_send_idle", createBridge("thread_send_idle", "discord_send_idle"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_send_idle",
    {
      threadId: "thread_send_idle",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_send_idle",
    "Start the next task.",
    "queue"
  );

  assert.match(result.content, /Started a new Codex turn/);
  assert.match(result.content, /> Start the next task\./);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_send_idle"]);
  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_send_idle",
      text: "Start the next task."
    }
  ]);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
});

test("ProviderCommandCoordinator send command starts an idle CLI session without resuming", async () => {
  const harness = createHarness();
  harness.bridges.set(
    "thread_cli_send_idle",
    createBridge("thread_cli_send_idle", "discord_cli_send_idle", "cli-session")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_cli_send_idle",
    {
      threadId: "thread_cli_send_idle",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "cli-session",
      name: "CLI bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_cli_send_idle",
    "Start from Discord in the live CLI.",
    "queue"
  );

  assert.match(result.content, /Started a new Codex turn/);
  assert.match(result.content, /> Start from Discord in the live CLI\./);
  assert.deepEqual(harness.resumeThreadCalls, []);
  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_cli_send_idle",
      text: "Start from Discord in the live CLI."
    }
  ]);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
});

test("ProviderCommandCoordinator send command routes bridge remote CLI threads through app-server", async () => {
  const desktopStartTurnCalls: Array<{ conversationId: string; turnStartParams: Record<string, unknown> }> = [];
  const harness = createHarness({
    desktopIpcClient: {
      startTurn: async (conversationId: string, turnStartParams: Record<string, unknown>) => {
        desktopStartTurnCalls.push({ conversationId, turnStartParams });
      }
    },
    metadata: new Map([
      [
        "thread_remote_cli_send_idle",
        {
          cwd: "C:\\repo",
          repoName: "repo",
          threadName: "Remote CLI thread",
          actorName: null,
          parentThreadId: null,
          sourceSubagentOther: null,
          originator: "codex-mobile",
          source: "vscode"
        }
      ]
    ])
  });
  harness.bridges.set(
    "thread_remote_cli_send_idle",
    createBridge("thread_remote_cli_send_idle", "discord_remote_cli_send_idle", "app-server")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_remote_cli_send_idle",
    {
      threadId: "thread_remote_cli_send_idle",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Remote CLI bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_remote_cli_send_idle",
    "Start from Discord in the remote CLI.",
    "queue"
  );

  assert.match(result.content, /Started a new Codex turn/);
  assert.match(result.content, /> Start from Discord in the remote CLI\./);
  assert.deepEqual(harness.resumeThreadCalls, []);
  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_remote_cli_send_idle",
      text: "Start from Discord in the remote CLI."
    }
  ]);
  assert.deepEqual(desktopStartTurnCalls, []);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
});

test("ProviderCommandCoordinator send command queues while active and exposes write-back buttons", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_send_active", createBridge("thread_send_active", "discord_send_active"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_send_active",
    {
      threadId: "thread_send_active",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_active",
      lastTurnStatus: "in_progress"
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_send_active",
    "Queue this after the active turn.",
    "queue"
  );

  assert.match(result.content, /Queued for the next turn\. Position 1\./);
  assert.match(result.content, /> Queue this after the active turn\./);
  assert.equal(harness.writeBackQueue[0]?.status, "pending");
  assert.deepEqual(harness.startTurnCalls, []);
  assert.deepEqual(result.buttons?.map((button) => button.label), ["Steer instead", "Retract"]);
});

test("ProviderCommandCoordinator send command reconciles stale active state from canonical final answer", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_send_stale_final", createBridge("thread_send_stale_final", "discord_send_stale_final"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_send_stale_final",
    {
      threadId: "thread_send_stale_final",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_stale_final",
      lastTurnStatus: "in_progress"
    }
  );
  (harness.coordinator as unknown as {
    context: {
      stateStore: {
        appendCanonicalThreadEvent(record: {
          threadId: string;
          eventKind: string;
          itemKind: string;
          turnId: string;
          summary: string;
        }): void;
      };
    };
  }).context.stateStore.appendCanonicalThreadEvent({
    threadId: "thread_send_stale_final",
    eventKind: "content",
    itemKind: "agentAnswer",
    turnId: "turn_stale_final",
    summary: "Finished."
  });

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_send_stale_final",
    "Start from stale completed state.",
    "queue"
  );

  assert.match(result.content, /Started a new Codex turn/);
  assert.match(result.content, /> Start from stale completed state\./);
  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_send_stale_final",
      text: "Start from stale completed state."
    }
  ]);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  const runtimeState = (harness.coordinator as unknown as {
    runtime: { threadState: Map<string, { lastTurnId: string | null; lastTurnStatus: string | null }> };
  }).runtime.threadState.get("thread_send_stale_final");
  assert.equal(runtimeState?.lastTurnId, null);
  assert.equal(runtimeState?.lastTurnStatus, "in_progress");
});

test("ProviderCommandCoordinator send command steers only active turns", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_send_steer", createBridge("thread_send_steer", "discord_send_steer"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_send_steer",
    {
      threadId: "thread_send_steer",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_send_steer",
      lastTurnStatus: "in_progress"
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_send_steer",
    "Adjust the active turn.",
    "steer"
  );

  assert.match(result.content, /Sent to the active turn\./);
  assert.match(result.content, /> Adjust the active turn\./);
  assert.deepEqual(harness.steerTurnCalls, [
    {
      threadId: "thread_send_steer",
      turnId: "turn_send_steer",
      text: "Adjust the active turn."
    }
  ]);

  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_send_steer",
    {
      threadId: "thread_send_steer",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  const idle = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_send_steer",
    "This should start a new turn instead.",
    "steer"
  );
  assert.equal(idle.ephemeral, true);
  assert.match(idle.content, /thread is idle/i);
});

test("ProviderCommandCoordinator send command steers bridge remote CLI through app-server when Desktop IPC is ready", async () => {
  const desktopSteerTurnCalls: Array<{ threadId: string; turnId: string; input: unknown }> = [];
  const desktopIpcClient = {
    isReady: () => true,
    getConversationState: () => null,
    waitForConversationState: async () => null,
    steerTurn: async (threadId: string, turnId: string, input: unknown) => {
      desktopSteerTurnCalls.push({ threadId, turnId, input });
    }
  };
  const harness = createHarness({
    desktopIpcClient,
    metadata: new Map([
      [
        "thread_remote_cli_steer",
        {
          cwd: "C:\\repo",
          repoName: "repo",
          threadName: "Remote CLI bridge thread",
          actorName: null,
          parentThreadId: null,
          sourceSubagentOther: null,
          originator: "codex-mobile",
          source: "vscode"
        }
      ]
    ])
  });
  harness.bridges.set(
    "thread_remote_cli_steer",
    createBridge("thread_remote_cli_steer", "discord_remote_cli_steer", "app-server")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_remote_cli_steer",
    {
      threadId: "thread_remote_cli_steer",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Remote CLI bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_remote_cli_steer",
      lastTurnStatus: "in_progress"
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_remote_cli_steer",
    "Adjust the active remote CLI turn.",
    "steer"
  );

  assert.match(result.content, /Sent to the active turn\./);
  assert.match(result.content, /> Adjust the active remote CLI turn\./);
  assert.deepEqual(harness.steerTurnCalls, [
    {
      threadId: "thread_remote_cli_steer",
      turnId: "turn_remote_cli_steer",
      text: "Adjust the active remote CLI turn."
    }
  ]);
  assert.deepEqual(desktopSteerTurnCalls, []);
});

test("ProviderCommandCoordinator retracts the latest pending queued write-back", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_retract", createBridge("thread_retract", "discord_retract"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_retract",
    {
      status: { type: "active" },
      lastTurnId: "turn_retract",
      lastTurnStatus: "in_progress"
    }
  );

  await harness.coordinator.handleSendCommand(authorizedActor, "discord_retract", "First", "queue");
  await harness.coordinator.handleSendCommand(authorizedActor, "discord_retract", "Second", "queue");
  const result = await harness.coordinator.handleRetractCommand(authorizedActor, "discord_retract");

  assert.match(result.content, /Retracted the latest pending queued message\./);
  assert.match(result.content, /> Second/);
  assert.equal(harness.writeBackQueue[0]?.status, "pending");
  assert.equal(harness.writeBackQueue[1]?.status, "retracted");
});

test("ProviderCommandCoordinator drains only one queued write-back per idle transition", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_drain", createBridge("thread_drain", "discord_drain"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_drain",
    {
      threadId: "thread_drain",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_drain_old",
      lastTurnStatus: "in_progress"
    }
  );
  await harness.coordinator.handleSendCommand(authorizedActor, "discord_drain", "First", "queue");
  await harness.coordinator.handleSendCommand(authorizedActor, "discord_drain", "Second", "queue");
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_drain",
    {
      threadId: "thread_drain",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_drain_old",
      lastTurnStatus: "completed"
    }
  );

  await harness.coordinator.drainNextQueuedWriteBackMessage("thread_drain");
  await harness.coordinator.drainNextQueuedWriteBackMessage("thread_drain");

  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_drain",
      text: "First"
    }
  ]);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.equal(harness.writeBackQueue[1]?.status, "pending");
});

test("ProviderCommandCoordinator drains queued bridge remote CLI write-back through app-server", async () => {
  const desktopStartTurnCalls: Array<{ conversationId: string; turnStartParams: Record<string, unknown> }> = [];
  const harness = createHarness({
    desktopIpcClient: {
      startTurn: async (conversationId: string, turnStartParams: Record<string, unknown>) => {
        desktopStartTurnCalls.push({ conversationId, turnStartParams });
      }
    },
    metadata: new Map([
      [
        "thread_remote_cli_drain",
        {
          cwd: "C:\\repo",
          repoName: "repo",
          threadName: "Remote CLI bridge thread",
          actorName: null,
          parentThreadId: null,
          sourceSubagentOther: null,
          originator: "codex-mobile",
          source: "vscode"
        }
      ]
    ])
  });
  harness.bridges.set(
    "thread_remote_cli_drain",
    createBridge("thread_remote_cli_drain", "discord_remote_cli_drain", "app-server")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_remote_cli_drain",
    {
      threadId: "thread_remote_cli_drain",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Remote CLI bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_remote_cli_drain_old",
      lastTurnStatus: "in_progress"
    }
  );
  await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_remote_cli_drain",
    "Run after the active remote CLI turn.",
    "queue"
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_remote_cli_drain",
    {
      threadId: "thread_remote_cli_drain",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Remote CLI bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_remote_cli_drain_old",
      lastTurnStatus: "completed"
    }
  );

  await harness.coordinator.drainNextQueuedWriteBackMessage("thread_remote_cli_drain");

  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_remote_cli_drain",
      text: "Run after the active remote CLI turn."
    }
  ]);
  assert.deepEqual(desktopStartTurnCalls, []);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
});

test("ProviderCommandCoordinator steer-instead button sends without starting a duplicate turn", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_button", createBridge("thread_button", "discord_button"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_button",
    {
      threadId: "thread_button",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_button",
      lastTurnStatus: "in_progress"
    }
  );

  await harness.coordinator.handleSendCommand(authorizedActor, "discord_button", "Steer this instead.", "queue");
  const result = await harness.coordinator.handleWriteBackButton(authorizedActor, "steer", 1);

  assert.match(result.content, /Sent queued message to the active turn\./);
  assert.match(result.content, /> Steer this instead\./);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.deepEqual(harness.steerTurnCalls, [
    {
      threadId: "thread_button",
      turnId: "turn_button",
      text: "Steer this instead."
    }
  ]);
  assert.deepEqual(harness.startTurnCalls, []);
});

test("DesktopSteerPayloadBuilder restore summary does not count duplicated rollback thread bytes", () => {
  const { builder } = createDesktopSteerPayloadBuilder();
  const desktopConversationState = {
    id: "thread_desktop_summary",
    cwd: "C:\\repo",
    updatedAt: 1_777_000_000_000,
    latestModel: "gpt-5.4",
    latestReasoningEffort: "high",
    turns: [
      {
        turnId: "turn_desktop_summary_live",
        status: "inProgress",
        params: {
          threadId: "thread_desktop_summary",
          input: [
            {
              type: "text",
              text: "Keep the restore payload compact."
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
  };

  const restoreMessage = builder.buildDesktopRestoreMessage(
    "thread_desktop_summary",
    desktopConversationState,
    "turn_desktop_summary_live"
  );
  const summary = builder.summarizeDesktopSteerPayload(desktopConversationState, restoreMessage);

  assert.ok(restoreMessage);
  assert.equal("rollbackResponse" in restoreMessage, false);
  assert.equal(summary.restoreThreadBytes ? summary.restoreThreadBytes > 0 : false, true);
  assert.equal(summary.restoreRollbackResponseBytes, null);
  assert.equal(summary.restoreRollbackResponseThreadBytes, null);
  assert.equal(summary.estimatedDuplicatedThreadBytes, null);
});

test("DesktopSteerPayloadBuilder sanitizes historical rollback items but keeps live rollback input", () => {
  const { builder } = createDesktopSteerPayloadBuilder();
  const historicalSteeringItem = {
    id: "turn_desktop_sanitize_old:steer",
    type: "steeringUserMessage",
    targetTurnId: "turn_desktop_sanitize_old",
    status: "delivered",
    input: [
      {
        type: "text",
        text: "Older feedback."
      }
    ],
    restoreMessage: {
      id: "restore:old",
      text: "Nested restore prompt.",
      thread: {
        id: "thread_desktop_sanitize",
        turns: []
      }
    }
  };
  const historicalCommandItem = {
    id: "cmd_desktop_sanitize_old",
    type: "commandExecution",
    command: "npm run test",
    status: "completed",
    aggregatedOutput: "very long historical output",
    exitCode: 0
  };
  const desktopConversationState = {
    id: "thread_desktop_sanitize",
    cwd: "C:\\repo",
    updatedAt: 1_779_100_000_000,
    latestModel: "gpt-5.4",
    latestReasoningEffort: "high",
    turns: [
      {
        turnId: "turn_desktop_sanitize_old",
        status: "complete",
        items: [historicalSteeringItem, historicalCommandItem]
      },
      {
        turnId: "turn_desktop_sanitize_live",
        status: "inProgress",
        params: {
          threadId: "thread_desktop_sanitize",
          input: [
            {
              type: "text",
              text: "Current live prompt."
            }
          ],
          cwd: "C:\\repo",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["C:\\repo"]
          },
          attachments: [],
          commentAttachments: []
        },
        items: []
      }
    ],
    requests: []
  };

  const restoreMessage = builder.buildDesktopRestoreMessage(
    "thread_desktop_sanitize",
    desktopConversationState,
    "turn_desktop_sanitize_live"
  );
  assert.ok(restoreMessage);

  const rollbackTurns =
    (((restoreMessage.thread as Record<string, unknown>)?.turns as Record<string, unknown>[]) ?? []);
  const historicalTurn = rollbackTurns.find((turn) => turn.id === "turn_desktop_sanitize_old");
  assert.ok(historicalTurn);
  const historicalItems = (historicalTurn.items as Record<string, unknown>[]) ?? [];
  const sanitizedSteeringItem = historicalItems.find((item) => item.type === "steeringUserMessage");
  const sanitizedCommandItem = historicalItems.find((item) => item.type === "commandExecution");
  assert.ok(sanitizedSteeringItem);
  assert.ok(sanitizedCommandItem);
  assert.equal("restoreMessage" in sanitizedSteeringItem, false);
  assert.equal("aggregatedOutput" in sanitizedCommandItem, false);
  assert.equal(sanitizedCommandItem.command, "npm run test");

  const liveTurn = rollbackTurns.find((turn) => turn.id === "turn_desktop_sanitize_live");
  assert.ok(liveTurn);
  assert.deepEqual((liveTurn.items as unknown[])[0], {
    id: "turn_desktop_sanitize_live:user-message",
    type: "userMessage",
    content: [
      {
        type: "text",
        text: "Current live prompt."
      }
    ]
  });
  assert.equal("restoreMessage" in historicalSteeringItem, true);
  assert.equal("aggregatedOutput" in historicalCommandItem, true);
});

test("DesktopSteerPayloadBuilder only dumps oversized Desktop steer payloads behind the dev guardrail", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-steer-dump-"));
  const configPath = path.join(dir, "bridge.config.json");
  const { builder, runtimeConfig } = createDesktopSteerPayloadBuilder({ configPath, dumpEnabled: false });

  const dumpArgs = {
    targetThreadId: "thread_dump_guard",
    runtimeTurnId: "turn_runtime",
    preferredTurnId: "turn_preferred",
    desktopTurnId: "turn_desktop",
    restoreStateSource: "desktop-ipc" as const,
    waitedForConversationState: false,
    waitForConversationStateDurationMs: 0,
    desktopConversationState: {
      id: "thread_dump_guard",
      turns: []
    },
    restoreMessage: {
      id: "restore:turn_desktop"
    },
    steerPayloadSummary: {
      conversationTurnCount: 0,
      rollbackTurnCount: 0,
      rollbackItemCount: 0,
      conversationStateBytes: null,
      restoreContextBytes: null,
      restoreThreadBytes: null,
      restoreRollbackResponseBytes: null,
      restoreRollbackResponseThreadBytes: null,
      estimatedDuplicatedThreadBytes: null,
      restoreMessageBytes: 30 * 1024 * 1024
    }
  };

  await builder.dumpOversizedDesktopSteerPayload(dumpArgs);
  const dumpDir = path.join(dir, "tmp", "desktop-steer-dumps");
  assert.equal(existsSync(dumpDir), false);

  runtimeConfig.diagnostics.desktopSteerDumpEnabled = true;
  await builder.dumpOversizedDesktopSteerPayload(dumpArgs);
  assert.equal(existsSync(dumpDir), true);
  assert.equal(readdirSync(dumpDir).length > 0, true);
});
