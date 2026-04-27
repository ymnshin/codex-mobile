import test from "node:test";
import assert from "node:assert/strict";
import { selectLatestInspectionMessage } from "../src/providers/discord/inspection.js";

test("inspect preview prefers the most recently edited message over newer-created stale messages", () => {
  const summary = selectLatestInspectionMessage(
    [
      {
        createdTimestamp: Date.parse("2026-04-06T10:20:00Z"),
        editedTimestamp: Date.parse("2026-04-06T12:37:43Z"),
        content: "new preview from edited grouped message"
      },
      {
        createdTimestamp: Date.parse("2026-04-06T10:30:00Z"),
        editedTimestamp: null,
        content: "older visible preview"
      }
    ],
    (content: string) => content
  );

  assert.deepEqual(summary, {
    activityTimestamp: Date.parse("2026-04-06T12:37:43Z"),
    preview: "new preview from edited grouped message"
  });
});
