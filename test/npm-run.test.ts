import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.cwd(), "package.json"));
const npmRun = require("./scripts/npm-run.cjs") as {
  main: (
    argv?: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
      execPath?: string;
      scriptDir?: string;
      spawnSync?: typeof spawnSync;
      writeError?: (message: string) => void;
      exit?: (code: number) => void;
    }
  ) => void;
  execute: (
    argv?: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
      execPath?: string;
      scriptDir?: string;
      spawnSync?: typeof spawnSync;
      writeError?: (message: string) => void;
    }
  ) => number;
  resolvePackageJsonPath: (env?: NodeJS.ProcessEnv, scriptDir?: string) => string;
};

test("package npm launchers route directly through npm-run.cjs", () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts.build, "node scripts/npm-run.cjs build");
  assert.equal(packageJson.scripts.clean, "node scripts/npm-run.cjs clean");
  assert.equal(packageJson.scripts["inspect:discord-thread"], "node scripts/npm-run.cjs inspect discord-thread");
  for (const [name, script] of Object.entries(packageJson.scripts)) {
    assert.match(script, /^node scripts\/npm-run\.cjs\b/, `${name} should use npm-run.cjs`);
    assert.doesNotMatch(script, /node -e/, `${name} should not use the old eval launcher`);
  }
});

test("package launcher preserves clean args through npm-run.cjs", () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const cleanScript = packageJson.scripts.clean;
  assert.equal(cleanScript, "node scripts/npm-run.cjs clean");

  const calls: Array<{ command: string; args: string[] }> = [];
  const fakeRepo = path.join(tmpdir(), "codex-mobile-clean-forwarding");
  const exitCode = npmRun.execute(["clean", "--dry-run"], {
    env: { npm_package_json: path.join(fakeRepo, "package.json") } as NodeJS.ProcessEnv,
    execPath: "/node-bin",
    scriptDir: path.join(fakeRepo, "scripts"),
    spawnSync: ((command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0 };
    }) as typeof spawnSync
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls[1], {
    command: "/node-bin",
    args: [path.join(fakeRepo, "dist", "src", "index.js"), "clean", "--dry-run"]
  });
});

test("npm-run execute normalizes repo root and runs build before clean", () => {
  const calls: Array<{ command: string; args: string[]; cwd: string | undefined }> = [];
  const fakeRepo = path.join(tmpdir(), "codex-mobile-runner-repo");
  const env = {
    npm_package_json:
      process.platform === "win32"
        ? `\\\\?\\${path.join(fakeRepo, "package.json")}`
        : path.join(fakeRepo, "package.json")
  } as NodeJS.ProcessEnv;

  const exitCode = npmRun.execute(["clean", "--verbose"], {
    env,
    execPath: "/node-bin",
    scriptDir: path.join(fakeRepo, "scripts"),
    spawnSync: ((command: string, args: string[], options: { cwd?: string }) => {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0 };
    }) as typeof spawnSync
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      command: "/node-bin",
      args: [
        path.join(fakeRepo, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        path.join(fakeRepo, "tsconfig.json")
      ],
      cwd: fakeRepo
    },
    {
      command: "/node-bin",
      args: [path.join(fakeRepo, "dist", "src", "index.js"), "clean", "--verbose"],
      cwd: fakeRepo
    }
  ]);
});

test("npm-run execute runs build before coverage", () => {
  const calls: Array<{ command: string; args: string[]; cwd: string | undefined }> = [];
  const fakeRepo = path.join(tmpdir(), "codex-mobile-runner-coverage");
  const env = {
    npm_package_json:
      process.platform === "win32"
        ? `\\\\?\\${path.join(fakeRepo, "package.json")}`
        : path.join(fakeRepo, "package.json")
  } as NodeJS.ProcessEnv;

  const exitCode = npmRun.execute(["coverage"], {
    env,
    execPath: "/node-bin",
    scriptDir: path.join(fakeRepo, "scripts"),
    spawnSync: ((command: string, args: string[], options: { cwd?: string }) => {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0 };
    }) as typeof spawnSync
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      command: "/node-bin",
      args: [
        path.join(fakeRepo, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        path.join(fakeRepo, "tsconfig.json")
      ],
      cwd: fakeRepo
    },
    {
      command: "/node-bin",
      args: [
        "--experimental-test-coverage",
        path.join(fakeRepo, "dist", "test", "run.js")
      ],
      cwd: fakeRepo
    }
  ]);
});

