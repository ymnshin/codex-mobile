import test from "node:test";
import assert from "node:assert/strict";
import type { SessionBackfillEvent } from "../src/codex/CodexSessionEventTailer.js";
import { buildStartupSessionBackfillDisplayEntries } from "../src/bridge/startupSelection.js";

test("startup session display budgeting preserves structural subagent spawn events", () => {
  const threadId = "parent-thread";
  const turnId = "parent-turn";
  const events: SessionBackfillEvent[] = [
    {
      type: "sessionUserMessage",
      threadId,
      turnId,
      timestampMs: 1,
      text: "Retained parent prompt"
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      type: "sessionAgentMessage" as const,
      threadId,
      turnId,
      timestampMs: 2 + index,
      text: `Leading answer ${index + 1}`,
      phase: "commentary"
    })),
    {
      type: "sessionSubagentSpawned",
      threadId,
      turnId,
      childThreadId: "child-thread",
      childAgentName: "Dewey",
      prompt: "Inspect harmlessly",
      timestampMs: 10
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      type: "sessionAgentMessage" as const,
      threadId,
      turnId,
      timestampMs: 11 + index,
      text: `Trailing answer ${index + 1}`,
      phase: "commentary"
    }))
  ];

  const entries = buildStartupSessionBackfillDisplayEntries(events, {
    leadingEventBudget: 1,
    trailingEventBudget: 1
  });

  const retainedEvents = entries
    .filter((entry) => entry.kind === "event")
    .map((entry) => entry.event);
  assert.equal(
    retainedEvents.some(
      (event) => event.type === "sessionSubagentSpawned" && event.childThreadId === "child-thread"
    ),
    true
  );
  assert.ok(entries.some((entry) => entry.kind === "notice"));
});
