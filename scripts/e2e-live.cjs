#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const dotenv = require("dotenv");

const DEFAULT_MANIFEST_PATH = path.join("e2e-live", "manifest.json");
const DEFAULT_BRIDGE_CONFIG_PATH = "bridge.config.json";
const DEFAULT_INSPECT_LIMIT = 30;
const DEFAULT_TIMEOUT_SECONDS = 45;
const POLL_INTERVAL_MS = 3000;
const STOP_WAIT_TIMEOUT_MS = 10000;
const STOP_WAIT_POLL_MS = 250;
const STOP_SETTLE_MS = 500;
const START_READY_TIMEOUT_MS = 300000;
const START_READY_POLL_MS = 500;
const LIVE_E2E_LISTENER_BASE_PORT = 21000;
const LIVE_E2E_LISTENER_PORT_SPAN = 20000;
const SESSION_SCOPE_LOOKBACK_MS = 30 * 60 * 1000;
const SESSION_SCOPE_MAX_FILES = 200;
const RUN_ROOT = path.join("tmp", "live-e2e");
const CURRENT_RUN_FILENAME = "current-run.json";
const THREAD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BRIDGE_STARTUP_READY_META_KEY = "bridge_startup_ready_at";

function stripJsonComments(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1] || "";

    if (inLineComment) {
      if (current === "\n" || current === "\r") {
        inLineComment = false;
        result += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (current === "\"") {
        inString = false;
      }
      continue;
    }

    if (current === "\"") {
      inString = true;
      result += current;
      continue;
    }

    if (current === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += current;
  }

  return result;
}

function readJsonFile(filePath, { allowComments = false } = {}) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(allowComments ? stripJsonComments(raw) : raw);
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(target, source) {
  if (!isPlainObject(source)) {
    return target;
  }

  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key], value);
      continue;
    }
    target[key] = deepClone(value);
  }
  return target;
}

function resolveRepoRoot(options = {}) {
  return path.resolve(options.repoRoot || path.join(__dirname, ".."));
}

function loadManifest(repoRoot) {
  return readJsonFile(path.join(repoRoot, DEFAULT_MANIFEST_PATH));
}

function flattenScenarios(manifest) {
  const tests = Array.isArray(manifest.tests) ? manifest.tests : [];
  return tests.flatMap((testEntry) => {
    const scenarios = Array.isArray(testEntry.scenarios) ? testEntry.scenarios : [];
    return scenarios.map((scenario) => ({
      ...scenario,
      testId: testEntry.id,
      playbook: testEntry.playbook
    }));
  });
}

function findScenario(manifest, scenarioId) {
  return flattenScenarios(manifest).find((scenario) => scenario.id === scenarioId) || null;
}

function stringList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined && item !== null && String(item).trim() !== "").map(String);
  }
  if (value === undefined || value === null || String(value).trim() === "") {
    return [];
  }
  return [String(value)];
}

function formatHumanInputSummary(humanInput, indent = "  ") {
  if (!isPlainObject(humanInput)) {
    return [];
  }

  const lines = [];
  const summary = stringList(humanInput.summary);
  const required = stringList(humanInput.required);
  const approvals = stringList(humanInput.approvals);
  const notRequired = stringList(humanInput.notRequired);

  if (summary.length > 0) {
    lines.push(`${indent}Human input: ${summary.join(" ")}`);
  }
  if (required.length > 0) {
    lines.push(`${indent}Required: ${required.join(" ")}`);
  }
  if (approvals.length > 0) {
    lines.push(`${indent}Approvals: ${approvals.join(" ")}`);
  }
  if (notRequired.length > 0) {
    lines.push(`${indent}Not required: ${notRequired.join(" ")}`);
  }

  return lines;
}

function formatHumanInputSection(humanInput) {
  if (!isPlainObject(humanInput)) {
    return ["- (not documented)"];
  }

  const lines = [];
  const summary = stringList(humanInput.summary);
  const required = stringList(humanInput.required);
  const approvals = stringList(humanInput.approvals);
  const notRequired = stringList(humanInput.notRequired);

  if (summary.length > 0) {
    lines.push(`Summary: ${summary.join(" ")}`);
  }
  if (required.length > 0) {
    lines.push("Required:");
    required.forEach((item) => lines.push(`- ${item}`));
  }
  if (approvals.length > 0) {
    lines.push("Approvals:");
    approvals.forEach((item) => lines.push(`- ${item}`));
  }
  if (notRequired.length > 0) {
    lines.push("Not required:");
    notRequired.forEach((item) => lines.push(`- ${item}`));
  }

  return lines.length > 0 ? lines : ["- (not documented)"];
}

function listGroups(manifest) {
  const groups = Array.isArray(manifest.groups) ? manifest.groups : [];
  if (groups.length === 0) {
    return "No live e2e groups are defined.";
  }

  return [
    "Live e2e groups:",
    ...groups.map((group) => {
      const scenarioCount = Array.isArray(group.scenarios) ? group.scenarios.length : 0;
      const title = group.title ? `${group.title}` : "(untitled)";
      const description = group.description ? ` ${group.description}` : "";
      return [
        `- ${group.id} (${scenarioCount} scenario${scenarioCount === 1 ? "" : "s"}): ${title}${description}`,
        ...formatHumanInputSummary(group.humanInput)
      ].join("\n");
    })
  ].join("\n");
}

function listScenarios(manifest) {
  const lines = [];
  const groups = Array.isArray(manifest.groups) ? manifest.groups : [];
  if (groups.length > 0) {
    lines.push(listGroups(manifest));
    lines.push("");
  }
  lines.push("Scenarios:");
  for (const testEntry of manifest.tests || []) {
    lines.push(`${testEntry.id} (${testEntry.playbook})`);
    for (const scenario of testEntry.scenarios || []) {
      const safety = scenario.safety || manifest.defaults?.safety || "isolated";
      lines.push(`  - ${scenario.id} [${safety}] ${scenario.title || ""}`.trimEnd());
    }
  }
  return lines.join("\n");
}

function findGroup(manifest, groupId) {
  return (Array.isArray(manifest.groups) ? manifest.groups : []).find((group) => group.id === groupId) || null;
}

function describeGroup(manifest, groupId) {
  const group = findGroup(manifest, groupId);
  if (!group) {
    throw new Error(`Unknown live e2e group: ${groupId}`);
  }

  const scenarioIds = Array.isArray(group.scenarios) ? group.scenarios : [];
  const scenarios = scenarioIds.map((scenarioId) => {
    const scenario = findScenario(manifest, scenarioId);
    if (!scenario) {
      throw new Error(`Group ${groupId} references unknown scenario: ${scenarioId}`);
    }
    return scenario;
  });

  return [
    `Group: ${group.id}`,
    `Title: ${group.title || "(untitled)"}`,
    group.description ? `Description: ${group.description}` : null,
    "",
    "Human input:",
    ...formatHumanInputSection(group.humanInput),
    "",
    "Run contract:",
    "1. Run these scenarios one at a time in the listed order.",
    "2. Use a unique run ID per scenario, for example `<group-id>-001`, `<group-id>-002`.",
    "3. Do not ask for user follow-up unless the scenario safety is `manual`.",
    "4. For `initial-user-message` scenarios only, pass `--marker` as an exact distinctive substring from the initial user request that started this group.",
    "5. For every other scenario, do not pass `--marker`; use the generated marker printed by `prepare` and perform the action with that exact marker.",
    "6. For the default store surface, use the stable current-run commands printed by `prepare`: `start-local-current`, `verify --run-id`, and `stop-current`.",
    "7. Use `prepare --surface discord` only when the user asks for a full Discord API/rendering check. Confirm prepare prints `Discovery scope`. For Discord-surface runs, cleanup means mapped-only `cleanup-current`, not `stop-current`.",
    "8. Do not set `BRIDGE_CONFIG_PATH` or `STORE_PATH` by hand, and do not use `Start-Process`; the helper owns the temp environment.",
    "9. If the user asked to run tests only, do not debug, retry, or run ad hoc inspection beyond the playbook; run the printed cleanup command and report the helper failure as it occurs.",
    "10. During command and file-edit scenarios, avoid extra shell/file tool calls while the bridge is running because they change the observed command/file counts.",
    "11. Report pass/fail for every scenario and include the helper verify output.",
    "",
    "Scenarios:",
    ...scenarios.map((scenario, index) => {
      const safety = scenario.safety || manifest.defaults?.safety || "isolated";
      return `${index + 1}. ${scenario.id} [${safety}] ${scenario.title || ""}`.trimEnd();
    })
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      options[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[withoutPrefix] = next;
      index += 1;
      continue;
    }

    options[withoutPrefix] = "true";
  }

  return { positional, options };
}

function validateRunId(runId) {
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(runId)) {
    throw new Error("Run IDs must be 1-81 characters and use only letters, numbers, '.', '_' or '-'.");
  }
}

function validateThreadId(threadId) {
  if (!THREAD_ID_PATTERN.test(String(threadId || ""))) {
    throw new Error(`Invalid Codex thread id for live e2e scope: ${threadId || "(empty)"}.`);
  }
}

function runDirFor(repoRoot, runId) {
  validateRunId(runId);
  return path.join(repoRoot, RUN_ROOT, runId);
}

function runMetadataPathFor(repoRoot, runId) {
  return path.join(runDirFor(repoRoot, runId), "run.json");
}

function currentRunPathFor(repoRoot) {
  return path.join(repoRoot, RUN_ROOT, CURRENT_RUN_FILENAME);
}

