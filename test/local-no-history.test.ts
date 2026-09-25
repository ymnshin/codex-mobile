import {
  test, assert, createBridgeConfigFromPreset, createBridgeTestRig, FakeSessionEventTailer, FakeDesktopIpcClient
} from "./helpers/bridgeIntegration.js";

for (const useSession of [false, true]) {
  test(`zero startup history preserves live updates without old anchors (${useSession ? "session" : "app-server"})`, async () => {
    const tailer = useSession ? new FakeSessionEventTailer() : undefined;
    const runtimeConfig = createBridgeConfigFromPreset("recommended", { allowedUserIds: ["user_1"] }, {
      startupBackfill: { maxCodexMessages: 0 },
      retention: { maxTurnsPerThread: 0 }
    });
    const { codex, discord, bridge, store } = createBridgeTestRig({
      runtimeConfig, ...(tailer ? { sessionEventTailer: tailer } : {})
    });
    const now = Math.floor(Date.now() / 1000);
    const thread = {
      id: "no_history", name: "No history", preview: "No history", modelProvider: null,
      createdAt: now - 60, updatedAt: now, ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    };
    codex.threads = [thread];
    codex.metadata.set(thread.id, { cwd: "C:\\repo", repoName: "repo" });
    codex.threadDetails.set(thread.id, { ...thread, turns: [{
      id: "old_turn", createdAt: now - 60, status: "inProgress", items: [
        { type: "userMessage", id: "old_user", content: [{ type: "text", text: "private old question" }] },
        { type: "message", id: "old_answer", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "private old answer" }] }
      ]
    }] });
    tailer?.setLatestTurnBackfillEvents(thread.id, [{
      type: "sessionUserMessage", threadId: thread.id, turnId: "old_turn", itemId: "old_user",
      timestampMs: (now - 60) * 1000, text: "private old question"
    }, {
      type: "shellApprovalRequested", threadId: thread.id, turnId: "old_turn", callId: "old_approval",
      timestampMs: (now - 59) * 1000, command: "old command", cwd: "C:\\repo"
    }]);
    try {
      await bridge.start();
      assert.equal(discord.sentTextMessages.length, 0);
      assert.equal(discord.liveTextMessages.length, 0);
      if (!tailer) assert.ok(store.getThreadBridge(thread.id)?.latestMirroredCursor);
      // A fresh request after startup remains visible through the normal notification path.
      codex.threadDetails.get(thread.id).turns.push({
        id: "new_turn", createdAt: now + 1, status: "inProgress", items: [{
          type: "userMessage", id: "new_user", content: [{ type: "text", text: "new live question" }]
        }]
      });
      tailer?.setEvents(thread.id, [{
        type: "sessionUserMessage", threadId: thread.id, turnId: "new_turn", itemId: "new_user",
        timestampMs: (now + 1) * 1000, text: "new live question"
      }]);
      const cursorBeforeRefresh = store.getThreadBridge(thread.id)?.latestMirroredCursor;
      await bridge.maybeAttachThread({ summary: { ...thread, updatedAt: now + 2 }, source: "app-server" }, false);
      assert.equal(store.getThreadBridge(thread.id)?.latestMirroredCursor, cursorBeforeRefresh);
      codex.emit("notification", { method: "item/completed", params: {
        threadId: thread.id, turnId: "new_turn", item: {
          type: "userMessage", id: "new_user", content: [{ type: "text", text: "new live question" }]
        }
      } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.ok(discord.sentTextMessages.some((entry) => entry.content.includes("new live question")));
      assert.ok(![...discord.sentTextMessages, ...discord.liveTextMessages].some((entry) => entry.content.includes("private old")));
    } finally { await bridge.stop(); }
  });
}

