import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import {
  ensureWindowsStandaloneCodexLauncher,
  resolveStandaloneCodexRemoteTarget,
  rewriteStandaloneCodexRemoteArgs,
  shouldInjectStandaloneCodexRemote
} from "../src/codex/CodexCliStandaloneLauncher.js";

test("resolveStandaloneCodexRemoteTarget only accepts local websocket listeners", () => {
  assert.deepEqual(resolveStandaloneCodexRemoteTarget("ws://127.0.0.1:8837"), {
    listenUrl: "ws://127.0.0.1:8837",
    host: "127.0.0.1",
    port: 8837
  });
  assert.deepEqual(resolveStandaloneCodexRemoteTarget("ws://localhost:9000"), {
    listenUrl: "ws://localhost:9000",
    host: "localhost",
    port: 9000
  });
  assert.equal(resolveStandaloneCodexRemoteTarget("stdio://"), null);
  assert.equal(resolveStandaloneCodexRemoteTarget("ws://192.168.1.20:8837"), null);
  assert.equal(resolveStandaloneCodexRemoteTarget("wss://127.0.0.1:8837"), null);
  assert.equal(resolveStandaloneCodexRemoteTarget("ws://127.0.0.1:8837/path"), null);
});

test("shouldInjectStandaloneCodexRemote only targets interactive CLI entrypoints", () => {
  assert.equal(shouldInjectStandaloneCodexRemote([]), true);
  assert.equal(shouldInjectStandaloneCodexRemote(["count", "to", "5"]), true);
  assert.equal(shouldInjectStandaloneCodexRemote(["--profile", "work", "resume", "--last"]), true);
  assert.equal(shouldInjectStandaloneCodexRemote(["exec", "count", "to", "5"]), false);
  assert.equal(shouldInjectStandaloneCodexRemote(["--profile", "work", "exec", "count", "to", "5"]), false);
  assert.equal(shouldInjectStandaloneCodexRemote(["--help"]), false);
  assert.equal(shouldInjectStandaloneCodexRemote(["--remote", "ws://127.0.0.1:8837"]), false);
});

test("rewriteStandaloneCodexRemoteArgs injects caller cwd and resolves relative cd arguments", () => {
  assert.deepEqual(rewriteStandaloneCodexRemoteArgs(["count", "to", "5"], "C:\\Users\\Natale\\Desktop\\projects\\test3"), [
    "-C",
    "C:\\Users\\Natale\\Desktop\\projects\\test3",
    "count",
    "to",
    "5"
  ]);
  assert.deepEqual(rewriteStandaloneCodexRemoteArgs(["-C", ".", "count", "to", "5"], "C:\\Users\\Natale\\Desktop\\projects\\test3"), [
    "-C",
    "C:\\Users\\Natale\\Desktop\\projects\\test3",
    "count",
    "to",
    "5"
  ]);
  assert.deepEqual(
    rewriteStandaloneCodexRemoteArgs(["--cd=..\\test4", "count", "to", "5"], "C:\\Users\\Natale\\Desktop\\projects\\test3"),
    ["--cd=C:\\Users\\Natale\\Desktop\\projects\\test4", "count", "to", "5"]
  );
});

test("ensureWindowsStandaloneCodexLauncher installs a helper that injects remote only for interactive runs", async () => {
  const appDataDir = mkdtempSync(path.join(tmpdir(), "codex-mobile-cli-launcher-"));
  const packageBinDir = path.join(appDataDir, "npm", "node_modules", "@openai", "codex", "bin");
  mkdirSync(packageBinDir, { recursive: true });
  writeFileSync(
    path.join(packageBinDir, "codex.js"),
    `console.log(JSON.stringify(process.argv.slice(2)));`,
    "utf8"
  );

  const bridgeServer = net.createServer((socket) => {
    socket.end();
  });
  await new Promise<void>((resolve) => bridgeServer.listen(0, "127.0.0.1", () => resolve()));
  const address = bridgeServer.address();
  assert.ok(address && typeof address !== "string");
  const listenUrl = `ws://127.0.0.1:${address.port}`;

  const installResult = await ensureWindowsStandaloneCodexLauncher({
    listenUrl,
    appDataDir,
    platform: "win32"
  });
  assert.equal(installResult.status, "installed");
  assert.ok(installResult.paths);

  const helperPath = installResult.paths!.helperPath;
  const interactiveArgs = await runHelper(helperPath, ["count", "to", "5"]);
  assert.deepEqual(interactiveArgs, ["--remote", listenUrl, "-C", process.cwd(), "count", "to", "5"]);

  const relativeCdArgs = await runHelper(helperPath, ["-C", ".", "count", "to", "5"]);
  assert.deepEqual(relativeCdArgs, ["--remote", listenUrl, "-C", process.cwd(), "count", "to", "5"]);

  const noninteractiveArgs = await runHelper(helperPath, ["--profile", "work", "exec", "count", "to", "5"]);
  assert.deepEqual(noninteractiveArgs, ["--profile", "work", "exec", "count", "to", "5"]);

  await new Promise<void>((resolve, reject) => {
    bridgeServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const fallbackArgs = await runHelper(helperPath, ["count", "to", "5"]);
  assert.deepEqual(fallbackArgs, ["count", "to", "5"]);

  const secondInstallResult = await ensureWindowsStandaloneCodexLauncher({
    listenUrl,
    appDataDir,
    platform: "win32"
  });
  assert.equal(secondInstallResult.status, "alreadyCurrent");
});

test("ensureWindowsStandaloneCodexLauncher skips Windows launcher reconciliation when the global Codex npm entry is missing", async () => {
  const appDataDir = mkdtempSync(path.join(tmpdir(), "codex-mobile-cli-launcher-missing-"));
  const result = await ensureWindowsStandaloneCodexLauncher({
    listenUrl: "ws://127.0.0.1:8837",
    appDataDir,
    platform: "win32"
  });

  assert.equal(result.status, "skipped");
  assert.match(result.reason ?? "", /@openai\/codex/i);
});

async function runHelper(helperPath: string, args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`helper exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout.trim()) as string[]);
    });
  });
}
