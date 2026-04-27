import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.cwd(), "package.json"));
const Database = require("better-sqlite3") as any;
const e2eLive = require("./scripts/e2e-live.cjs") as {
  buildChildEnv: (
    baseEnv?: NodeJS.ProcessEnv,
    overrides?: Record<string, string | undefined>
  ) => NodeJS.ProcessEnv;
  execute: (
    argv?: string[],
    options?: {
      repoRoot?: string;
      env?: NodeJS.ProcessEnv;
      execPath?: string;
      spawnSync?: typeof spawnSync;
      inspectDiscordThread?: (
        repoRoot: string,
        channelId: string,
        limit: number,
        options: { env?: NodeJS.ProcessEnv }
      ) => Promise<{ status: number; stdout: string; stderr: string; error: Error | null }>;
      spawn?: (...args: any[]) => any;
      earlyExitTimeoutMs?: number;
      startReadyTimeoutMs?: number;
      writeOutput?: (message: string) => void;
      writeError?: (message: string) => void;
    }
  ) => Promise<number>;
  startRun: (
    repoRoot: string,
    runId: string,
    options?: {
      provider?: "local" | "discord";
      env?: NodeJS.ProcessEnv;
      execPath?: string;
      spawn?: (...args: any[]) => any;
      earlyExitTimeoutMs?: number;
      startReadyTimeoutMs?: number;
    }
  ) => Promise<string>;
};

function writeFixtureRepo(): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "codex-mobile-e2e-live-"));
  mkdirSync(path.join(repoRoot, "e2e-live"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, "e2e-live", "manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        defaults: {
          timeoutSeconds: 1,
          inspectLimit: 5,
          safety: "isolated"
        },
        groups: [
          {
            id: "sample-group",
            title: "Sample group",
            description: "No manual input.",
            humanInput: {
              summary: "No follow-up human input required after the initial request.",
              required: ["Initial request to run this group."],
              approvals: ["No Discord or network approval."],
              notRequired: ["No second user message.", "No manual channel ID."]
            },
            scenarios: ["sample.commands"]
          },
          {
            id: "discord-group",
            title: "Discord group",
            description: "Full stack.",
            humanInput: {
              summary: "No follow-up test messages required, but Discord/network approval may be required.",
              required: ["Initial request to run this group."],
              approvals: ["Approval for Discord API verification if Codex sandbox policy asks."],
              notRequired: ["No browser or Discord UI inspection."]
            },
            scenarios: ["sample.commands"]
          }
        ],
        baseConfig: {
          preset: "recommended",
          visibility: {
            userMessages: false,
            thinkingMessages: false,
            finalMessages: false,
            commands: false,
            fileEdits: false
          }
        },
        tests: [
          {
            id: "sample",
            playbook: "sample.md",
            scenarios: [
              {
                id: "sample.commands",
                title: "Sample commands",
                config: {
                  visibility: {
                    commands: true
                  }
                },
                action: {
                  type: "two-shell-commands",
                  steps: ["Use `${marker}`"]
                },
                expect: {
                  discordContains: ["${marker}"],
                  discordNotContains: ["FORBIDDEN"]
                }
              },
              {
                id: "sample.summary",
                title: "Sample summary",
                config: {
                  visibility: {
                    commands: true
                  },
                  ui: {
                    commandDisplayMode: "summary"
                  }
                },
                action: {
                  type: "two-shell-commands",
                  steps: ["Use `${marker}`"]
                },
                expect: {
                  discordContains: ["Ran 2 commands"],
                  discordNotContains: ["${marker}"]
                }
              },
              {
                id: "sample.user",
                title: "Sample user",
                config: {
                  visibility: {
                    userMessages: true
                  },
                  startupBackfill: {
                    maxCodexMessages: 20
                  }
                },
                action: {
                  type: "initial-user-message",
                  steps: ["Use an initial prompt substring."]
                },
                expect: {
                  discordContains: ["${marker}"],
                  discordNotContains: []
                }
              },
              {
                id: "sample.absence",
                title: "Sample absence-only",
                config: {
                  visibility: {
                    commands: false
                  }
                },
                action: {
                  type: "two-shell-commands",
                  steps: ["Use `${marker}`"]
                },
                expect: {
                  absenceOnly: true,
                  discordContains: [],
                  discordNotContains: ["${marker}"]
                }
              },
              {
                id: "sample.approval",
                title: "Sample approval",
                defaultSurface: "discord",
                action: {
                  type: "subagent-approval-request",
                  steps: ["Use `${marker}` in a subagent approval request."]
                },
                expect: {
                  discordContains: ["${marker}", "Type: Command execution", "Preview:"],
                  discordNotContains: ["FORBIDDEN"],
                  storeContains: ["${marker}", "approval commandExecution"],
                  storeNotContains: []
                }
              },
              {
                id: "sample.plan",
                title: "Sample proposed plan",
                defaultSurface: "discord",
                config: {
                  approvals: {
                    allowFromDiscord: true
                  },
                  visibility: {
                    finalMessages: true
                  }
                },
                action: {
                  type: "subagent-proposed-plan",
                  steps: ["Use `${marker}` in a subagent proposed plan."]
                },
                expect: {
                  discordContains: [
                    "${marker}",
                    "Accept plan",
                    "No, and tell Codex what to do differently"
                  ],
                  discordNotContains: ["FORBIDDEN"],
                  storeContains: ["${marker}", "proposed-plan status=pending"],
                  storeNotContains: []
                }
              }
            ]
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeFileSync(
    path.join(repoRoot, "bridge.config.json"),
    [
      "{",
      "  // comments are accepted here",
      "  \"preset\": \"recommended\",",
      "  \"approvals\": {",
      "    \"allowFromDiscord\": true,",
      "    \"mentionApprovers\": false,",
      "    \"approvalTtlMinutes\": 7",
      "  },",
      "  \"messageWriteBacks\": {",
      "    \"allowFromDiscord\": true",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  return repoRoot;
}

async function listenOnEphemeralLocalPort(): Promise<{ server: net.Server; url: string }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP address.");
  }
  return {
    server,
    url: `ws://127.0.0.1:${address.port}`
  };
}

test("e2e-live list prints manifest scenarios", async () => {
  const output: string[] = [];
  const exitCode = await e2eLive.execute(["list"], {
    repoRoot: process.cwd(),
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /basic-message\.commentary-on/);
  assert.match(output.join("\n"), /commands\.summary/);
  assert.match(output.join("\n"), /approvals\.command-request/);
  assert.match(output.join("\n"), /approvals\.proposed-plan-card/);
  assert.match(output.join("\n"), /autonomous-basic/);
  assert.match(output.join("\n"), /No-user-input local-store smoke coverage/);
  assert.match(output.join("\n"), /Human input: No follow-up human input required/);
});

test("e2e-live groups prints only group summaries", async () => {
  const output: string[] = [];
  const exitCode = await e2eLive.execute(["groups"], {
    repoRoot: process.cwd(),
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /Live e2e groups/);
  assert.match(output.join("\n"), /autonomous-basic \(6 scenarios\)/);
  assert.match(output.join("\n"), /autonomous-visibility \(13 scenarios\)/);
  assert.match(output.join("\n"), /discord-basic \(2 scenarios\)/);
  assert.match(output.join("\n"), /approval-requests \(2 scenarios\)/);
  assert.match(output.join("\n"), /Human input: No follow-up human input required/);
  assert.match(output.join("\n"), /Approvals: No Discord or network approval/);
  assert.match(output.join("\n"), /Human input: No follow-up test messages required, but Discord\/network approval may be required/);
  assert.match(output.join("\n"), /No approval decision is required/);
  assert.doesNotMatch(output.join("\n"), /basic-message\.commentary-on/);
});

test("e2e-live group prints ordered scenario runbook", async () => {
  const repoRoot = writeFixtureRepo();
  const output: string[] = [];
  const exitCode = await e2eLive.execute(["group", "sample-group"], {
    repoRoot,
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /Group: sample-group/);
  assert.match(output.join("\n"), /Human input:/);
  assert.match(output.join("\n"), /Summary: No follow-up human input required/);
  assert.match(output.join("\n"), /Approvals:/);
  assert.match(output.join("\n"), /No Discord or network approval/);
  assert.match(output.join("\n"), /Do not ask for user follow-up/);
  assert.match(output.join("\n"), /stable current-run commands/);
  assert.match(output.join("\n"), /start-local-current/);
  assert.doesNotMatch(output.join("\n"), /npm run inspect:discord/);
  assert.match(output.join("\n"), /1\. sample\.commands \[isolated\]/);
});

test("e2e-live child env collapses duplicate Windows path keys", () => {
  const env = e2eLive.buildChildEnv(
    {
      PATH: "wrong-path",
      Path: "right-path",
      TEMP: "C:\\Temp"
    },
    {
      BRIDGE_CONFIG_PATH: "C:\\run\\bridge.config.json",
      STORE_PATH: "C:\\run\\bridge.sqlite"
    }
  );

  assert.equal(env.Path, "right-path");
  assert.equal(env.PATH, undefined);
  assert.equal(env.TEMP, "C:\\Temp");
  assert.equal(env.BRIDGE_CONFIG_PATH, "C:\\run\\bridge.config.json");
  assert.equal(env.STORE_PATH, "C:\\run\\bridge.sqlite");
});

test("e2e-live prepare copies non-secret approvals and applies scenario config", async () => {
  const repoRoot = writeFixtureRepo();
  const output: string[] = [];
  const exitCode = await e2eLive.execute(["prepare", "sample.commands", "--run-id", "run-1"], {
    repoRoot,
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /Prepared live e2e scenario sample\.commands/);
  assert.match(output.join("\n"), /Surface: store/);
  assert.match(output.join("\n"), /npm run e2e-live -- start-local-current/);
  assert.match(output.join("\n"), /Fallback with explicit run ID: npm run e2e-live -- start-local run-1/);
  assert.match(output.join("\n"), /npm run e2e-live -- verify sample\.commands --run-id run-1/);
  assert.match(output.join("\n"), /npm run e2e-live -- stop-current/);
  assert.match(output.join("\n"), /Fallback with explicit run ID: npm run e2e-live -- stop run-1/);
  assert.doesNotMatch(output.join("\n"), /cleanup-current/);
  assert.doesNotMatch(output.join("\n"), /\$env:/);
  assert.doesNotMatch(output.join("\n"), /Start-Process/);
  assert.doesNotMatch(output.join("\n"), /npm run inspect:discord/);
  assert.doesNotMatch(output.join("\n"), /inspect-discord/);

  const config = JSON.parse(
    readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-1", "bridge.config.json"), "utf8")
  ) as {
    approvals: {
      allowFromDiscord: boolean;
      mentionApprovers: boolean;
      approvalTtlMinutes: number;
    };
    messageWriteBacks: {
      allowFromDiscord: boolean;
    };
    visibility: {
      commands: boolean;
    };
  };

  assert.equal(config.approvals.allowFromDiscord, true);
  assert.equal(config.approvals.mentionApprovers, false);
  assert.equal(config.approvals.approvalTtlMinutes, 7);
  assert.equal("allowedUserIds" in config.approvals, false);
  assert.equal(config.messageWriteBacks.allowFromDiscord, true);
  assert.equal("allowedUserIds" in config.messageWriteBacks, false);
  assert.equal(config.visibility.commands, true);

  const currentRun = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "current-run.json"), "utf8")) as {
    runId: string;
    scenarioId: string;
    surface: string;
  };
  assert.equal(currentRun.runId, "run-1");
  assert.equal(currentRun.scenarioId, "sample.commands");
  assert.equal(currentRun.surface, "store");
});

test("e2e-live prepare assigns an isolated app-server listener per run", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(["prepare", "sample.commands", "--run-id", "listener-one"], {
    repoRoot,
    writeOutput: () => undefined
  });
  await e2eLive.execute(["prepare", "sample.commands", "--run-id", "listener-two"], {
    repoRoot,
    writeOutput: () => undefined
  });

  const firstRun = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "listener-one", "run.json"), "utf8")) as {
    appServerListenUrl: string;
  };
  const secondRun = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "listener-two", "run.json"), "utf8")) as {
    appServerListenUrl: string;
  };

  assert.match(firstRun.appServerListenUrl, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.match(secondRun.appServerListenUrl, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(firstRun.appServerListenUrl, secondRun.appServerListenUrl);
});

