#!/usr/bin/env node

const childProcess = require("node:child_process");
const path = require("node:path");

function normalizeMaybeExtendedLengthPath(input) {
  if (!input) {
    return input;
  }

  return input.replace(/^\\\\\?\\/, "");
}

function resolvePackageJsonPath(env = process.env, scriptDir = __dirname) {
  const fromEnv = normalizeMaybeExtendedLengthPath(env.npm_package_json);
  if (fromEnv) {
    return fromEnv;
  }

  return path.join(scriptDir, "..", "package.json");
}

function execute(argv = process.argv.slice(2), options = {}) {
  const env = options.env ?? process.env;
  const scriptDir = options.scriptDir ?? __dirname;
  const spawnSync = options.spawnSync ?? childProcess.spawnSync;
  const nodeBin = options.execPath ?? process.execPath;
  const writeError = options.writeError ?? ((message) => console.error(message));
  const packageJsonPath = resolvePackageJsonPath(env, scriptDir);

  if (!packageJsonPath) {
    writeError("npm_package_json is not set.");
    return 1;
  }

  const repoRoot = normalizeMaybeExtendedLengthPath(path.dirname(packageJsonPath));
  const action = argv[0];
  const extraArgs = argv.slice(1);

  if (!action) {
    writeError("Usage: npm-run.cjs <action> [args...]");
    return 1;
  }

  const tscBin = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const tsxBin = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const indexJs = path.join(repoRoot, "dist", "src", "index.js");
  const initJs = path.join(repoRoot, "dist", "src", "init.js");
  const doctorJs = path.join(repoRoot, "dist", "src", "doctor.js");
  const testRunnerJs = path.join(repoRoot, "dist", "test", "run.js");
  const e2eLiveJs = path.join(repoRoot, "scripts", "e2e-live.cjs");
  const tsconfigPath = path.join(repoRoot, "tsconfig.json");
  const coreCoverageIncludes = [
    "dist/src/bridge/BridgeService.js",
    "dist/src/bridge/approval/*.js",
    "dist/src/bridge/artifacts/*.js",
    "dist/src/bridge/commands/*.js",
    "dist/src/bridge/events/subagentAttachment.js",
    "dist/src/bridge/runtime/*.js",
    "dist/src/codex/codexFsHelpers.js",
    "dist/src/config.js",
    "dist/src/platform.js",
    "dist/src/policy/*.js",
    "dist/src/store/StateStore.js",
    "scripts/npm-run.cjs"
  ];

  function run(command, commandArgs) {
    const result = spawnSync(command, commandArgs, {
      cwd: repoRoot,
      stdio: "inherit",
      windowsHide: false
    });

    if (typeof result.status === "number") {
      return result.status;
    }

    if (result.error) {
      writeError(result.error.message);
    }
    return 1;
  }

  function runNode(scriptPath, scriptArgs = []) {
    return run(nodeBin, [scriptPath, ...scriptArgs]);
  }

  function runBuild() {
    return runNode(tscBin, ["-p", tsconfigPath]);
  }

  function runCoverage(mode = "report") {
    const args = ["--experimental-test-coverage"];
    if (mode === "gate") {
      args.push("--test-coverage-lines=80");
      for (const include of coreCoverageIncludes) {
        args.push("--test-coverage-include", include);
      }
    }
    args.push(testRunnerJs);
    return run(nodeBin, args);
  }

  switch (action.toLowerCase()) {
    case "build":
      return runBuild();
    case "check":
      return runNode(tscBin, ["--noEmit", "-p", tsconfigPath]);
    case "dev":
      return runNode(tsxBin, ["watch", path.join(repoRoot, "src", "index.ts"), ...extraArgs]);
    case "e2e-live":
      return runNode(e2eLiveJs, extraArgs);
    case "doctor": {
      const buildCode = runBuild();
      if (buildCode !== 0) {
        return buildCode;
      }
      return runNode(doctorJs);
    }
    case "init": {
      const buildCode = runBuild();
      if (buildCode !== 0) {
        return buildCode;
      }
      return runNode(initJs);
    }
    case "clean": {
      const buildCode = runBuild();
      if (buildCode !== 0) {
        return buildCode;
      }
      return runNode(indexJs, ["clean", ...extraArgs]);
    }
    case "coverage": {
      const buildCode = runBuild();
      if (buildCode !== 0) {
        return buildCode;
      }
      const coverageMode = extraArgs[0]?.toLowerCase() === "gate" ? "gate" : "report";
      return runCoverage(coverageMode);
    }
    case "approvals": {
      const buildCode = runBuild();
      if (buildCode !== 0) {
        return buildCode;
      }
      return runNode(indexJs, ["approvals", ...extraArgs]);
    }
    case "approve": {
      const buildCode = runBuild();
      if (buildCode !== 0) {
        return buildCode;
      }
      return runNode(indexJs, ["approve", ...extraArgs]);
    }
    case "inspect": {
      const buildCode = runBuild();
      if (buildCode !== 0) {
        return buildCode;
      }
      return runNode(indexJs, ["inspect", ...extraArgs]);
    }
    case "cli": {
      const buildCode = runBuild();
      if (buildCode !== 0) {
        return buildCode;
      }
      return runNode(indexJs, ["cli", ...extraArgs]);
    }
    case "start":
      return runNode(indexJs, extraArgs);
    case "test": {
      const buildCode = runBuild();
      if (buildCode !== 0) {
        return buildCode;
      }
      return runNode(testRunnerJs);
    }
    default:
      writeError(`Unknown action: ${action}`);
      return 1;
  }
}

function main(argv = process.argv.slice(2), options = {}) {
  const exit = options.exit ?? process.exit;
  exit(execute(argv, options));
}

module.exports = {
  execute,
  main,
  normalizeMaybeExtendedLengthPath,
  resolvePackageJsonPath
};

if (require.main === module) {
  main();
}
