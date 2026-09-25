import test from "node:test";
import assert from "node:assert/strict";
import { CodexDesktopIpcClient } from "../src/codex/CodexDesktopIpcClient.js";
import { createLogger } from "../src/logger.js";

function createClientHarness() {
  const client = new CodexDesktopIpcClient(createLogger("silent"), "\\\\.\\pipe\\codex-mobile-test");
  (client as unknown as { socket: { destroyed: boolean } }).socket = { destroyed: false };
  (client as unknown as { clientId: string }).clientId = "bridge-client";
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    overrides: { timeoutMs?: number; targetClientId?: string };
  }> = [];

  return { client, calls };
}

test("CodexDesktopIpcClient steerTurn uses the cached owner client id when one is present", async () => {
  const { client, calls } = createClientHarness();
  (
    client as unknown as {
      ownerClientIdsByThread: Map<string, string>;
      sendThreadFollowerRequest: (
        method: string,
        params: Record<string, unknown>,
        overrides: { timeoutMs?: number; targetClientId?: string }
      ) => Promise<unknown>;
    }
  ).ownerClientIdsByThread.set("thread_self_target", "bridge-client");

  (
    client as unknown as {
      sendThreadFollowerRequest: (
        method: string,
        params: Record<string, unknown>,
        overrides: { timeoutMs?: number; targetClientId?: string }
      ) => Promise<unknown>;
    }
  ).sendThreadFollowerRequest = async (method, params, overrides) => {
    calls.push({ method, params, overrides });
    return { ok: true };
  };

  await client.steerTurn("thread_self_target", "turn_1", [{ type: "text", text: "Keep going." }]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "thread-follower-steer-turn");
  assert.deepEqual(calls[0]?.overrides, { timeoutMs: 30_000, targetClientId: "bridge-client" });
});

test("CodexDesktopIpcClient steerTurn sends a single targeted request when a non-bridge owner is cached", async () => {
  const { client, calls } = createClientHarness();
  const internalClient = client as unknown as {
    ownerClientIdsByThread: Map<string, string>;
    sendThreadFollowerRequest: (
      method: string,
      params: Record<string, unknown>,
      overrides: { timeoutMs?: number; targetClientId?: string }
    ) => Promise<unknown>;
  };
  internalClient.ownerClientIdsByThread.set("thread_retry_target", "desktop-client");

  internalClient.sendThreadFollowerRequest = async (method, params, overrides) => {
    calls.push({ method, params, overrides });
    return { ok: true };
  };

  await client.steerTurn("thread_retry_target", "turn_2", [{ type: "text", text: "Retry without the stale target." }]);

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls.map((call) => call.overrides.targetClientId ?? null),
    ["desktop-client"]
  );
  assert.deepEqual(
    calls.map((call) => call.overrides.timeoutMs ?? null),
    [30_000]
  );
  assert.equal(internalClient.ownerClientIdsByThread.has("thread_retry_target"), true);
});

