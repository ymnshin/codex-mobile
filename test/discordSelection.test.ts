import test from "node:test";
import assert from "node:assert/strict";
import {
  selectCanonicalConversationChannel,
  type ConversationChannelCandidate
} from "../src/providers/discord/conversationChannelSelection.js";

function candidate(overrides: Partial<ConversationChannelCandidate>): ConversationChannelCandidate {
  return {
    id: "channel-default",
    name: "main",
    parentId: "category-1",
    topic: null,
    codexThreadId: null,
    bridgeScope: null,
    isBridgeManaged: false,
    createdTimestamp: 1,
    ...overrides
  };
}

test("conversation channel selection prefers the preferred exact-thread match and marks other exact matches as duplicates", () => {
  const selected = selectCanonicalConversationChannel(
    [
      candidate({
        id: "channel-old",
        topic: "[codex-bridge] thread:thr_main",
        codexThreadId: "thr_main",
        isBridgeManaged: true,
        createdTimestamp: 1
      }),
      candidate({
        id: "channel-current",
        topic: "[codex-bridge] thread:thr_main",
        codexThreadId: "thr_main",
        isBridgeManaged: true,
        createdTimestamp: 2
      })
    ],
    {
      codexThreadId: "thr_main",
      desiredName: "main",
      categoryId: "category-1",
      preferredChannelId: "channel-old"
    }
  );

  assert.equal(selected.canonical?.id, "channel-old");
  assert.deepEqual(selected.duplicates.map((entry) => entry.id), ["channel-current"]);
});

test("conversation channel selection prefers an exact bridge-managed topic match over a same-name fallback", () => {
  const selected = selectCanonicalConversationChannel(
    [
      candidate({
        id: "channel-name-fallback",
        name: "main",
        topic: null,
        codexThreadId: null,
        isBridgeManaged: false,
        createdTimestamp: 3
      }),
      candidate({
        id: "channel-topic-match",
        name: "main",
        topic: "[codex-bridge] thread:thr_main",
        codexThreadId: "thr_main",
        isBridgeManaged: true,
        createdTimestamp: 2
      })
    ],
    {
      codexThreadId: "thr_main",
      desiredName: "main",
      categoryId: "category-1",
      preferredChannelId: null
    }
  );

  assert.equal(selected.canonical?.id, "channel-topic-match");
  assert.deepEqual(selected.duplicates, []);
});

test("conversation channel selection can ignore exact-thread matches outside an isolated category", () => {
  const selected = selectCanonicalConversationChannel(
    [
      candidate({
        id: "channel-live-bridge",
        parentId: "category-live",
        topic: "[codex-bridge] thread:thr_main",
        codexThreadId: "thr_main",
        bridgeScope: null,
        isBridgeManaged: true,
        createdTimestamp: 3
      }),
      candidate({
        id: "channel-e2e-placeholder",
        name: "main",
        parentId: "category-e2e",
        topic: "[codex-bridge] thread: scope:e2e-run",
        codexThreadId: null,
        bridgeScope: "e2e-run",
        isBridgeManaged: true,
        createdTimestamp: 2
      })
    ],
    {
      codexThreadId: "thr_main",
      desiredName: "main",
      categoryId: "category-e2e",
      preferredChannelId: null,
      allowCrossCategoryExactMatch: false,
      bridgeScope: "e2e-run"
    }
  );

  assert.equal(selected.canonical?.id, "channel-e2e-placeholder");
  assert.deepEqual(selected.duplicates, []);
});

test("conversation channel selection does not adopt a non-bridge-managed same-name channel", () => {
  const selected = selectCanonicalConversationChannel(
    [
      candidate({
        id: "channel-blank-topic",
        name: "main",
        topic: "",
        codexThreadId: null,
        isBridgeManaged: false,
        createdTimestamp: 2
      }),
      candidate({
        id: "channel-unrelated",
        name: "other",
        topic: null,
        codexThreadId: null,
        isBridgeManaged: false,
        createdTimestamp: 3
      })
    ],
    {
      codexThreadId: "thr_main",
      desiredName: "main",
      categoryId: "category-1",
      preferredChannelId: null
    }
  );

  assert.equal(selected.canonical, null);
  assert.deepEqual(selected.duplicates, []);
});

test("conversation channel selection may reuse a bridge-managed placeholder channel with no bound thread id", () => {
  const selected = selectCanonicalConversationChannel(
    [
      candidate({
        id: "channel-placeholder",
        name: "main",
        topic: "[codex-bridge] thread:",
        codexThreadId: null,
        isBridgeManaged: true,
        createdTimestamp: 2
      }),
      candidate({
        id: "channel-unrelated",
        name: "other",
        topic: null,
        codexThreadId: null,
        isBridgeManaged: false,
        createdTimestamp: 3
      })
    ],
    {
      codexThreadId: "thr_main",
      desiredName: "main",
      categoryId: "category-1",
      preferredChannelId: null
    }
  );

  assert.equal(selected.canonical?.id, "channel-placeholder");
  assert.deepEqual(selected.duplicates, []);
});