test("e2e-live start passes the isolated app-server listener to the bridge env", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(["prepare", "sample.commands", "--run-id", "listener-env"], {
    repoRoot,
    writeOutput: () => undefined
  });
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "listener-env", "run.json"), "utf8")) as {
    appServerListenUrl: string;
  };

  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const fakeChild = new EventEmitter() as EventEmitter & {
    pid: number;
    unref: () => void;
  };
  fakeChild.pid = 123456;
  fakeChild.unref = () => undefined;

  const output = await e2eLive.startRun(repoRoot, "listener-env", {
    provider: "local",
    env: {
      Path: "test-path"
    },
    execPath: "/node-bin",
    earlyExitTimeoutMs: 1,
    spawn: ((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = options.env;
      return fakeChild;
    }) as (...args: any[]) => any
  });

  assert.equal(capturedEnv?.CODEX_APP_SERVER_LISTEN_URL, run.appServerListenUrl);
  assert.equal(capturedEnv?.CODEX_MOBILE_LIVE_E2E_RUN_ID, "listener-env");
  assert.equal(capturedEnv?.DISCORD_CONTROLLER_USER_ID, "live-e2e-local-controller");
  assert.match(output, new RegExp(`App-server listener: ${run.appServerListenUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("e2e-live start waits for scoped thread mapping and session cursor", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(
    [
      "prepare",
      "sample.commands",
      "--run-id",
      "listener-ready",
      "--surface",
      "discord",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
      repoRoot,
      writeOutput: () => undefined
    }
  );
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "listener-ready", "run.json"), "utf8")) as {
    scopedThreadId: string;
    storePath: string;
  };

  const fakeChild = new EventEmitter() as EventEmitter & {
    pid: number;
    unref: () => void;
  };
  fakeChild.pid = process.pid;
  fakeChild.unref = () => undefined;

  const readyTimer = setTimeout(() => {
    const db = new Database(run.storePath);
    db.exec(`
      CREATE TABLE thread_bridges (
        codex_thread_id TEXT PRIMARY KEY,
        discord_channel_id TEXT,
        channel_kind TEXT
      );
      CREATE TABLE session_log_cursors (
        thread_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO thread_bridges (codex_thread_id, discord_channel_id, channel_kind) VALUES (?, ?, ?)"
    ).run(run.scopedThreadId, "discord_channel_ready", "conversation");
    db.prepare(
      "INSERT INTO session_log_cursors (thread_id, file_path, byte_offset, updated_at) VALUES (?, ?, ?, ?)"
    ).run(run.scopedThreadId, "session.jsonl", 1, new Date().toISOString());
    db.prepare("INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)").run(
      "bridge_startup_ready_at",
      new Date().toISOString(),
      new Date().toISOString()
    );
    db.close();
  }, 50);

  try {
    const output = await e2eLive.startRun(repoRoot, "listener-ready", {
      provider: "discord",
      execPath: "/node-bin",
      earlyExitTimeoutMs: 1,
      startReadyTimeoutMs: 2000,
      spawn: (() => fakeChild) as (...args: any[]) => any
    });

    assert.match(
      output,
      /Readiness: scoped thread 019dc07b-9c42-74c0-95b1-f3f816d463b1 mapped, session cursor initialized, and startup completed\./
    );
  } finally {
    clearTimeout(readyTimer);
  }
});

