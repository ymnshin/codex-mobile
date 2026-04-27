import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface InstanceLock {
  release: () => void;
}

export interface AcquireInstanceLockOptions {
  currentPid?: number;
  purpose?: "start" | "clean";
  processAlive?: (pid: number) => boolean;
}

function isProcessAlive(pid: number): boolean {
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

function createConflictMessage(existingPid: number, purpose: "start" | "clean"): string {
  if (purpose === "clean") {
    return `Another bridge instance is already running (pid ${existingPid}). Stop it before running clean.`;
  }
  return `Another bridge instance is already running (pid ${existingPid}). Stop it before starting a new one.`;
}

export function acquireInstanceLock(
  lockPath: string,
  options: AcquireInstanceLockOptions = {}
): InstanceLock {
  const currentPid = options.currentPid ?? process.pid;
  const purpose = options.purpose ?? "start";
  const processAlive = options.processAlive ?? isProcessAlive;

  mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({
    pid: currentPid,
    createdAt: new Date().toISOString()
  });

  while (true) {
    try {
      writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      const candidate = error as NodeJS.ErrnoException;
      if (candidate.code !== "EEXIST") {
        throw error;
      }

      let existingPid: number | null = null;
      try {
        const raw = readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { pid?: unknown };
        existingPid = typeof parsed.pid === "number" ? parsed.pid : null;
      } catch {
        existingPid = null;
      }

      if (existingPid !== null && processAlive(existingPid)) {
        throw new Error(createConflictMessage(existingPid, purpose));
      }

      rmSync(lockPath, { force: true });
    }
  }

  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Ignore cleanup failures on shutdown.
      }
    }
  };
}
