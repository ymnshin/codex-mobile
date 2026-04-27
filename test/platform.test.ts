import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  formatMirroredNarrativeText,
  normalizeSubagentThreadName,
  renderItalicFileName
} from "../src/bridge/messageRendering.js";
import {
  basenameFromLocalPath,
  normalizeLocalPath,
  normalizePathForComparison,
  resolveCommandSpawn,
  resolveDesktopIpcPath,
  resolveDesktopLogPaths
} from "../src/platform.js";

test("normalizeLocalPath handles Windows, UNC, file URL, and POSIX paths", () => {
  assert.equal(normalizeLocalPath("C:\\Users\\me\\repo\\file.ts"), "C:/Users/me/repo/file.ts");
  assert.equal(normalizeLocalPath("/C:/Users/me/repo/file.ts"), "C:/Users/me/repo/file.ts");
  assert.equal(normalizeLocalPath("\\\\server\\share\\file.ts"), "//server/share/file.ts");
  assert.equal(normalizeLocalPath("file:///Users/me/repo/file.ts"), "/Users/me/repo/file.ts");
  assert.equal(normalizeLocalPath("/Users/me/repo/file.ts"), "/Users/me/repo/file.ts");
});

test("basenameFromLocalPath extracts the filename across path styles", () => {
  assert.equal(basenameFromLocalPath("C:\\Users\\me\\repo\\BridgeService.ts"), "BridgeService.ts");
  assert.equal(basenameFromLocalPath("/Users/me/repo/BridgeService.ts"), "BridgeService.ts");
  assert.equal(basenameFromLocalPath("file:///Users/me/repo/BridgeService.ts"), "BridgeService.ts");
});

test("normalizePathForComparison folds Windows case but preserves POSIX case", () => {
  assert.equal(normalizePathForComparison("C:\\Repo\\Src\\File.ts"), "c:/repo/src/file.ts");
  assert.equal(normalizePathForComparison("//SERVER/Share/File.ts"), "//server/share/file.ts");
  assert.equal(normalizePathForComparison("/Users/Me/Repo/File.ts"), "/Users/Me/Repo/File.ts");
});

test("resolveCommandSpawn uses shell quoting on Windows and argv parsing on POSIX", () => {
  const windows = resolveCommandSpawn("codex", ["app-server", "path with spaces"], {
    platform: "win32",
    windowsHide: false
  });
  assert.equal(windows.shell, true);
  assert.equal(windows.args.length, 0);
  assert.equal(windows.command, 'codex app-server "path with spaces"');
  assert.equal(windows.windowsHide, false);

  const mac = resolveCommandSpawn("codex --profile 'work default'", ["app-server"], {
    platform: "darwin"
  });
  assert.equal(mac.shell, false);
  assert.equal(mac.command, "codex");
  assert.deepEqual(mac.args, ["--profile", "work default", "app-server"]);
});

test("resolveDesktopIpcPath keeps Windows defaults and makes macOS explicit", () => {
  const windows = resolveDesktopIpcPath({ platform: "win32" });
  assert.equal(windows.path, "\\\\.\\pipe\\codex-ipc");
  assert.equal(windows.reason, null);

  const mac = resolveDesktopIpcPath({ platform: "darwin" });
  assert.equal(mac.path, null);
  assert.match(mac.reason ?? "", /macOS/i);

  const override = resolveDesktopIpcPath({
    platform: "darwin",
    overridePath: "/tmp/codex-desktop.sock"
  });
  assert.equal(override.path, "/tmp/codex-desktop.sock");
  assert.equal(override.reason, null);
});

test("resolveDesktopLogPaths returns Windows and macOS candidate directories", () => {
  const date = new Date("2026-04-14T08:00:00.000Z");
  const windows = resolveDesktopLogPaths(date, {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } as NodeJS.ProcessEnv
  });
  assert.deepEqual(windows.directories, [
    path.win32.join("C:\\Users\\me\\AppData\\Local", "Codex", "Logs", "2026", "04", "14")
  ]);

  const mac = resolveDesktopLogPaths(date, {
    platform: "darwin",
    homeDir: "/Users/me"
  });
  assert.deepEqual(mac.directories, [
    path.posix.join("/Users/me", "Library", "Logs", "Codex", "2026", "04", "14"),
    path.posix.join(
      "/Users/me",
      "Library",
      "Application Support",
      "Codex",
      "Logs",
      "2026",
      "04",
      "14"
    )
  ]);

  const override = resolveDesktopLogPaths(date, {
    platform: "darwin",
    overrideRoot: "/tmp/codex-desktop-logs"
  });
  assert.deepEqual(override.directories, [
    path.posix.join("/tmp/codex-desktop-logs", "2026", "04", "14")
  ]);
});

test("mirrored narrative rendering replaces Windows, POSIX, and file URL paths with basenames", () => {
  assert.match(
    formatMirroredNarrativeText("Open C:\\Users\\me\\repo\\BridgeService.ts next."),
    /\*BridgeService\.ts\*/
  );
  assert.match(
    formatMirroredNarrativeText("Open /Users/me/repo/BridgeService.ts next."),
    /\*BridgeService\.ts\*/
  );
  assert.match(
    formatMirroredNarrativeText("Open file:///Users/me/repo/BridgeService.ts next."),
    /\*BridgeService\.ts\*/
  );
});

test("renderItalicFileName supports Windows and POSIX paths", () => {
  assert.equal(renderItalicFileName("C:\\Users\\me\\repo\\BridgeService.ts"), "*BridgeService.ts*");
  assert.equal(renderItalicFileName("/Users/me/repo/BridgeService.ts"), "*BridgeService.ts*");
});

test("normalizeSubagentThreadName falls back for raw path-like titles on Windows and POSIX", () => {
  assert.equal(
    normalizeSubagentThreadName("C:\\Users\\me\\repo\\script.ps1", "019d5702-c814-7b21-b836-321b913e9859"),
    "Sub-agent 019d5702"
  );
  assert.equal(
    normalizeSubagentThreadName("/Users/me/repo/script.sh", "019d5702-c814-7b21-b836-321b913e9859"),
    "Sub-agent 019d5702"
  );
});
