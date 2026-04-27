import test from "node:test";
import assert from "node:assert/strict";
import {
  attachPreparedSubagentThread,
  buildSubagentFallbackName,
  prepareSubagentAttachment,
  refreshAttachedSubagentStatus
} from "../src/bridge/events/subagentAttachment.js";

function createSubagentBridge(overrides: Record<string, unknown> = {}) {
  return {
    codexThreadId: "child_thread",
    parentCodexThreadId: "parent_thread",
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_child",
    discordParentChannelId: "discord_parent",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto" as const,
    threadName: "Worker",
    actorName: "Stored actor",
    lastStatusType: "idle",
    channelKind: "subagent" as const,
    sourceKind: "app-server" as const,
    ...overrides
  };
}

test("buildSubagentFallbackName redacts prompt text and falls back to a short thread id", () => {
  assert.equal(
    buildSubagentFallbackName("019da4b7-60e4-7e11-aa4f-49a433595c1b", "Prompt password=secret"),
    "Prompt [redacted]"
  );
  assert.equal(
    buildSubagentFallbackName("019da4b7-60e4-7e11-aa4f-49a433595c1b"),
    "Sub-agent 019da4b7"
  );
});

test("prepareSubagentAttachment merges inherited metadata and falls back to a synthetic summary", async () => {
  const bridges = new Map<string, ReturnType<typeof createSubagentBridge>>([
    [
      "parent_thread",
      createSubagentBridge({
        codexThreadId: "parent_thread",
        parentCodexThreadId: null,
        discordChannelId: "discord_parent",
        discordParentChannelId: null,
        actorName: null,
        channelKind: "conversation"
      })
    ],
    ["child_thread", createSubagentBridge()]
  ]);
  const runtime = {
    threadState: new Map([
      [
        "parent_thread",
        {
          cwd: "C:\\repo",
          repoName: null,
          sourceKind: "cli-session"
        }
      ]
    ])
  };
  const prepared = await prepareSubagentAttachment(
    {
      stateStore: {
        getThreadBridge: (threadId: string) => bridges.get(threadId) ?? null
      }
    } as never,
    runtime as never,
    {
      resolveThreadMetadata: async () => ({
        cwd: null,
        repoName: null,
        threadName: "Resolved worker",
        actorName: null,
        parentThreadId: null
      }),
      syntheticSummary: (threadId: string, preferredName: string) => ({
        id: threadId,
        name: preferredName,
        preview: "synthetic",
        modelProvider: null,
        createdAt: null,
        updatedAt: null,
        ephemeral: false,
        status: { type: "active", activeFlags: [] as string[] }
      }),
      tryReadThread: async () => null
    },
    {
      parentThreadId: "parent_thread",
      childThreadId: "child_thread",
      prompt: "Worker password=secret",
      actorNameHint: "Ada"
    }
  );

  assert.equal(prepared.summaryWasSynthetic, true);
  assert.equal(prepared.summary.name, "Worker [redacted]");
  assert.equal(prepared.sourceKind, "cli-session");
  assert.equal(prepared.resolvedMetadata.cwd, "C:\\repo");
  assert.equal(prepared.resolvedMetadata.repoName, "repo");
  assert.equal(prepared.resolvedMetadata.actorName, "Ada");
  assert.equal(prepared.resolvedMetadata.parentThreadId, "parent_thread");
});

test("refreshAttachedSubagentStatus updates runtime state and queues mapped children", async () => {
  const state = {
    latestAgentMessage: null as string | null
  };
  let persisted: unknown = null;
  let queuedThreadId: string | null = null;
  let flushedThreadId: string | null = null;
  let touchedTimestampState: unknown = null;

  await refreshAttachedSubagentStatus(
    {
      threadState: new Map([["child_thread", state]])
    } as never,
    {
      flushStatusUpdate: async (threadId: string) => {
        flushedThreadId = threadId;
      },
      persistThreadState: (threadState: unknown) => {
        persisted = threadState;
      },
      queueStatusUpdate: (threadId: string) => {
        queuedThreadId = threadId;
      },
      updateStateLastActivityAt: (threadState: unknown) => {
        touchedTimestampState = threadState;
      }
    },
    "child_thread",
    createSubagentBridge(),
    "Waiting on approval"
  );

  assert.equal(state.latestAgentMessage, "Waiting on approval");
  assert.equal(persisted, state);
  assert.equal(touchedTimestampState, state);
  assert.equal(queuedThreadId, "child_thread");
  assert.equal(flushedThreadId, null);
});