test("e2e-live start refuses a stale app-server listener for the run", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(["prepare", "sample.commands", "--run-id", "listener-stale"], {
    repoRoot,
    writeOutput: () => undefined
  });
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const { server, url } = await listenOnEphemeralLocalPort();
  try {
    const runMetadataPath = path.join(repoRoot, "tmp", "live-e2e", "listener-stale", "run.json");
    const run = JSON.parse(readFileSync(runMetadataPath, "utf8")) as Record<string, unknown>;
    run.appServerListenUrl = url;
    writeFileSync(runMetadataPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");

    await assert.rejects(
      () =>
        e2eLive.startRun(repoRoot, "listener-stale", {
          provider: "local",
          execPath: "/node-bin",
          spawn: () => {
            throw new Error("spawn should not run");
          }
        }),
      /app-server listener .* is already reachable/
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("e2e-live prepare resets stale run artifacts before writing metadata", async () => {
  const repoRoot = writeFixtureRepo();
  const runDir = path.join(repoRoot, "tmp", "live-e2e", "run-stale");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "bridge.sqlite"), "stale-store", "utf8");
  writeFileSync(path.join(runDir, "bridge.sqlite-wal"), "stale-wal", "utf8");
  writeFileSync(path.join(runDir, "bridge.out.log"), "old stdout", "utf8");
  writeFileSync(path.join(runDir, "report.md"), "old report", "utf8");

  const output: string[] = [];
  const exitCode = await e2eLive.execute(["prepare", "sample.commands", "--run-id", "run-stale"], {
    repoRoot,
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /Prepared live e2e scenario sample\.commands/);
  assert.equal(existsSync(path.join(runDir, "bridge.sqlite")), false);
  assert.equal(existsSync(path.join(runDir, "bridge.sqlite-wal")), false);
  assert.equal(existsSync(path.join(runDir, "bridge.out.log")), false);
  assert.equal(existsSync(path.join(runDir, "report.md")), false);
  assert.equal(existsSync(path.join(runDir, "bridge.config.json")), true);
  assert.equal(existsSync(path.join(runDir, "run.json")), true);
});

test("e2e-live prepare can print Discord surface commands explicitly", async () => {
  const repoRoot = writeFixtureRepo();
  const output: string[] = [];
  const exitCode = await e2eLive.execute(
    [
      "prepare",
      "sample.commands",
      "--run-id",
      "run-discord",
      "--surface",
      "discord",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
      repoRoot,
      writeOutput: (message) => output.push(message)
    }
  );

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /Surface: discord/);
  assert.match(output.join("\n"), /Discovery scope: Codex thread 019dc07b-9c42-74c0-95b1-f3f816d463b1 \(explicit\)/);
  assert.match(output.join("\n"), /Discord namespace: e2e-run-discord/);
  assert.match(output.join("\n"), /npm run e2e-live -- start-current/);
  assert.match(output.join("\n"), /Fallback with explicit run ID: npm run e2e-live -- start run-discord/);
  assert.match(output.join("\n"), /npm run e2e-live -- inspect-discord run-discord/);
  assert.match(output.join("\n"), /npm run e2e-live -- verify sample\.commands --run-id run-discord --channel/);
  assert.match(output.join("\n"), /npm run e2e-live -- cleanup-current/);
  assert.match(output.join("\n"), /Fallback with explicit run ID: npm run e2e-live -- cleanup run-discord/);
  assert.doesNotMatch(output.join("\n"), /Fallback with explicit run ID: npm run e2e-live -- stop run-discord/);

  const config = JSON.parse(
    readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-discord", "bridge.config.json"), "utf8")
  ) as {
    discovery: {
      allowedThreadIds: string[];
      projectNamePrefix: string;
    };
  };
  assert.deepEqual(config.discovery.allowedThreadIds, ["019dc07b-9c42-74c0-95b1-f3f816d463b1"]);
  assert.equal(config.discovery.projectNamePrefix, "e2e-run-discord");
});

test("e2e-live prepare honors scenario default Discord surface", async () => {
  const repoRoot = writeFixtureRepo();
  const output: string[] = [];
  const exitCode = await e2eLive.execute(
    [
      "prepare",
      "sample.approval",
      "--run-id",
      "run-default-discord",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
      repoRoot,
      writeOutput: (message) => output.push(message)
    }
  );

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /Surface: discord/);
  assert.match(output.join("\n"), /Discovery scope: Codex thread 019dc07b-9c42-74c0-95b1-f3f816d463b1 \(explicit\)/);
  assert.match(output.join("\n"), /npm run e2e-live -- start-current/);
  assert.match(output.join("\n"), /npm run e2e-live -- verify sample\.approval --run-id run-default-discord/);
  assert.match(output.join("\n"), /npm run e2e-live -- cleanup-current/);
  assert.doesNotMatch(output.join("\n"), /start-local-current/);
  assert.doesNotMatch(output.join("\n"), /stop-current/);

  const run = JSON.parse(
    readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-default-discord", "run.json"), "utf8")
  ) as {
    surface: string;
    scopedThreadId: string;
  };
  assert.equal(run.surface, "discord");
  assert.equal(run.scopedThreadId, "019dc07b-9c42-74c0-95b1-f3f816d463b1");
});

test("e2e-live prepare applies proposed-plan scenario controls", async () => {
  const repoRoot = writeFixtureRepo();
  const output: string[] = [];
  const exitCode = await e2eLive.execute(
    [
      "prepare",
      "sample.plan",
      "--run-id",
      "run-default-plan",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
      repoRoot,
      writeOutput: (message) => output.push(message)
    }
  );

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /Surface: discord/);
  assert.match(output.join("\n"), /Action type: subagent-proposed-plan/);
  assert.match(output.join("\n"), /npm run e2e-live -- verify sample\.plan --run-id run-default-plan/);

  const config = JSON.parse(
    readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-default-plan", "bridge.config.json"), "utf8")
  ) as {
    approvals: {
      allowFromDiscord: boolean;
    };
    visibility: {
      finalMessages: boolean;
    };
  };
  assert.equal(config.approvals.allowFromDiscord, true);
  assert.equal("allowedUserIds" in config.approvals, false);
  assert.equal(config.visibility.finalMessages, true);
});

