import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createBridgeConfigFromPreset, loadConfig } from "../src/config.js";

test("basic preset mirrors grouped activity without Discord message write-back", () => {
  const config = createBridgeConfigFromPreset("basic", {
    allowedUserIds: ["user_1"]
  });

  assert.equal(config.preset, "basic");
  assert.equal(config.visibility.userMessages, true);
  assert.equal(config.visibility.thinkingMessages, true);
  assert.equal(config.visibility.finalMessages, true);
  assert.equal(config.visibility.commands, true);
  assert.equal(config.visibility.fileEdits, true);
  assert.equal(config.approvals.approvalTtlMinutes, 30);
  assert.equal(config.messageWriteBacks.allowFromDiscord, false);
  assert.deepEqual(config.messageWriteBacks.allowedUserIds, ["user_1"]);
  assert.equal(config.startupBackfill.maxCodexMessages, 20);
  assert.equal(config.startupBackfill.leadingEventBudget, 10);
  assert.equal(config.startupBackfill.trailingEventBudget, 10);
  assert.equal(config.retention.maxTurnsPerThread, 2);
  assert.equal(config.ui.commandDisplayMode, "summary");
  assert.equal(config.ui.enableCommandDetails, false);
  assert.equal(config.ui.showDevDetailButtons, false);
  assert.equal(config.diagnostics.desktopSteerDumpEnabled, false);
  assert.equal(config.diagnostics.mirrorTraceEnabled, false);
  assert.equal(config.diagnostics.mirrorTracePath, "./tmp/bridge-mirror-trace.jsonl");
  assert.equal(config.diagnostics.mirrorTraceMaxBytes, 5 * 1024 * 1024);
  assert.deepEqual(config.discovery.allowedThreadIds, []);
  assert.equal(config.discovery.projectNamePrefix, null);
});

test("recommended preset enables Discord message write-back with grouped activity", () => {
  const config = createBridgeConfigFromPreset("recommended", {
    allowFromDiscord: true,
    allowedUserIds: ["user_1"]
  });

  assert.equal(config.preset, "recommended");
  assert.equal(config.approvals.allowFromDiscord, true);
  assert.deepEqual(config.approvals.allowedUserIds, ["user_1"]);
  assert.equal(config.messageWriteBacks.allowFromDiscord, true);
  assert.deepEqual(config.messageWriteBacks.allowedUserIds, ["user_1"]);
  assert.equal(config.ui.commandDisplayMode, "summary");
  assert.equal(config.ui.enableCommandDetails, false);
  assert.equal(config.visibility.commands, true);
  assert.equal(config.visibility.fileEdits, true);
});

test("loadConfig accepts zero turn retention without enabling startup history and rejects invalid limits", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-retention-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");
  const env = {
    DISCORD_BOT_TOKEN: "token",
    DISCORD_APPLICATION_ID: "app",
    DISCORD_GUILD_ID: "guild",
    DISCORD_CONTROLLER_USER_ID: "user_1",
    CODEX_COMMAND: "codex",
    BRIDGE_CONFIG_PATH: bridgeConfigPath
  };
  const writeLimit = (maxTurnsPerThread: number) => writeFileSync(bridgeConfigPath, JSON.stringify({
    preset: "recommended",
    retention: { maxTurnsPerThread },
    startupBackfill: { maxCodexMessages: 0 }
  }));
  writeLimit(0);
  const config = loadConfig(env).bridge;
  assert.equal(config.retention.maxTurnsPerThread, 0);
  assert.equal(config.startupBackfill.maxCodexMessages, 0);
  for (const limit of [-1, 0.5, 21]) {
    writeLimit(limit);
    assert.throws(() => loadConfig(env), /maxTurnsPerThread/);
  }
});

test("full preset uses ungrouped command and file activity with details", () => {
  const config = createBridgeConfigFromPreset("full", {
    allowFromDiscord: true,
    allowedUserIds: ["user_1"]
  });

  assert.equal(config.preset, "full");
  assert.equal(config.messageWriteBacks.allowFromDiscord, true);
  assert.equal(config.ui.commandDisplayMode, "full");
  assert.equal(config.ui.commandPreviewMaxLength, 140);
  assert.equal(config.ui.enableCommandDetails, true);
  assert.equal(config.visibility.commands, true);
  assert.equal(config.visibility.fileEdits, true);
});

test("createBridgeConfigFromPreset fails closed without exactly one Discord controller user", () => {
  assert.throws(
    () =>
      createBridgeConfigFromPreset("recommended", {
        allowFromDiscord: true,
        allowedUserIds: []
      }),
    /exactly one DISCORD_CONTROLLER_USER_ID/i
  );
  assert.throws(
    () =>
      createBridgeConfigFromPreset("recommended", {
        allowFromDiscord: true,
        allowedUserIds: ["user_1", "user_2"]
      }),
    /exactly one DISCORD_CONTROLLER_USER_ID/i
  );
  assert.doesNotThrow(() =>
    createBridgeConfigFromPreset("basic", {
      allowFromDiscord: false,
      allowedUserIds: []
    })
  );
});