test("refreshAttachedSubagentStatus flushes unattached children without runtime state", async () => {
  let flushedThreadId: string | null = null;

  await refreshAttachedSubagentStatus(
    {
      threadState: new Map()
    } as never,
    {
      flushStatusUpdate: async (threadId: string) => {
        flushedThreadId = threadId;
      },
      persistThreadState: () => undefined,
      queueStatusUpdate: () => undefined,
      updateStateLastActivityAt: () => undefined
    },
    "child_thread",
    null,
    "Ignored"
  );

  assert.equal(flushedThreadId, "child_thread");
});

test("attachPreparedSubagentThread hydrates, suppresses resume failures, and flushes fresh child status", async () => {
  let hydrated: {
    threadId: string;
    attachMode: "auto" | "manual";
    preferredName: string | null | undefined;
    parentAnchorTurnId: string | null;
    parentAnchorTurnCursor: string | null;
    allowFilesystemScan: boolean | undefined;
  } | null = null;
  let resumedThreadId: string | null = null;
  let flushedThreadId: string | null = null;
  const warnings: Array<{ childThreadId: string; message: string }> = [];

  await attachPreparedSubagentThread(
    {
      codexAdapter: {
        resumeThread: async (threadId: string) => {
          resumedThreadId = threadId;
          throw new Error("resume failed");
        }
      },
      logger: {
        warn: (payload: { childThreadId: string }, message: string) => {
          warnings.push({ childThreadId: payload.childThreadId, message });
        }
      }
    } as never,
    {
      threadState: new Map()
    } as never,
    {
      hydrateThread: async (
        threadId: string,
        _summary,
        attachMode: "auto" | "manual",
        hydrateOptions
      ) => {
        hydrated = {
          threadId,
          attachMode,
          preferredName: hydrateOptions?.preferredName,
          parentAnchorTurnId: hydrateOptions?.parentAnchorTurnId ?? null,
          parentAnchorTurnCursor: hydrateOptions?.parentAnchorTurnCursor ?? null,
          allowFilesystemScan: hydrateOptions?.allowFilesystemScan
        };
        return { bridge: null, created: true } as never;
      },
      flushStatusUpdate: async (threadId: string) => {
        flushedThreadId = threadId;
      },
      persistThreadState: () => undefined,
      queueStatusUpdate: () => undefined,
      updateStateLastActivityAt: () => undefined
    },
    {
      childThreadId: "child_thread",
      prepared: {
        existingChild: null,
        fallbackName: "Fallback worker",
        resolvedMetadata: {
          cwd: "C:\\repo",
          repoName: "repo",
          threadName: null,
          actorName: "Ada",
          parentThreadId: "parent_thread"
        },
        sourceKind: "app-server",
        summary: {
          id: "child_thread",
          name: null,
          preview: "preview",
          modelProvider: null,
          createdAt: null,
          updatedAt: null,
          ephemeral: false,
          status: { type: "active", activeFlags: [] }
        },
        summaryWasSynthetic: false
      },
      parentAnchorTurnId: "turn_123",
      parentAnchorTurnCursor: "cursor_123",
      statusText: "fresh child status",
      failureMessage: "resume failed for child"
    }
  );

  assert.deepEqual(hydrated, {
    threadId: "child_thread",
    attachMode: "auto",
    preferredName: "Fallback worker",
    parentAnchorTurnId: "turn_123",
    parentAnchorTurnCursor: "cursor_123",
    allowFilesystemScan: false
  });
  assert.equal(resumedThreadId, "child_thread");
  assert.equal(flushedThreadId, "child_thread");
  assert.deepEqual(warnings, [
    {
      childThreadId: "child_thread",
      message: "resume failed for child"
    }
  ]);
});
