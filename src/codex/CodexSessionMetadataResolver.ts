import { createReadStream } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { extractNestedString } from "./codexFsHelpers.js";
import { CodexSessionLogLocator } from "./CodexSessionLogLocator.js";

export interface SessionMetadata {
  cwd: string | null;
  repoName: string | null;
  threadName: string | null;
  actorName: string | null;
  parentThreadId: string | null;
  sourceSubagentOther: string | null;
  originator: string | null;
  source: string | null;
}

interface SessionIndexEntry {
  threadName: string | null;
}

export class CodexSessionMetadataResolver {
  private readonly cache = new Map<string, SessionMetadata>();
  private readonly sessionIndexByThread = new Map<string, SessionIndexEntry>();
  private readonly sessionLogLocator: CodexSessionLogLocator;
  private sessionIndexMtimeMs: number | null = null;

  constructor(private readonly codexHome: string) {
    this.sessionLogLocator = new CodexSessionLogLocator(codexHome);
  }

  async resolve(
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ): Promise<SessionMetadata | undefined> {
    if (this.cache.has(threadId)) {
      const cached = this.cache.get(threadId);
      if (!cached) {
        return undefined;
      }
      const refreshedThreadName = await this.resolveThreadNameFromIndex(threadId);
      if (refreshedThreadName !== cached.threadName) {
        const updated = {
          ...cached,
          threadName: refreshedThreadName
        };
        this.cache.set(threadId, updated);
        return updated;
      }
      return cached;
    }

    const sessionPath = await this.sessionLogLocator.resolve(threadId, options);
    if (sessionPath) {
      const metadata = await this.readSessionMetadata(sessionPath, threadId);
      if (metadata) {
        this.cache.set(threadId, metadata);
        return metadata;
      }
    }

    if (options.allowFilesystemScan === false) {
      return undefined;
    }

    const searchRoots = [
      path.join(this.codexHome, "sessions"),
      path.join(this.codexHome, "archived_sessions")
    ];

    for (const root of searchRoots) {
      const found = await this.searchDirectory(root, threadId);
      if (found) {
        this.cache.set(threadId, found);
        return found;
      }
    }

    this.sessionLogLocator.rememberMissing(threadId);
    return undefined;
  }

  private async searchDirectory(directory: string, threadId: string): Promise<SessionMetadata | undefined> {
    try {
      await access(directory);
    } catch {
      return undefined;
    }

    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await this.searchDirectory(fullPath, threadId);
        if (found) {
          return found;
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const metadata = await this.readSessionMetadata(fullPath, threadId);
      if (metadata) {
        this.sessionLogLocator.remember(threadId, fullPath);
        return metadata;
      }
    }

    return undefined;
  }

  private async readSessionMetadata(filePath: string, threadId: string): Promise<SessionMetadata | undefined> {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const parsed = JSON.parse(line) as {
          type?: string;
          payload?: Record<string, unknown>;
        };

        if (parsed.type !== "session_meta" || parsed.payload?.id !== threadId) {
          continue;
        }

        const cwd =
          typeof parsed.payload.cwd === "string" && parsed.payload.cwd.trim()
            ? parsed.payload.cwd
            : null;
        const actorName =
          (typeof parsed.payload.agent_nickname === "string" && parsed.payload.agent_nickname.trim()) ||
          extractNestedString(parsed.payload, ["source", "subagent", "thread_spawn", "agent_nickname"], {
            allowArrays: true,
            trimResult: false
          }) ||
          extractNestedString(parsed.payload, ["source", "subagent", "threadSpawn", "agentNickname"], {
            allowArrays: true,
            trimResult: false
          }) ||
          null;
        const parentThreadId =
          extractNestedString(parsed.payload, ["source", "subagent", "thread_spawn", "parent_thread_id"], {
            allowArrays: true,
            trimResult: false
          }) ||
          extractNestedString(parsed.payload, ["source", "subagent", "threadSpawn", "parentThreadId"], {
            allowArrays: true,
            trimResult: false
          }) ||
          (typeof parsed.payload.forked_from_id === "string" && parsed.payload.forked_from_id.trim()) ||
          null;
        const sourceSubagentOther = extractNestedString(parsed.payload, ["source", "subagent", "other"], {
          allowArrays: true
        });
        const threadName = await this.resolveThreadNameFromIndex(threadId);
        return {
          cwd,
          repoName: cwd ? path.basename(cwd) : null,
          threadName,
          actorName,
          parentThreadId,
          sourceSubagentOther,
          originator:
            typeof parsed.payload.originator === "string" && parsed.payload.originator.trim()
              ? parsed.payload.originator.trim()
              : null,
          source:
            typeof parsed.payload.source === "string" && parsed.payload.source.trim()
              ? parsed.payload.source.trim()
              : null
        };
      }
    } finally {
      lines.close();
      stream.close();
    }

    return undefined;
  }

  private async resolveThreadNameFromIndex(threadId: string): Promise<string | null> {
    const indexPath = path.join(this.codexHome, "session_index.jsonl");
    let stats;
    try {
      stats = await stat(indexPath);
    } catch {
      return null;
    }

    if (this.sessionIndexMtimeMs !== stats.mtimeMs) {
      this.sessionIndexByThread.clear();
      this.sessionIndexMtimeMs = stats.mtimeMs;

      try {
        const content = await readFile(indexPath, "utf8");
        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) {
            continue;
          }

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
          if (!id) {
            continue;
          }

          const threadName =
            typeof parsed.thread_name === "string" && parsed.thread_name.trim()
              ? parsed.thread_name.trim()
              : typeof parsed.name === "string" && parsed.name.trim()
                ? parsed.name.trim()
                : null;

          this.sessionIndexByThread.set(id, { threadName });
        }
      } catch {
        this.sessionIndexByThread.clear();
      }
    }

    return this.sessionIndexByThread.get(threadId)?.threadName ?? null;
  }

}
