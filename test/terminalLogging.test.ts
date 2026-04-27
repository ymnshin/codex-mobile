import test from "node:test";
import assert from "node:assert/strict";
import { formatTerminalLogLine, formatTerminalTimestamp } from "../src/util/terminalLogging.js";

test("formatTerminalTimestamp renders local clock time as HH:MM:SS", () => {
  const value = formatTerminalTimestamp(new Date(2026, 3, 15, 8, 9, 10));
  assert.match(value, /^\d{2}:\d{2}:\d{2}$/);
});

test("formatTerminalLogLine prefixes messages with a timestamp and tag", () => {
  assert.equal(
    formatTerminalLogLine("bridge", "Mapped thread 019d8b79.", new Date(2026, 3, 15, 8, 9, 10)),
    "[08:09:10] [bridge] Mapped thread 019d8b79."
  );
});
