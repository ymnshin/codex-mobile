import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  extractNestedString,
  findNewestStateDatabasePath,
  pathExists
} from "../src/codex/codexFsHelpers.js";

test("extractNestedString follows nested paths and respects array and trim options", () => {
  assert.equal(
    extractNestedString(
      { parent: { child: { value: "  hello  " } } },
      ["parent", "child", "value"]
    ),
    "hello"
  );
  assert.equal(
    extractNestedString(
      { parent: [{ value: "from-array" }] as unknown as Record<string, unknown> },
      ["parent", "0", "value"]
    ),
    null
  );
  assert.equal(
    extractNestedString(
      { parent: [{ value: "  raw  " }] as unknown as Record<string, unknown> },
      ["parent", "0", "value"],
      { allowArrays: true, trimResult: false }
    ),
    "  raw  "
  );
});

test("findNewestStateDatabasePath picks the newest state database and ignores unrelated files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-fs-"));
  writeFileSync(path.join(dir, "state_0001.sqlite"), "");
  writeFileSync(path.join(dir, "state_0012.sqlite"), "");
  writeFileSync(path.join(dir, "notes.txt"), "");

  assert.equal(findNewestStateDatabasePath(dir), path.join(dir, "state_0012.sqlite"));
  assert.equal(findNewestStateDatabasePath(path.join(dir, "missing")), null);
});

test("pathExists reports existing and missing filesystem paths", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-fs-exists-"));
  const filePath = path.join(dir, "present.txt");
  writeFileSync(filePath, "present");

  assert.equal(await pathExists(filePath), true);
  assert.equal(await pathExists(path.join(dir, "missing.txt")), false);
});