test("e2e-live Discord prepare auto-scopes to the current session file", async () => {
  const repoRoot = writeFixtureRepo();
  const codexHome = path.join(repoRoot, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "24");
  const threadId = "019dc07b-9c42-74c0-95b1-f3f816d463b1";
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    path.join(sessionDir, `rollout-2026-04-24T19-13-39-${threadId}.jsonl`),
    JSON.stringify({
      type: "response_item",
      item: {
        type: "function_call",
        arguments: "npm run e2e-live -- prepare sample.commands --run-id run-auto --surface discord"
      }
    }),
    "utf8"
  );

  const output: string[] = [];
  const exitCode = await e2eLive.execute(
    ["prepare", "sample.commands", "--run-id", "run-auto", "--surface", "discord"],
    {
      repoRoot,
      env: {
        CODEX_HOME: codexHome
      },
      writeOutput: (message) => output.push(message)
    }
  );

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /session-file-match/);
  const config = JSON.parse(
    readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-auto", "bridge.config.json"), "utf8")
  ) as {
    discovery: {
      allowedThreadIds: string[];
    };
  };
  assert.deepEqual(config.discovery.allowedThreadIds, [threadId]);
});

test("e2e-live cleanup runs bridge clean with temp Discord env", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(
    [
      "prepare",
      "sample.commands",
      "--run-id",
      "run-clean",
      "--surface",
      "discord",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
      repoRoot,
      writeOutput: () => undefined
    }
  );
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-clean", "run.json"), "utf8")) as {
    configPath: string;
    storePath: string;
  };

  const output: string[] = [];
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const exitCode = await e2eLive.execute(["cleanup", "run-clean"], {
    repoRoot,
    env: {
      PATH: "wrong-path",
      Path: "right-path"
    },
    execPath: "/node-bin",
    spawnSync: ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push(options.env ? { command, args, env: options.env } : { command, args });
      return {
        status: 0,
        stdout: "clean ok",
        stderr: ""
      };
    }) as typeof spawnSync,
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.deepEqual(call.args, [path.join(repoRoot, "dist", "src", "index.js"), "clean", "--mapped-only"]);
  assert.equal(call.env?.Path, "right-path");
  assert.equal(call.env?.PATH, undefined);
  assert.equal(call.env?.BRIDGE_CONFIG_PATH, run.configPath);
  assert.equal(call.env?.STORE_PATH, run.storePath);
  assert.match(output.join("\n"), /No bridge PID file found for run-clean/);
  assert.match(output.join("\n"), /Discord clean output:\nclean ok/);
});

test("e2e-live cleanup-discord-runs skips store runs", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(["prepare", "sample.commands", "--run-id", "run-clean-store"], {
    repoRoot,
    writeOutput: () => undefined
  });
  await e2eLive.execute(
    [
      "prepare",
      "sample.commands",
      "--run-id",
      "run-clean-discord",
      "--surface",
      "discord",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
      repoRoot,
      writeOutput: () => undefined
    }
  );
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");

  const output: string[] = [];
  const calls: string[][] = [];
  const exitCode = await e2eLive.execute(["cleanup-discord-runs"], {
    repoRoot,
    execPath: "/node-bin",
    spawnSync: ((_command: string, args: string[]) => {
      calls.push(args);
      return {
        status: 0,
        stdout: "clean ok",
        stderr: ""
      };
    }) as typeof spawnSync,
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    [path.join(repoRoot, "dist", "src", "index.js"), "clean", "--mapped-only"],
    [path.join(repoRoot, "dist", "src", "index.js"), "clean", "--mapped-only"]
  ]);
  assert.match(output.join("\n"), /Found 1 prepared Discord-surface live e2e run/);
  assert.match(output.join("\n"), /Mapped-only Discord clean for run-clean-discord/);
  assert.match(output.join("\n"), /Prepared aggregate Discord cleanup store with 0 seeded category id/);
  assert.match(output.join("\n"), /run-clean-discord/);
  assert.doesNotMatch(output.join("\n"), /run-clean-store/);
});

test("e2e-live prepare requires marker for initial user message scenarios", async () => {
  const repoRoot = writeFixtureRepo();
  const errors: string[] = [];
  const missingMarkerExitCode = await e2eLive.execute(["prepare", "sample.user", "--run-id", "run-user"], {
    repoRoot,
    writeError: (message) => errors.push(message)
  });

  assert.equal(missingMarkerExitCode, 1);
  assert.match(errors.join("\n"), /requires --marker/);

  const output: string[] = [];
  const okExitCode = await e2eLive.execute(
    ["prepare", "sample.user", "--run-id", "run-user-ok", "--marker", "initial request phrase"],
    {
      repoRoot,
      writeOutput: (message) => output.push(message)
    }
  );

  assert.equal(okExitCode, 0);
  assert.match(output.join("\n"), /initial request phrase/);
});

test("e2e-live prepare rejects custom markers for non-user-message scenarios", async () => {
  const repoRoot = writeFixtureRepo();
  const errors: string[] = [];
  const exitCode = await e2eLive.execute(
    ["prepare", "sample.commands", "--run-id", "run-marker-wrong", "--marker", "initial request phrase"],
    {
      repoRoot,
      writeError: (message) => errors.push(message)
    }
  );

  assert.equal(exitCode, 1);
  assert.match(errors.join("\n"), /does not accept --marker/);
  assert.match(errors.join("\n"), /generated marker/);
});

test("e2e-live verify checks scoped inspect output", async () => {
  const repoRoot = writeFixtureRepo();
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const output: string[] = [];
  const calls: Array<{ channelId: string; limit: number }> = [];

  const exitCode = await e2eLive.execute(
    ["verify", "sample.commands", "--channel", "channel_1", "--marker", "MARKER_1"],
    {
      repoRoot,
      inspectDiscordThread: async (_repoRoot, channelId, limit) => {
        calls.push({ channelId, limit });
        return {
          status: 0,
          stdout: [
            "== Discord Thread Inspect ==",
            "Discord channel/thread: channel_1",
            "",
            "== Discord Messages ==",
            "- content: MARKER_1"
          ].join("\n"),
          stderr: "",
          error: null
        };
      },
      writeOutput: (message) => output.push(message)
    }
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{ channelId: "channel_1", limit: 5 }]);
  assert.match(output.join("\n"), /PASS live e2e verification/);
});

