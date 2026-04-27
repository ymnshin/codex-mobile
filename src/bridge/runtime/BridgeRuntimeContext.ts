import type { BridgeRuntimeConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { CodexAdapter } from "../../codex/CodexAdapter.js";
import type { CodexDesktopIpcClient } from "../../codex/CodexDesktopIpcClient.js";
import type { CodexSessionEventTailer } from "../../codex/CodexSessionEventTailer.js";
import { Policy } from "../../policy/Policy.js";
import type { BridgeProvider } from "../../providers/types.js";
import { StateStore } from "../../store/StateStore.js";

export const DEFAULT_DISCOVERY_LIMIT = 25;
export const INITIAL_DISCOVERY_FETCH_LIMIT = 25;
export const INITIAL_IMPORT_LIMIT = 25;
export const INITIAL_IMPORT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const INITIAL_IMPORT_FULL_HISTORY_THREAD_LIMIT = 5;
export const CURRENT_UPDATE_WINDOW_MS = 5 * 60 * 1000;
export const MAX_CONVERSATION_CHANNELS_PER_CATEGORY = 20;
export const DISCOVERY_ATTACH_CONCURRENCY = 5;
export const DISCOVERY_RESUME_TIMEOUT_MS = 2_500;
export const DISCOVERY_RESUME_THROTTLE_MS = 60_000;
export const STATUS_EDIT_DEBOUNCE_MS = 750;
export const MESSAGE_SYNC_DEBOUNCE_MS = 1200;
export const APPROVAL_SESSION_SETTLE_DELAY_MS = 150;
export const APPROVAL_SESSION_SETTLE_PASSES = 4;
export const INACTIVE_APPROVAL_RETENTION_MS = 60 * 60 * 1000;
export const AUDIT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface BridgeServiceOptions {
  codexAdapter: CodexAdapter;
  provider: BridgeProvider;
  stateStore: StateStore;
  policy: Policy;
  logger: Logger;
  discoveryPollSeconds: number;
  sourceKinds: string[];
  runtimeConfig?: BridgeRuntimeConfig;
  sessionEventTailer?: CodexSessionEventTailer;
  desktopIpcClient?: CodexDesktopIpcClient;
}

export interface BridgeRuntimeContext {
  codexAdapter: CodexAdapter;
  provider: BridgeProvider;
  stateStore: StateStore;
  policy: Policy;
  logger: Logger;
  discoveryPollSeconds: number;
  sourceKinds: string[];
  runtimeConfig: BridgeRuntimeConfig;
  sessionEventTailer: CodexSessionEventTailer;
  desktopIpcClient?: CodexDesktopIpcClient;
}