test("loadConfig reads bridge.config.json with a single controller user for approvals and write-back", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");
  writeFileSync(
    bridgeConfigPath,
    JSON.stringify({
      preset: "full",
      approvals: {
        allowFromDiscord: true,
        approvalTtlMinutes: 45
      },
      messageWriteBacks: {
        allowFromDiscord: true
      },
      visibility: {
        thinkingMessages: true
      },
      ui: {
        commandDisplayMode: "full"
      },
      startupBackfill: {
        leadingEventBudget: 6,
        trailingEventBudget: 14
      },
      diagnostics: {
        desktopSteerDumpEnabled: 1,
        mirrorTraceEnabled: true,
        mirrorTracePath: "./tmp/test-trace.jsonl",
        mirrorTraceMaxBytes: 1048576
      },
      discovery: {
        allowedThreadIds: ["thread_1", "thread_2"],
        projectNamePrefix: "e2e-run"
      }
    }),
    "utf8"
  );

  const config = loadConfig({
    DISCORD_BOT_TOKEN: "token",
    DISCORD_APPLICATION_ID: "app",
    DISCORD_GUILD_ID: "guild",
    DISCORD_CONTROLLER_USER_ID: "user_1",
    CODEX_COMMAND: "codex",
    CODEX_DESKTOP_IPC_PATH: "/tmp/codex-desktop.sock",
    CODEX_DESKTOP_LOG_ROOT: "./tmp/codex-desktop-logs",
    BRIDGE_CONFIG_PATH: bridgeConfigPath
  });

  assert.equal(config.bridge.preset, "full");
  assert.deepEqual(config.bridge.approvals.allowedUserIds, ["user_1"]);
  assert.equal(config.bridge.approvals.approvalTtlMinutes, 45);
  assert.equal(config.bridge.messageWriteBacks.allowFromDiscord, true);
  assert.deepEqual(config.bridge.messageWriteBacks.allowedUserIds, ["user_1"]);
  assert.equal(config.bridge.visibility.thinkingMessages, true);
  assert.equal(config.bridge.visibility.finalMessages, true);
  assert.equal(config.bridge.startupBackfill.maxCodexMessages, 20);
  assert.equal(config.bridge.startupBackfill.leadingEventBudget, 6);
  assert.equal(config.bridge.startupBackfill.trailingEventBudget, 14);
  assert.equal(config.bridge.ui.commandDisplayMode, "full");
  assert.equal(config.bridge.retention.maxTurnsPerThread, 2);
  assert.equal(config.bridge.diagnostics.desktopSteerDumpEnabled, true);
  assert.equal(config.bridge.diagnostics.mirrorTraceEnabled, true);
  assert.equal(config.bridge.diagnostics.mirrorTracePath, path.resolve(dir, "tmp/test-trace.jsonl"));
  assert.equal(config.bridge.diagnostics.mirrorTraceMaxBytes, 1048576);
  assert.deepEqual(config.bridge.discovery.allowedThreadIds, ["thread_1", "thread_2"]);
  assert.equal(config.bridge.discovery.projectNamePrefix, "e2e-run");
  assert.equal(config.codexDesktopIpcPath, "/tmp/codex-desktop.sock");
  assert.equal(config.codexDesktopLogRoot, path.resolve("tmp/codex-desktop-logs"));
});

test("loadConfig accepts diagnostics.desktopSteerDumpEnabled set to 1", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");
  writeFileSync(
    bridgeConfigPath,
    JSON.stringify({
      preset: "recommended",
      approvals: {
        allowFromDiscord: true
      },
      diagnostics: {
        desktopSteerDumpEnabled: 1
      }
    }),
    "utf8"
  );

  const config = loadConfig({
    DISCORD_BOT_TOKEN: "token",
    DISCORD_APPLICATION_ID: "app",
    DISCORD_GUILD_ID: "guild",
    DISCORD_CONTROLLER_USER_ID: "user_1",
    CODEX_COMMAND: "codex",
    BRIDGE_CONFIG_PATH: bridgeConfigPath
  });

  assert.equal(config.bridge.diagnostics.desktopSteerDumpEnabled, true);
});

test("loadConfig defaults the bridge app-server listener to the local websocket endpoint", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");
  writeFileSync(
    bridgeConfigPath,
    JSON.stringify({
      preset: "recommended",
      approvals: {
        allowFromDiscord: true
      }
    }),
    "utf8"
  );

  const config = loadConfig({
    DISCORD_BOT_TOKEN: "token",
    DISCORD_APPLICATION_ID: "app",
    DISCORD_GUILD_ID: "guild",
    DISCORD_CONTROLLER_USER_ID: "user_1",
    CODEX_COMMAND: "codex",
    BRIDGE_CONFIG_PATH: bridgeConfigPath
  });

  assert.equal(config.codexAppServerListenUrl, "ws://127.0.0.1:8837");
  assert.deepEqual(config.codexThreadSourceKinds, ["vscode", "cli"]);
});

