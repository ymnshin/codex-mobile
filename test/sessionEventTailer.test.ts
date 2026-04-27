import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CodexSessionEventTailer } from "../src/codex/CodexSessionEventTailer.js";
import { StateStore } from "../src/store/StateStore.js";

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    }
  };
}

function buildJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

test("recent turn backfill locates the earliest required user turn without widening scans", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "15");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-aaaa-7bbb-8ccc-1234567890ab";
  const turnOneId = "019d9999-turn-one";
  const turnTwoId = "019d9999-turn-two";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);
  const filler = "x".repeat(9 * 1024 * 1024);

  let content = "";
  const append = (line: string): number => {
    const offset = Buffer.byteLength(content, "utf8");
    content += line;
    return offset;
  };

  const turnOneOffset = append(
    buildJsonLine({
      timestamp: "2026-04-15T09:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: turnOneId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "older prompt" }]
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "older answer" }]
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:00:03.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [],
        content: null,
        encrypted_content: filler
      }
    })
  );

  const turnTwoOffset = append(
    buildJsonLine({
      timestamp: "2026-04-15T09:10:00.000Z",
      type: "turn_context",
      payload: { turn_id: turnTwoId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:10:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "newer prompt" }]
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:10:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "newer answer" }]
      }
    })
  );

  writeFileSync(filePath, content, "utf8");

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});

  const locatedOffset = await (tailer as any).locateRecentTurnBackfillStartOffset(
    filePath,
    Buffer.byteLength(content, "utf8"),
    2
  );
  assert.equal(locatedOffset, turnOneOffset);
  assert.ok(turnTwoOffset > turnOneOffset);

  const events = await tailer.readRecentTurnBackfillEvents(threadId, 2);
  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      turnId: event.turnId,
      text: "text" in event ? event.text : null
    })),
    [
      { type: "sessionUserMessage", turnId: turnOneId, text: "older prompt" },
      { type: "sessionAgentMessage", turnId: turnOneId, text: "older answer" },
      { type: "sessionUserMessage", turnId: turnTwoId, text: "newer prompt" },
      { type: "sessionAgentMessage", turnId: turnTwoId, text: "newer answer" }
    ]
  );
});

test("recent turn backfill does not count subagent notifications as parent user turns", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "15");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-subagent-notification-parent";
  const oldestTurnId = "019d9999-subagent-oldest";
  const middleTurnId = "019d9999-subagent-middle";
  const latestTurnId = "019d9999-subagent-latest";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);
  const subagentNotification =
    '<subagent_notification>{"agent_path":"child-thread","status":{"completed":"Worker finished."}}</subagent_notification>';

  let content = "";
  const append = (line: string): number => {
    const offset = Buffer.byteLength(content, "utf8");
    content += line;
    return offset;
  };

  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: oldestTurnId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "oldest real prompt" }]
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "oldest answer" }]
      }
    })
  );

  const middleOffset = append(
    buildJsonLine({
      timestamp: "2026-04-15T09:10:00.000Z",
      type: "turn_context",
      payload: { turn_id: middleTurnId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:10:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "middle real prompt" }]
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:10:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "middle answer" }]
      }
    })
  );

  const latestOffset = append(
    buildJsonLine({
      timestamp: "2026-04-15T09:20:00.000Z",
      type: "turn_context",
      payload: { turn_id: latestTurnId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:20:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "latest real prompt" }]
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:20:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "latest answer" }]
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:20:03.000Z",
      type: "turn_context",
      payload: { turn_id: latestTurnId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:20:04.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        text: subagentNotification
      }
    })
  );

  writeFileSync(filePath, content, "utf8");

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});

  const locatedOffset = await (tailer as any).locateRecentTurnBackfillStartOffset(
    filePath,
    Buffer.byteLength(content, "utf8"),
    2
  );
  assert.equal(locatedOffset, middleOffset);
  assert.ok(latestOffset > middleOffset);

  const events = await tailer.readRecentTurnBackfillEvents(threadId, 2);
  assert.deepEqual(
    events
      .filter((event) => event.type === "sessionUserMessage")
      .map((event) => ({
        turnId: event.turnId,
        text: event.text
      })),
    [
      { turnId: middleTurnId, text: "middle real prompt" },
      { turnId: latestTurnId, text: "latest real prompt" },
      { turnId: latestTurnId, text: subagentNotification }
    ]
  );
});

test("recent turn backfill classification is resilient to reordered JSON fields", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "15");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-reordered-json-thread";
  const turnId = "019d9999-reordered-json-turn";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);

  let content = "";
  const append = (line: string): number => {
    const offset = Buffer.byteLength(content, "utf8");
    content += line;
    return offset;
  };

  const turnOffset = append(
    `{"payload":{"turnId":"${turnId}"},"timestamp":"2026-04-15T10:00:00.000Z","type":"turn_context"}\n`
  );
  append(
    `{"payload":{"role":"user","content":[{"text":"reordered prompt","type":"input_text"}],"type":"message"},"type":"response_item","timestamp":"2026-04-15T10:00:01.000Z"}\n`
  );
  append(
    `{"timestamp":"2026-04-15T10:00:02.000Z","payload":{"content":[{"text":"reordered answer","type":"output_text"}],"type":"message","role":"assistant"},"type":"response_item"}\n`
  );

  writeFileSync(filePath, content, "utf8");

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});

  const locatedOffset = await (tailer as any).locateRecentTurnBackfillStartOffset(
    filePath,
    Buffer.byteLength(content, "utf8"),
    1
  );
  assert.equal(locatedOffset, turnOffset);

  const events = await tailer.readRecentTurnBackfillEvents(threadId, 1);
  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      turnId: event.turnId,
      text: "text" in event ? event.text : null
    })),
    [
      { type: "sessionUserMessage", turnId, text: "reordered prompt" },
      { type: "sessionAgentMessage", turnId, text: "reordered answer" }
    ]
  );
});