test("zero-history discovery refresh does not skip a live final or strand the FIFO queue", async () => {
  const tailer = new FakeSessionEventTailer();
  const desktop = new FakeDesktopIpcClient();
  const starts: string[] = [];
  (desktop as any).startTurn = async (_threadId: string, params: Record<string, unknown>) => {
    starts.push((params.input as Array<{ text: string }>)[0]!.text);
    return { result: { turn: { id: `queued_turn_${starts.length}`, status: "inProgress" } } };
  };
  const { codex, discord, bridge, store } = createBridgeTestRig({
    sessionEventTailer: tailer, desktopIpcClient: desktop,
    runtimeConfig: createBridgeConfigFromPreset("recommended", { allowedUserIds: ["user_1"] }, {
      startupBackfill: { maxCodexMessages: 0 }, retention: { maxTurnsPerThread: 0 }
    })
  });
  const now = Math.floor(Date.now() / 1000);
  const thread = { id: "live_refresh", name: "Live refresh", preview: "Live refresh", modelProvider: null,
    createdAt: now - 60, updatedAt: now, ephemeral: false, status: { type: "active" as const, activeFlags: [] } };
  codex.threads = [thread];
  codex.metadata.set(thread.id, { cwd: "C:\\repo", repoName: "repo" });
  codex.threadDetails.set(thread.id, { ...thread, turns: [] });
  try {
    await bridge.start();
    await bridge.handleSessionEvent({ type: "sessionUserMessage", threadId: thread.id, turnId: "live_turn",
      timestampMs: (now + 1) * 1000, text: "Current live question", sourceOrder: "00000001", eventKey: "live_user" });
    const channel = store.getThreadBridge(thread.id)!.discordChannelId;
    const actor = { userId: "user_1", username: "controller", roleIds: [] };
    await discord.handlers!.onSendCommand(actor, channel, "First follow-up", "queue");
    await discord.handlers!.onSendCommand(actor, channel, "Second follow-up", "queue");
    assert.deepEqual(starts, []);
    const fastForwards = tailer.fastForwardedThreadIds.length;
    tailer.setEvents(thread.id, [{ type: "sessionAgentMessage", threadId: thread.id, turnId: "live_turn",
      timestampMs: (now + 2) * 1000, text: "Live final response", phase: "final_answer",
      sourceOrder: "00000002", eventKey: "live_final" }]);
    // A normal discovery refresh can race a final waiting to be polled.
    await bridge.maybeAttachThread({ summary: { ...thread, updatedAt: now + 3 }, source: "app-server" }, false);
    assert.equal(tailer.fastForwardedThreadIds.length, fastForwards);
    await bridge.pollLocalSessionEvents();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert([...discord.sentTextMessages, ...discord.liveTextMessages]
      .some(message => message.content.includes("Live final response")));
    assert.deepEqual(starts, ["First follow-up"]);
    assert.deepEqual(store.listWriteBackQueueItems(thread.id).map(row => row.status), ["sent", "pending"]);
    await bridge.handleSessionEvent({ type: "sessionAgentMessage", threadId: thread.id, turnId: "queued_turn_1",
      timestampMs: (now + 4) * 1000, text: "First follow-up response", phase: "final_answer",
      sourceOrder: "00000003", eventKey: "queued_final_1" });
    assert.deepEqual(starts, ["First follow-up", "Second follow-up"]);
    await bridge.handleSessionEvent({ type: "sessionAgentMessage", threadId: thread.id, turnId: "queued_turn_2",
      timestampMs: (now + 5) * 1000, text: "Second follow-up response", phase: "final_answer",
      sourceOrder: "00000004", eventKey: "queued_final_2" });
    assert.deepEqual(store.listWriteBackQueueItems(thread.id).map(row => row.status), ["sent", "sent"]);
    assert.equal(starts.length, 2);
    assert.deepEqual(codex.resumedThreadIds, [], "the Desktop writer must not be resumed in the observer app-server");
  } finally { await bridge.stop(); }
});

test("zero startup history remains blocked if the app-server frontier cannot be read", async () => {
  const { codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset("recommended", { allowedUserIds: ["user_1"] }, {
      startupBackfill: { maxCodexMessages: 0 },
      retention: { maxTurnsPerThread: 0 }
    })
  });
  const now = Math.floor(Date.now() / 1000);
  const thread = {
    id: "failed_frontier", name: "Failed frontier", preview: "Failed frontier", modelProvider: null,
    createdAt: now, updatedAt: now, ephemeral: false, status: { type: "idle" as const }
  };
  codex.threads = [thread];
  codex.metadata.set(thread.id, { cwd: "C:\\repo", repoName: "repo" });
  codex.readThreadErrors.set(thread.id, new Error("Temporarily unreadable"));
  try {
    await bridge.start();
    codex.readThreadErrors.delete(thread.id);
    codex.threadDetails.set(thread.id, { ...thread, turns: [{
      id: "old_turn", createdAt: now - 60, status: "completed", items: [{
        type: "message", id: "old_answer", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: "private old answer" }]
      }]
    }] });
    codex.emit("notification", { method: "item/completed", params: { threadId: thread.id, turnId: "old_turn", item: {
      type: "message", id: "old_answer", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "private old answer" }]
    } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(discord.sentTextMessages.length, 0);
    assert.equal(discord.liveTextMessages.length, 0);
  } finally { await bridge.stop(); }
});
