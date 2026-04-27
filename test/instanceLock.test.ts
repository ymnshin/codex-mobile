import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { acquireInstanceLock } from "../src/instanceLock.js";

test("instance lock replaces stale locks and writes the current pid payload", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-lock-"));
  const lockPath = path.join(dir, "bridge.lock");
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 1001,
      createdAt: "2026-04-15T07:00:00.000Z"
    })
  );

  const lock = acquireInstanceLock(lockPath, {
    currentPid: 2002,
    processAlive: () => false
  });

  try {
    const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
    assert.equal(payload.pid, 2002);
  } finally {
    lock.release();
  }

  assert.equal(existsSync(lockPath), false);
});

test("instance lock throws a clean-specific error while another live bridge owns the lock", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-lock-"));
  const lockPath = path.join(dir, "bridge.lock");
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 42284,
      createdAt: "2026-04-15T07:05:02.074Z"
    })
  );

  assert.throws(
    () =>
      acquireInstanceLock(lockPath, {
        purpose: "clean",
        processAlive: () => true
      }),
    /Stop it before running clean/
  );
});