test("recent turn backfill falls back to recent non-user turns after a bounded deep scan", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "15");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-agent-only-tail-thread";
  const oldUserTurnOneId = "019d9999-old-user-turn-one";
  const oldUserTurnTwoId = "019d9999-old-user-turn-two";
  const recentAgentTurnOneId = "019d9999-recent-agent-turn-one";
  const recentAgentTurnTwoId = "019d9999-recent-agent-turn-two";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);
  const filler = "y".repeat(36 * 1024 * 1024);

  let content = "";
  const append = (line: string): number => {
    const offset = Buffer.byteLength(content, "utf8");
    content += line;
    return offset;
  };

  append(
    buildJsonLine({
      timestamp: "2026-04-15T07:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: oldUserTurnOneId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T07:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "older prompt one" }]
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T07:10:00.000Z",
      type: "turn_context",
      payload: { turn_id: oldUserTurnTwoId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T07:10:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "older prompt two" }]
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T07:10:02.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [],
        content: null,
        encrypted_content: filler
      }
    })
  );

  const recentAgentTurnOneOffset = append(
    buildJsonLine({
      timestamp: "2026-04-15T09:20:00.000Z",
      type: "turn_context",
      payload: { turn_id: recentAgentTurnOneId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:20:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "recent agent answer one" }]
      }
    })
  );
  const recentAgentTurnTwoOffset = append(
    buildJsonLine({
      timestamp: "2026-04-15T09:30:00.000Z",
      type: "turn_context",
      payload: { turn_id: recentAgentTurnTwoId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-15T09:30:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "recent agent answer two" }]
      }
    })
  );

  writeFileSync(filePath, content, "utf8");

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});

  const locatedOffset = await (tailer as any).locateRecentTurnBackfillStartOffset(
    filePath,
    Buffer.byteLength(content, "utf8"),
    2
  );

  assert.equal(locatedOffset, recentAgentTurnOneOffset);
  assert.ok(recentAgentTurnTwoOffset > recentAgentTurnOneOffset);

  const events = await tailer.readRecentTurnBackfillEvents(threadId, 2);
  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      turnId: event.turnId,
      text: "text" in event ? event.text : null
    })),
    [
      { type: "sessionAgentMessage", turnId: recentAgentTurnOneId, text: "recent agent answer one" },
      { type: "sessionAgentMessage", turnId: recentAgentTurnTwoId, text: "recent agent answer two" }
    ]
  );
});

test("recent turn backfill keeps pending shell approvals from function-call logs", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "16");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-shell-approval-thread";
  const turnId = "019d9999-shell-approval-turn";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);

  writeFileSync(
    filePath,
    [
      buildJsonLine({
        timestamp: "2026-04-16T09:00:00.000Z",
        type: "turn_context",
        payload: { turn_id: turnId }
      }),
      buildJsonLine({
        timestamp: "2026-04-16T09:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please open example.com." }]
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-16T09:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call_shell_approval",
          arguments: JSON.stringify({
            command: "Start-Process https://example.com",
            workdir: "C:\\repo",
            justification: "Open example.com for approval testing.",
            sandbox_permissions: "require_escalated"
          })
        }
      })
    ].join(""),
    "utf8"
  );

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const events = await tailer.readRecentTurnBackfillEvents(threadId, 1);

  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      turnId: event.turnId,
      callId: "callId" in event ? event.callId : null,
      command: "command" in event ? event.command : null
    })),
    [
      {
        type: "sessionUserMessage",
        turnId,
        callId: null,
        command: null
      },
      {
        type: "shellApprovalRequested",
        turnId,
        callId: "call_shell_approval",
        command: "Start-Process https://example.com"
      }
    ]
  );
});

test("recent turn backfill drops shell-like function-call outputs when tool-call context is missing", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "16");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-missing-shell-context-thread";
  const turnId = "019d9999-missing-shell-context-turn";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);

  writeFileSync(
    filePath,
    [
      buildJsonLine({
        timestamp: "2026-04-16T09:20:00.000Z",
        type: "turn_context",
        payload: { turn_id: turnId }
      }),
      buildJsonLine({
        timestamp: "2026-04-16T09:20:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Check the output." }]
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-16T09:20:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_missing_context",
          output: "Exit code: 0\nWall time: 1.23s\nThis text came from some other tool."
        }
      })
    ].join(""),
    "utf8"
  );

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const events = await tailer.readRecentTurnBackfillEvents(threadId, 1);

  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      turnId: event.turnId,
      text: "text" in event ? event.text : null
    })),
    [{ type: "sessionUserMessage", turnId, text: "Check the output." }]
  );
});

test("readBackfillEventsSince keeps live turn binding available while backfill parsing is in progress", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "20");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-live-backfill-thread";
  const liveTurnId = "019d9999-live-turn";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);

  writeFileSync(
    filePath,
    buildJsonLine({
      timestamp: "2026-04-20T05:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: liveTurnId }
    }),
    "utf8"
  );

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  (tailer as any).sessionLogLocator.remember(threadId, filePath);
  (tailer as any).currentTurnIdByThread.set(threadId, liveTurnId);

  let parsedDuringBackfill: Array<Record<string, unknown>> = [];
  (tailer as any).readBackfillEventsFromOffset = async () => {
    parsedDuringBackfill = (tailer as any).parseLine(
      threadId,
      buildJsonLine({
        timestamp: "2026-04-20T05:00:01.000Z",
        type: "response_item",
        payload: {
          id: "assistant_during_backfill",
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Commentary emitted while backfill parsing is active." }]
        }
      }),
      filePath,
      100
    );
    return [];
  };

  const events = await tailer.readBackfillEventsSince(threadId, { filePath, offset: 0 });

  assert.deepEqual(events, []);
  assert.equal(parsedDuringBackfill.length, 1);
  assert.equal(parsedDuringBackfill[0]?.type, "sessionAgentMessage");
  assert.equal(parsedDuringBackfill[0]?.turnId, liveTurnId);
  assert.equal((tailer as any).currentTurnIdByThread.get(threadId), liveTurnId);
});

