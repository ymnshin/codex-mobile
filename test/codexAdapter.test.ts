import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/codex/CodexAdapter.js";

class FakeStream extends EventEmitter {}

class FakeChildProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = {
    write: (_chunk: string) => true
  };
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function createLogger() {
  const warnings: Array<{ payload: unknown; message: string | undefined }> = [];
  return {
    warnings,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (payloadOrMessage: unknown, maybeMessage?: string) => {
        if (typeof payloadOrMessage === "string" && maybeMessage === undefined) {
          warnings.push({ payload: null, message: payloadOrMessage });
          return;
        }
        warnings.push({ payload: payloadOrMessage, message: maybeMessage });
      },
      error: () => undefined
    }
  };
}

test("CodexAdapter ignores websocket child exit when the transport stays connected", async () => {
  const child = new FakeChildProcess();
  const { logger, warnings } = createLogger();
  const adapter = new CodexAdapter("codex", logger as never, process.cwd(), "ws://127.0.0.1:8837");
  const exitedCodes: Array<number | null> = [];

  adapter.on("exited", (code) => {
    exitedCodes.push(code);
  });

  (adapter as any).spawnCodexProcess = () => child;
  (adapter as any).connectWebSocket = async () => {
    (adapter as any).websocket = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    };
  };
  (adapter as any).initialize = async () => undefined;
  (adapter as any).request = async (method: string) => {
    if (method === "account/read") {
      return { account: "ok" };
    }
    throw new Error(`Unexpected request: ${method}`);
  };

  await adapter.start();
  child.emit("exit", 1);

  assert.deepEqual(exitedCodes, []);
  assert.equal((adapter as any).childProcess, null);
  assert.match(
    warnings.map((entry) => entry.message ?? "").join("\n"),
    /websocket transport is still connected/i
  );

  await adapter.stop();
});

test("CodexAdapter metadata exposes guardian subagent source from session JSONL", async () => {
  const codexHome = mkdtempSync(path.join(tmpdir(), "codex-mobile-codex-adapter-"));
  const sessionsDir = path.join(codexHome, "sessions", "2026", "04", "25");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019dc305-f4d0-7dc3-a156-c1449a48a91e";
  writeFileSync(
    path.join(sessionsDir, `rollout-2026-04-25T07-04-00-${threadId}.jsonl`),
    `${JSON.stringify({
      timestamp: "2026-04-25T05:04:00.000Z",
      type: "session_meta",
      payload: {
        id: threadId,
        cwd: "C:\\Users\\Natale\\Desktop\\projects\\codex-mobile",
        originator: "Codex Desktop",
        source: {
          subagent: {
            other: "guardian"
          }
        }
      }
    })}\n`,
    "utf8"
  );

  const { logger } = createLogger();
  const adapter = new CodexAdapter("codex", logger as never, codexHome);
  const metadata = await adapter.resolveMetadata(threadId);

  assert.equal(metadata.sourceSubagentOther, "guardian");
});
