import test from "node:test";
import assert from "node:assert/strict";
import { renderApprovalCard, renderStatusCard } from "../src/util/formatting.js";

test("renders status cards with compact pinned fields", () => {
  const content = renderStatusCard({
    threadId: "019d5702-c814-7b21-b836-321b913e9859",
    title: "Build bridge",
    shortThreadId: "019d5702",
    kindLabel: "Conversation",
    parentShortThreadId: null,
    projectLabel: "codex-mobile",
    statusLabel: "Running",
    attentionLabel: "Monitoring",
    workspaceLabel: "codex-mobile",
    lastActivityAt: Date.now(),
    latestCommandPreview: "npm test",
    latestAgentMessage: "Working through the implementation."
  });

  assert.match(content, /Build bridge/);
  assert.match(content, /Thread: `019d5702`/);
  assert.match(content, /Project: codex-mobile/);
  assert.match(content, /Last activity:/);
  assert.doesNotMatch(content, /Type:/);
  assert.doesNotMatch(content, /Status:/);
  assert.doesNotMatch(content, /Attention:/);
  assert.doesNotMatch(content, /Workspace:/);
  assert.doesNotMatch(content, /Latest command:/);
  assert.doesNotMatch(content, /Latest final:/);
});

test("renders approval cards with expiry and preview", () => {
  const content = renderApprovalCard({
    token: "token",
    threadId: "thread",
    shortThreadId: "thread",
    kind: "commandExecution",
    createdAt: new Date("2026-04-07T06:40:10.000Z"),
    availableDecisions: ["accept", "decline"],
    actionsEnabled: true,
    sanitizedPreview: "npm install",
    cwd: "C:\\repo",
    reason: "Need dependencies",
    expiresAt: new Date(),
    details: "{}"
  });

  assert.match(content, /\*\*Codex\*\*/);
  assert.match(content, /\[\d{2}:\d{2}:\d{2}\]/);
  assert.match(content, /Waiting for a decision/);
  assert.match(content, /npm install/);
  assert.match(content, /Need dependencies/);
  assert.doesNotMatch(content, /Thread:/);
  assert.doesNotMatch(content, /Options:/);
});

test("renders resolved approval cards without the expiry line", () => {
  const content = renderApprovalCard(
    {
      token: "token",
      threadId: "thread",
      shortThreadId: "thread",
      kind: "commandExecution",
      createdAt: new Date("2026-04-07T06:40:10.000Z"),
      availableDecisions: ["accept", "decline"],
      actionsEnabled: true,
      sanitizedPreview: "npm install",
      cwd: "C:\\repo",
      reason: "Need dependencies",
      expiresAt: new Date("2026-04-07T06:50:10.000Z"),
      details: "{}"
    },
    "✅ Approved once in Discord"
  );

  assert.match(content, /Approved once in Discord/);
  assert.doesNotMatch(content, /Expires:/);
});

test("renders read-only CLI approval cards as CLI-local", () => {
  const content = renderApprovalCard({
    token: "token",
    threadId: "thread",
    shortThreadId: "thread",
    kind: "commandExecution",
    createdAt: new Date("2026-04-07T06:40:10.000Z"),
    availableDecisions: [],
    actionsEnabled: false,
    sourceKind: "cli-session",
    sanitizedPreview: "Start-Process 'https://www.wikipedia.org'",
    cwd: "C:\\repo",
    reason: "Need approval",
    expiresAt: new Date("2026-04-07T06:50:10.000Z"),
    details: "{}"
  });

  assert.match(content, /Resolve this in Codex CLI/);
  assert.doesNotMatch(content, /Resolve this in Codex Desktop/);
});

test("renders only the next unanswered tool input question while pending", () => {
  const content = renderApprovalCard({
    token: "token",
    threadId: "thread",
    shortThreadId: "thread",
    kind: "toolUserInput",
    createdAt: new Date("2026-04-07T06:40:10.000Z"),
    availableDecisions: [],
    actionsEnabled: true,
    sanitizedPreview: "Tool input requested (2 questions)",
    cwd: null,
    reason: null,
    expiresAt: new Date("2026-04-07T06:50:10.000Z"),
    details: "{}",
    toolInput: {
      questions: [
        {
          id: "color",
          question: "What color?",
          options: [{ label: "Blue" }]
        },
        {
          id: "food",
          question: "What food?",
          options: [{ label: "Pizza" }]
        }
      ],
      selectedAnswers: {
        color: "Blue"
      }
    }
  });

  assert.match(content, /Answered: 1 of 2/);
  assert.match(content, /Question 2 of 2: What food\?/);
  assert.doesNotMatch(content, /Question 1 of 2: What color\?/);
});