test("readRecentTurnBackfillEvents does not clear live turn binding while startup backfill groups are scanned", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "20");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-live-startup-thread";
  const liveTurnId = "019d9999-live-startup-turn";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);

  writeFileSync(
    filePath,
    buildJsonLine({
      timestamp: "2026-04-20T05:10:00.000Z",
      type: "turn_context",
      payload: { turn_id: liveTurnId }
    }),
    "utf8"
  );

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  (tailer as any).sessionLogLocator.remember(threadId, filePath);
  (tailer as any).currentTurnIdByThread.set(threadId, liveTurnId);
  (tailer as any).locateRecentTurnBackfillStartOffset = async () => 0;

  let parsedDuringScan: Array<Record<string, unknown>> = [];
  (tailer as any).scanRecentTurnBackfillGroups = async () => {
    parsedDuringScan = (tailer as any).parseLine(
      threadId,
      buildJsonLine({
        timestamp: "2026-04-20T05:10:01.000Z",
        type: "response_item",
        payload: {
          id: "assistant_during_startup_scan",
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Commentary emitted while startup backfill scans recent turns." }]
        }
      }),
      filePath,
      120
    );
    return { recentTurns: [], recentUserTurns: [] };
  };

  const events = await tailer.readRecentTurnBackfillEvents(threadId, 1);

  assert.deepEqual(events, []);
  assert.equal(parsedDuringScan.length, 1);
  assert.equal(parsedDuringScan[0]?.type, "sessionAgentMessage");
  assert.equal(parsedDuringScan[0]?.turnId, liveTurnId);
  assert.equal((tailer as any).currentTurnIdByThread.get(threadId), liveTurnId);
});

test("explicit live turn ids on response items refresh parser context for later same-turn events", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const threadId = "019d9999-live-turn-inherit-thread";
  const liveTurnId = "019d9999-live-turn-inherit";
  const filePath = path.join(tempRoot, "rollout.jsonl");

  const userEvents = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-20T05:12:04.000Z",
      type: "response_item",
      payload: {
        id: "resp_live_user",
        turn_id: liveTurnId,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "ok let's test again. no subagents for now" }]
      }
    }),
    filePath,
    0
  ) as Array<Record<string, unknown>>;

  const commentaryEvents = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-20T05:12:20.000Z",
      type: "response_item",
      payload: {
        id: "resp_live_commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "I’m restarting onto the new tailer fix first." }]
      }
    }),
    filePath,
    120
  ) as Array<Record<string, unknown>>;

  const patchEvents = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-20T05:12:55.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "call_live_apply_patch",
        status: "completed",
        input: ["*** Update File: src/file.ts", "@@", "-old", "+new"].join("\n")
      }
    }),
    filePath,
    240
  ) as Array<Record<string, unknown>>;

  assert.equal(userEvents.length, 1);
  assert.equal(userEvents[0]?.turnId, liveTurnId);

  assert.equal(commentaryEvents.length, 1);
  assert.equal(commentaryEvents[0]?.type, "sessionAgentMessage");
  assert.equal(commentaryEvents[0]?.turnId, liveTurnId);

  assert.equal(patchEvents.length, 1);
  assert.equal(patchEvents[0]?.type, "sessionApplyPatchCompleted");
  assert.equal(patchEvents[0]?.turnId, liveTurnId);
  assert.equal((tailer as any).currentTurnIdByThread.get(threadId), liveTurnId);
});

test("advisory turn hints let the first turnless live assistant and command events inherit the active turn after restart", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const threadId = "019da988-restart-hint-thread";
  const liveTurnId = "019da988-dee6-7ee2-8992-5eae36e1bda7";
  const filePath = path.join(tempRoot, "rollout.jsonl");

  tailer.rememberTurnHint(threadId, liveTurnId);

  const commentaryEvents = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-20T07:03:39.948Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "First live commentary after restart." }],
        phase: "commentary"
      }
    }),
    filePath,
    0
  ) as Array<Record<string, unknown>>;

  const commandEvents = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-20T07:03:43.614Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        arguments: "{\"command\":\"Get-Date -Format o\",\"sandbox_permissions\":\"require_escalated\"}",
        call_id: "call_live_after_restart"
      }
    }),
    filePath,
    200
  ) as Array<Record<string, unknown>>;

  assert.equal(commentaryEvents.length, 1);
  assert.equal(commentaryEvents[0]?.type, "sessionAgentMessage");
  assert.equal(commentaryEvents[0]?.turnId, liveTurnId);
  assert.equal(commandEvents.length, 1);
  assert.equal(commandEvents[0]?.type, "shellApprovalRequested");
  assert.equal(commandEvents[0]?.turnId, liveTurnId);
  assert.equal((tailer as any).currentTurnIdByThread.get(threadId), liveTurnId);
});

