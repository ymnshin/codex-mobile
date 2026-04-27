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

test("CodexDesktopIpcClient startTurn targets the cached owner client id", async () => {
  const { client, calls } = createClientHarness();
  const internalClient = client as unknown as {
    ownerClientIdsByThread: Map<string, string>;
    sendThreadFollowerRequest: (
      method: string,
      params: Record<string, unknown>,
      overrides: { timeoutMs?: number; targetClientId?: string }
    ) => Promise<unknown>;
  };
  internalClient.ownerClientIdsByThread.set("thread_start_target", "desktop-client");

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
    turnStartParams: {
      input: [{ type: "text", text: "Start from Discord." }],
      attachments: []
    }
  });
  assert.deepEqual(calls[0]?.overrides, { timeoutMs: 30_000, targetClientId: "desktop-client" });
});

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