function writeCurrentRunPointer(repoRoot, metadata) {
  const currentRunPath = currentRunPathFor(repoRoot);
  fs.mkdirSync(path.dirname(currentRunPath), { recursive: true });
  fs.writeFileSync(
    currentRunPath,
    `${JSON.stringify(
      {
        runId: metadata.runId,
        scenarioId: metadata.scenarioId,
        surface: metadata.surface,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function hashRunIdForPort(runId) {
  let hash = 2166136261;
  for (const char of String(runId)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function resolveRunAppServerListenUrl(runId) {
  const port = LIVE_E2E_LISTENER_BASE_PORT + (hashRunIdForPort(runId) % LIVE_E2E_LISTENER_PORT_SPAN);
  return `ws://127.0.0.1:${port}`;
}

function loadCurrentRunPointer(repoRoot) {
  const currentRunPath = currentRunPathFor(repoRoot);
  if (!fs.existsSync(currentRunPath)) {
    throw new Error(`No live e2e current run pointer found at ${currentRunPath}. Run prepare first.`);
  }
  const current = readJsonFile(currentRunPath);
  validateRunId(current.runId);
  return current;
}

function loadRunMetadata(repoRoot, runId) {
  const runMetadataPath = runMetadataPathFor(repoRoot, runId);
  if (!fs.existsSync(runMetadataPath)) {
    throw new Error(`Live e2e run metadata not found at ${runMetadataPath}. Run prepare first.`);
  }
  return readJsonFile(runMetadataPath);
}

function resetRunDirectoryForPrepare(repoRoot, runId) {
  const runDir = runDirFor(repoRoot, runId);
  const runRoot = path.resolve(repoRoot, RUN_ROOT);
  const resolvedRunDir = path.resolve(runDir);
  if (!resolvedRunDir.startsWith(`${runRoot}${path.sep}`)) {
    throw new Error(`Refusing to reset live e2e run directory outside ${runRoot}: ${resolvedRunDir}`);
  }

  const pidPath = path.join(runDir, "bridge.pid");
  const existingPid = fs.existsSync(pidPath)
    ? Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10)
    : 0;
  if (processIsRunning(existingPid)) {
    throw new Error(
      `Refusing to prepare ${runId} because its previous bridge process is still running with PID ${existingPid}. Run \`npm run e2e-live -- stop ${runId}\` first.`
    );
  }
  const existingMetadataPath = path.join(runDir, "run.json");
  const existingMetadata = fs.existsSync(existingMetadataPath) ? readJsonFile(existingMetadataPath) : { runId };
  const staleListener = findRunAppServerListenerPid(existingMetadata);
  if (staleListener.reachable) {
    throw new Error(
      `Refusing to prepare ${runId} because its previous app-server listener is still reachable at ${staleListener.listenUrl}${
        staleListener.pid ? ` with PID ${staleListener.pid}` : ""
      }. Run \`npm run e2e-live -- stop ${runId}\` first.`
    );
  }

  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function resolveCodexHome(env = process.env) {
  const explicit = env.CODEX_HOME && String(env.CODEX_HOME).trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), ".codex");
}

function collectRecentSessionFiles(directory, cutoffMs, files = []) {
  if (files.length >= SESSION_SCOPE_MAX_FILES || !fs.existsSync(directory)) {
    return files;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (files.length >= SESSION_SCOPE_MAX_FILES) {
      break;
    }
    const fullPath = path.join(directory, entry.name);
    let stats;
    try {
      stats = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (entry.isDirectory()) {
      collectRecentSessionFiles(fullPath, cutoffMs, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || stats.mtimeMs < cutoffMs) {
      continue;
    }
    files.push({ filePath: fullPath, mtimeMs: stats.mtimeMs, size: stats.size });
  }

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, SESSION_SCOPE_MAX_FILES);
}

function readSessionTail(filePath, size, maxBytes = 96 * 1024) {
  try {
    const length = Math.min(size, maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, Math.max(0, size - length));
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function extractThreadIdFromSessionPath(filePath) {
  const match = path.basename(filePath).match(THREAD_ID_PATTERN);
  return match ? match[0] : null;
}

function resolveCurrentCodexThreadId(repoRoot, { env = process.env, needles = [] } = {}) {
  const codexHome = resolveCodexHome(env);
  const sessionsDir = path.join(codexHome, "sessions");
  const cutoffMs = Date.now() - SESSION_SCOPE_LOOKBACK_MS;
  const candidates = collectRecentSessionFiles(sessionsDir, cutoffMs);
  const scored = [];

  for (const candidate of candidates) {
    const threadId = extractThreadIdFromSessionPath(candidate.filePath);
    if (!threadId) {
      continue;
    }
    const tail = readSessionTail(candidate.filePath, candidate.size);
    const matchedNeedles = needles.filter((needle) => needle && tail.includes(String(needle)));
    scored.push({
      threadId,
      filePath: candidate.filePath,
      matchedNeedles,
      score: candidate.mtimeMs + (matchedNeedles.length > 0 ? 10_000_000_000 : 0)
    });
  }

  scored.sort((left, right) => right.score - left.score);
  const best = scored[0] || null;
  if (!best) {
    return null;
  }
  return {
    threadId: best.threadId,
    source: best.matchedNeedles.length > 0 ? "session-file-match" : "newest-session-file",
    filePath: path.relative(repoRoot, best.filePath)
  };
}

function childEnvWithRun(baseEnv = process.env, metadata) {
  return buildChildEnv(baseEnv, {
    BRIDGE_CONFIG_PATH: metadata.configPath,
    STORE_PATH: metadata.storePath,
    CODEX_APP_SERVER_LISTEN_URL: metadata.appServerListenUrl || resolveRunAppServerListenUrl(metadata.runId),
    CODEX_MOBILE_LIVE_E2E_RUN_ID: metadata.runId,
    CODEX_MOBILE_LIVE_E2E_IGNORE_HELPER_COMMANDS: "1"
  });
}

function childEnvWithLocalRun(baseEnv = process.env, metadata) {
  return buildChildEnv(baseEnv, {
    BRIDGE_CONFIG_PATH: metadata.configPath,
    STORE_PATH: metadata.storePath,
    CODEX_APP_SERVER_LISTEN_URL: metadata.appServerListenUrl || resolveRunAppServerListenUrl(metadata.runId),
    CODEX_MOBILE_LIVE_E2E_RUN_ID: metadata.runId,
    CODEX_MOBILE_LIVE_E2E_IGNORE_HELPER_COMMANDS: "1",
    CODEX_MOBILE_PROVIDER: "local",
    DISCORD_BOT_TOKEN: baseEnv.DISCORD_BOT_TOKEN || "live-e2e-local-token",
    DISCORD_APPLICATION_ID: baseEnv.DISCORD_APPLICATION_ID || "live-e2e-local-application",
    DISCORD_GUILD_ID: baseEnv.DISCORD_GUILD_ID || "live-e2e-local-guild",
    DISCORD_CONTROLLER_USER_ID: baseEnv.DISCORD_CONTROLLER_USER_ID || "live-e2e-local-controller"
  });
}

function buildChildEnv(baseEnv = process.env, overrides = {}) {
  const result = {};
  const keyByLower = new Map();

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) {
      continue;
    }
    const lower = key.toLowerCase();
    const existingKey = keyByLower.get(lower);
    if (existingKey) {
      if (lower === "path" && key === "Path" && existingKey !== "Path") {
        delete result[existingKey];
        result[key] = value;
        keyByLower.set(lower, key);
      }
      continue;
    }
    result[key] = value;
    keyByLower.set(lower, key);
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      continue;
    }
    const lower = key.toLowerCase();
    const existingKey = keyByLower.get(lower);
    if (existingKey) {
      delete result[existingKey];
    }
    result[key] = String(value);
    keyByLower.set(lower, key);
  }

  return result;
}

function childEnvWithRepoDotenv(repoRoot, env = process.env) {
  const result = buildChildEnv(env);
  const dotenvPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(dotenvPath)) {
    return result;
  }

  const parsed = dotenv.parse(fs.readFileSync(dotenvPath));
  for (const [key, value] of Object.entries(parsed)) {
    const existingKey = Object.keys(result).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (!existingKey) {
      result[key] = value;
    }
  }
  return result;
}

function ensureBuiltIndex(repoRoot) {
  const indexJs = path.join(repoRoot, "dist", "src", "index.js");
  if (!fs.existsSync(indexJs)) {
    throw new Error("dist/src/index.js is missing. Run `npm run build` first.");
  }
  return indexJs;
}

function pidPathForRun(metadata) {
  return path.join(path.dirname(metadata.storePath), "bridge.pid");
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parsePortFromListenUrl(listenUrl) {
  try {
    const parsed = new URL(listenUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "http:" && parsed.protocol !== "tcp:") {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
      return null;
    }
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

function findWindowsListeningPidOnPort(port) {
  if (process.platform !== "win32" || !Number.isInteger(port)) {
    return null;
  }
  const result = childProcess.spawnSync("netstat", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const portPattern = new RegExp(`(?:^|\\s)(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|\\[::\\]|::1|::):${port}\\s`, "i");
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line) || !portPattern.test(line)) {
      continue;
    }
    const pid = Number.parseInt(line.trim().split(/\s+/).at(-1) || "", 10);
    if (Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  }
  return null;
}

function findRunAppServerListenerPid(metadata) {
  const listenUrl = metadata.appServerListenUrl || resolveRunAppServerListenUrl(metadata.runId);
  const port = parsePortFromListenUrl(listenUrl);
  const pid = port ? findWindowsListeningPidOnPort(port) : null;
  return {
    listenUrl,
    port,
    pid,
    reachable: Boolean(pid && processIsRunning(pid))
  };
}

function canConnectToListenUrl(listenUrl, timeoutMs = 250) {
  const port = parsePortFromListenUrl(listenUrl);
  if (!port) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port
    });
    let settled = false;
    const finish = (reachable) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitUntilProcessStops(pid, timeoutMs = STOP_WAIT_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!processIsRunning(pid)) {
      return true;
    }
    await sleep(STOP_WAIT_POLL_MS);
  }
  return !processIsRunning(pid);
}

async function waitUntilRunStops(metadata, pid, timeoutMs = STOP_WAIT_TIMEOUT_MS) {
  const listenUrl = metadata.appServerListenUrl || resolveRunAppServerListenUrl(metadata.runId);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const processStopped = !processIsRunning(pid);
    const listenerStopped = !(await canConnectToListenUrl(listenUrl));
    if (processStopped && listenerStopped) {
      return true;
    }
    await sleep(STOP_WAIT_POLL_MS);
  }
  return !processIsRunning(pid) && !(await canConnectToListenUrl(listenUrl));
}

function killProcessTree(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, output: `Invalid PID ${pid}.` };
  }
  if (process.platform === "win32") {
    const result = childProcess.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true
    });
    return {
      ok: !result.error && result.status === 0,
      output: `${result.stdout || ""}${result.stderr || ""}`.trim()
    };
  }
  try {
    process.kill(-pid, signal);
    return { ok: true, output: `Sent ${signal} to process group ${pid}.` };
  } catch (groupError) {
    try {
      process.kill(pid, signal);
      return { ok: true, output: `Sent ${signal} to process ${pid}.` };
    } catch (processError) {
      return {
        ok: false,
        output: processError instanceof Error ? processError.message : String(groupError)
      };
    }
  }
}

async function stopRunAppServerListener(metadata, lines) {
  const listener = findRunAppServerListenerPid(metadata);
  const reachable = listener.reachable || (await canConnectToListenUrl(listener.listenUrl));
  if (!reachable) {
    return false;
  }
  if (!listener.pid) {
    lines.push(`App-server listener ${listener.listenUrl} is still reachable, but no listener PID could be resolved.`);
    return false;
  }
  const killed = killProcessTree(listener.pid, "SIGTERM");
  lines.push(
    `Stopped lingering app-server listener ${listener.listenUrl} with PID ${listener.pid}.`
  );
  if (killed.output) {
    lines.push(killed.output);
  }
  const stopped = await waitUntilProcessStops(listener.pid);
  lines.push(
    stopped
      ? `App-server listener PID ${listener.pid} stopped.`
      : `App-server listener PID ${listener.pid} is still running after ${STOP_WAIT_TIMEOUT_MS}ms.`
  );
  return stopped;
}