test("fastForwardThread restores the mirrored turn context for the first post-startup commentary and command", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "20");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-fast-forward-thread";
  const liveTurnId = "019d9999-fast-forward-turn";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);

  writeFileSync(
    filePath,
    buildJsonLine({
      timestamp: "2026-04-20T05:20:00.000Z",
      type: "response_item",
      payload: {
        id: "startup_anchor",
        type: "message",
        role: "user",
        turn_id: liveTurnId,
        content: [{ type: "input_text", text: "Startup anchor." }]
      }
    }),
    "utf8"
  );

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  store.upsertThreadBridge({
    codexThreadId: threadId,
    parentCodexThreadId: null,
    projectKey: "codex-mobile",
    projectName: "codex-mobile",
    parentAnchorTurnId: null,
    parentAnchorTurnCursor: null,
    discordChannelId: "discord-channel",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: null,
    repoName: null,
    lastSeenAt: new Date("2026-04-20T05:20:00.000Z").toISOString(),
    attachMode: "auto",
    threadName: "Fast forward test",
    lastStatusType: null,
    channelKind: "conversation",
    sourceKind: "app-server",
    latestMirroredTimestampMs: Date.parse("2026-04-20T05:20:00.000Z"),
    latestMirroredCursor: "cursor:019d9999-fast-forward-turn",
    latestMirroredTurnCursor: `turn:${liveTurnId}`,
    latestMirroredSourceFilePath: filePath,
    latestMirroredSourceOffset: 0,
    latestMirroredSourceEventKey: null
  });

  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  (tailer as any).sessionLogLocator.remember(threadId, filePath);

  assert.equal(await tailer.fastForwardThread(threadId), true);

  appendFileSync(
    filePath,
    [
      buildJsonLine({
        timestamp: "2026-04-20T05:20:01.000Z",
        type: "response_item",
        payload: {
          id: "assistant_after_fast_forward",
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "First commentary after startup fast-forward." }]
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-20T05:20:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call_fast_forward_command",
          arguments: JSON.stringify({
            command: "Get-Date -Format o",
            workdir: "C:\\Users\\Natale\\Desktop\\projects\\codex-mobile"
          })
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-20T05:20:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_fast_forward_command",
          output: "Exit code: 0\nWall time: 0.3 seconds\nOutput:\n2026-04-20T05:20:02.999Z\n"
        }
      })
    ].join(""),
    "utf8"
  );

  const events = await tailer.pollThread(threadId);

  const commentaryEvents = events.filter((event) => event.type === "sessionAgentMessage");
  const commandEvents = events.filter((event) => event.type === "shellCommandCompleted");

  assert.equal(commentaryEvents.length, 1);
  assert.equal(commentaryEvents[0]?.turnId, liveTurnId);
  assert.equal(commandEvents.length, 1);
  assert.equal(commandEvents[0]?.turnId, liveTurnId);
});

test("replayThreadFromFrontier preserves startup-window same-turn commentary and commands", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "20");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-frontier-replay-thread";
  const liveTurnId = "019d9999-frontier-replay-turn";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);

  writeFileSync(
    filePath,
    buildJsonLine({
      timestamp: "2026-04-20T05:40:00.000Z",
      type: "response_item",
      payload: {
        id: "startup_anchor",
        type: "message",
        role: "user",
        turn_id: liveTurnId,
        content: [{ type: "input_text", text: "Startup anchor." }]
      }
    }),
    "utf8"
  );

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  store.upsertThreadBridge({
    codexThreadId: threadId,
    parentCodexThreadId: null,
    projectKey: "codex-mobile",
    projectName: "codex-mobile",
    parentAnchorTurnId: null,
    parentAnchorTurnCursor: null,
    discordChannelId: "discord-channel",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: null,
    repoName: null,
    lastSeenAt: new Date("2026-04-20T05:40:00.000Z").toISOString(),
    attachMode: "auto",
    threadName: "Frontier replay test",
    lastStatusType: null,
    channelKind: "conversation",
    sourceKind: "app-server",
    latestMirroredTimestampMs: Date.parse("2026-04-20T05:40:00.000Z"),
    latestMirroredCursor: "cursor:019d9999-frontier-replay-turn",
    latestMirroredTurnCursor: `turn:${liveTurnId}`,
    latestMirroredSourceFilePath: filePath,
    latestMirroredSourceOffset: 0,
    latestMirroredSourceEventKey: null
  });

  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  (tailer as any).sessionLogLocator.remember(threadId, filePath);
  const frontier = await tailer.captureThreadFrontier(threadId);
  assert.ok(frontier);

  appendFileSync(
    filePath,
    [
      buildJsonLine({
        timestamp: "2026-04-20T05:40:01.000Z",
        type: "response_item",
        payload: {
          id: "assistant_after_capture",
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Commentary that landed after the captured startup frontier." }]
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-20T05:40:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call_frontier_replay_command",
          arguments: JSON.stringify({
            command: "Get-Date -Format o",
            workdir: "C:\\Users\\Natale\\Desktop\\projects\\codex-mobile"
          })
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-20T05:40:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_frontier_replay_command",
          output: "Exit code: 0\nWall time: 0.3 seconds\nOutput:\n2026-04-20T05:40:02.999Z\n"
        }
      })
    ].join(""),
    "utf8"
  );

  const events = await tailer.replayThreadFromFrontier(threadId, frontier);
  const commentaryEvents = events.filter((event) => event.type === "sessionAgentMessage");
  const commandEvents = events.filter((event) => event.type === "shellCommandCompleted");

  assert.equal(commentaryEvents.length, 1);
  assert.equal(commentaryEvents[0]?.turnId, liveTurnId);
  assert.equal(commandEvents.length, 1);
  assert.equal(commandEvents[0]?.turnId, liveTurnId);
});