test("npm-run execute applies the core coverage gate when requested", () => {
  const calls: Array<{ command: string; args: string[]; cwd: string | undefined }> = [];
  const fakeRepo = path.join(tmpdir(), "codex-mobile-runner-coverage-gate");
  const env = {
    npm_package_json:
      process.platform === "win32"
        ? `\\\\?\\${path.join(fakeRepo, "package.json")}`
        : path.join(fakeRepo, "package.json")
  } as NodeJS.ProcessEnv;

  const exitCode = npmRun.execute(["coverage", "gate"], {
    env,
    execPath: "/node-bin",
    scriptDir: path.join(fakeRepo, "scripts"),
    spawnSync: ((command: string, args: string[], options: { cwd?: string }) => {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0 };
    }) as typeof spawnSync
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      command: "/node-bin",
      args: [
        path.join(fakeRepo, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        path.join(fakeRepo, "tsconfig.json")
      ],
      cwd: fakeRepo
    },
    {
      command: "/node-bin",
      args: [
        "--experimental-test-coverage",
        "--test-coverage-lines=80",
        "--test-coverage-include",
        "dist/src/bridge/BridgeService.js",
        "--test-coverage-include",
        "dist/src/bridge/approval/*.js",
        "--test-coverage-include",
        "dist/src/bridge/artifacts/*.js",
        "--test-coverage-include",
        "dist/src/bridge/commands/*.js",
        "--test-coverage-include",
        "dist/src/bridge/events/subagentAttachment.js",
        "--test-coverage-include",
        "dist/src/bridge/runtime/*.js",
        "--test-coverage-include",
        "dist/src/codex/codexFsHelpers.js",
        "--test-coverage-include",
        "dist/src/config.js",
        "--test-coverage-include",
        "dist/src/platform.js",
        "--test-coverage-include",
        "dist/src/policy/*.js",
        "--test-coverage-include",
        "dist/src/store/StateStore.js",
        "--test-coverage-include",
        "scripts/npm-run.cjs",
        path.join(fakeRepo, "dist", "test", "run.js")
      ],
      cwd: fakeRepo
    }
  ]);
});