function readFileTail(filePath, maxChars = 4000) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.length > maxChars ? content.slice(content.length - maxChars) : content;
  } catch {
    return "";
  }
}

function waitForEarlyChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(result);
    };
    const onExit = (code, signal) => finish({ code, signal });
    const onError = (error) => finish({ error });
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function scenarioChannelKind(scenario) {
  const actionType = scenario.action?.type;
  return ["subagent-final", "subagent-approval-request", "subagent-proposed-plan"].includes(actionType)
    ? "subagent"
    : "conversation";
}

function parseTimeMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function loadThreadMarkerEvidence(database, marker) {
  const evidence = new Map();
  if (!marker) {
    return evidence;
  }

  const likeMarker = `%${marker}%`;
  const addEvidence = (threadId, createdAt = null) => {
    const normalizedThreadId = String(threadId || "");
    if (!normalizedThreadId) {
      return;
    }
    const existing = evidence.get(normalizedThreadId) || {
      count: 0,
      latestAt: null
    };
    const existingMs = parseTimeMs(existing.latestAt);
    const createdMs = parseTimeMs(createdAt);
    evidence.set(normalizedThreadId, {
      count: existing.count + 1,
      latestAt: createdMs > existingMs ? String(createdAt) : existing.latestAt
    });
  };

  if (hasSqliteTable(database, "canonical_thread_events")) {
    for (const row of database
      .prepare(
        [
          "SELECT thread_id, created_at",
          "FROM canonical_thread_events",
          "WHERE COALESCE(summary, '') LIKE ? OR COALESCE(detail, '') LIKE ?"
        ].join(" ")
      )
      .all(likeMarker, likeMarker)) {
      addEvidence(row.thread_id, row.created_at);
    }
  }

  if (hasSqliteTable(database, "mirrored_items")) {
    const evidenceColumn = hasSqliteColumn(database, "mirrored_items", "updated_at") ? "updated_at" : "timestamp_ms";
    for (const row of database
      .prepare(
        [
          `SELECT thread_id, ${evidenceColumn} AS evidence_at`,
          "FROM mirrored_items",
          "WHERE COALESCE(rendered_content, '') LIKE ?"
        ].join(" ")
      )
      .all(likeMarker)) {
      addEvidence(row.thread_id, normalizeSqliteEvidenceTime(row.evidence_at));
    }
  }

  if (hasSqliteTable(database, "message_details")) {
    const evidenceColumn = hasSqliteColumn(database, "message_details", "updated_at") ? "updated_at" : "NULL";
    for (const row of database
      .prepare(
        [
          `SELECT thread_id, ${evidenceColumn} AS evidence_at`,
          "FROM message_details",
          "WHERE COALESCE(title, '') LIKE ?",
          "OR COALESCE(button_label, '') LIKE ?",
          "OR COALESCE(detail, '') LIKE ?"
        ].join(" ")
      )
      .all(likeMarker, likeMarker, likeMarker)) {
      addEvidence(row.thread_id, normalizeSqliteEvidenceTime(row.evidence_at));
    }
  }

  if (hasSqliteTable(database, "proposed_plan_actions")) {
    for (const row of database
      .prepare(
        [
          "SELECT thread_id, created_at",
          "FROM proposed_plan_actions",
          "WHERE COALESCE(plan_text, '') LIKE ?"
        ].join(" ")
      )
      .all(likeMarker)) {
      addEvidence(row.thread_id, row.created_at);
    }
  }

  return evidence;
}

function loadExpectedDiscordMessageIds(database, scenario, marker, threadId) {
  if (!threadId) {
    return [];
  }

  const variables = {
    marker,
    scenarioId: scenario.id,
    threadId,
    channel: ""
  };
  const expected = templateList(scenario.expect?.discordContains || [], variables).filter(Boolean);
  if (expected.length === 0) {
    return [];
  }

  const messageIds = [];

  if (
    hasSqliteTable(database, "mirrored_items") &&
    hasSqliteColumn(database, "mirrored_items", "discord_message_id")
  ) {
    const orderColumns = [
      hasSqliteColumn(database, "mirrored_items", "timestamp_ms") ? "timestamp_ms ASC" : null,
      hasSqliteColumn(database, "mirrored_items", "cursor") ? "cursor ASC" : null,
      "item_id ASC"
    ].filter(Boolean);
    const rows = database
      .prepare(
        [
          "SELECT discord_message_id, rendered_content",
          "FROM mirrored_items",
          "WHERE thread_id = ?",
          "AND COALESCE(discord_message_id, '') <> ''",
          `ORDER BY ${orderColumns.join(", ")}`
        ].join(" ")
      )
      .all(threadId);
    for (const row of rows) {
      const renderedContent = String(row.rendered_content || "");
      if (expected.some((needle) => renderedContent.includes(needle))) {
        const messageId = String(row.discord_message_id || "");
        if (messageId && !messageIds.includes(messageId)) {
          messageIds.push(messageId);
        }
      }
    }
  }

  if (
    hasSqliteTable(database, "proposed_plan_actions") &&
    hasSqliteColumn(database, "proposed_plan_actions", "discord_message_id")
  ) {
    const rows = database
      .prepare(
        [
          "SELECT discord_message_id, plan_text",
          "FROM proposed_plan_actions",
          "WHERE thread_id = ?",
          "AND COALESCE(discord_message_id, '') <> ''",
          "ORDER BY created_at ASC, token ASC"
        ].join(" ")
      )
      .all(threadId);
    for (const row of rows) {
      const planText = String(row.plan_text || "");
      if (expected.some((needle) => planText.includes(needle))) {
        const messageId = String(row.discord_message_id || "");
        if (messageId && !messageIds.includes(messageId)) {
          messageIds.push(messageId);
        }
      }
    }
  }

  return messageIds;
}