test("readRecentTurnBackfillEvents primes live turn and open-call context for the first post-startup live events", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "20");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-startup-prime-thread";
  const turnId = "019d9999-startup-prime-turn";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);

  writeFileSync(
    filePath,
    [
      buildJsonLine({
        timestamp: "2026-04-20T05:30:00.000Z",
        type: "turn_context",
        payload: { turn_id: turnId }
      }),
      buildJsonLine({
        timestamp: "2026-04-20T05:30:01.000Z",
        type: "response_item",
        payload: {
          id: "startup_user_anchor",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "live test again" }]
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-20T05:30:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call_startup_shell",
          arguments: JSON.stringify({
            command: "Get-Date -Format o",
            sandbox_permissions: "require_escalated"
          })
        }
      })
    ].join(""),
    "utf8"
  );

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});

  const backfillEvents = await tailer.readRecentTurnBackfillEvents(threadId, 1);
  assert.equal(backfillEvents.length, 2);
  assert.equal((tailer as any).currentTurnIdByThread.get(threadId), turnId);
  assert.equal((tailer as any).openToolCallsByThread.get(threadId)?.has("call_startup_shell"), true);

  const commentaryEvents = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-20T05:30:03.000Z",
      type: "response_item",
      payload: {
        id: "startup_commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "The fresh scratch file is created." }]
      }
    }),
    filePath,
    240
  ) as Array<Record<string, unknown>>;
  assert.equal(commentaryEvents.length, 1);
  assert.equal(commentaryEvents[0]?.type, "sessionAgentMessage");
  assert.equal(commentaryEvents[0]?.turnId, turnId);

  const commandOutputEvents = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-20T05:30:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_startup_shell",
        output: "2026-04-20T05:30:04.000Z"
      }
    }),
    filePath,
    360
  ) as Array<Record<string, unknown>>;
  assert.equal(commandOutputEvents.length, 1);
  assert.equal(commandOutputEvents[0]?.type, "shellCommandCompleted");
  assert.equal(commandOutputEvents[0]?.turnId, turnId);
});

test("readBackfillEventsSince primes live turn context without overwriting a newer live cursor", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "20");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-frontier-prime-thread";
  const olderTurnId = "019d9999-frontier-older-turn";
  const newerTurnId = "019d9999-frontier-newer-turn";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);

  let content = "";
  const append = (value: unknown): number => {
    const offset = Buffer.byteLength(content, "utf8");
    content += buildJsonLine(value);
    return offset;
  };

  const frontierOffset = append({
    timestamp: "2026-04-20T05:40:00.000Z",
    type: "turn_context",
    payload: { turn_id: olderTurnId }
  });
  append({
    timestamp: "2026-04-20T05:40:01.000Z",
    type: "response_item",
    payload: {
      id: "older_user_anchor",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "older turn" }]
    }
  });
  append({
    timestamp: "2026-04-20T05:40:02.000Z",
    type: "response_item",
    payload: {
      id: "older_commentary",
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "older commentary" }]
    }
  });

  const newerStartOffset = append({
    timestamp: "2026-04-20T05:41:00.000Z",
    type: "turn_context",
    payload: { turn_id: newerTurnId }
  });
  append({
    timestamp: "2026-04-20T05:41:01.000Z",
    type: "response_item",
    payload: {
      id: "newer_user_anchor",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "newer turn" }]
    }
  });

  writeFileSync(filePath, content, "utf8");

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});

  store.upsertSessionLogCursor({
    threadId,
    filePath,
    byteOffset: Buffer.byteLength(content, "utf8"),
    updatedAt: new Date("2026-04-20T05:41:02.000Z").toISOString()
  });

  const seededEvents = await tailer.readBackfillEventsSince(threadId, {
    filePath,
    offset: frontierOffset
  });
  assert.equal(seededEvents.length, 3);
  assert.equal((tailer as any).currentTurnIdByThread.get(threadId), newerTurnId);

  const freshCommentaryEvents = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-20T05:41:03.000Z",
      type: "response_item",
      payload: {
        id: "newer_commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "newer commentary" }]
      }
    }),
    filePath,
    newerStartOffset + 200
  ) as Array<Record<string, unknown>>;
  assert.equal(freshCommentaryEvents.length, 1);
  assert.equal(freshCommentaryEvents[0]?.turnId, newerTurnId);

  (tailer as any).currentTurnIdByThread.delete(threadId);
  store.upsertSessionLogCursor({
    threadId,
    filePath,
    byteOffset: Buffer.byteLength(content, "utf8") + 100,
    updatedAt: new Date("2026-04-20T05:41:05.000Z").toISOString()
  });

  await tailer.readBackfillEventsSince(threadId, {
    filePath,
    offset: frontierOffset
  });
  assert.equal((tailer as any).currentTurnIdByThread.has(threadId), false);
});

test("recent turn backfill reconstructs spawn_agent child threads from function-call logs", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "16");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019d9999-spawn-backfill-thread";
  const turnId = "019d9999-spawn-backfill-turn";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);

  writeFileSync(
    filePath,
    [
      buildJsonLine({
        timestamp: "2026-04-16T09:10:00.000Z",
        type: "turn_context",
        payload: { turn_id: turnId }
      }),
      buildJsonLine({
        timestamp: "2026-04-16T09:10:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Spawn a helper agent." }]
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-16T09:10:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call_spawn_backfill",
          arguments: JSON.stringify({ message: "Inspect scripts" })
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-16T09:10:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_spawn_backfill",
          output: JSON.stringify({ agent_id: "child-thread-backfill", nickname: "Aquinas" })
        }
      })
    ].join(""),
    "utf8"
  );

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const events = await tailer.readRecentTurnBackfillEvents(threadId, 1);

  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      turnId: event.turnId,
      childThreadId: "childThreadId" in event ? event.childThreadId : null,
      childAgentName: "childAgentName" in event ? event.childAgentName : null
    })),
    [
      {
        type: "sessionUserMessage",
        turnId,
        childThreadId: null,
        childAgentName: null
      },
      {
        type: "sessionSubagentSpawned",
        turnId,
        childThreadId: "child-thread-backfill",
        childAgentName: "Aquinas"
      }
    ]
  );
});

