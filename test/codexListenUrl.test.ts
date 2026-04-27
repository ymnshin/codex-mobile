import test from "node:test";
import assert from "node:assert/strict";
import { resolveCodexListenUrl } from "../src/util/codexListenUrl.js";

test("bridge-service mode honors the configured listen URL", () => {
  assert.equal(resolveCodexListenUrl("stdio://", "bridge-service"), "stdio://");
  assert.equal(
    resolveCodexListenUrl("ws://127.0.0.1:8765", "bridge-service"),
    "ws://127.0.0.1:8765"
  );
});

test("local-control mode stays on isolated stdio even when a websocket listener is configured", () => {
  assert.equal(resolveCodexListenUrl("ws://127.0.0.1:8765", "local-control"), "stdio://");
});
