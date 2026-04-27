import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createBridgeConfigFromPreset } from "../src/config.js";
import {
  loadExistingBridgeConfig,
  renderBridgeConfigFile,
  resolveInitBridgeConfigPath
} from "../src/init.js";

test("renderBridgeConfigFile preserves overrides and omits inherited preset defaults", () => {
  const config = createBridgeConfigFromPreset(
    "full",
    {
      allowFromDiscord: true,
      mentionApprovers: false,
      allowedUserIds: ["user_1"],
      approvalTtlMinutes: 45
    },
    {
      ui: {
        commandDisplayMode: "full",
        commandPreviewMaxLength: 180,
        enableCommandDetails: true,
        detailButtonTtlMinutes: 15,
        showDevDetailButtons: true
      }
    }
  );

  const rendered = JSON.parse(renderBridgeConfigFile(config)) as {
    approvals: { mentionApprovers: boolean; approvalTtlMinutes: number };
    messageWriteBacks?: { allowFromDiscord: boolean };
    ui: {
      commandDisplayMode?: string;
      commandPreviewMaxLength?: number;
      enableCommandDetails?: boolean;
      detailButtonTtlMinutes?: number;
      showDevDetailButtons?: boolean;
    };
    diagnostics?: {
      desktopSteerDumpEnabled?: boolean;
    };
  };

  assert.equal(rendered.approvals.mentionApprovers, false);
  assert.equal(rendered.approvals.approvalTtlMinutes, 45);
  assert.equal("allowedUserIds" in rendered.approvals, false);
  assert.equal("messageWriteBacks" in rendered, false);
  assert.equal(rendered.ui.commandDisplayMode, undefined);
  assert.equal(rendered.ui.commandPreviewMaxLength, 180);
  assert.equal(rendered.ui.enableCommandDetails, undefined);
  assert.equal(rendered.ui.detailButtonTtlMinutes, 15);
  assert.equal(rendered.ui.showDevDetailButtons, true);
  assert.equal("diagnostics" in rendered, false);
});

test("renderBridgeConfigFile omits the default approval TTL from init output", () => {
  const config = createBridgeConfigFromPreset("recommended", {
    allowFromDiscord: true,
    allowedUserIds: ["user_1"]
  });

  const rendered = JSON.parse(renderBridgeConfigFile(config)) as {
    approvals: Record<string, unknown>;
  };

  assert.equal("approvalTtlMinutes" in rendered.approvals, false);
});

test("resolveInitBridgeConfigPath honors existing BRIDGE_CONFIG_PATH", () => {
  const customPath = path.join("custom", "bridge.config.json");
  const resolved = resolveInitBridgeConfigPath({
    BRIDGE_CONFIG_PATH: customPath
  });

  assert.equal(resolved, path.resolve(customPath));
});

test("loadExistingBridgeConfig returns null when config is missing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-init-"));
  const configPath = path.join(dir, "bridge.config.json");

  const loaded = await loadExistingBridgeConfig(configPath);

  assert.equal(loaded, null);
});

test("loadExistingBridgeConfig throws on invalid existing config", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-init-"));
  const configPath = path.join(dir, "bridge.config.json");
  writeFileSync(configPath, "{ invalid json", "utf8");

  await assert.rejects(() => loadExistingBridgeConfig(configPath), /JSON|Unexpected/i);
});
