import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { checkCodexCommand } from "../src/doctor.js";

test("checkCodexCommand times out instead of passing a hung command", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-doctor-"));
  const scriptPath = path.join(dir, "hang.js");
  writeFileSync(scriptPath, "setTimeout(() => {}, 60000);\n");

  const result = await checkCodexCommand(`"${process.execPath}" "${scriptPath}"`, { helpTimeoutMs: 100 });

  assert.equal(result.ok, false);
  assert.match(result.details, /Timed out waiting/);
});