test("recent local thread discovery keeps child session metadata when inherited parent session_meta appears later", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "19");
  mkdirSync(sessionsDir, { recursive: true });

  const parentThreadId = "019d9fe9-ee8e-7e62-9d39-114cfb5e11e2";
  const childThreadId = "019da46a-d0dd-7fd2-b3f5-d87cdd08052f";
  const filePath = path.join(sessionsDir, `rollout-2026-04-19T08-25-56-${childThreadId}.jsonl`);

  writeFileSync(
    filePath,
    [
      buildJsonLine({
        timestamp: "2026-04-19T06:26:07.572Z",
        type: "session_meta",
        payload: {
          id: childThreadId,
          timestamp: "2026-04-19T06:25:56.994Z",
          cwd: "C:\\Users\\Natale\\Desktop\\projects\\codex-mobile",
          originator: "Codex Desktop",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: parentThreadId,
                agent_nickname: "Singer"
              }
            }
          }
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-19T06:26:08.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "You are Worker A."
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-19T06:26:09.000Z",
        type: "event_msg",
        payload: {
          type: "task_started"
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-19T06:26:10.000Z",
        type: "session_meta",
        payload: {
          id: parentThreadId,
          timestamp: "2026-04-18T09:26:41.000Z",
          cwd: "C:\\Users\\Natale\\Desktop\\projects\\codex-mobile",
          originator: "Codex Desktop"
        }
      })
    ].join(""),
    "utf8"
  );

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const threads = await tailer.listRecentLocalThreads(10, 12 * 60 * 60 * 1000);

  assert.deepEqual(
    threads.map((thread) => ({
      threadId: thread.threadId,
      parentThreadId: thread.parentThreadId,
      actorName: thread.actorName,
      status: thread.status,
      preview: thread.preview
    })),
    [
      {
        threadId: childThreadId,
        parentThreadId,
        actorName: "Singer",
        status: "active",
        preview: "You are Worker A."
      }
    ]
  );
});

test("recent local thread discovery exposes guardian subagent source metadata", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "25");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019dc305-f4d0-7dc3-a156-c1449a48a91e";
  const filePath = path.join(sessionsDir, `rollout-2026-04-25T07-04-00-${threadId}.jsonl`);

  writeFileSync(
    filePath,
    [
      buildJsonLine({
        timestamp: "2026-04-25T05:04:00.000Z",
        type: "session_meta",
        payload: {
          id: threadId,
          timestamp: "2026-04-25T05:04:00.000Z",
          cwd: "C:\\Users\\Natale\\Desktop\\projects\\codex-mobile",
          originator: "Codex Desktop",
          source: {
            subagent: {
              other: "guardian"
            }
          }
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-25T05:04:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Assess this approval request."
        }
      })
    ].join(""),
    "utf8"
  );

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const threads = await tailer.listRecentLocalThreads(10, 12 * 60 * 60 * 1000);

  assert.deepEqual(
    threads.map((thread) => ({
      threadId: thread.threadId,
      sourceKind: thread.sourceKind,
      sourceSubagentOther: thread.sourceSubagentOther,
      preview: thread.preview
    })),
    [
      {
        threadId,
        sourceKind: "app-server",
        sourceSubagentOther: "guardian",
        preview: "Assess this approval request."
      }
    ]
  );
});

test("recent local thread discovery ignores archived session files", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "20");
  const archivedDir = path.join(tempRoot, "archived_sessions", "2026", "04", "20");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(archivedDir, { recursive: true });

  const activeThreadId = "019dactive-local-thread";
  const archivedThreadId = "019darchived-local-thread";

  writeFileSync(
    path.join(sessionsDir, `rollout-${activeThreadId}.jsonl`),
    [
      buildJsonLine({
        timestamp: "2026-04-20T09:00:00.000Z",
        type: "session_meta",
        payload: {
          id: activeThreadId,
          cwd: "C:\\Users\\Natale\\Desktop\\projects\\active-repo",
          originator: "codex-tui"
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-20T09:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Active thread prompt"
        }
      })
    ].join(""),
    "utf8"
  );
  writeFileSync(
    path.join(archivedDir, `rollout-${archivedThreadId}.jsonl`),
    [
      buildJsonLine({
        timestamp: "2026-04-20T08:00:00.000Z",
        type: "session_meta",
        payload: {
          id: archivedThreadId,
          cwd: "C:\\Users\\Natale\\Desktop\\projects\\archived-repo",
          originator: "codex-tui"
        }
      }),
      buildJsonLine({
        timestamp: "2026-04-20T08:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Archived thread prompt"
        }
      })
    ].join(""),
    "utf8"
  );

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const threads = await tailer.listRecentLocalThreads(10, 12 * 60 * 60 * 1000);

  assert.deepEqual(
    threads.map((thread) => thread.threadId),
    [activeThreadId]
  );
});

test("spawn_agent function-call output keeps the parent turn id on subagent spawn events", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const threadId = "019d9999-parent-thread";
  const filePath = path.join(tempRoot, "rollout.jsonl");

  (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-16T08:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-parent-001" }
    }),
    filePath,
    0
  );
  (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-16T08:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call_spawn_agent",
        arguments: JSON.stringify({ message: "Run checks" })
      }
    }),
    filePath,
    100
  );

  const events = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-16T08:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_spawn_agent",
        output: JSON.stringify({ agent_id: "child-thread-001", nickname: "Darwin" })
      }
    }),
    filePath,
    200
  ) as Array<{
    type: string;
    threadId: string;
    turnId: string | null;
    childThreadId: string;
    childAgentName: string | null;
    prompt: string | null;
    eventKey?: string;
  }>;

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "sessionSubagentSpawned",
    timestampMs: Date.parse("2026-04-16T08:00:02.000Z"),
    eventKey: "subagent-spawn:child-thread-001",
    threadId,
    turnId: "turn-parent-001",
    childThreadId: "child-thread-001",
    childAgentName: "Darwin",
    prompt: "Run checks",
    sourceFilePath: filePath,
    sourceOffset: 200,
    sourceOrder: "0000000000000200:0000"
  });
});