function loadRunChannelCandidates(metadata, scenario, marker = null) {
  if (!fs.existsSync(metadata.storePath)) {
    return [];
  }

  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (error) {
    throw new Error(
      `Unable to load better-sqlite3 for live e2e channel auto-selection: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const database = new Database(metadata.storePath, { readonly: true, fileMustExist: true });
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_bridges'")
      .get();
    if (!table) {
      return [];
    }

    const markerEvidence = loadThreadMarkerEvidence(database, marker);
    const rows = database
      .prepare(
        [
          "SELECT codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id,",
          "project_name, thread_name, last_seen_at",
          "FROM thread_bridges",
          "WHERE discord_channel_id IS NOT NULL",
          "AND COALESCE(channel_kind, 'conversation') = ?",
          "ORDER BY last_seen_at DESC"
        ].join(" ")
      )
      .all(scenarioChannelKind(scenario));

    return rows.map((row) => {
      const codexThreadId = String(row.codex_thread_id || "");
      const threadEvidence = markerEvidence.get(codexThreadId) || {
        count: 0,
        latestAt: null
      };
      return {
        codexThreadId,
        discordChannelId: String(row.discord_channel_id || ""),
        channelKind: String(row.channel_kind || "conversation"),
        parentCodexThreadId: row.parent_codex_thread_id ? String(row.parent_codex_thread_id) : null,
        projectName: row.project_name ? String(row.project_name) : null,
        threadName: row.thread_name ? String(row.thread_name) : null,
        lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
        markerEvidenceCount: threadEvidence.count,
        markerEvidenceLatestAt: threadEvidence.latestAt,
        expectedDiscordMessageIds: loadExpectedDiscordMessageIds(database, scenario, marker, codexThreadId)
      };
    });
  } finally {
    database.close();
  }
}

function sortCandidatesNewestFirst(candidates) {
  return [...candidates].sort((left, right) => {
    const leftMarkerMs = parseTimeMs(left.markerEvidenceLatestAt);
    const rightMarkerMs = parseTimeMs(right.markerEvidenceLatestAt);
    if (leftMarkerMs !== rightMarkerMs) {
      return rightMarkerMs - leftMarkerMs;
    }
    return parseTimeMs(right.lastSeenAt) - parseTimeMs(left.lastSeenAt);
  });
}

function selectRunChannel(metadata, scenario, marker = null) {
  return selectRunChannels(metadata, scenario, marker)[0] || null;
}

function selectRunChannels(metadata, scenario, marker = null) {
  const candidates = loadRunChannelCandidates(metadata, scenario, marker).filter((candidate) => candidate.discordChannelId);
  if (candidates.length === 0) {
    return [];
  }

  const absenceOnly = Boolean(scenario.expect?.absenceOnly);
  const markerCandidates = marker ? candidates.filter((candidate) => candidate.markerEvidenceCount > 0) : [];
  if (marker && markerCandidates.length === 0 && !absenceOnly) {
    return [];
  }
  if (markerCandidates.length > 0) {
    return sortCandidatesNewestFirst(markerCandidates);
  }

  const createdAtMs = parseTimeMs(metadata.createdAt);
  const freshCandidates =
    createdAtMs > 0
      ? candidates.filter((candidate) => parseTimeMs(candidate.lastSeenAt) + 2000 >= createdAtMs)
      : [];
  return sortCandidatesNewestFirst(freshCandidates.length > 0 ? freshCandidates : candidates);
}

function formatChannelSelection(candidate) {
  if (!candidate) {
    return "manual";
  }
  const name = candidate.threadName ? ` name="${candidate.threadName}"` : "";
  const parent = candidate.parentCodexThreadId ? ` parent=${candidate.parentCodexThreadId}` : "";
  const markerEvidence = candidate.markerEvidenceCount ? ` markerEvidence=${candidate.markerEvidenceCount}` : "";
  const messageIds =
    candidate.expectedDiscordMessageIds && candidate.expectedDiscordMessageIds.length > 0
      ? ` messages=${candidate.expectedDiscordMessageIds.join(",")}`
      : "";
  return `auto ${candidate.channelKind} ${candidate.discordChannelId} codex=${candidate.codexThreadId}${parent}${name}${markerEvidence}${messageIds}`;
}

function hasSqliteTable(database, tableName) {
  return Boolean(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );
}

function hasSqliteColumn(database, tableName, columnName) {
  return database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((row) => row.name === columnName);
}

function normalizeSqliteEvidenceTime(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const numericValue = Number.parseInt(value, 10);
    return Number.isFinite(numericValue) && numericValue > 0 ? new Date(numericValue).toISOString() : null;
  }
  return value ? String(value) : null;
}

function openReadonlyDatabase(databasePath) {
  if (!fs.existsSync(databasePath)) {
    return null;
  }

  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (error) {
    throw new Error(
      `Unable to load better-sqlite3 for live e2e store verification: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return new Database(databasePath, { readonly: true, fileMustExist: true });
}

function loadRunStartupReadiness(metadata) {
  if (!metadata.scopedThreadId) {
    return {
      mapped: true,
      sessionCursorReady: true,
      startupReady: true
    };
  }

  let database;
  try {
    database = openReadonlyDatabase(metadata.storePath);
  } catch {
    return {
      mapped: false,
      sessionCursorReady: false,
      startupReady: false
    };
  }
  if (!database) {
    return {
      mapped: false,
      sessionCursorReady: false,
      startupReady: false
    };
  }

  try {
    const bridge =
      hasSqliteTable(database, "thread_bridges")
        ? database
            .prepare(
              [
                "SELECT discord_channel_id",
                "FROM thread_bridges",
                "WHERE codex_thread_id = ?",
                "AND COALESCE(channel_kind, 'conversation') = 'conversation'"
              ].join(" ")
            )
            .get(metadata.scopedThreadId)
        : null;
    const cursor =
      hasSqliteTable(database, "session_log_cursors")
        ? database
            .prepare("SELECT thread_id FROM session_log_cursors WHERE thread_id = ?")
            .get(metadata.scopedThreadId)
        : null;
    const startupReady =
      hasSqliteTable(database, "schema_meta")
        ? database
            .prepare("SELECT value FROM schema_meta WHERE key = ?")
            .get(BRIDGE_STARTUP_READY_META_KEY)
        : null;

    return {
      mapped: Boolean(bridge?.discord_channel_id),
      sessionCursorReady: Boolean(cursor),
      startupReady: Boolean(startupReady?.value)
    };
  } finally {
    database.close();
  }
}

function formatStartupReadiness(readiness) {
  return `mapped=${readiness.mapped ? "yes" : "no"} sessionCursor=${
    readiness.sessionCursorReady ? "yes" : "no"
  } startupReady=${readiness.startupReady ? "yes" : "no"}`;
}

async function waitForRunStartupReady(metadata, childPid, options = {}) {
  if (!metadata.scopedThreadId) {
    return null;
  }

  const timeoutMs =
    typeof options.startReadyTimeoutMs === "number" ? options.startReadyTimeoutMs : START_READY_TIMEOUT_MS;
  if (timeoutMs <= 0) {
    return null;
  }

  const deadline = Date.now() + timeoutMs;
  let lastReadiness = loadRunStartupReadiness(metadata);
  while (Date.now() <= deadline) {
    if (lastReadiness.mapped && lastReadiness.sessionCursorReady && lastReadiness.startupReady) {
      return `Readiness: scoped thread ${metadata.scopedThreadId} mapped, session cursor initialized, and startup completed.`;
    }
    if (childPid && !processIsRunning(childPid)) {
      throw new Error(
        `Live e2e bridge for ${metadata.runId} exited before scoped startup readiness (${formatStartupReadiness(
          lastReadiness
        )}).`
      );
    }
    await sleep(Math.min(START_READY_POLL_MS, Math.max(0, deadline - Date.now())));
    lastReadiness = loadRunStartupReadiness(metadata);
  }

  throw new Error(
    `Timed out waiting for live e2e bridge ${metadata.runId} to initialize scoped thread ${
      metadata.scopedThreadId
    } (${formatStartupReadiness(lastReadiness)}).`
  );
}

function loadRunStoreSnapshot(metadata, scenario, selectedOverride = null, marker = null) {
  const database = openReadonlyDatabase(metadata.storePath);
  if (!database) {
    return {
      selected: null,
      lines: [],
      assertionText: "",
      text: ""
    };
  }

  try {
    if (!hasSqliteTable(database, "thread_bridges")) {
      return {
        selected: null,
        lines: [],
        assertionText: "",
        text: ""
      };
    }

    const selected = selectedOverride || selectRunChannel(metadata, scenario, marker);
    if (!selected) {
      return {
        selected,
        lines: [],
        assertionText: "",
        text: ""
      };
    }

    const itemRows = hasSqliteTable(database, "mirrored_items")
      ? database
          .prepare(
            [
              "SELECT item_id, kind, rendered_content",
              "FROM mirrored_items",
              "WHERE thread_id = ?",
              "ORDER BY timestamp_ms ASC, cursor ASC, item_id ASC"
            ].join(" ")
          )
          .all(selected.codexThreadId)
      : [];
    const detailRows = hasSqliteTable(database, "message_details")
      ? database
          .prepare(
            [
              "SELECT kind, title, button_label, detail, updated_at",
              "FROM message_details",
              "WHERE thread_id = ?",
              "ORDER BY updated_at ASC, token ASC"
            ].join(" ")
          )
          .all(selected.codexThreadId)
      : [];
    const approvalRows = hasSqliteTable(database, "pending_approvals")
      ? database
          .prepare(
            [
              "SELECT kind, status, request_id, item_id, discord_message_id, available_decisions, sanitized_preview",
              "FROM pending_approvals",
              "WHERE thread_id = ?",
              "ORDER BY created_at ASC, token ASC"
            ].join(" ")
          )
          .all(selected.codexThreadId)
      : [];
    const proposedPlanRows = hasSqliteTable(database, "proposed_plan_actions")
      ? database
          .prepare(
            [
              "SELECT status, item_id, discord_message_id, plan_text",
              "FROM proposed_plan_actions",
              "WHERE thread_id = ?",
              "ORDER BY created_at ASC, token ASC"
            ].join(" ")
          )
          .all(selected.codexThreadId)
      : [];
    const contentLines = [
      ...itemRows.map((row) => `${row.kind} ${row.item_id}: ${String(row.rendered_content || "").replace(/\s+/g, " ").trim()}`),
      ...detailRows.map((row) =>
        `detail ${row.kind} ${row.button_label || ""} ${row.title || ""}: ${String(row.detail || "").replace(/\s+/g, " ").trim()}`
      ),
      ...approvalRows.map((row) =>
        `approval ${row.kind} status=${row.status} request=${row.request_id} item=${row.item_id} message=${row.discord_message_id || "(none)"} decisions=${row.available_decisions || "[]"} preview=${String(row.sanitized_preview || "").replace(/\s+/g, " ").trim()}`
      ),
      ...proposedPlanRows.map((row) =>
        `proposed-plan status=${row.status} item=${row.item_id} message=${row.discord_message_id || "(none)"} plan=${String(row.plan_text || "").replace(/\s+/g, " ").trim()}`
      )
    ];
    const lines = [
      `thread ${selected.codexThreadId}: ${formatChannelSelection(selected)}`,
      ...contentLines
    ];
    return {
      selected,
      lines,
      assertionText: contentLines.join("\n"),
      text: lines.join("\n")
    };
  } finally {
    database.close();
  }
}

function loadRunStoreSnapshots(metadata, scenario, marker = null) {
  const candidates = selectRunChannels(metadata, scenario, marker);
  if (candidates.length === 0) {
    return [loadRunStoreSnapshot(metadata, scenario, null, marker)];
  }
  return candidates.map((candidate) => loadRunStoreSnapshot(metadata, scenario, candidate, marker));
}

function normalizeMarkerToken(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function defaultMarkerForScenario(scenarioId, runId) {
  return `LIVE_E2E_${normalizeMarkerToken(scenarioId)}_${normalizeMarkerToken(runId)}`;
}

function templateString(value, variables) {
  return String(value).replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match
  );
}

function templateList(values, variables) {
  return (Array.isArray(values) ? values : []).map((value) => templateString(value, variables));
}

function copyApprovalsFromBaseConfig(baseConfig) {
  const baseApprovals = isPlainObject(baseConfig.approvals) ? baseConfig.approvals : {};
  const allowFromDiscord =
    typeof baseApprovals.allowFromDiscord === "boolean" ? baseApprovals.allowFromDiscord : true;
  const approvals = {
    allowFromDiscord,
    mentionApprovers:
      typeof baseApprovals.mentionApprovers === "boolean"
        ? baseApprovals.mentionApprovers
        : allowFromDiscord
  };

  if (baseApprovals.approvalTtlMinutes !== undefined) {
    approvals.approvalTtlMinutes = baseApprovals.approvalTtlMinutes;
  }

  return approvals;
}

function copyMessageWriteBacksFromBaseConfig(baseConfig, approvals) {
  const baseMessageWriteBacks = isPlainObject(baseConfig.messageWriteBacks) ? baseConfig.messageWriteBacks : {};
  const allowFromDiscord =
    typeof baseMessageWriteBacks.allowFromDiscord === "boolean"
      ? baseMessageWriteBacks.allowFromDiscord
      : approvals.allowFromDiscord;
  return {
    allowFromDiscord
  };
}

function buildScenarioConfig(manifest, scenario, baseConfig) {
  const config = deepClone(manifest.baseConfig || {});
  config.approvals = copyApprovalsFromBaseConfig(baseConfig);
  config.messageWriteBacks = copyMessageWriteBacksFromBaseConfig(baseConfig, config.approvals);
  deepMerge(config, scenario.config || {});
  return config;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function formatActionSteps(scenario, variables) {
  const action = scenario.action || {};
  const lines = [];
  if (action.type) {
    lines.push(`Action type: ${action.type}`);
  }
  if (action.description) {
    lines.push(templateString(action.description, variables));
  }
  const steps = templateList(action.steps || [], variables);
  if (steps.length > 0) {
    lines.push("Action steps:");
    steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
  return lines.join("\n");
}

function prepareScenario(scenarioId, argvOptions, options = {}) {
  const repoRoot = resolveRepoRoot(options);
  const manifest = loadManifest(repoRoot);
  const scenario = findScenario(manifest, scenarioId);
  if (!scenario) {
    throw new Error(`Unknown live e2e scenario: ${scenarioId}`);
  }

  const runId = argvOptions["run-id"];
  validateRunId(runId);
  if (scenario.action?.type === "initial-user-message" && !argvOptions.marker) {
    throw new Error(
      `Scenario ${scenarioId} requires --marker set to an exact distinctive substring from the initial user request that started this live test.`
    );
  }
  if (scenario.action?.type !== "initial-user-message" && argvOptions.marker) {
    throw new Error(
      `Scenario ${scenarioId} does not accept --marker. Use the generated marker printed by prepare for non-user-message scenarios.`
    );
  }
  const marker = argvOptions.marker || defaultMarkerForScenario(scenarioId, runId);
  const surface =
    argvOptions.surface === "discord" || argvOptions.surface === "store"
      ? argvOptions.surface
      : scenario.defaultSurface === "discord"
        ? "discord"
        : "store";
  const baseConfigPath = path.join(repoRoot, DEFAULT_BRIDGE_CONFIG_PATH);
  const baseConfig = readJsonFile(baseConfigPath, { allowComments: true });
  const runDir = resetRunDirectoryForPrepare(repoRoot, runId);
  const configPath = path.join(runDir, "bridge.config.json");
  const storePath = path.join(runDir, "bridge.sqlite");
  const reportPath = path.join(runDir, "report.md");
  const runMetadataPath = path.join(runDir, "run.json");
  const appServerListenUrl = resolveRunAppServerListenUrl(runId);
  const scenarioConfig = buildScenarioConfig(manifest, scenario, baseConfig);
  let threadScope = null;
  if (surface === "discord") {
    const explicitThreadId = argvOptions["thread-id"] || argvOptions["codex-thread-id"];
    if (explicitThreadId) {
      validateThreadId(explicitThreadId);
      threadScope = {
        threadId: explicitThreadId,
        source: "explicit"
      };
    } else {
      threadScope = resolveCurrentCodexThreadId(repoRoot, {
        env: options.env || process.env,
        needles: [runId, scenarioId, marker]
      });
      if (!threadScope) {
        throw new Error(
          "Could not resolve the current Codex thread id for Discord-surface live e2e. Re-run prepare with `--thread-id <codex-thread-id>`; unscoped Discord e2e runs are refused."
        );
      }
    }
    scenarioConfig.discovery = {
      ...(scenarioConfig.discovery || {}),
      allowedThreadIds: [threadScope.threadId],
      projectNamePrefix: `e2e-${runId}`.slice(0, 60)
    };
  }
  const variables = {
    marker,
    runId,
    scenarioId,
    configPath,
    storePath,
    reportPath,
    appServerListenUrl
  };

  fs.writeFileSync(configPath, `${JSON.stringify(scenarioConfig, null, 2)}\n`, "utf8");
  const runMetadata = {
    scenarioId,
    testId: scenario.testId,
    playbook: scenario.playbook,
    runId,
    marker,
    configPath,
    storePath,
    reportPath,
    appServerListenUrl,
    surface,
    scopedThreadId: threadScope?.threadId || null,
    scopeSource: threadScope?.source || null,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(runMetadataPath, `${JSON.stringify(runMetadata, null, 2)}\n`, "utf8");
  writeCurrentRunPointer(repoRoot, runMetadata);

  const output = [
    `Prepared live e2e scenario ${scenarioId}`,
    `Run ID: ${runId}`,
    `Marker: ${marker}`,
    `Config: ${configPath}`,
    `Store: ${storePath}`,
    `Report: ${reportPath}`,
    `App-server listener: ${appServerListenUrl}`,
    `Surface: ${surface}`,
    ...(threadScope
      ? [
          `Discovery scope: Codex thread ${threadScope.threadId} (${threadScope.source})`,
          `Discord namespace: ${scenarioConfig.discovery.projectNamePrefix}`
        ]
      : []),
    "",
    surface === "discord"
      ? "Start bridge (stable command for session approval):"
      : "Start local bridge (stable command for session approval):",
    surface === "discord" ? "npm run e2e-live -- start-current" : "npm run e2e-live -- start-local-current",
    surface === "discord"
      ? `Fallback with explicit run ID: npm run e2e-live -- start ${runId}`
      : `Fallback with explicit run ID: npm run e2e-live -- start-local ${runId}`,
    "",
    formatActionSteps(scenario, variables),
    "",
    surface === "discord" ? "Verify the scoped Discord channel/thread:" : "Verify the scoped local store thread:",
    `npm run e2e-live -- verify ${scenarioId} --run-id ${runId}`,
    ...(surface === "discord"
      ? [
          "",
          "If auto-selection cannot identify the channel/thread:",
          `npm run e2e-live -- inspect-discord ${runId}`,
          `npm run e2e-live -- verify ${scenarioId} --run-id ${runId} --channel <discord-channel-or-thread-id>`
        ]
      : []),
    "",
    "Cleanup:",
    surface === "discord" ? "npm run e2e-live -- cleanup-current" : "npm run e2e-live -- stop-current",
    surface === "discord"
      ? `Fallback with explicit run ID: npm run e2e-live -- cleanup ${runId}`
      : `Fallback with explicit run ID: npm run e2e-live -- stop ${runId}`,
    surface === "discord"
      ? "This stops the run-scoped bridge, then runs the bridge clean path with this run's temp config/store to delete bridge-managed Discord structure."
      : "Store-surface cleanup only stops the run-scoped local bridge process; it does not touch Discord."
  ].join("\n");

  return { output, configPath, storePath, marker, runMetadataPath };
}

function extractMatchingLines(text, needles) {
  const lines = text.split(/\r?\n/);
  const matches = [];
  for (const needle of needles) {
    const line = lines.find((candidate) => candidate.includes(needle));
    matches.push({ needle, line: line || null });
  }
  return matches;
}

function truncateDiagnosticText(text, maxLength = 8000) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 80))}\n... truncated ${normalized.length - maxLength + 80} character(s) ...`;
}

function indentDiagnosticLines(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return ["  (none)"];
  }
  return normalized.split(/\r?\n/).map((line) => `  ${line}`);
}

function formatErrorForOutput(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const code = typeof error.code === "string" && error.code ? ` [${error.code}]` : "";
  const base = error.message && error.message.trim() ? error.message : `${error.name || "Error"}${code}`;
  if (error instanceof AggregateError && Array.isArray(error.errors) && error.errors.length > 0) {
    const details = error.errors
      .map((inner) => (inner instanceof Error ? formatErrorForOutput(inner) : String(inner)))
      .filter(Boolean)
      .join("\n");
    return details ? `${base}\n${details}` : base;
  }
  return base;
}

function formatDiscordVerificationDiagnostics(runMetadata, scenario, marker, channelId, inspectionText) {
  const diagnostics = ["", "Selected store snapshot:"];
  let snapshot = null;
  if (runMetadata && channelId) {
    const selectedCandidate =
      selectRunChannels(runMetadata, scenario, marker).find(
        (candidate) => candidate.discordChannelId === channelId
      ) || null;
    snapshot = loadRunStoreSnapshot(runMetadata, scenario, selectedCandidate, marker);
  }
  if (snapshot?.lines?.length) {
    diagnostics.push(...snapshot.lines.map((line) => `  ${line}`));
  } else {
    diagnostics.push("  (no selected store rows)");
  }

  diagnostics.push("", "Last Discord inspect output:");
  diagnostics.push(...indentDiagnosticLines(truncateDiagnosticText(inspectionText, 12000)));
  return diagnostics;
}

function extractInspectSection(text, title) {
  const lines = text.split(/\r?\n/);
  const header = `== ${title} ==`;
  const startIndex = lines.findIndex((line) => line.trim() === header);
  if (startIndex < 0) {
    return "";
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^== .+ ==$/.test(lines[index].trim())) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join("\n");
}

function extractDiscordAssertionText(inspectionText) {
  return ["Discord Thread Inspect", "Discord Messages"]
    .map((title) => extractInspectSection(inspectionText, title))
    .filter((section) => section.trim() !== "")
    .join("\n");
}

function withTemporaryProcessContext({ cwd, env }, callback) {
  const previousEnv = process.env;
  const previousCwd = process.cwd();
  process.env = env ? { ...env } : process.env;
  if (cwd) {
    process.chdir(cwd);
  }
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (cwd) {
        process.chdir(previousCwd);
      }
      process.env = previousEnv;
    });
}

async function captureConsoleOutput(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = "";
  let stderr = "";
  console.log = (...args) => {
    stdout += `${args.map((arg) => String(arg)).join(" ")}\n`;
  };
  console.error = (...args) => {
    stderr += `${args.map((arg) => String(arg)).join(" ")}\n`;
  };

  try {
    await callback();
    return { stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function inspectDiscordThread(repoRoot, channelId, limit, options = {}) {
  if (options.inspectDiscordThread) {
    return await options.inspectDiscordThread(repoRoot, channelId, limit, options);
  }

  const indexJs = ensureBuiltIndex(repoRoot);
  const env = childEnvWithRepoDotenv(repoRoot, options.env || process.env);

  try {
    const output = await withTemporaryProcessContext({ cwd: repoRoot, env }, async () =>
      captureConsoleOutput(async () => {
        const indexModule = await import(pathToFileURL(indexJs).href);
        if (typeof indexModule.runInspectDiscordThread !== "function") {
          throw new Error(`Built index does not export runInspectDiscordThread: ${indexJs}`);
        }
        await indexModule.runInspectDiscordThread(channelId, limit);
      })
    );
    return {
      status: 0,
      stdout: output.stdout,
      stderr: output.stderr,
      error: null
    };
  } catch (error) {
    return {
      status: 1,
      stdout: "",
      stderr: error instanceof Error ? error.stack || error.message : String(error),
      error
    };
  }
}

function resolveRunContext(env = process.env) {
  const configPath = env.BRIDGE_CONFIG_PATH || "";
  const storePath = env.STORE_PATH || "";
  const storeDir = storePath ? path.dirname(storePath) : "";
  const runMetadataPath = storeDir ? path.join(storeDir, "run.json") : "";
  let runMetadata = null;

  if (runMetadataPath && fs.existsSync(runMetadataPath)) {
    try {
      runMetadata = readJsonFile(runMetadataPath);
    } catch {
      runMetadata = null;
    }
  }

  return {
    runId: runMetadata?.runId || path.basename(storeDir) || "(unknown)",
    configPath: configPath || runMetadata?.configPath || "(default bridge.config.json)",
    storePath: storePath || runMetadata?.storePath || "(default STORE_PATH)",
    reportPath: runMetadata?.reportPath || (storeDir ? path.join(storeDir, "report.md") : null)
  };
}

function evaluateInspection(scenario, channelId, marker, inspectionText, options = {}) {
  const variables = { marker, channel: channelId, scenarioId: scenario.id };
  const scenarioExpect = scenario.expect || {};
  const assertionText = extractDiscordAssertionText(inspectionText);
  const expectedDiscordMessageIds = Array.isArray(options.expectedDiscordMessageIds)
    ? options.expectedDiscordMessageIds
    : [];
  const expected = [
    "Discord Thread Inspect",
    `Discord channel/thread: ${channelId}`,
    ...templateList(scenarioExpect.discordContains || [], variables),
    ...expectedDiscordMessageIds.map((messageId) => `id=${messageId}`)
  ];
  const forbidden = templateList(scenarioExpect.discordNotContains || [], variables);
  const missing = expected.filter((needle) => !assertionText.includes(needle));
  const presentForbidden = forbidden.filter((needle) => assertionText.includes(needle));

  return {
    assertionText,
    expected,
    forbidden,
    missing,
    presentForbidden,
    absenceOnly: Boolean(scenarioExpect.absenceOnly),
    hasScopedThread: assertionText.includes("Discord Thread Inspect") &&
      assertionText.includes(`Discord channel/thread: ${channelId}`)
  };
}

function evaluateStoreSnapshot(scenario, marker, snapshot) {
  const variables = {
    marker,
    scenarioId: scenario.id,
    threadId: snapshot.selected?.codexThreadId || "",
    channel: snapshot.selected?.discordChannelId || ""
  };
  const scenarioExpect = scenario.expect || {};
  const expected = templateList(
    Array.isArray(scenarioExpect.storeContains)
      ? scenarioExpect.storeContains
      : scenarioExpect.discordContains || [],
    variables
  );
  const forbidden = templateList(
    Array.isArray(scenarioExpect.storeNotContains)
      ? scenarioExpect.storeNotContains
      : scenarioExpect.discordNotContains || [],
    variables
  );
  const assertionText = snapshot.assertionText ?? snapshot.text;
  const missing = expected.filter((needle) => !assertionText.includes(needle));
  const presentForbidden = forbidden.filter((needle) => assertionText.includes(needle));

  return {
    expected,
    forbidden,
    missing,
    presentForbidden,
    absenceOnly: Boolean(scenarioExpect.absenceOnly),
    hasScopedThread: Boolean(snapshot.selected)
  };
}

function selectBestStoreEvaluation(snapshotEvaluations) {
  if (snapshotEvaluations.length === 0) {
    return null;
  }

  const withForbidden = snapshotEvaluations.find(({ evaluation }) => evaluation.presentForbidden.length > 0);
  if (withForbidden) {
    return withForbidden;
  }

  const complete = snapshotEvaluations.find(
    ({ evaluation }) => evaluation.hasScopedThread && !evaluation.absenceOnly && evaluation.missing.length === 0
  );
  if (complete) {
    return complete;
  }

  const absenceOnly = snapshotEvaluations.find(
    ({ evaluation }) => evaluation.hasScopedThread && evaluation.absenceOnly && evaluation.missing.length === 0
  );
  if (absenceOnly) {
    return absenceOnly;
  }

  return snapshotEvaluations
    .filter(({ evaluation }) => evaluation.hasScopedThread)
    .sort((left, right) => left.evaluation.missing.length - right.evaluation.missing.length)[0] || snapshotEvaluations[0];
}

function selectBestInspectionEvaluation(inspectionEvaluations) {
  if (inspectionEvaluations.length === 0) {
    return null;
  }

  const withForbidden = inspectionEvaluations.find(
    ({ evaluation }) => evaluation.hasScopedThread && evaluation.presentForbidden.length > 0
  );
  if (withForbidden) {
    return withForbidden;
  }

  const complete = inspectionEvaluations.find(
    ({ evaluation }) => evaluation.hasScopedThread && !evaluation.absenceOnly && evaluation.missing.length === 0
  );
  if (complete) {
    return complete;
  }

  const absenceOnly = inspectionEvaluations.find(
    ({ evaluation }) => evaluation.hasScopedThread && evaluation.absenceOnly && evaluation.missing.length === 0
  );
  if (absenceOnly) {
    return absenceOnly;
  }

  return (
    inspectionEvaluations
      .filter(({ evaluation }) => evaluation.hasScopedThread)
      .sort((left, right) => left.evaluation.missing.length - right.evaluation.missing.length)[0] ||
    inspectionEvaluations[0]
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyScenario(scenarioId, argvOptions, options = {}) {
  const repoRoot = resolveRepoRoot(options);
  const manifest = loadManifest(repoRoot);
  const scenario = findScenario(manifest, scenarioId);
  if (!scenario) {
    throw new Error(`Unknown live e2e scenario: ${scenarioId}`);
  }

  const requestedChannelId = argvOptions.channel || null;
  const runMetadata = argvOptions["run-id"] ? loadRunMetadata(repoRoot, argvOptions["run-id"]) : null;
  const marker = argvOptions.marker || runMetadata?.marker;
  if (!requestedChannelId && !runMetadata) {
    throw new Error("Missing required --channel <discord-channel-or-thread-id>.");
  }
  if (!marker) {
    throw new Error("Missing required --run-id <run-id> or --marker <marker>.");
  }

  const timeoutSeconds = Number.parseInt(
    argvOptions["timeout-seconds"] || scenario.timeoutSeconds || manifest.defaults?.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS,
    10
  );
  const inspectLimit = Number.parseInt(
    argvOptions.limit || scenario.inspectLimit || manifest.defaults?.inspectLimit || DEFAULT_INSPECT_LIMIT,
    10
  );
  const runEnv = runMetadata ? childEnvWithRun(options.env || process.env, runMetadata) : options.env;
  const runContext = runMetadata
    ? {
        runId: runMetadata.runId,
        configPath: runMetadata.configPath,
        storePath: runMetadata.storePath,
        reportPath: runMetadata.reportPath
      }
    : resolveRunContext(options.env || process.env);
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  let lastEvaluation = null;
  let lastInspectionText = "";
  let channelId = requestedChannelId;
  let channelSelection = requestedChannelId ? "manual" : null;
  let attempts = 0;

  while (Date.now() <= deadline) {
    attempts += 1;
    const candidates = requestedChannelId
      ? [
          {
            discordChannelId: requestedChannelId,
            selection: "manual"
          }
        ]
      : runMetadata
        ? selectRunChannels(runMetadata, scenario, marker).map((candidate) => ({
            discordChannelId: candidate.discordChannelId,
            selection: formatChannelSelection(candidate),
            expectedDiscordMessageIds: candidate.expectedDiscordMessageIds || []
          }))
        : [];

    if (candidates.length === 0) {
      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        await sleep(Math.max(0, deadline - Date.now()));
        continue;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const inspectionEvaluations = [];
    for (const candidate of candidates) {
      const inspection = await inspectDiscordThread(repoRoot, candidate.discordChannelId, inspectLimit, {
        ...options,
        env: runEnv
      });
      const inspectionText = `${inspection.stdout}${inspection.stderr ? `\n${inspection.stderr}` : ""}`;

      if (inspection.error) {
        throw inspection.error;
      }
      if (inspection.status !== 0) {
        throw new Error(`Inspection command failed with exit code ${inspection.status}.\n${inspectionText}`);
      }

      inspectionEvaluations.push({
        channelId: candidate.discordChannelId,
        channelSelection: candidate.selection,
        inspectionText,
        evaluation: evaluateInspection(scenario, candidate.discordChannelId, marker, inspectionText, {
          expectedDiscordMessageIds: candidate.expectedDiscordMessageIds || []
        })
      });
    }

    const best = selectBestInspectionEvaluation(inspectionEvaluations);
    if (!best) {
      throw new Error("Verification did not inspect any candidate Discord channels or threads.");
    }

    channelId = best.channelId;
    channelSelection = best.channelSelection;
    lastEvaluation = best.evaluation;
    lastInspectionText = best.inspectionText;

    if (lastEvaluation.hasScopedThread && lastEvaluation.presentForbidden.length > 0) {
      break;
    }
    if (lastEvaluation.hasScopedThread && !lastEvaluation.absenceOnly && lastEvaluation.missing.length === 0) {
      break;
    }
    if (
      lastEvaluation.hasScopedThread &&
      lastEvaluation.absenceOnly &&
      lastEvaluation.missing.length === 0 &&
      Date.now() >= deadline
    ) {
      break;
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      await sleep(Math.max(0, deadline - Date.now()));
      continue;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!lastEvaluation) {
    throw new Error("Verification could not auto-select a scoped Discord channel or thread before timeout.");
  }

  const matchingExpected = extractMatchingLines(lastEvaluation.assertionText, lastEvaluation.expected);
  const matchingForbidden = extractMatchingLines(lastEvaluation.assertionText, lastEvaluation.forbidden);
  const diagnosticLines = formatDiscordVerificationDiagnostics(
    runMetadata,
    scenario,
    marker,
    channelId,
    lastInspectionText
  );
  const reportLines = [
    `Scenario: ${scenarioId}`,
    `Run ID: ${runContext.runId}`,
    `Marker: ${marker}`,
    `Config: ${runContext.configPath}`,
    `Store: ${runContext.storePath}`,
    `Channel: ${channelId}`,
    `Channel selection: ${channelSelection || "manual"}`,
    `Attempts: ${attempts}`,
    `Absence-only: ${lastEvaluation.absenceOnly ? "yes" : "no"}`,
    "Cleanup status: pending; run `npm run clean` with the same temp environment after review.",
    "",
    "Expected evidence:",
    ...matchingExpected.map((match) => `- ${match.needle}: ${match.line || "(missing)"}`),
    "",
    "Forbidden evidence:",
    ...(matchingForbidden.length > 0
      ? matchingForbidden.map((match) => `- ${match.needle}: ${match.line || "(absent)"}`)
      : ["- (none configured)"])
  ];

  if (lastEvaluation.presentForbidden.length > 0) {
    const output = [
      "FAIL live e2e verification.",
      ...reportLines,
      ...diagnosticLines,
      "",
      `Forbidden content was present: ${lastEvaluation.presentForbidden.join(", ")}`
    ].join("\n");
    writeReportIfAvailable(runContext.reportPath, output);
    return {
      ok: false,
      output
    };
  }

  if (lastEvaluation.missing.length > 0) {
    const output = [
      "FAIL live e2e verification.",
      ...reportLines,
      ...diagnosticLines,
      "",
      `Expected content was missing: ${lastEvaluation.missing.join(", ")}`
    ].join("\n");
    writeReportIfAvailable(runContext.reportPath, output);
    return {
      ok: false,
      output
    };
  }

  const output = ["PASS live e2e verification.", ...reportLines].join("\n");
  writeReportIfAvailable(runContext.reportPath, output);
  return {
    ok: true,
    output
  };
}

async function verifyStoreScenario(scenarioId, argvOptions, options = {}) {
  const repoRoot = resolveRepoRoot(options);
  const manifest = loadManifest(repoRoot);
  const scenario = findScenario(manifest, scenarioId);
  if (!scenario) {
    throw new Error(`Unknown live e2e scenario: ${scenarioId}`);
  }

  const runMetadata = argvOptions["run-id"] ? loadRunMetadata(repoRoot, argvOptions["run-id"]) : null;
  if (!runMetadata) {
    throw new Error("Missing required --run-id <run-id>.");
  }
  const marker = argvOptions.marker || runMetadata.marker;
  if (!marker) {
    throw new Error("Missing required marker in run metadata.");
  }

  const timeoutSeconds = Number.parseInt(
    argvOptions["timeout-seconds"] || scenario.timeoutSeconds || manifest.defaults?.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS,
    10
  );
  const runContext = {
    runId: runMetadata.runId,
    configPath: runMetadata.configPath,
    storePath: runMetadata.storePath,
    reportPath: runMetadata.reportPath
  };
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  let lastSnapshot = {
    selected: null,
    lines: [],
    text: ""
  };
  let lastEvaluation = null;
  let attempts = 0;

  while (Date.now() <= deadline) {
    attempts += 1;
    const snapshotEvaluations = loadRunStoreSnapshots(runMetadata, scenario, marker).map((snapshot) => ({
      snapshot,
      evaluation: evaluateStoreSnapshot(scenario, marker, snapshot)
    }));
    const best = selectBestStoreEvaluation(snapshotEvaluations);
    if (!best) {
      throw new Error("Store verification did not load any snapshots.");
    }
    lastSnapshot = best.snapshot;
    lastEvaluation = best.evaluation;

    if (lastEvaluation.hasScopedThread && lastEvaluation.presentForbidden.length > 0) {
      break;
    }
    if (lastEvaluation.hasScopedThread && !lastEvaluation.absenceOnly && lastEvaluation.missing.length === 0) {
      break;
    }
    if (
      lastEvaluation.hasScopedThread &&
      lastEvaluation.absenceOnly &&
      lastEvaluation.missing.length === 0 &&
      Date.now() >= deadline
    ) {
      break;
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      await sleep(Math.max(0, deadline - Date.now()));
      continue;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!lastEvaluation) {
    throw new Error("Store verification did not run.");
  }

  const lastAssertionText = lastSnapshot.assertionText ?? lastSnapshot.text;
  const matchingExpected = extractMatchingLines(lastAssertionText, lastEvaluation.expected);
  const matchingForbidden = extractMatchingLines(lastAssertionText, lastEvaluation.forbidden);
  const reportLines = [
    `Scenario: ${scenarioId}`,
    `Surface: store`,
    `Run ID: ${runContext.runId}`,
    `Marker: ${marker}`,
    `Config: ${runContext.configPath}`,
    `Store: ${runContext.storePath}`,
    `Thread selection: ${formatChannelSelection(lastSnapshot.selected)}`,
    `Attempts: ${attempts}`,
    `Absence-only: ${lastEvaluation.absenceOnly ? "yes" : "no"}`,
    "Cleanup status: pending; run `npm run e2e-live -- stop-current` after review.",
    "",
    "Expected evidence:",
    ...(matchingExpected.length > 0
      ? matchingExpected.map((match) => `- ${match.needle}: ${match.line || "(missing)"}`)
      : ["- (none configured)"]),
    "",
    "Forbidden evidence:",
    ...(matchingForbidden.length > 0
      ? matchingForbidden.map((match) => `- ${match.needle}: ${match.line || "(absent)"}`)
      : ["- (none configured)"])
  ];

  if (!lastEvaluation.hasScopedThread) {
    const output = [
      "FAIL live e2e store verification.",
      ...reportLines,
      "",
      "No scoped thread mapping was found in the temp store."
    ].join("\n");
    writeReportIfAvailable(runContext.reportPath, output);
    return { ok: false, output };
  }

  if (lastEvaluation.presentForbidden.length > 0) {
    const output = [
      "FAIL live e2e store verification.",
      ...reportLines,
      "",
      `Forbidden content was present: ${lastEvaluation.presentForbidden.join(", ")}`
    ].join("\n");
    writeReportIfAvailable(runContext.reportPath, output);
    return { ok: false, output };
  }

  if (lastEvaluation.missing.length > 0) {
    const output = [
      "FAIL live e2e store verification.",
      ...reportLines,
      "",
      `Expected content was missing: ${lastEvaluation.missing.join(", ")}`
    ].join("\n");
    writeReportIfAvailable(runContext.reportPath, output);
    return { ok: false, output };
  }

  const output = ["PASS live e2e store verification.", ...reportLines].join("\n");
  writeReportIfAvailable(runContext.reportPath, output);
  return { ok: true, output };
}

function writeReportIfAvailable(reportPath, content) {
  if (!reportPath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${content}\n`, "utf8");
  } catch {
    // Verification output remains the source of truth if the report file cannot be written.
  }
}