test("e2e-live Discord verify loads repo dotenv for in-process inspection", async () => {
  const repoRoot = writeFixtureRepo();
  writeFileSync(
    path.join(repoRoot, ".env"),
    [
      "DISCORD_BOT_TOKEN=dotenv-token",
      "DISCORD_APPLICATION_ID=dotenv-application",
      "DISCORD_GUILD_ID=dotenv-guild",
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(path.join(repoRoot, "package.json"), "{\"type\":\"module\"}\n", "utf8");
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, "dist", "src", "index.js"),
    [
      "export async function runInspectDiscordThread(channelId) {",
      "  if (process.cwd() !== process.env.EXPECTED_REPO_ROOT) {",
      "    throw new Error(`wrong cwd ${process.cwd()}`);",
      "  }",
      "  if (process.env.DISCORD_BOT_TOKEN !== 'dotenv-token') {",
      "    throw new Error('missing dotenv token');",
      "  }",
      "  console.log('== Discord Thread Inspect ==');",
      "  console.log(`Discord channel/thread: ${channelId}`);",
      "  console.log('');",
      "  console.log('== Discord Messages ==');",
      "  console.log('- content: MARKER_1');",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  const output: string[] = [];

  const exitCode = await e2eLive.execute(
    ["verify", "sample.commands", "--channel", "channel_1", "--marker", "MARKER_1"],
    {
      repoRoot,
      env: {
        EXPECTED_REPO_ROOT: repoRoot
      },
      writeOutput: (message) => output.push(message)
    }
  );

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /PASS live e2e verification/);
});

test("e2e-live verify ignores non-visible diagnostic sections", async () => {
  const repoRoot = writeFixtureRepo();
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const output: string[] = [];

  const exitCode = await e2eLive.execute(
    ["verify", "sample.commands", "--channel", "channel_1", "--marker", "MARKER_1"],
    {
      repoRoot,
      inspectDiscordThread: async () => ({
          status: 0,
          stdout: [
            "== Discord Thread Inspect ==",
            "Discord channel/thread: channel_1",
            "",
            "== Discord Messages ==",
            "- content: MARKER_1",
            "",
            "== Canonical Events ==",
            "- summary=FORBIDDEN detail=FORBIDDEN"
          ].join("\n"),
          stderr: "",
          error: null
        }),
      writeOutput: (message) => output.push(message)
    }
  );

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /PASS live e2e verification/);
  assert.doesNotMatch(output.join("\n"), /Forbidden content was present/);
});

test("e2e-live verify reports empty-message AggregateErrors", async () => {
  const repoRoot = writeFixtureRepo();
  const errors: string[] = [];

  const exitCode = await e2eLive.execute(
    ["verify", "sample.commands", "--channel", "channel_1", "--marker", "MARKER_1"],
    {
      repoRoot,
      inspectDiscordThread: async () => {
        const error = new AggregateError([], "");
        (error as Error & { code?: string }).code = "EACCES";
        throw error;
      },
      writeError: (message) => errors.push(message)
    }
  );

  assert.equal(exitCode, 1);
  assert.match(errors.join("\n"), /AggregateError \[EACCES\]/);
});