test("collab_agent_spawn_end keeps the parent turn id on subagent spawn events", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const threadId = "019d9999-parent-thread";
  const filePath = path.join(tempRoot, "rollout.jsonl");

  (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-16T08:10:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-parent-002" }
    }),
    filePath,
    0
  );

  const events = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-16T08:10:01.000Z",
      type: "event_msg",
      payload: {
        type: "collab_agent_spawn_end",
        sender_thread_id: threadId,
        new_thread_id: "child-thread-002",
        new_agent_nickname: "Aquinas",
        prompt: "Inspect scripts"
      }
    }),
    filePath,
    120
  ) as Array<{
    type: string;
    threadId: string;
    turnId: string | null;
    childThreadId: string;
    childAgentName: string | null;
    prompt: string | null;
    eventKey?: string;
  }>;

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "sessionSubagentSpawned",
    timestampMs: Date.parse("2026-04-16T08:10:01.000Z"),
    eventKey: "subagent-spawn:child-thread-002",
    threadId,
    turnId: "turn-parent-002",
    childThreadId: "child-thread-002",
    childAgentName: "Aquinas",
    prompt: "Inspect scripts",
    sourceFilePath: filePath,
    sourceOffset: 120,
    sourceOrder: "0000000000000120:0000"
  });
});

test("pollThread caches missing session log lookups briefly to avoid repeated filesystem scans", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  let searchCalls = 0;

  (tailer as any).sessionLogLocator.resolveFromStateDatabase = () => null;
  (tailer as any).sessionLogLocator.searchSessionFile = async () => {
    searchCalls += 1;
    return null;
  };

  await tailer.pollThread("missing-thread");
  await tailer.pollThread("missing-thread");

  assert.equal(searchCalls, 1);
});

test("pollThread does not replay stale tail events for an already mirrored mapped thread", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "18");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019da000-parent-thread";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);
  const content = [
    buildJsonLine({
      timestamp: "2026-04-18T11:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-old-subagent" }
    }),
    buildJsonLine({
      timestamp: "2026-04-18T11:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "collab_agent_spawn_end",
        sender_thread_id: threadId,
        new_thread_id: "child-thread-stale",
        new_agent_nickname: "Halley",
        prompt: "Old stale worker"
      }
    })
  ].join("");
  writeFileSync(filePath, content, "utf8");

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  store.upsertThreadBridge({
    codexThreadId: threadId,
    parentCodexThreadId: null,
    projectKey: "C:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: "2026-04-18T11:05:00.000Z",
    attachMode: "auto",
    threadName: "Parent thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredCursor: "00000001776503200000:00000001:item_latest",
    latestMirroredTurnCursor: "turn:turn-latest"
  });

  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const events = await tailer.pollThread(threadId);

  assert.deepEqual(events, []);
  assert.equal(store.getSessionLogCursor(threadId)?.filePath, filePath);
  assert.equal(store.getSessionLogCursor(threadId)?.byteOffset, Buffer.byteLength(content, "utf8"));
});

test("pollThread resumes from the latest mirrored source frontier for mapped threads without a session cursor", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const sessionsDir = path.join(tempRoot, "sessions", "2026", "04", "20");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019da000-live-resume-thread";
  const turnId = "turn-live-resume";
  const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);

  let content = "";
  const append = (line: string): number => {
    const offset = Buffer.byteLength(content, "utf8");
    content += line;
    return offset;
  };

  append(
    buildJsonLine({
      timestamp: "2026-04-20T06:16:52.714Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-20T06:16:52.729Z",
      type: "turn_context",
      payload: { turn_id: turnId }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-20T06:16:52.729Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "rerun teh live test" }]
      }
    })
  );
  const mirroredUserOffset = append(
    buildJsonLine({
      timestamp: "2026-04-20T06:16:52.730Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "rerun teh live test"
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-20T06:17:08.368Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [
          {
            type: "output_text",
            text: "I’m rerunning the same startup/live parent-thread test on this new user turn."
          }
        ]
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-20T06:17:08.381Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        call_id: "call_resume_live_shell",
        arguments: JSON.stringify({
          command: "Get-Date -Format o",
          workdir: "C:\\repo"
        })
      }
    })
  );
  append(
    buildJsonLine({
      timestamp: "2026-04-20T06:17:09.100Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_resume_live_shell",
        output: "Exit code: 0\nWall time: 0.2 seconds\nOutput:\n2026-04-20T08:17:36.7248657+02:00\n"
      }
    })
  );

  writeFileSync(filePath, content, "utf8");

  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  store.upsertThreadBridge({
    codexThreadId: threadId,
    parentCodexThreadId: null,
    projectKey: "C:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: "2026-04-20T06:16:53.000Z",
    attachMode: "auto",
    threadName: "Parent thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredCursor: "session:0000000359267773:0000:line:359267773:0",
    latestMirroredTurnCursor: `turn:${turnId}`,
    latestMirroredSourceFilePath: filePath,
    latestMirroredSourceOffset: mirroredUserOffset,
    latestMirroredSourceEventKey: `line:${mirroredUserOffset}:0`
  });

  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const events = await tailer.pollThread(threadId);

  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      turnId: "turnId" in event ? (event.turnId ?? null) : null,
      text: "text" in event ? event.text : null,
      command: "command" in event ? event.command ?? null : null
    })),
    [
      {
        type: "sessionAgentMessage",
        turnId,
        text: "I’m rerunning the same startup/live parent-thread test on this new user turn.",
        command: null
      },
      {
        type: "shellCommandCompleted",
        turnId,
        text: null,
        command: "Get-Date -Format o"
      }
    ]
  );
  assert.equal(store.getSessionLogCursor(threadId)?.filePath, filePath);
  assert.equal(store.getSessionLogCursor(threadId)?.byteOffset, Buffer.byteLength(content, "utf8"));
});