test("CodexDesktopIpcClient startTurn targets the freshly discovered owner client id", async () => {
  const { client, calls } = createClientHarness();
  const internalClient = client as unknown as {
    ownerClientIdsByThread: Map<string, string>;
    sendThreadFollowerRequest: (
      method: string,
      params: Record<string, unknown>,
      overrides: { timeoutMs?: number; targetClientId?: string }
    ) => Promise<unknown>;
  };
  internalClient.ownerClientIdsByThread.set("thread_start_target", "stale-desktop-client");
  client.discoverThreadOwner = async (threadId) => {
    assert.equal(threadId, "thread_start_target");
    return "desktop-client";
  };

  internalClient.sendThreadFollowerRequest = async (method, params, overrides) => {
    calls.push({ method, params, overrides });
    return { ok: true };
  };

  await client.startTurn("thread_start_target", {
    input: [{ type: "text", text: "Start from Discord." }],
    attachments: []
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "thread-follower-start-turn");
  assert.deepEqual(calls[0]?.params, {
    conversationId: "thread_start_target",
    turnStart: {
      request: {
        threadId: "thread_start_target",
        input: [{ type: "text", text: "Start from Discord." }]
      },
      context: { attachments: [] }
    }
  });
  assert.deepEqual(calls[0]?.overrides, { timeoutMs: 30_000, targetClientId: "desktop-client" });
});

test("CodexDesktopIpcClient startTurn uses the Desktop v2 wire envelope without changing steer v1", async () => {
  const { client } = createClientHarness();
  const frames: Array<Record<string, unknown>> = [];
  const internalClient = client as unknown as {
    writeFrame: (frame: Record<string, unknown>) => void;
    handleFrame: (frame: Record<string, unknown>) => void;
  };
  internalClient.writeFrame = (frame) => {
    frames.push(frame);
    internalClient.handleFrame({
      type: "response", requestId: frame.requestId, resultType: "success",
      handledByClientId: "current-desktop-client", result: { ok: true }
    });
  };

  await client.startTurn("thread_v2", { input: [{ type: "text", text: "New instruction." }] });
  await client.steerTurn("thread_v2", "turn_active", [{ type: "text", text: "Clarification." }]);

  assert.equal(frames.length, 3);
  assert.equal(frames[0]?.method, "thread-owner-discovery");
  assert.equal(frames[0]?.version, 1);
  assert.deepEqual(frames[0]?.params, { hostId: "local", conversationId: "thread_v2" });
  assert.equal(frames[0]?.targetClientId, undefined);
  assert.equal(frames[1]?.version, 2);
  assert.equal(frames[1]?.targetClientId, "current-desktop-client");
  assert.deepEqual(frames[1]?.params, {
    conversationId: "thread_v2",
    turnStart: {
      request: { threadId: "thread_v2", input: [{ type: "text", text: "New instruction." }] },
      context: { attachments: [] }
    }
  });
  assert.equal(frames[2]?.version, 1);
  assert.equal(frames[2]?.method, "thread-follower-steer-turn");
});

test("CodexDesktopIpcClient does not retry a rejected v2 start with a legacy or app-server route", async () => {
  const { client } = createClientHarness();
  const frames: Array<Record<string, unknown>> = [];
  const internalClient = client as unknown as {
    writeFrame: (frame: Record<string, unknown>) => void;
    handleFrame: (frame: Record<string, unknown>) => void;
  };
  internalClient.writeFrame = (frame) => {
    frames.push(frame);
    if (frame.method === "thread-owner-discovery") {
      internalClient.handleFrame({
        type: "response", requestId: frame.requestId, resultType: "success",
        handledByClientId: "desktop-client", result: { supportsUntrustedAppInput: true }
      });
      return;
    }
    internalClient.handleFrame({
      type: "response", requestId: frame.requestId, resultType: "error", error: "no-client-found"
    });
  };

  await assert.rejects(client.startTurn("thread_v2", { input: [] }), /unavailable: desktop/);
  assert.equal(frames.length, 2);
  assert.equal(frames[1]?.version, 2);
});

test("CodexDesktopIpcClient refreshes a stale owner on each start without retrying input", async () => {
  const { client } = createClientHarness();
  const frames: Array<Record<string, unknown>> = [];
  const internal = client as unknown as {
    ownerClientIdsByThread: Map<string, string>;
    writeFrame: (frame: Record<string, unknown>) => void;
    handleFrame: (frame: Record<string, unknown>) => void;
  };
  internal.ownerClientIdsByThread.set("thread_reload", "old-renderer");
  let discoveries = 0;
  internal.writeFrame = frame => {
    frames.push(frame);
    if (frame.method === "thread-owner-discovery") discoveries++;
    internal.handleFrame({ type: "response", requestId: frame.requestId, resultType: "success",
      handledByClientId: `renderer-${discoveries}`, result: { ok: true } });
  };
  await client.startTurn("thread_reload", { input: [] });
  await client.startTurn("thread_reload", { input: [] });
  const starts = frames.filter(frame => frame.method === "thread-follower-start-turn");
  assert.equal(discoveries, 2);
  assert.deepEqual(starts.map(frame => frame.targetClientId), ["renderer-1", "renderer-2"]);
  assert.equal(client.getOwnerClientId("thread_reload"), "renderer-2");
});

for (const response of [
  { resultType: "error", error: "no-client-found" },
  { resultType: "success", result: { supportsUntrustedAppInput: true } }
]) {
  test(`CodexDesktopIpcClient fails closed when owner discovery ${response.resultType === "error" ? "fails" : "omits the owner"}`, async () => {
    const { client } = createClientHarness();
    const frames: Array<Record<string, unknown>> = [];
    const internal = client as unknown as {
      ownerClientIdsByThread: Map<string, string>;
      writeFrame: (frame: Record<string, unknown>) => void;
      handleFrame: (frame: Record<string, unknown>) => void;
    };
    internal.ownerClientIdsByThread.set("thread_unavailable", "stale-renderer");
    internal.writeFrame = frame => {
      frames.push(frame);
      internal.handleFrame({ type: "response", requestId: frame.requestId, ...response });
    };
    await assert.rejects(client.startTurn("thread_unavailable", { input: [] }), /unavailable: desktop/);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.method, "thread-owner-discovery");
    assert.equal(client.getOwnerClientId("thread_unavailable"), null);
  });
}

test("CodexDesktopIpcClient steerTurn surfaces Desktop IPC timeouts even if a confirmation callback is provided", async () => {
  const { client, calls } = createClientHarness();
  const internalClient = client as unknown as {
    ownerClientIdsByThread: Map<string, string>;
    sendThreadFollowerRequest: (
      method: string,
      params: Record<string, unknown>,
      overrides: { timeoutMs?: number; targetClientId?: string }
    ) => Promise<unknown>;
  };
  internalClient.ownerClientIdsByThread.set("thread_confirm_timeout", "desktop-client");

  internalClient.sendThreadFollowerRequest = async (method, params, overrides) => {
    calls.push({ method, params, overrides });
    throw new Error("Timed out waiting for Codex Desktop IPC response to thread-follower-steer-turn.");
  };

  await assert.rejects(
    client.steerTurn(
      "thread_confirm_timeout",
      "turn_3",
      [{ type: "text", text: "Wait for the late steer to become visible." }],
      {
        confirmDelivery: async () => true
      }
    ),
    /Timed out waiting for Codex Desktop IPC response/
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls.map((call) => call.overrides.targetClientId ?? null),
    ["desktop-client"]
  );
  assert.equal(internalClient.ownerClientIdsByThread.has("thread_confirm_timeout"), true);
});