test("npm-run execute covers direct launcher routes", () => {
  const fakeRepo = path.join(tmpdir(), "codex-mobile-runner-direct");
  const env = {
    npm_package_json:
      process.platform === "win32"
        ? `\\\\?\\${path.join(fakeRepo, "package.json")}`
        : path.join(fakeRepo, "package.json")
  } as NodeJS.ProcessEnv;

  for (const testCase of [
    {
      action: "build",
      extraArgs: [] as string[],
      expectedArgs: [path.join(fakeRepo, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(fakeRepo, "tsconfig.json")]
    },
    {
      action: "check",
      extraArgs: [] as string[],
      expectedArgs: [
        path.join(fakeRepo, "node_modules", "typescript", "bin", "tsc"),
        "--noEmit",
        "-p",
        path.join(fakeRepo, "tsconfig.json")
      ]
    },
    {
      action: "dev",
      extraArgs: ["--inspect"],
      expectedArgs: [
        path.join(fakeRepo, "node_modules", "tsx", "dist", "cli.mjs"),
        "watch",
        path.join(fakeRepo, "src", "index.ts"),
        "--inspect"
      ]
    },
    {
      action: "e2e-live",
      extraArgs: ["list"],
      expectedArgs: [path.join(fakeRepo, "scripts", "e2e-live.cjs"), "list"]
    },
    {
      action: "start",
      extraArgs: ["--foreground"],
      expectedArgs: [path.join(fakeRepo, "dist", "src", "index.js"), "--foreground"]
    }
  ]) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exitCode = npmRun.execute([testCase.action, ...testCase.extraArgs], {
      env,
      execPath: "/node-bin",
      scriptDir: path.join(fakeRepo, "scripts"),
      spawnSync: ((command: string, args: string[]) => {
        calls.push({ command, args });
        return { status: 0 };
      }) as typeof spawnSync
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [{ command: "/node-bin", args: testCase.expectedArgs }]);
  }
});

test("npm-run execute covers build-gated routes and short-circuits on build failure", () => {
  const fakeRepo = path.join(tmpdir(), "codex-mobile-runner-gated");
  const env = {
    npm_package_json:
      process.platform === "win32"
        ? `\\\\?\\${path.join(fakeRepo, "package.json")}`
        : path.join(fakeRepo, "package.json")
  } as NodeJS.ProcessEnv;

  for (const testCase of [
    {
      action: "doctor",
      extraArgs: [] as string[],
      expectedSecondArgs: [path.join(fakeRepo, "dist", "src", "doctor.js")]
    },
    {
      action: "init",
      extraArgs: [] as string[],
      expectedSecondArgs: [path.join(fakeRepo, "dist", "src", "init.js")]
    },
    {
      action: "approvals",
      extraArgs: ["--json"],
      expectedSecondArgs: [path.join(fakeRepo, "dist", "src", "index.js"), "approvals", "--json"]
    },
    {
      action: "approve",
      extraArgs: ["123", "accept"],
      expectedSecondArgs: [path.join(fakeRepo, "dist", "src", "index.js"), "approve", "123", "accept"]
    },
    {
      action: "inspect",
      extraArgs: ["store"],
      expectedSecondArgs: [path.join(fakeRepo, "dist", "src", "index.js"), "inspect", "store"]
    },
    {
      action: "cli",
      extraArgs: ["threads"],
      expectedSecondArgs: [path.join(fakeRepo, "dist", "src", "index.js"), "cli", "threads"]
    },
    {
      action: "test",
      extraArgs: [] as string[],
      expectedSecondArgs: [path.join(fakeRepo, "dist", "test", "run.js")]
    }
  ]) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exitCode = npmRun.execute([testCase.action, ...testCase.extraArgs], {
      env,
      execPath: "/node-bin",
      scriptDir: path.join(fakeRepo, "scripts"),
      spawnSync: ((command: string, args: string[]) => {
        calls.push({ command, args });
        return { status: 0 };
      }) as typeof spawnSync
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      {
        command: "/node-bin",
        args: [
          path.join(fakeRepo, "node_modules", "typescript", "bin", "tsc"),
          "-p",
          path.join(fakeRepo, "tsconfig.json")
        ]
      },
      {
        command: "/node-bin",
        args: testCase.expectedSecondArgs
      }
    ]);
  }

  const failedCalls: Array<{ command: string; args: string[] }> = [];
  const exitCode = npmRun.execute(["doctor"], {
    env,
    execPath: "/node-bin",
    scriptDir: path.join(fakeRepo, "scripts"),
    spawnSync: ((command: string, args: string[]) => {
      failedCalls.push({ command, args });
      return { status: failedCalls.length === 1 ? 2 : 0 };
    }) as typeof spawnSync
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(failedCalls, [
    {
      command: "/node-bin",
      args: [
        path.join(fakeRepo, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        path.join(fakeRepo, "tsconfig.json")
      ]
    }
  ]);
});

test("npm-run execute reports missing actions, unknown actions, and spawn errors", () => {
  const fakeRepo = path.join(tmpdir(), "codex-mobile-runner-errors");
  const env = {
    npm_package_json:
      process.platform === "win32"
        ? `\\\\?\\${path.join(fakeRepo, "package.json")}`
        : path.join(fakeRepo, "package.json")
  } as NodeJS.ProcessEnv;
  const errors: string[] = [];

  assert.equal(
    npmRun.execute([], {
      env,
      scriptDir: path.join(fakeRepo, "scripts"),
      writeError: (message) => errors.push(message)
    }),
    1
  );
  assert.match(errors[0] ?? "", /Usage: npm-run.cjs/);

  assert.equal(
    npmRun.execute(["unknown"], {
      env,
      scriptDir: path.join(fakeRepo, "scripts"),
      writeError: (message) => errors.push(message)
    }),
    1
  );
  assert.match(errors[1] ?? "", /Unknown action: unknown/);

  assert.equal(
    npmRun.execute(["build"], {
      env,
      execPath: "/node-bin",
      scriptDir: path.join(fakeRepo, "scripts"),
      writeError: (message) => errors.push(message),
      spawnSync: ((() => ({ status: null, error: new Error("spawn failed") })) as unknown) as typeof spawnSync
    }),
    1
  );
  assert.match(errors[2] ?? "", /spawn failed/);
});

test("npm-run main exits with the execute status", () => {
  let exitCode: number | null = null;

  npmRun.main(["check"], {
    exit: (code: number) => {
      exitCode = code;
    },
    execPath: "/node-bin",
    env: {
      npm_package_json: path.join(tmpdir(), "codex-mobile-main", "package.json")
    } as NodeJS.ProcessEnv,
    scriptDir: path.join(tmpdir(), "codex-mobile-main", "scripts"),
    spawnSync: ((() => ({ status: 7 })) as unknown) as typeof spawnSync
  });

  assert.equal(exitCode, 7);
});

test("npm-run resolves package.json from scriptDir when npm_package_json is missing", () => {
  const scriptDir = path.join(tmpdir(), "codex-mobile-runner-fallback", "scripts");
  assert.equal(
    npmRun.resolvePackageJsonPath({} as NodeJS.ProcessEnv, scriptDir),
    path.join(scriptDir, "..", "package.json")
  );
});