test("desktop log parsing captures question prompts and preserves raw resolution payloads", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const filePath = path.join(tempRoot, "desktop.log");

  const questionEvents = (tailer as any).parseDesktopLine(
    "2026-04-19T08:15:00.000Z INFO [electron-message-handler] [desktop-notifications] show question conversationId=thr_q questionCount=2 requestId=req_q_1",
    filePath,
    12
  ) as Array<Record<string, unknown>>;
  assert.deepEqual(questionEvents, [
    {
      type: "nativeQuestionRequested",
      eventKey: "desktop-question-request:req_q_1",
      threadId: "thr_q",
      requestId: "req_q_1",
      questionCount: 2,
      timestampMs: Date.parse("2026-04-19T08:15:00.000Z"),
      sourceFilePath: filePath,
      sourceOffset: 12,
      sourceOrder: "0000000000000012:0000"
    }
  ]);

  const resolutionEvents = (tailer as any).parseDesktopLine(
    "2026-04-19T08:15:01.000Z INFO [electron-message-handler] Sending server response id=req_q_1 method=question.respond response=not-json",
    filePath,
    34
  ) as Array<Record<string, unknown>>;
  assert.deepEqual(resolutionEvents, [
    {
      type: "nativeApprovalResolved",
      eventKey: "desktop-resolution:req_q_1:question.respond",
      threadId: null,
      requestId: "req_q_1",
      method: "question.respond",
      timestampMs: Date.parse("2026-04-19T08:15:01.000Z"),
      response: "not-json",
      sourceFilePath: filePath,
      sourceOffset: 34,
      sourceOrder: "0000000000000034:0000"
    }
  ]);
});

test("response parsing marks input_text user messages as synthetic and suppresses injected instructions", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const threadId = "019d9999-synthetic-user-thread";
  const filePath = path.join(tempRoot, "rollout.jsonl");

  (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-19T08:20:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-synthetic-001" }
    }),
    filePath,
    0
  );

  const syntheticEvents = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-19T08:20:01.000Z",
      type: "response_item",
      payload: {
        id: "resp_user_synthetic",
        type: "message",
        role: "user",
        content: [{ input_text: "You are Worker B. Only touch tmp/child." }]
      }
    }),
    filePath,
    120
  ) as Array<Record<string, unknown>>;

  assert.deepEqual(syntheticEvents, [
    {
      type: "sessionUserMessage",
      eventKey: "response-message:resp_user_synthetic",
      threadId,
      turnId: "turn-synthetic-001",
      timestampMs: Date.parse("2026-04-19T08:20:01.000Z"),
      text: "You are Worker B. Only touch tmp/child.",
      isSyntheticSubagentInstruction: true,
      sourceFilePath: filePath,
      sourceOffset: 120,
      sourceOrder: "0000000000000120:0000"
    }
  ]);

  const suppressedEvents = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-19T08:20:02.000Z",
      type: "response_item",
      payload: {
        id: "resp_user_injected",
        type: "message",
        role: "user",
        content: [{ input_text: "<INSTRUCTIONS>\nDo not mirror this synthetic parent prompt." }]
      }
    }),
    filePath,
    240
  ) as Array<Record<string, unknown>>;

  assert.deepEqual(suppressedEvents, []);
});

test("apply_patch parsing summarizes moved files and per-kind counts", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-session-tailer-"));
  const store = new StateStore(path.join(tempRoot, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(tempRoot, store, createLogger() as never, {});
  const threadId = "019d9999-apply-patch-thread";
  const filePath = path.join(tempRoot, "rollout.jsonl");

  (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-19T08:25:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-patch-001" }
    }),
    filePath,
    0
  );

  const patchInput = [
    "*** Update File: src/old-name.ts",
    "*** Move to: src/new-name.ts",
    "@@",
    "-old line",
    "+new line",
    "*** Add File: src/added.ts",
    "+hello",
    "*** Delete File: src/deleted.ts"
  ].join("\n");

  const events = (tailer as any).parseLine(
    threadId,
    buildJsonLine({
      timestamp: "2026-04-19T08:25:01.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "call_apply_patch",
        status: "completed",
        input: patchInput
      }
    }),
    filePath,
    180
  ) as Array<Record<string, unknown>>;

  assert.deepEqual(events, [
    {
      type: "sessionApplyPatchCompleted",
      eventKey: "apply-patch:call_apply_patch",
      threadId,
      turnId: "turn-patch-001",
      callId: "call_apply_patch",
      timestampMs: Date.parse("2026-04-19T08:25:01.000Z"),
      summary:
        "edited `src/new-name.ts` +1 -1, added `src/added.ts` +1 -0, deleted `src/deleted.ts` +0 -0",
      fileCounts: {
        created: 1,
        edited: 1,
        deleted: 1,
        createdPaths: ["src/added.ts"],
        editedPaths: ["src/new-name.ts"],
        deletedPaths: ["src/deleted.ts"]
      },
      details: patchInput,
      sourceFilePath: filePath,
      sourceOffset: 180,
      sourceOrder: "0000000000000180:0000"
    }
  ]);
});