async function startRun(repoRoot, runId, options = {}) {
  const metadata = loadRunMetadata(repoRoot, runId);
  const provider = options.provider || metadata.surface || "discord";
  if (provider === "discord" && !metadata.scopedThreadId) {
    throw new Error(
      `Refusing to start unscoped Discord live e2e run ${runId}. Re-run prepare so it records a scoped Codex thread id.`
    );
  }
  const pidPath = pidPathForRun(metadata);
  const existingPid = fs.existsSync(pidPath)
    ? Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10)
    : 0;
  if (processIsRunning(existingPid)) {
    throw new Error(
      `Refusing to start ${runId} because its previous bridge process is still running with PID ${existingPid}. Run \`npm run e2e-live -- stop ${runId}\` first.`
    );
  }
  const listenUrl = metadata.appServerListenUrl || resolveRunAppServerListenUrl(runId);
  const listener = findRunAppServerListenerPid(metadata);
  if (listener.reachable || (await canConnectToListenUrl(listenUrl))) {
    throw new Error(
      `Refusing to start ${runId} because app-server listener ${listenUrl} is already reachable${
        listener.pid ? ` with PID ${listener.pid}` : ""
      }. Run \`npm run e2e-live -- stop ${runId}\` first.`
    );
  }

  const runDir = path.dirname(metadata.storePath);
  fs.mkdirSync(runDir, { recursive: true });
  const outPath = path.join(runDir, "bridge.out.log");
  const errPath = path.join(runDir, "bridge.err.log");
  const out = fs.openSync(outPath, "a");
  const err = fs.openSync(errPath, "a");
  let child;
  try {
    child = (options.spawn || childProcess.spawn)(options.execPath || process.execPath, [ensureBuiltIndex(repoRoot)], {
      cwd: repoRoot,
      env:
        provider === "local"
          ? childEnvWithLocalRun(options.env || process.env, metadata)
          : childEnvWithRun(options.env || process.env, metadata),
      detached: true,
      stdio: ["ignore", out, err],
      windowsHide: false
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }

  const earlyExit = await waitForEarlyChildExit(child, options.earlyExitTimeoutMs ?? 1000);
  if (earlyExit) {
    const stdout = readFileTail(outPath).trim();
    const stderr = readFileTail(errPath).trim();
    const reason = earlyExit.error
      ? `spawn error: ${earlyExit.error.message || String(earlyExit.error)}`
      : `exit code ${earlyExit.code}${earlyExit.signal ? ` signal ${earlyExit.signal}` : ""}`;
    throw new Error(
      [
        `Live e2e bridge for ${runId} exited during startup (${reason}).`,
        stdout ? `Stdout:\n${stdout}` : null,
        stderr ? `Stderr:\n${stderr}` : null
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }

  child.unref();
  fs.writeFileSync(pidPath, `${child.pid}\n`, "utf8");
  const readinessLine = await waitForRunStartupReady(metadata, child.pid, options);
  return [
    `Started live e2e ${provider === "local" ? "local-store " : ""}bridge for ${runId}.`,
    `PID: ${child.pid}`,
    `Config: ${metadata.configPath}`,
    `Store: ${metadata.storePath}`,
    `Provider: ${provider}`,
    ...(metadata.scopedThreadId ? [`Discovery scope: ${metadata.scopedThreadId}`] : []),
    readinessLine,
    `App-server listener: ${listenUrl}`,
    `Stdout: ${outPath}`,
    `Stderr: ${errPath}`
  ]
    .filter(Boolean)
    .join("\n");
}

async function stopRunWithMetadata(metadata, { waitForExit = false } = {}) {
  const pidPath = pidPathForRun(metadata);
  const lines = [];
  if (!fs.existsSync(pidPath)) {
    lines.push(`No bridge PID file found for ${metadata.runId}.`);
    await stopRunAppServerListener(metadata, lines);
    return lines.join("\n");
  }

  const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
  if (!processIsRunning(pid)) {
    lines.push(`Bridge PID ${pid} for ${metadata.runId} is not running.`);
    await stopRunAppServerListener(metadata, lines);
    try {
      fs.rmSync(pidPath, { force: true });
    } catch {
      // A stale PID file is harmless if it cannot be removed.
    }
    return lines.join("\n");
  }

  const killed = killProcessTree(pid, "SIGTERM");
  lines.push(`Sent stop signal to live e2e bridge process tree for ${metadata.runId} with PID ${pid}.`);
  if (killed.output) {
    lines.push(killed.output);
  }
  if (waitForExit) {
    let stopped = await waitUntilRunStops(metadata, pid);
    lines.push(
      stopped
        ? `Bridge process tree and app-server listener for ${metadata.runId} stopped.`
        : `Bridge process tree or app-server listener for ${metadata.runId} is still active after ${STOP_WAIT_TIMEOUT_MS}ms.`
    );
    if (!stopped) {
      await stopRunAppServerListener(metadata, lines);
      stopped = await waitUntilRunStops(metadata, pid, STOP_WAIT_POLL_MS);
    }
    if (stopped) {
      try {
        fs.rmSync(pidPath, { force: true });
      } catch {
        // A stale PID file is harmless if it cannot be removed.
      }
      if (process.platform === "win32") {
        await sleep(STOP_SETTLE_MS);
        lines.push(`Waited ${STOP_SETTLE_MS}ms for Windows process cleanup to settle.`);
      }
    }
  }
  return lines.join("\n");
}

async function stopRun(repoRoot, runId) {
  const metadata = loadRunMetadata(repoRoot, runId);
  return await stopRunWithMetadata(metadata, { waitForExit: true });
}

function runDiscordClean(repoRoot, metadata, options = {}) {
  const result = (options.spawnSync || childProcess.spawnSync)(
    options.execPath || process.execPath,
    [ensureBuiltIndex(repoRoot), "clean", "--mapped-only"],
    {
      cwd: repoRoot,
      env: childEnvWithRun(options.env || process.env, metadata),
      encoding: "utf8",
      windowsHide: false
    }
  );

  if (result.error) {
    throw result.error;
  }

  return {
    ok: typeof result.status === "number" ? result.status === 0 : false,
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim()
  };
}

function findPreparedRuns(repoRoot) {
  const runRoot = path.join(repoRoot, RUN_ROOT);
  if (!fs.existsSync(runRoot)) {
    return [];
  }

  return fs
    .readdirSync(runRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const runMetadataPath = path.join(runRoot, entry.name, "run.json");
      if (!fs.existsSync(runMetadataPath)) {
        return null;
      }
      try {
        return readJsonFile(runMetadataPath);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) =>
      String(left.createdAt || left.runId).localeCompare(String(right.createdAt || right.runId))
    );
}

function loadBetterSqlite3() {
  try {
    return require("better-sqlite3");
  } catch (error) {
    throw new Error(
      `better-sqlite3 is required for aggregate Discord cleanup but could not be loaded: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function readSeedProjectCategories(metadata, Database) {
  if (!metadata.storePath || !fs.existsSync(metadata.storePath)) {
    return [];
  }

  let db;
  try {
    db = new Database(metadata.storePath, { readonly: true, fileMustExist: true });
    const hasProjectBridges = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_bridges'")
      .get();
    if (!hasProjectBridges) {
      return [];
    }
    return db
      .prepare(
        [
          "SELECT project_name AS projectName, discord_category_id AS discordCategoryId",
          "FROM project_bridges",
          "WHERE created_by_bridge = 1 AND discord_category_id IS NOT NULL AND discord_category_id <> ''"
        ].join(" ")
      )
      .all()
      .map((row) => ({
        projectName: row.projectName || metadata.testId || metadata.runId,
        discordCategoryId: row.discordCategoryId
      }));
  } catch {
    return [];
  } finally {
    if (db) {
      db.close();
    }
  }
}

function prepareAggregateDiscordCleanupRun(repoRoot, discordRuns) {
  const runId = "cleanup-discord-runs";
  const runDir = runDirFor(repoRoot, runId);
  const configPath = path.join(runDir, "bridge.config.json");
  const storePath = path.join(runDir, "bridge.sqlite");
  const reportPath = path.join(runDir, "report.md");
  const sourceConfigPath =
    discordRuns.map((metadata) => metadata.configPath).find((candidate) => candidate && fs.existsSync(candidate)) ||
    path.join(repoRoot, DEFAULT_BRIDGE_CONFIG_PATH);

  fs.mkdirSync(runDir, { recursive: true });
  fs.copyFileSync(sourceConfigPath, configPath);
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${storePath}${suffix}`, { force: true });
  }

  const Database = loadBetterSqlite3();
  const uniqueCategories = new Map();
  for (const metadata of discordRuns) {
    for (const seed of readSeedProjectCategories(metadata, Database)) {
      if (!uniqueCategories.has(seed.discordCategoryId)) {
        uniqueCategories.set(seed.discordCategoryId, seed.projectName);
      }
    }
  }

  const db = new Database(storePath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_bridges (
        project_key TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        discord_category_id TEXT NOT NULL UNIQUE,
        created_by_bridge INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO project_bridges (
        project_key,
        project_name,
        discord_category_id,
        created_by_bridge,
        updated_at
      ) VALUES (?, ?, ?, 1, ?)
    `);
    let index = 0;
    const updatedAt = new Date().toISOString();
    for (const [categoryId, projectName] of uniqueCategories.entries()) {
      index += 1;
      insert.run(`cleanup-${index}-${categoryId}`, projectName || `cleanup-${index}`, categoryId, updatedAt);
    }
  } finally {
    db.close();
  }

  const metadata = {
    scenarioId: "cleanup-discord-runs",
    testId: "cleanup",
    playbook: "cleanup",
    runId,
    marker: "cleanup-discord-runs",
    configPath,
    storePath,
    reportPath,
    appServerListenUrl: resolveRunAppServerListenUrl(runId),
    surface: "discord",
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeCurrentRunPointer(repoRoot, metadata);
  return { metadata, seedCategoryCount: uniqueCategories.size };
}

async function cleanupRun(repoRoot, runId, options = {}) {
  const metadata = loadRunMetadata(repoRoot, runId);
  const lines = [`Cleanup for live e2e run ${runId}:`, await stopRunWithMetadata(metadata, { waitForExit: true })];

  if (metadata.surface !== "discord") {
    lines.push("No Discord cleanup needed for this store-surface run.");
    return { ok: true, output: lines.join("\n") };
  }

  const result = runDiscordClean(repoRoot, metadata, options);
  lines.push("Discord clean output:");
  lines.push(result.output || "(no output)");

  if (!result.ok) {
    lines.push(`Discord clean exited with status ${result.status ?? "unknown"}.`);
  }

  return { ok: result.ok, output: lines.join("\n") };
}

async function cleanupDiscordRuns(repoRoot, options = {}) {
  const allRuns = findPreparedRuns(repoRoot);
  const discordRuns = allRuns.filter(
    (metadata) => metadata.surface === "discord" && metadata.runId !== "cleanup-discord-runs"
  );
  if (discordRuns.length === 0) {
    return { ok: true, output: "No prepared Discord-surface live e2e runs found." };
  }

  const outputs = [`Found ${discordRuns.length} prepared Discord-surface live e2e run(s).`];
  let ok = true;
  for (const metadata of discordRuns) {
    outputs.push(await stopRunWithMetadata(metadata, { waitForExit: true }));
    const runClean = runDiscordClean(repoRoot, metadata, options);
    outputs.push(`Mapped-only Discord clean for ${metadata.runId}:`);
    outputs.push(runClean.output || "(no output)");
    if (!runClean.ok) {
      ok = false;
      outputs.push(`Discord clean for ${metadata.runId} exited with status ${runClean.status ?? "unknown"}.`);
    }
  }

  const aggregate = prepareAggregateDiscordCleanupRun(repoRoot, discordRuns);
  outputs.push(
    `Prepared aggregate Discord cleanup store with ${aggregate.seedCategoryCount} seeded category id(s).`
  );
  const result = runDiscordClean(repoRoot, aggregate.metadata, options);
  outputs.push("Discord clean output:");
  outputs.push(result.output || "(no output)");
  if (!result.ok) {
    ok = false;
    outputs.push(`Discord clean exited with status ${result.status ?? "unknown"}.`);
  }

  return { ok, output: outputs.join("\n\n") };
}

function inspectDiscordForRun(repoRoot, runId, options = {}) {
  const metadata = loadRunMetadata(repoRoot, runId);
  const result = (options.spawnSync || childProcess.spawnSync)(
    options.execPath || process.execPath,
    [ensureBuiltIndex(repoRoot), "inspect", "discord"],
    {
      cwd: repoRoot,
      env: childEnvWithRun(options.env || process.env, metadata),
      encoding: "utf8",
      windowsHide: false
    }
  );
  return {
    status: typeof result.status === "number" ? result.status : 1,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    error: result.error || null
  };
}

async function execute(argv = process.argv.slice(2), options = {}) {
  const { positional, options: argvOptions } = parseArgs(argv);
  const command = positional[0] || "list";
  const writeOutput = options.writeOutput || ((message) => console.log(message));
  const writeError = options.writeError || ((message) => console.error(message));
  const repoRoot = resolveRepoRoot(options);

  try {
    if (command === "list") {
      writeOutput(listScenarios(loadManifest(repoRoot)));
      return 0;
    }

    if (command === "groups") {
      writeOutput(listGroups(loadManifest(repoRoot)));
      return 0;
    }

    if (command === "group") {
      const groupId = positional[1];
      if (!groupId) {
        throw new Error("Usage: npm run e2e-live -- group <group-id>");
      }
      writeOutput(describeGroup(loadManifest(repoRoot), groupId));
      return 0;
    }

    if (command === "prepare") {
      const scenarioId = positional[1];
      if (!scenarioId) {
        throw new Error("Usage: npm run e2e-live -- prepare <scenario-id> --run-id <id>");
      }
      const prepared = prepareScenario(scenarioId, argvOptions, { ...options, repoRoot });
      writeOutput(prepared.output);
      return 0;
    }

    if (command === "start") {
      const runId = positional[1];
      if (!runId) {
        throw new Error("Usage: npm run e2e-live -- start <run-id>");
      }
      writeOutput(await startRun(repoRoot, runId, { ...options, provider: "discord" }));
      return 0;
    }

    if (command === "start-current") {
      const current = loadCurrentRunPointer(repoRoot);
      writeOutput(await startRun(repoRoot, current.runId, { ...options, provider: "discord" }));
      return 0;
    }

    if (command === "start-local") {
      const runId = positional[1];
      if (!runId) {
        throw new Error("Usage: npm run e2e-live -- start-local <run-id>");
      }
      writeOutput(await startRun(repoRoot, runId, { ...options, provider: "local" }));
      return 0;
    }

    if (command === "start-local-current") {
      const current = loadCurrentRunPointer(repoRoot);
      writeOutput(await startRun(repoRoot, current.runId, { ...options, provider: "local" }));
      return 0;
    }

    if (command === "stop") {
      const runId = positional[1];
      if (!runId) {
        throw new Error("Usage: npm run e2e-live -- stop <run-id>");
      }
      writeOutput(await stopRun(repoRoot, runId));
      return 0;
    }

    if (command === "stop-current") {
      const current = loadCurrentRunPointer(repoRoot);
      writeOutput(await stopRun(repoRoot, current.runId));
      return 0;
    }

    if (command === "cleanup") {
      const runId = positional[1];
      if (!runId) {
        throw new Error("Usage: npm run e2e-live -- cleanup <run-id>");
      }
      const result = await cleanupRun(repoRoot, runId, options);
      writeOutput(result.output);
      return result.ok ? 0 : 1;
    }

    if (command === "cleanup-current") {
      const current = loadCurrentRunPointer(repoRoot);
      const result = await cleanupRun(repoRoot, current.runId, options);
      writeOutput(result.output);
      return result.ok ? 0 : 1;
    }

    if (command === "cleanup-discord-runs") {
      const result = await cleanupDiscordRuns(repoRoot, options);
      writeOutput(result.output);
      return result.ok ? 0 : 1;
    }

    if (command === "inspect-discord") {
      const runId = positional[1];
      if (!runId) {
        throw new Error("Usage: npm run e2e-live -- inspect-discord <run-id>");
      }
      const result = inspectDiscordForRun(repoRoot, runId, options);
      if (result.error) {
        throw result.error;
      }
      writeOutput(result.output);
      return result.status;
    }

    if (command === "verify" || command === "verify-store" || command === "verify-discord") {
      const scenarioId = positional[1];
      if (!scenarioId) {
        throw new Error(
          "Usage: npm run e2e-live -- verify <scenario-id> --run-id <run-id>"
        );
      }
      const runMetadata = argvOptions["run-id"] ? loadRunMetadata(repoRoot, argvOptions["run-id"]) : null;
      const surface =
        command === "verify-store"
          ? "store"
          : command === "verify-discord"
            ? "discord"
            : argvOptions.surface === "discord" || argvOptions.surface === "store"
              ? argvOptions.surface
              : argvOptions.channel || !runMetadata
                ? "discord"
                : runMetadata.surface || "store";
      const result =
        surface === "discord"
          ? await verifyScenario(scenarioId, argvOptions, { ...options, repoRoot })
          : await verifyStoreScenario(scenarioId, argvOptions, { ...options, repoRoot });
      writeOutput(result.output);
      return result.ok ? 0 : 1;
    }

    throw new Error(`Unknown live e2e command: ${command}`);
  } catch (error) {
    writeError(formatErrorForOutput(error));
    return 1;
  }
}

async function main(argv = process.argv.slice(2), options = {}) {
  const exit = options.exit || process.exit;
  exit(await execute(argv, options));
}

module.exports = {
  buildScenarioConfig,
  copyApprovalsFromBaseConfig,
  deepMerge,
  execute,
  findScenario,
  buildChildEnv,
  describeGroup,
  findGroup,
  listGroups,
  listScenarios,
  cleanupDiscordRuns,
  cleanupRun,
  loadRunMetadata,
  prepareScenario,
  stripJsonComments,
  startRun,
  stopRun,
  verifyScenario,
  verifyStoreScenario
};

if (require.main === module) {
  void main();
}