test("e2e-live Discord verify failure reports store snapshot and inspect text", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(
    [
      "prepare",
      "sample.summary",
      "--run-id",
      "run-discord-failure-diagnostics",
      "--surface",
      "discord",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
      repoRoot,
      writeOutput: () => undefined
    }
  );
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const run = JSON.parse(
    readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-discord-failure-diagnostics", "run.json"), "utf8")
  ) as {
    marker: string;
    storePath: string;
    reportPath: string;
  };
  const db = new Database(run.storePath);
  db.exec(`
    CREATE TABLE thread_bridges (
      codex_thread_id TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      channel_kind TEXT,
      parent_codex_thread_id TEXT,
      project_name TEXT,
      thread_name TEXT,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE canonical_thread_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      summary TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE mirrored_items (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      discord_message_id TEXT NOT NULL,
      rendered_content TEXT NOT NULL,
      timestamp_ms INTEGER,
      cursor TEXT
    );
  `);
  const now = Date.now();
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("target_thread", "discord_channel_target", "conversation", null, "repo", "Target thread", new Date(now).toISOString());
  db.prepare(
    "INSERT INTO canonical_thread_events (thread_id, summary, detail, created_at) VALUES (?, ?, ?, ?)"
  ).run("target_thread", `Write-Output "${run.marker} command-two"`, null, new Date(now).toISOString());
  db.prepare(
    [
      "INSERT INTO mirrored_items",
      "(thread_id, item_id, kind, discord_message_id, rendered_content, timestamp_ms, cursor)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("target_thread", "item_target", "command", "target_msg", "Codex\nRan 2 commands", now, "cursor_target");
  db.close();

  const output: string[] = [];
  const exitCode = await e2eLive.execute(["verify", "sample.summary", "--run-id", "run-discord-failure-diagnostics"], {
    repoRoot,
    inspectDiscordThread: async (_repoRoot, channel) => {
      return {
        status: 0,
        stdout: [
          "== Discord Thread Inspect ==",
          `Discord channel/thread: ${channel}`,
          "",
          "== Discord Messages ==",
          "- 24/04/2026, 17:47:02 id=target_msg Codex type=default",
          "  content: Still waiting for summary"
        ].join("\n"),
        stderr: "",
        error: null
      };
    },
    writeOutput: (message) => output.push(message)
  });

  const text = output.join("\n");
  assert.equal(exitCode, 1);
  assert.match(text, /FAIL live e2e verification/);
  assert.match(text, /Selected store snapshot:/);
  assert.match(text, /command item_target: Codex Ran 2 commands/);
  assert.match(text, /Last Discord inspect output:/);
  assert.match(text, /Still waiting for summary/);
  assert.match(readFileSync(run.reportPath, "utf8"), /Selected store snapshot:/);
});

test("e2e-live verify defaults to local store verification for prepared store runs", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(["prepare", "sample.commands", "--run-id", "run-store"], {
    repoRoot,
    writeOutput: () => undefined
  });
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-store", "run.json"), "utf8")) as {
    marker: string;
    storePath: string;
  };
  const db = new Database(run.storePath);
  db.exec(`
    CREATE TABLE thread_bridges (
      codex_thread_id TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      channel_kind TEXT,
      parent_codex_thread_id TEXT,
      project_name TEXT,
      thread_name TEXT,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE mirrored_items (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      rendered_content TEXT NOT NULL,
      timestamp_ms INTEGER,
      cursor TEXT
    );
  `);
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("store_thread", "local_channel_store_thread", "conversation", null, "repo", "Store thread", new Date().toISOString());
  db.prepare(
    [
      "INSERT INTO mirrored_items",
      "(thread_id, item_id, kind, rendered_content, timestamp_ms, cursor)",
      "VALUES (?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("store_thread", "item_1", "command", `Stored ${run.marker}`, Date.now(), "cursor_1");
  db.close();

  const output: string[] = [];
  const exitCode = await e2eLive.execute(["verify", "sample.commands", "--run-id", "run-store"], {
    repoRoot,
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /PASS live e2e store verification/);
  assert.match(output.join("\n"), /Surface: store/);
  assert.match(output.join("\n"), /Thread selection: auto conversation local_channel_store_thread codex=store_thread/);
  assert.match(output.join("\n"), new RegExp(run.marker));
});

test("e2e-live verify selects the store thread containing expected evidence", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(["prepare", "sample.commands", "--run-id", "run-store-multiple"], {
    repoRoot,
    writeOutput: () => undefined
  });
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-store-multiple", "run.json"), "utf8")) as {
    marker: string;
    storePath: string;
  };
  const db = new Database(run.storePath);
  db.exec(`
    CREATE TABLE thread_bridges (
      codex_thread_id TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      channel_kind TEXT,
      parent_codex_thread_id TEXT,
      project_name TEXT,
      thread_name TEXT,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE mirrored_items (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      rendered_content TEXT NOT NULL,
      timestamp_ms INTEGER,
      cursor TEXT
    );
  `);
  const now = Date.now();
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("wrong_thread", "local_channel_wrong", "conversation", null, "repo", "Wrong thread", new Date(now + 1000).toISOString());
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("target_thread", "local_channel_target", "conversation", null, "repo", "Target thread", new Date(now).toISOString());
  db.prepare(
    [
      "INSERT INTO mirrored_items",
      "(thread_id, item_id, kind, rendered_content, timestamp_ms, cursor)",
      "VALUES (?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("wrong_thread", "item_wrong", "command", "Unrelated activity", now + 1000, "cursor_wrong");
  db.prepare(
    [
      "INSERT INTO mirrored_items",
      "(thread_id, item_id, kind, rendered_content, timestamp_ms, cursor)",
      "VALUES (?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("target_thread", "item_target", "command", `Stored ${run.marker}`, now, "cursor_target");
  db.close();

  const output: string[] = [];
  const exitCode = await e2eLive.execute(["verify", "sample.commands", "--run-id", "run-store-multiple"], {
    repoRoot,
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /PASS live e2e store verification/);
  assert.match(output.join("\n"), /Thread selection: auto conversation local_channel_target codex=target_thread/);
  assert.match(output.join("\n"), new RegExp(run.marker));
});

test("e2e-live absence-only store verify falls back to fresh mapped threads without marker evidence", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(["prepare", "sample.absence", "--run-id", "run-store-absence"], {
    repoRoot,
    writeOutput: () => undefined
  });
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-store-absence", "run.json"), "utf8")) as {
    marker: string;
    storePath: string;
  };
  const db = new Database(run.storePath);
  db.exec(`
    CREATE TABLE thread_bridges (
      codex_thread_id TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      channel_kind TEXT,
      parent_codex_thread_id TEXT,
      project_name TEXT,
      thread_name TEXT,
      last_seen_at TEXT NOT NULL
    );
  `);
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run(
    "absence_thread",
    "local_channel_absence",
    "conversation",
    null,
    "repo",
    `Absence thread ${run.marker}`,
    new Date().toISOString()
  );
  db.close();

  const output: string[] = [];
  const exitCode = await e2eLive.execute(["verify", "sample.absence", "--run-id", "run-store-absence"], {
    repoRoot,
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /PASS live e2e store verification/);
  assert.match(output.join("\n"), new RegExp(`Thread selection: auto conversation local_channel_absence codex=absence_thread name="Absence thread ${run.marker}"`));
});

test("e2e-live approval store verify selects subagent thread and includes approval evidence", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(["prepare", "sample.approval", "--run-id", "run-store-approval", "--surface", "store"], {
    repoRoot,
    writeOutput: () => undefined
  });
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-store-approval", "run.json"), "utf8")) as {
    marker: string;
    storePath: string;
  };
  const db = new Database(run.storePath);
  db.exec(`
    CREATE TABLE thread_bridges (
      codex_thread_id TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      channel_kind TEXT,
      parent_codex_thread_id TEXT,
      project_name TEXT,
      thread_name TEXT,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE canonical_thread_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      summary TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE pending_approvals (
      token TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      request_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      discord_message_id TEXT,
      available_decisions TEXT NOT NULL,
      sanitized_preview TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("parent_thread", "local_channel_parent", "conversation", null, "repo", "Parent thread", new Date(now).toISOString());
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("child_thread", "local_thread_child", "subagent", "parent_thread", "repo", "Child thread", new Date(now + 1000).toISOString());
  db.prepare(
    "INSERT INTO canonical_thread_events (thread_id, summary, detail, created_at) VALUES (?, ?, ?, ?)"
  ).run("child_thread", "Approval request arrived.", `Write-Output "${run.marker} approval-request"`, new Date(now + 1000).toISOString());
  db.prepare(
    [
      "INSERT INTO pending_approvals",
      "(token, thread_id, kind, status, request_id, item_id, discord_message_id, available_decisions, sanitized_preview, created_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run(
    "approval_token",
    "child_thread",
    "commandExecution",
    "pending",
    "request_1",
    "item_1",
    "local_message_approval_1",
    "[\"accept\",\"cancel\"]",
    `Write-Output "${run.marker} approval-request"`,
    new Date(now + 1000).toISOString()
  );
  db.close();

  const output: string[] = [];
  const exitCode = await e2eLive.execute(["verify", "sample.approval", "--run-id", "run-store-approval"], {
    repoRoot,
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /PASS live e2e store verification/);
  assert.match(output.join("\n"), /Thread selection: auto subagent local_thread_child codex=child_thread/);
  assert.match(output.join("\n"), /approval commandExecution/);
  assert.match(output.join("\n"), /status=pending/);
  assert.match(output.join("\n"), new RegExp(run.marker));
});

test("e2e-live proposed-plan store verify selects subagent thread and includes plan evidence", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(["prepare", "sample.plan", "--run-id", "run-store-plan", "--surface", "store"], {
    repoRoot,
    writeOutput: () => undefined
  });
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-store-plan", "run.json"), "utf8")) as {
    marker: string;
    storePath: string;
  };
  const db = new Database(run.storePath);
  db.exec(`
    CREATE TABLE thread_bridges (
      codex_thread_id TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      channel_kind TEXT,
      parent_codex_thread_id TEXT,
      project_name TEXT,
      thread_name TEXT,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE proposed_plan_actions (
      token TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      plan_text TEXT NOT NULL,
      status TEXT NOT NULL,
      discord_message_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("parent_thread", "local_channel_parent", "conversation", null, "repo", "Parent thread", new Date(now).toISOString());
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("wrong_child", "local_thread_wrong", "subagent", "parent_thread", "repo", "Wrong child", new Date(now + 2000).toISOString());
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("target_child", "local_thread_plan", "subagent", "parent_thread", "repo", "Plan child", new Date(now + 1000).toISOString());
  db.prepare(
    [
      "INSERT INTO proposed_plan_actions",
      "(token, thread_id, item_id, plan_text, status, discord_message_id, created_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run(
    "plan_token",
    "target_child",
    "item_plan",
    `# ${run.marker} proposed-plan\n\n- Keep it harmless.`,
    "pending",
    "local_message_plan_1",
    new Date(now + 1000).toISOString()
  );
  db.close();

  const output: string[] = [];
  const exitCode = await e2eLive.execute(["verify", "sample.plan", "--run-id", "run-store-plan"], {
    repoRoot,
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /PASS live e2e store verification/);
  assert.match(output.join("\n"), /Thread selection: auto subagent local_thread_plan codex=target_child/);
  assert.match(output.join("\n"), /proposed-plan status=pending/);
  assert.match(output.join("\n"), new RegExp(run.marker));
});

test("e2e-live Discord verify selects the channel containing expected evidence", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(
    [
      "prepare",
      "sample.commands",
      "--run-id",
      "run-discord-multiple",
      "--surface",
      "discord",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
      repoRoot,
      writeOutput: () => undefined
    }
  );
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-discord-multiple", "run.json"), "utf8")) as {
    marker: string;
    storePath: string;
  };
  const db = new Database(run.storePath);
  db.exec(`
    CREATE TABLE thread_bridges (
      codex_thread_id TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      channel_kind TEXT,
      parent_codex_thread_id TEXT,
      project_name TEXT,
      thread_name TEXT,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE canonical_thread_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      summary TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("wrong_thread", "discord_channel_wrong", "conversation", null, "repo", "Wrong thread", new Date(now + 1000).toISOString());
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("target_thread", "discord_channel_target", "conversation", null, "repo", "Target thread", new Date(now).toISOString());
  db.prepare(
    "INSERT INTO canonical_thread_events (thread_id, summary, detail, created_at) VALUES (?, ?, ?, ?)"
  ).run("target_thread", `Observed ${run.marker}`, null, new Date(now).toISOString());
  db.close();

  const output: string[] = [];
  const channels: string[] = [];
  const exitCode = await e2eLive.execute(["verify", "sample.commands", "--run-id", "run-discord-multiple"], {
    repoRoot,
    inspectDiscordThread: async (_repoRoot, channel) => {
      channels.push(channel);
      return {
        status: 0,
        stdout: [
          "== Discord Thread Inspect ==",
          `Discord channel/thread: ${channel}`,
          "",
          "== Discord Messages ==",
          channel === "discord_channel_target" ? `- content: ${run.marker}` : "- content: unrelated"
        ].join("\n"),
        stderr: "",
        error: null
      };
    },
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(channels, ["discord_channel_target"]);
  assert.match(output.join("\n"), /PASS live e2e verification/);
  assert.match(output.join("\n"), /Channel selection: auto conversation discord_channel_target codex=target_thread.*markerEvidence=1/);
});

test("e2e-live Discord verify scopes generic expectations with store marker evidence and message ids", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(
    [
      "prepare",
      "sample.summary",
      "--run-id",
      "run-discord-summary",
      "--surface",
      "discord",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
    repoRoot,
    writeOutput: () => undefined
    }
  );
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-discord-summary", "run.json"), "utf8")) as {
    marker: string;
    storePath: string;
  };
  const db = new Database(run.storePath);
  db.exec(`
    CREATE TABLE thread_bridges (
      codex_thread_id TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      channel_kind TEXT,
      parent_codex_thread_id TEXT,
      project_name TEXT,
      thread_name TEXT,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE canonical_thread_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      summary TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE mirrored_items (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      discord_message_id TEXT NOT NULL,
      rendered_content TEXT NOT NULL,
      timestamp_ms INTEGER,
      cursor TEXT
    );
  `);
  const now = Date.now();
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("wrong_thread", "discord_channel_wrong", "conversation", null, "repo", "Wrong thread", new Date(now + 1000).toISOString());
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("target_thread", "discord_channel_target", "conversation", null, "repo", "Target thread", new Date(now).toISOString());
  db.prepare(
    "INSERT INTO canonical_thread_events (thread_id, summary, detail, created_at) VALUES (?, ?, ?, ?)"
  ).run("target_thread", `Write-Output "${run.marker} command-two"`, null, new Date(now).toISOString());
  db.prepare(
    [
      "INSERT INTO mirrored_items",
      "(thread_id, item_id, kind, discord_message_id, rendered_content, timestamp_ms, cursor)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("target_thread", "item_target", "command", "target_msg", "Codex\nRan 2 commands", now, "cursor_target");
  db.close();

  const output: string[] = [];
  const channels: string[] = [];
  const exitCode = await e2eLive.execute(["verify", "sample.summary", "--run-id", "run-discord-summary"], {
    repoRoot,
    inspectDiscordThread: async (_repoRoot, channel) => {
      channels.push(channel);
      return {
        status: 0,
        stdout: [
          "== Discord Thread Inspect ==",
          `Discord channel/thread: ${channel}`,
          "",
          "== Discord Messages ==",
          channel === "discord_channel_target"
            ? "- 24/04/2026, 17:47:02 id=target_msg Codex type=default\n  content: Ran 2 commands"
            : "- 24/04/2026, 17:40:00 id=wrong_msg Codex type=default\n  content: Ran 2 commands"
        ].join("\n"),
        stderr: "",
        error: null
      };
    },
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(channels, ["discord_channel_target"]);
  assert.match(output.join("\n"), /PASS live e2e verification/);
  assert.match(output.join("\n"), /id=target_msg/);
  assert.match(output.join("\n"), /messages=target_msg/);
});

test("e2e-live Discord approval verify selects child thread from canonical approval evidence", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(
    [
      "prepare",
      "sample.approval",
      "--run-id",
      "run-discord-approval",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
    repoRoot,
    writeOutput: () => undefined
    }
  );
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-discord-approval", "run.json"), "utf8")) as {
    marker: string;
    storePath: string;
  };
  const db = new Database(run.storePath);
  db.exec(`
    CREATE TABLE thread_bridges (
      codex_thread_id TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      channel_kind TEXT,
      parent_codex_thread_id TEXT,
      project_name TEXT,
      thread_name TEXT,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE canonical_thread_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      summary TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("parent_thread", "discord_channel_parent", "conversation", null, "repo", "Parent thread", new Date(now).toISOString());
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("wrong_child", "discord_thread_wrong", "subagent", "parent_thread", "repo", "Wrong child", new Date(now + 2000).toISOString());
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("target_child", "discord_thread_target", "subagent", "parent_thread", "repo", "Target child", new Date(now + 1000).toISOString());
  db.prepare(
    "INSERT INTO canonical_thread_events (thread_id, summary, detail, created_at) VALUES (?, ?, ?, ?)"
  ).run("target_child", "Approval request arrived.", `Write-Output "${run.marker} approval-request"`, new Date(now + 1000).toISOString());
  db.close();

  const output: string[] = [];
  const channels: string[] = [];
  const exitCode = await e2eLive.execute(["verify", "sample.approval", "--run-id", "run-discord-approval"], {
    repoRoot,
    inspectDiscordThread: async (_repoRoot, channel) => {
      channels.push(channel);
      return {
        status: 0,
        stdout: [
          "== Discord Thread Inspect ==",
          `Discord channel/thread: ${channel}`,
          "",
          "== Discord Messages ==",
          channel === "discord_thread_target"
            ? [
                `- 24/04/2026, 17:47:02 id=approval_msg Codex type=default`,
                `  content: ${run.marker}\nStatus: Approved in Codex\nType: Command execution\nPreview: \`Write-Output \"${run.marker} approval-request\"\``
              ].join("\n")
            : "- 24/04/2026, 17:40:00 id=wrong_msg Codex type=default\n  content: unrelated"
        ].join("\n"),
        stderr: "",
        error: null
      };
    },
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(channels, ["discord_thread_target"]);
  assert.match(output.join("\n"), /PASS live e2e verification/);
  assert.match(output.join("\n"), /Channel selection: auto subagent discord_thread_target codex=target_child.*markerEvidence=1/);
});

test("e2e-live Discord proposed-plan verify selects child thread from plan evidence", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(
    [
      "prepare",
      "sample.plan",
      "--run-id",
      "run-discord-plan",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
    repoRoot,
    writeOutput: () => undefined
    }
  );
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-discord-plan", "run.json"), "utf8")) as {
    marker: string;
    storePath: string;
  };
  const db = new Database(run.storePath);
  db.exec(`
    CREATE TABLE thread_bridges (
      codex_thread_id TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      channel_kind TEXT,
      parent_codex_thread_id TEXT,
      project_name TEXT,
      thread_name TEXT,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE proposed_plan_actions (
      token TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      plan_text TEXT NOT NULL,
      status TEXT NOT NULL,
      discord_message_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("parent_thread", "discord_channel_parent", "conversation", null, "repo", "Parent thread", new Date(now).toISOString());
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("wrong_child", "discord_thread_wrong", "subagent", "parent_thread", "repo", "Wrong child", new Date(now + 2000).toISOString());
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("target_child", "discord_thread_plan", "subagent", "parent_thread", "repo", "Plan child", new Date(now + 1000).toISOString());
  db.prepare(
    [
      "INSERT INTO proposed_plan_actions",
      "(token, thread_id, item_id, plan_text, status, discord_message_id, created_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run(
    "plan_token",
    "target_child",
    "item_plan",
    `# ${run.marker} proposed-plan\n\n- Keep it harmless.`,
    "pending",
    "plan_msg",
    new Date(now + 1000).toISOString()
  );
  db.close();

  const output: string[] = [];
  const channels: string[] = [];
  const exitCode = await e2eLive.execute(["verify", "sample.plan", "--run-id", "run-discord-plan"], {
    repoRoot,
    inspectDiscordThread: async (_repoRoot, channel) => {
      channels.push(channel);
      return {
        status: 0,
        stdout: [
          "== Discord Thread Inspect ==",
          `Discord channel/thread: ${channel}`,
          "",
          "== Discord Messages ==",
          channel === "discord_thread_plan"
            ? [
                `- 24/04/2026, 17:47:02 id=plan_msg Codex type=default`,
                `  content: <proposed_plan>\n# ${run.marker} proposed-plan\n</proposed_plan>`,
                "  components: Button:Accept plan style=1 customId=codex:plan:token:accept | Button:No, and tell Codex what to do differently style=2 customId=codex:plan:token:feedback"
              ].join("\n")
            : "- 24/04/2026, 17:40:00 id=wrong_msg Codex type=default\n  content: unrelated"
        ].join("\n"),
        stderr: "",
        error: null
      };
    },
    writeOutput: (message) => output.push(message)
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(channels, ["discord_thread_plan"]);
  assert.match(output.join("\n"), /PASS live e2e verification/);
  assert.match(output.join("\n"), /id=plan_msg/);
  assert.match(output.join("\n"), /messages=plan_msg/);
  assert.match(output.join("\n"), /Channel selection: auto subagent discord_thread_plan codex=target_child.*markerEvidence=1/);
});

test("e2e-live verify can load marker and temp env from run id", async () => {
  const repoRoot = writeFixtureRepo();
  await e2eLive.execute(
    [
      "prepare",
      "sample.commands",
      "--run-id",
      "run-verify",
      "--surface",
      "discord",
      "--thread-id",
      "019dc07b-9c42-74c0-95b1-f3f816d463b1"
    ],
    {
    repoRoot,
    writeOutput: () => undefined
    }
  );
  mkdirSync(path.join(repoRoot, "dist", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", "src", "index.js"), "", "utf8");
  const run = JSON.parse(readFileSync(path.join(repoRoot, "tmp", "live-e2e", "run-verify", "run.json"), "utf8")) as {
    marker: string;
    configPath: string;
    storePath: string;
  };
  const output: string[] = [];
  const calls: Array<{ channelId: string; limit: number; env?: NodeJS.ProcessEnv }> = [];
  const db = new Database(run.storePath);
  db.exec(`
    CREATE TABLE thread_bridges (
      codex_thread_id TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      channel_kind TEXT,
      parent_codex_thread_id TEXT,
      project_name TEXT,
      thread_name TEXT,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE canonical_thread_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      summary TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("older_thread", "old_channel", "conversation", null, "repo", "Old thread", "2026-01-01T00:00:00.000Z");
  db.prepare(
    [
      "INSERT INTO thread_bridges",
      "(codex_thread_id, discord_channel_id, channel_kind, parent_codex_thread_id, project_name, thread_name, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  ).run("current_thread", "channel_auto", "conversation", null, "repo", "Current thread", new Date().toISOString());
  db.prepare(
    "INSERT INTO canonical_thread_events (thread_id, summary, detail, created_at) VALUES (?, ?, ?, ?)"
  ).run("current_thread", `Observed ${run.marker}`, null, new Date().toISOString());
  db.close();

  const exitCode = await e2eLive.execute(
    ["verify", "sample.commands", "--run-id", "run-verify"],
    {
      repoRoot,
      env: {
        PATH: "wrong-path",
        Path: "right-path"
      },
      inspectDiscordThread: async (_repoRoot, channelId, limit, options) => {
        calls.push(options.env ? { channelId, limit, env: options.env } : { channelId, limit });
        return {
          status: 0,
          stdout: [
            "== Discord Thread Inspect ==",
            "Discord channel/thread: channel_auto",
            "",
            "== Discord Messages ==",
            `- content: ${run.marker}`
          ].join("\n"),
          stderr: "",
          error: null
        };
      },
      writeOutput: (message) => output.push(message)
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.channelId, "channel_auto");
  assert.equal(call.limit, 5);
  assert.ok(call.env);
  assert.equal(call.env.Path, "right-path");
  assert.equal(call.env.PATH, undefined);
  assert.equal(call.env.BRIDGE_CONFIG_PATH, run.configPath);
  assert.equal(call.env.STORE_PATH, run.storePath);
  assert.match(output.join("\n"), /PASS live e2e verification/);
  assert.match(output.join("\n"), /Channel selection: auto conversation channel_auto codex=current_thread/);
  assert.match(output.join("\n"), new RegExp(run.marker));
});