test("loadConfig derives startup backfill head and tail budgets from maxCodexMessages", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");
  writeFileSync(
    bridgeConfigPath,
    JSON.stringify({
      preset: "recommended",
      approvals: {
        allowFromDiscord: true
      },
      startupBackfill: {
        maxCodexMessages: 7
      }
    }),
    "utf8"
  );

  const config = loadConfig({
    DISCORD_BOT_TOKEN: "token",
    DISCORD_APPLICATION_ID: "app",
    DISCORD_GUILD_ID: "guild",
    DISCORD_CONTROLLER_USER_ID: "user_1",
    CODEX_COMMAND: "codex",
    BRIDGE_CONFIG_PATH: bridgeConfigPath
  });

  assert.equal(config.bridge.startupBackfill.maxCodexMessages, 7);
  assert.equal(config.bridge.startupBackfill.leadingEventBudget, 4);
  assert.equal(config.bridge.startupBackfill.trailingEventBudget, 3);
});

test("loadConfig accepts manual bridge configs with JSONC-style comments", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");
  writeFileSync(
    bridgeConfigPath,
    `{
      // Manual configs can start from the example file.
      "preset": "full",
      "approvals": {
        "allowFromDiscord": true
      },
      "ui": {
        "commandDisplayMode": "full"
      }
    }`,
    "utf8"
  );

  const config = loadConfig({
    DISCORD_BOT_TOKEN: "token",
    DISCORD_APPLICATION_ID: "app",
    DISCORD_GUILD_ID: "guild",
    DISCORD_CONTROLLER_USER_ID: "user_1",
    CODEX_COMMAND: "codex",
    BRIDGE_CONFIG_PATH: bridgeConfigPath
  });

  assert.equal(config.bridge.preset, "full");
  assert.deepEqual(config.bridge.approvals.allowedUserIds, ["user_1"]);
  assert.equal(config.bridge.ui.commandDisplayMode, "full");
});

test("loadConfig rejects unknown bridge config keys", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");
  writeFileSync(
    bridgeConfigPath,
    JSON.stringify({
      provider: "discord",
      preset: "recommended",
      approvals: {
        allowFromDiscord: true
      }
    }),
    "utf8"
  );

  assert.throws(
    () =>
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        DISCORD_CONTROLLER_USER_ID: "user_1",
        CODEX_COMMAND: "codex",
        BRIDGE_CONFIG_PATH: bridgeConfigPath
      }),
    /unrecognized key/i
  );
});

test("loadConfig rejects removed split write-back keys", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");
  writeFileSync(
    bridgeConfigPath,
    JSON.stringify({
      preset: "recommended",
      approvals: {
        allowFromDiscord: true,
        allowPlanActionsFromDiscord: true
      },
      messageWriteBacks: {
        allowFromDiscord: true,
        allowedUserIds: ["writer_1"],
        allowNewTurns: true,
        allowQueueing: true,
        allowSteering: true
      }
    }),
    "utf8"
  );

  assert.throws(
    () =>
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        DISCORD_CONTROLLER_USER_ID: "user_1",
        CODEX_COMMAND: "codex",
        BRIDGE_CONFIG_PATH: bridgeConfigPath
      }),
    /unrecognized key/i
  );
});

test("loadConfig requires a real bridge.config.json file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");

  assert.throws(
    () =>
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        DISCORD_CONTROLLER_USER_ID: "user_1",
        CODEX_COMMAND: "codex",
        BRIDGE_CONFIG_PATH: bridgeConfigPath
      }),
    /run `npm run init`/i
  );
});

test("loadConfig fails closed when Discord approvals are enabled without exactly one user", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");
  writeFileSync(
    bridgeConfigPath,
    JSON.stringify({
      preset: "recommended",
      approvals: {
        allowFromDiscord: true
      }
    }),
    "utf8"
  );

  assert.throws(
    () =>
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        CODEX_COMMAND: "codex",
        BRIDGE_CONFIG_PATH: bridgeConfigPath
      }),
    /DISCORD_CONTROLLER_USER_ID/i
  );
});

test("loadConfig rejects controller user IDs in bridge config", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");
  writeFileSync(
    bridgeConfigPath,
    JSON.stringify({
      preset: "recommended",
      approvals: {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"]
      }
    }),
    "utf8"
  );

  assert.throws(
    () =>
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        DISCORD_CONTROLLER_USER_ID: "user_1",
        CODEX_COMMAND: "codex",
        BRIDGE_CONFIG_PATH: bridgeConfigPath
      }),
    /unrecognized key/i
  );
});

test("loadConfig fails closed when Discord message write-backs are enabled without exactly one user", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-config-"));
  const bridgeConfigPath = path.join(dir, "bridge.config.json");
  writeFileSync(
    bridgeConfigPath,
    JSON.stringify({
      preset: "recommended",
      approvals: {
        allowFromDiscord: false
      },
      messageWriteBacks: {
        allowFromDiscord: true
      }
    }),
    "utf8"
  );

  assert.throws(
    () =>
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        CODEX_COMMAND: "codex",
        BRIDGE_CONFIG_PATH: bridgeConfigPath
      }),
    /DISCORD_CONTROLLER_USER_ID/i
  );
});

