import {
  test,
  assert,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  path,
  tmpdir,
  createBridgeConfigFromPreset,
  Policy,
  StateStore,
  createLogger,
  CodexSessionEventTailer,
  FakeCodexAdapter,
  FakeSessionEventTailer,
  createBridgeTestRig,
  createBridgeService,
  FakeDesktopIpcClient,
  FakeDiscordAdapter
} from "./helpers/bridgeIntegration.js";

test("newly attached threads backfill the latest completed turn messages from thread/read", async () => {
  const { codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_backfill",
      name: "Backfill thread",
      preview: "Backfill thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("thr_backfill", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_backfill", {
    id: "thr_backfill",
    name: "Backfill thread",
    preview: "Backfill thread",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_backfill",
        createdAt: nowSeconds,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_backfill",
            content: [{ type: "text", text: "Can you summarize the repo status?" }]
          },
          {
            type: "message",
            id: "agent_backfill",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Here is a concise repo summary." }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start();

    assert.equal(discord.sentTextMessages.length, 1);
    assert.match(discord.sentTextMessages[0]?.content ?? "", /^# 👤 \*\*You\*\*/);
    assert.match(discord.sentTextMessages[0]?.content ?? "", /\[\d{2}:\d{2}:\d{2}\]/);
    assert.equal(discord.liveTextMessages.length, 1);
    assert.match(discord.liveTextMessages[0]?.content ?? "", /^# 🤖 \*\*Codex\*\*/);
    assert.match(discord.liveTextMessages[0]?.content ?? "", /\[>\d{2}:\d{2}:\d{2}\]/);
    assert.match(discord.liveTextMessages[0]?.content ?? "", /concise repo summary/);
  } finally {
    await bridge.stop();
  }
});

test("startup backfill uses the same activity summary rendering as live mirroring", async () => {
  const { codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_backfill_activity_summary",
      name: "Backfill activity summary thread",
      preview: "Backfill activity summary thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("thr_backfill_activity_summary", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_backfill_activity_summary", {
    id: "thr_backfill_activity_summary",
    name: "Backfill activity summary thread",
    preview: "Backfill activity summary thread",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_backfill_activity_summary",
        createdAt: nowSeconds,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_backfill_activity_summary",
            content: [{ type: "text", text: "Please recap the latest work." }]
          },
          {
            type: "commandExecution",
            id: "cmd_backfill_activity_summary",
            command: "npm run build",
            status: "completed",
            aggregatedOutput: "Build finished successfully.",
            exitCode: 0,
            durationMs: 42
          },
          {
            type: "fileChange",
            id: "file_backfill_activity_summary",
            status: "completed",
            changes: [{ path: "src/a.ts", kind: "modified" }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start();

    assert.equal(discord.sentTextMessages.length, 1);
    assert.match(discord.sentTextMessages[0]?.content ?? "", /Please recap the latest work/);
    assert.equal(discord.liveTextMessages.length, 1);
    const mirrored = discord.liveTextMessages[0]?.content ?? "";
    assert.match(mirrored, /Edited 1 file, ran 1 command/);
    assert.doesNotMatch(mirrored, /`npm run build`/);
  } finally {
    await bridge.stop();
  }
});

test("startup backfill mirrors the latest turn from its beginning", async () => {
  const { codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        retention: {
          maxTurnsPerThread: 1
        }
      }
    )
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const oldAssistantItems = Array.from({ length: 25 }, (_value, index) => ({
    type: "message",
    id: `assistant_old_backfill_${index + 1}`,
    role: "assistant",
    phase: "final_answer",
    createdAt: nowSeconds - 120 + index,
    content: [{ type: "output_text", text: `Old assistant message ${index + 1}` }]
  }));
  const recentAssistantItems = Array.from({ length: 5 }, (_value, index) => ({
    type: "message",
    id: `assistant_recent_backfill_${index + 1}`,
    role: "assistant",
    phase: "final_answer",
    createdAt: nowSeconds + index,
    content: [{ type: "output_text", text: `Recent assistant message ${index + 1}` }]
  }));

  codex.threads = [
    {
      id: "thr_backfill_cap",
      name: "Backfill cap thread",
      preview: "Backfill cap thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("thr_backfill_cap", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_backfill_cap", {
    id: "thr_backfill_cap",
    name: "Backfill cap thread",
    preview: "Backfill cap thread",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_old_human",
        createdAt: nowSeconds - 60,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_old_backfill",
            content: [{ type: "text", text: "Old human message" }]
          },
          ...oldAssistantItems
        ]
      },
      {
        id: "turn_latest_human",
        createdAt: nowSeconds,
        status: "completed",
        items: [
          {
            type: "message",
            id: "assistant_before_latest_human",
            role: "assistant",
            phase: "final_answer",
            createdAt: nowSeconds - 1,
            content: [{ type: "output_text", text: "Assistant message before latest human" }]
          },
          {
            type: "userMessage",
            id: "user_latest_backfill",
            createdAt: nowSeconds,
            content: [{ type: "text", text: "Latest human message" }]
          },
          ...recentAssistantItems
        ]
      }
    ]
  });

  try {
    await bridge.start();

    assert.equal(discord.sentTextMessages.length, 1);
    assert.match(discord.sentTextMessages[0]?.content ?? "", /Latest human message/);
    assert.doesNotMatch(discord.sentTextMessages[0]?.content ?? "", /Old human message/);

    assert.equal(
      discord.liveTextMessages.length,
      1,
      "cold-start backfill should batch contiguous non-user startup history into one Discord create when it fits"
    );
    const liveContent = discord.liveTextMessages.map((message) => message.content).join("\n");
    assert.doesNotMatch(liveContent, /Old assistant message/);
    assert.doesNotMatch(liveContent, /Assistant message before latest human/);
    assert.match(liveContent, /Recent assistant message 1/);
    assert.match(liveContent, /Recent assistant message 5/);
    assert.doesNotMatch(
      discord.liveTextMessages[0]?.content ?? "",
      /\n\n/,
      "startup backfill should pack adjacent historical blocks without inserting blank lines between them"
    );
  } finally {
    await bridge.stop();
  }
});

test("startup backfill keeps the last two human-anchored turns by default", async () => {
  const { codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_backfill_two_turns",
      name: "Backfill two turns thread",
      preview: "Backfill two turns thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("thr_backfill_two_turns", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_backfill_two_turns", {
    id: "thr_backfill_two_turns",
    name: "Backfill two turns thread",
    preview: "Backfill two turns thread",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_oldest_backfill",
        createdAt: nowSeconds - 120,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_oldest_backfill",
            createdAt: nowSeconds - 120,
            content: [{ type: "text", text: "Oldest human message" }]
          },
          {
            type: "message",
            id: "assistant_oldest_backfill",
            role: "assistant",
            phase: "final_answer",
            createdAt: nowSeconds - 119,
            content: [{ type: "output_text", text: "Oldest assistant message" }]
          }
        ]
      },
      {
        id: "turn_middle_backfill",
        createdAt: nowSeconds - 60,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_middle_backfill",
            createdAt: nowSeconds - 60,
            content: [{ type: "text", text: "Middle human message" }]
          },
          {
            type: "message",
            id: "assistant_middle_backfill",
            role: "assistant",
            phase: "final_answer",
            createdAt: nowSeconds - 59,
            content: [{ type: "output_text", text: "Middle assistant message" }]
          }
        ]
      },
      {
        id: "turn_latest_backfill",
        createdAt: nowSeconds,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_latest_backfill_two",
            createdAt: nowSeconds,
            content: [{ type: "text", text: "Latest human message" }]
          },
          {
            type: "message",
            id: "assistant_latest_backfill_two",
            role: "assistant",
            phase: "final_answer",
            createdAt: nowSeconds + 1,
            content: [{ type: "output_text", text: "Latest assistant message" }]
          }
        ]
      },
      {
        id: "turn_subagent_notification_backfill",
        createdAt: nowSeconds + 10,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_subagent_notification_backfill",
            createdAt: nowSeconds + 10,
            content: [
              {
                type: "text",
                text:
                  '<subagent_notification>{"agent_path":"thr_backfill_child","status":{"completed":"Worker finished."}}</subagent_notification>'
              }
            ]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start();

    const startupContent = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.doesNotMatch(startupContent, /Oldest human message/);
    assert.doesNotMatch(startupContent, /Oldest assistant message/);
    assert.match(startupContent, /Middle human message/);
    assert.match(startupContent, /Middle assistant message/);
    assert.match(startupContent, /Latest human message/);
    assert.match(startupContent, /Latest assistant message/);
    assert.doesNotMatch(startupContent, /subagent_notification/i);
    assert.doesNotMatch(startupContent, /thr_backfill_child/);
  } finally {
    await bridge.stop();
  }
});

test("startup backfill uses exact session-log timestamps for the latest turn when available", async () => {
  const tailer = new FakeSessionEventTailer();
  const { codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never,
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_session_backfill",
      name: "Session backfill thread",
      preview: "Session backfill thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("thr_session_backfill", { cwd: "C:\\write", repoName: "write" });

  const baseTs = Date.parse("2026-04-08T10:00:00.000Z");
  tailer.setLatestTurnBackfillEvents("thr_session_backfill", [
    {
      type: "sessionUserMessage",
      threadId: "thr_session_backfill",
      turnId: "turn_session_backfill",
      streamOrder: 1,
      timestampMs: baseTs + 1000,
      text: "Please run a harmless check."
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_session_backfill",
      turnId: "turn_session_backfill",
      streamOrder: 2,
      timestampMs: baseTs + 2000,
      text: "Running a short check now.",
      phase: "commentary"
    },
    {
      type: "shellCommandCompleted",
      threadId: "thr_session_backfill",
      turnId: "turn_session_backfill",
      callId: "call_session_backfill_1",
      streamOrder: 3,
      timestampMs: baseTs + 3000,
      command: "Get-Date -Format o",
      cwd: "C:\\write",
      output: "Exit code: 0",
      status: null
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_session_backfill",
      turnId: "turn_session_backfill",
      streamOrder: 4,
      timestampMs: baseTs + 4000,
      text: "Done.",
      phase: "final_answer"
    }
  ]);

  const toClock = (timestampMs: number) => {
    const date = new Date(timestampMs);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  try {
    await bridge.start();

    assert.equal(discord.sentTextMessages.length, 1);
    assert.match(
      discord.sentTextMessages[0]?.content ?? "",
      new RegExp(`^# .*?\\*\\*You\\*\\*\\n${escapeRegex(`[${toClock(baseTs + 1000)}]`)}`)
    );

    const mirrored = discord.liveTextMessages.map((message) => message.content).join("\n");
    assert.match(mirrored, new RegExp(escapeRegex(`[${toClock(baseTs + 2000)}]`)));
    assert.match(mirrored, new RegExp(escapeRegex(`[${toClock(baseTs + 3000)}]`)));
    assert.match(mirrored, new RegExp(escapeRegex(`[${toClock(baseTs + 4000)}]`)));
    assert.match(mirrored, /\[\d{2}:\d{2}:\d{2}\]/);
    assert.ok(tailer.replayedFrontierThreadIds.includes("thr_session_backfill"));
  } finally {
    await bridge.stop();
  }
});

test("startup backfill falls back to thread/read when session-log backfill does not begin with a user message", async () => {
  const tailer = new FakeSessionEventTailer();
  const { codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_anchor_fallback",
      name: "Startup anchor fallback",
      preview: "Startup anchor fallback",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ];
  codex.metadata.set("thr_startup_anchor_fallback", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_startup_anchor_fallback", {
    id: "thr_startup_anchor_fallback",
    name: "Startup anchor fallback",
    preview: "Startup anchor fallback",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_anchor_fallback",
        status: "completed",
        items: [
          {
            id: "turn_anchor_user",
            type: "userMessage",
            text: "Actual conversation start"
          },
          {
            id: "turn_anchor_answer",
            type: "agentMessage",
            phase: "final",
            text: "Actual final answer"
          }
        ]
      }
    ]
  });
  tailer.setLatestTurnBackfillEvents("thr_startup_anchor_fallback", [
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_anchor_fallback",
      turnId: "turn_anchor_fallback",
      itemId: "orphaned_commentary",
      timestampMs: Date.now(),
      text: "Orphaned commentary before anchor",
      phase: "commentary"
    }
  ]);

  try {
    await bridge.start();

    assert.equal(discord.sentTextMessages.length, 1);
    assert.match(discord.sentTextMessages[0]?.content ?? "", /Actual conversation start/);
    assert.equal(discord.liveTextMessages.length, 1);
    assert.match(discord.liveTextMessages[0]?.content ?? "", /Actual final answer/);
    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.doesNotMatch(mirrored, /Orphaned commentary before anchor/);
  } finally {
    await bridge.stop();
  }
});

test("startup backfill uses thread/read for a non-completed human-anchored turn", async () => {
  const tailer = new FakeSessionEventTailer();
  const { codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_in_progress_anchor",
      name: "Startup in-progress anchor",
      preview: "Startup in-progress anchor",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_startup_in_progress_anchor", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_startup_in_progress_anchor", {
    id: "thr_startup_in_progress_anchor",
    name: "Startup in-progress anchor",
    preview: "Startup in-progress anchor",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_in_progress_anchor",
        status: "interrupted",
        items: [
          {
            id: "turn_in_progress_user",
            type: "userMessage",
            text: "Fresh current startup prompt"
          },
          {
            id: "turn_in_progress_commentary",
            type: "agentMessage",
            phase: "commentary",
            text: "Fresh current startup commentary"
          }
        ]
      }
    ]
  });
  tailer.setLatestTurnBackfillEvents("thr_startup_in_progress_anchor", [
    {
      type: "sessionUserMessage",
      threadId: "thr_startup_in_progress_anchor",
      turnId: "turn_in_progress_anchor",
      itemId: "session_wrong_user",
      timestampMs: Date.now(),
      text: "Wrong session-log startup prompt"
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_in_progress_anchor",
      turnId: "turn_in_progress_anchor",
      itemId: "session_wrong_commentary",
      timestampMs: Date.now() + 1,
      text: "Wrong session-log startup commentary",
      phase: "commentary"
    }
  ]);

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Fresh current startup prompt/);
    assert.match(mirrored, /Fresh current startup commentary/);
    assert.doesNotMatch(mirrored, /Wrong session-log startup prompt/);
    assert.doesNotMatch(mirrored, /Wrong session-log startup commentary/);
  } finally {
    await bridge.stop();
  }
});

test("startup backfill uses session-log history for a non-completed turn when the retained startup anchor matches", async () => {
  const tailer = new FakeSessionEventTailer();
  const { codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_in_progress_session_match",
      name: "Startup in-progress session match",
      preview: "Startup in-progress session match",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_startup_in_progress_session_match", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_startup_in_progress_session_match", {
    id: "thr_startup_in_progress_session_match",
    name: "Startup in-progress session match",
    preview: "Startup in-progress session match",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_in_progress_session_match",
        status: "interrupted",
        items: [
          {
            id: "turn_in_progress_session_match_user",
            type: "userMessage",
            text: "Please implement the approved plan."
          },
          {
            id: "turn_in_progress_session_match_commentary",
            type: "agentMessage",
            phase: "commentary",
            text: "Thread/read snapshot only knows the opening commentary."
          }
        ]
      }
    ]
  });

  const baseTs = Date.parse("2026-04-15T08:24:43.000Z");
  const toClock = (timestampMs: number) => {
    const date = new Date(timestampMs);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };
  tailer.setLatestTurnBackfillEvents("thr_startup_in_progress_session_match", [
    {
      type: "sessionUserMessage",
      threadId: "thr_startup_in_progress_session_match",
      turnId: "turn_in_progress_session_match",
      itemId: "session_user_anchor",
      timestampMs: baseTs,
      text: "Please implement the approved plan."
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_in_progress_session_match",
      turnId: "turn_in_progress_session_match",
      itemId: "session_agent_middle_1",
      timestampMs: baseTs + 60_000,
      text: "Middle session-log commentary that should be preserved.",
      phase: "commentary"
    },
    {
      type: "shellCommandCompleted",
      threadId: "thr_startup_in_progress_session_match",
      turnId: "turn_in_progress_session_match",
      callId: "session_call_middle",
      timestampMs: baseTs + 120_000,
      command: "npm test",
      cwd: "C:\\write",
      output: "Exit code: 0",
      status: null
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_in_progress_session_match",
      turnId: "turn_in_progress_session_match",
      itemId: "session_agent_middle_2",
      timestampMs: baseTs + 180_000,
      text: "Later session-log commentary that would otherwise be skipped.",
      phase: "commentary"
    }
  ]);

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Please implement the approved plan/);
    assert.match(mirrored, /Middle session-log commentary that should be preserved/);
    assert.match(mirrored, /Later session-log commentary that would otherwise be skipped/);
    assert.match(mirrored, new RegExp(`\\[${toClock(baseTs)}\\]`));
    assert.match(mirrored, new RegExp(`\\[${toClock(baseTs + 60_000)}\\]`));
    assert.match(mirrored, new RegExp(`\\[${toClock(baseTs + 180_000)}\\]`));
    assert.ok(tailer.replayedFrontierThreadIds.includes("thr_startup_in_progress_session_match"));
  } finally {
    await bridge.stop();
  }
});

test("startup backfill uses session-log history for a fresh conversation channel when thread/read is empty", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_session_log_truth_empty_thread_read",
      name: "Startup empty thread/read",
      preview: "Startup empty thread/read",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_startup_session_log_truth_empty_thread_read", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_startup_session_log_truth_empty_thread_read", {
    id: "thr_startup_session_log_truth_empty_thread_read",
    name: "Startup empty thread/read",
    preview: "Startup empty thread/read",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  tailer.setLatestTurnBackfillEvents("thr_startup_session_log_truth_empty_thread_read", [
    {
      type: "sessionUserMessage",
      threadId: "thr_startup_session_log_truth_empty_thread_read",
      turnId: "turn_startup_session_log_truth_empty_thread_read",
      itemId: "session_user_truth_empty_thread_read",
      timestampMs: Date.now(),
      text: "Please continue the active plan from the current conversation state."
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_session_log_truth_empty_thread_read",
      turnId: "turn_startup_session_log_truth_empty_thread_read",
      itemId: "session_answer_truth_empty_thread_read",
      timestampMs: Date.now() + 1,
      text: "Session-log startup history should seed the fresh Discord channel.",
      phase: "final_answer"
    }
  ]);

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Please continue the active plan from the current conversation state/);
    assert.match(mirrored, /Session-log startup history should seed the fresh Discord channel/);
    const persistedItems = store.listMirroredItems("thr_startup_session_log_truth_empty_thread_read");
    assert.ok(persistedItems.some((record) => record.kind === "user"));
    assert.ok(persistedItems.some((record) => record.kind === "agentAnswer"));
  } finally {
    await bridge.stop();
  }
});

test("startup backfill resurfaces pending shell approvals from session-log history", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_shell_approval",
      name: "Startup shell approval",
      preview: "Startup shell approval",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_startup_shell_approval", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_startup_shell_approval", {
    id: "thr_startup_shell_approval",
    name: "Startup shell approval",
    preview: "Startup shell approval",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  tailer.setLatestTurnBackfillEvents("thr_startup_shell_approval", [
    {
      type: "sessionUserMessage",
      threadId: "thr_startup_shell_approval",
      turnId: "turn_startup_shell_approval",
      timestampMs: Date.now(),
      text: "Please open example.com for testing.",
      eventKey: "evt_startup_shell_user",
      sourceOrder: "0000000000000001:0000",
      isSyntheticSubagentInstruction: false
    },
    {
      type: "shellApprovalRequested",
      threadId: "thr_startup_shell_approval",
      turnId: "turn_startup_shell_approval",
      callId: "call_startup_shell_approval",
      timestampMs: Date.now() + 1,
      command: "Start-Process https://example.com",
      cwd: "C:\\write",
      justification: "Open example.com for startup backfill testing.",
      prefixRule: null,
      details: "{\"command\":\"Start-Process https://example.com\"}",
      eventKey: "evt_startup_shell_approval",
      sourceOrder: "0000000000000002:0000"
    }
  ]);

  try {
    await bridge.start();

    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.preview, "Start-Process https://example.com");
    assert.deepEqual(discord.approvalCards[0]?.decisions, []);
    const approval = store.findPendingApprovalByItem(
      "thr_startup_shell_approval",
      "call_startup_shell_approval",
      "commandExecution"
    );
    assert.ok(approval);
    assert.deepEqual(approval.availableDecisions, []);
    assert.ok(tailer.replayedFrontierThreadIds.includes("thr_startup_shell_approval"));
  } finally {
    await bridge.stop();
  }
});

test("startup backfill still runs for newly attached threads when Discord reuses an existing conversation channel", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_session_log_truth_reused_channel",
      name: "Startup reused channel",
      preview: "Startup reused channel",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_startup_session_log_truth_reused_channel", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_startup_session_log_truth_reused_channel", {
    id: "thr_startup_session_log_truth_reused_channel",
    name: "Startup reused channel",
    preview: "Startup reused channel",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  tailer.setLatestTurnBackfillEvents("thr_startup_session_log_truth_reused_channel", [
    {
      type: "sessionUserMessage",
      threadId: "thr_startup_session_log_truth_reused_channel",
      turnId: "turn_startup_session_log_truth_reused_channel",
      itemId: "session_user_truth_reused_channel",
      timestampMs: Date.now(),
      text: "Please continue the active plan after startup recovery."
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_session_log_truth_reused_channel",
      turnId: "turn_startup_session_log_truth_reused_channel",
      itemId: "session_answer_truth_reused_channel",
      timestampMs: Date.now() + 1,
      text: "Session-log startup history should still mirror when the channel is reused.",
      phase: "final_answer"
    }
  ]);

  discord.conversationChannelIds.add("discord_channel_thr_startup_session_log_truth_reused_channel");

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Please continue the active plan after startup recovery/);
    assert.match(mirrored, /Session-log startup history should still mirror when the channel is reused/);
    const persistedItems = store.listMirroredItems("thr_startup_session_log_truth_reused_channel");
    assert.ok(persistedItems.some((record) => record.kind === "user"));
    assert.ok(persistedItems.some((record) => record.kind === "agentAnswer"));
    assert.equal(
      store.getThreadBridge("thr_startup_session_log_truth_reused_channel")?.discordChannelId,
      "discord_channel_thr_startup_session_log_truth_reused_channel"
    );
  } finally {
    await bridge.stop();
  }
});

test("startup backfill trusts locally discovered session history before slow thread/read", async () => {
  const tailer = new FakeSessionEventTailer();
  const { codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_local_session_truth",
      name: "Startup local session truth",
      preview: "Remote preview",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_startup_local_session_truth", { cwd: "C:\\write", repoName: "write" });
  codex.readThreadDelayMsByThread.set("thr_startup_local_session_truth", 1_000);
  codex.threadDetails.set("thr_startup_local_session_truth", {
    id: "thr_startup_local_session_truth",
    name: "Startup local session truth",
    preview: "Remote preview",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_remote_snapshot_only",
        status: "interrupted",
        items: [
          {
            id: "turn_remote_snapshot_user",
            type: "userMessage",
            text: "Remote-only startup prompt"
          },
          {
            id: "turn_remote_snapshot_answer",
            type: "agentMessage",
            phase: "final",
            text: "Remote-only startup answer"
          }
        ]
      }
    ]
  });

  tailer.setLocalThreads([
    {
      threadId: "thr_startup_local_session_truth",
      name: "Startup local session truth",
      preview: "Recovered startup anchor from local session",
      cwd: "C:\\write",
      repoName: "write",
      createdAtMs: nowSeconds * 1000,
      updatedAtMs: nowSeconds * 1000 + 5_000,
      status: "active",
      filePath: "C:\\Users\\Natale\\.codex\\sessions\\local-startup-truth.jsonl",
      sourceKind: "app-server",
      parentThreadId: null,
      actorName: null
    }
  ]);
  tailer.setLatestTurnBackfillEvents("thr_startup_local_session_truth", [
    {
      type: "sessionUserMessage",
      threadId: "thr_startup_local_session_truth",
      turnId: "turn_local_session_truth",
      itemId: "session_user_local_session_truth",
      timestampMs: Date.now(),
      text: "Recovered startup anchor from local session"
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_local_session_truth",
      turnId: "turn_local_session_truth",
      itemId: "session_answer_local_session_truth",
      timestampMs: Date.now() + 1,
      text: "Recovered startup answer from local session",
      phase: "final_answer"
    }
  ]);

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Recovered startup anchor from local session/);
    assert.match(mirrored, /Recovered startup answer from local session/);
    assert.doesNotMatch(mirrored, /Remote-only startup prompt/);
    assert.doesNotMatch(mirrored, /Remote-only startup answer/);
    assert.deepEqual(codex.readThreadCalls, []);
  } finally {
    await bridge.stop();
  }
});

test("startup backfill for existing mapped threads falls back to retained Codex turns when local session history is only partial", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_existing_partial_local_startup",
      name: "Existing partial local startup",
      preview: "Existing partial local startup",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_existing_partial_local_startup", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_existing_partial_local_startup", {
    id: "thr_existing_partial_local_startup",
    name: "Existing partial local startup",
    preview: "Existing partial local startup",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_existing_partial_previous",
        createdAt: nowSeconds - 120,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_existing_partial_previous",
            createdAt: nowSeconds - 120,
            content: [{ type: "text", text: "Retained startup prompt 1" }]
          },
          {
            type: "message",
            id: "assistant_existing_partial_previous",
            role: "assistant",
            phase: "final_answer",
            createdAt: nowSeconds - 119,
            content: [{ type: "output_text", text: "Retained startup answer 1" }]
          }
        ]
      },
      {
        id: "turn_existing_partial_latest",
        createdAt: nowSeconds - 60,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_existing_partial_latest",
            createdAt: nowSeconds - 60,
            content: [{ type: "text", text: "Retained startup prompt 2" }]
          },
          {
            type: "message",
            id: "assistant_existing_partial_latest",
            role: "assistant",
            phase: "final_answer",
            createdAt: nowSeconds - 59,
            content: [{ type: "output_text", text: "Retained startup answer 2" }]
          }
        ]
      }
    ]
  });

  tailer.setLocalThreads([
    {
      threadId: "thr_existing_partial_local_startup",
      name: "Existing partial local startup",
      preview: "Existing partial local startup",
      cwd: "C:\\write",
      repoName: "write",
      createdAtMs: nowSeconds * 1000,
      updatedAtMs: nowSeconds * 1000 + 5_000,
      status: "active",
      filePath: "C:\\Users\\Natale\\.codex\\sessions\\existing-partial-local-startup.jsonl",
      sourceKind: "app-server",
      parentThreadId: null,
      actorName: null
    }
  ]);
  tailer.setLatestTurnBackfillEvents("thr_existing_partial_local_startup", [
    {
      type: "sessionUserMessage",
      threadId: "thr_existing_partial_local_startup",
      turnId: "turn_existing_partial_latest",
      itemId: "session_user_existing_partial_latest",
      timestampMs: nowSeconds * 1000,
      text: "Retained startup prompt 2"
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_existing_partial_local_startup",
      turnId: "turn_existing_partial_latest",
      itemId: "session_answer_existing_partial_latest",
      timestampMs: nowSeconds * 1000 + 1,
      text: "Retained startup answer 2",
      phase: "final_answer"
    }
  ]);

  store.upsertThreadBridge({
    codexThreadId: "thr_existing_partial_local_startup",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_old_existing_partial_local_startup",
    discordParentChannelId: null,
    statusMessageId: "status_msg_old_existing_partial_local_startup",
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(nowSeconds * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Existing partial local startup",
    lastStatusType: "active",
    channelKind: "conversation",
    latestMirroredTimestampMs: null,
    latestMirroredCursor: null,
    latestMirroredTurnCursor: null
  });

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.match(mirrored, /Retained startup prompt 1/);
    assert.match(mirrored, /Retained startup answer 1/);
    assert.match(mirrored, /Retained startup prompt 2/);
    assert.match(mirrored, /Retained startup answer 2/);
    assert.ok(codex.readThreadCalls.includes("thr_existing_partial_local_startup"));
  } finally {
    await bridge.stop();
  }
});

test("startup backfill ignores session-log turns that do not match the retained thread/read turn set", async () => {
  const tailer = new FakeSessionEventTailer();
  const { codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_turn_mismatch",
      name: "Startup turn mismatch",
      preview: "Startup turn mismatch",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ];
  codex.metadata.set("thr_startup_turn_mismatch", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_startup_turn_mismatch", {
    id: "thr_startup_turn_mismatch",
    name: "Startup turn mismatch",
    preview: "Startup turn mismatch",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_thread_read_expected",
        status: "completed",
        items: [
          {
            id: "turn_expected_user",
            type: "userMessage",
            text: "Expected retained startup user message"
          },
          {
            id: "turn_expected_answer",
            type: "agentMessage",
            phase: "final",
            text: "Expected retained startup answer"
          }
        ]
      }
    ]
  });
  tailer.setLatestTurnBackfillEvents("thr_startup_turn_mismatch", [
    {
      type: "sessionUserMessage",
      threadId: "thr_startup_turn_mismatch",
      turnId: "turn_session_only",
      itemId: "session_only_user",
      timestampMs: Date.now(),
      text: "Wrong startup user from session log"
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_turn_mismatch",
      turnId: "turn_session_only",
      itemId: "session_only_answer",
      timestampMs: Date.now() + 1,
      text: "Wrong startup answer from session log",
      phase: "final"
    }
  ]);

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Expected retained startup user message/);
    assert.match(mirrored, /Expected retained startup answer/);
    assert.doesNotMatch(mirrored, /Wrong startup user from session log/);
    assert.doesNotMatch(mirrored, /Wrong startup answer from session log/);
  } finally {
    await bridge.stop();
  }
});

test("startup backfill for sub-agent threads does not use thread/read fallback without session history", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_anchor",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_parent_anchor",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent thread",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_child_anchor",
    parentCodexThreadId: "thr_parent_anchor",
    parentAnchorTurnId: "turn_child_inherited",
    parentAnchorTurnCursor: "turn:turn_child_inherited",
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_subagent_existing_anchor",
    discordParentChannelId: "discord_channel_parent_anchor",
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Darwin",
    actorName: "Darwin",
    lastStatusType: "idle",
    channelKind: "subagent"
  });
  discord.threadChannelIds.add("discord_subagent_existing_anchor");

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.metadata.set("thr_child_anchor", {
    cwd: "C:\\write",
    repoName: "write",
    actorName: "Darwin",
    parentThreadId: "thr_parent_anchor"
  });
  codex.threadDetails.set("thr_child_anchor", {
    id: "thr_child_anchor",
    name: "Run checks",
    preview: "Run checks",
    modelProvider: null,
    createdAt: nowSeconds - 20,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_child_inherited",
        createdAt: nowSeconds - 1,
        status: "completed",
        items: [
          {
            type: "message",
            id: "child_parent_prompt",
            role: "user",
            content: [{ type: "input_text", text: "Original parent prompt." }]
          }
        ]
      },
      {
        id: "turn_child_anchor",
        createdAt: nowSeconds,
        status: "completed",
        items: [
          {
            type: "message",
            id: "child_worker_prompt",
            role: "user",
            content: [{ type: "input_text", text: "You are worker 2. Run read-only checks." }]
          },
          {
            type: "message",
            id: "child_assistant_reply",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "I am starting the worker task now." }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start();
    const mirroredItems = store.listMirroredItems("thr_child_anchor");
    assert.equal(mirroredItems.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("conversation startup ignores synthetic child-worker user turns when selecting retained startup history", async () => {
  const { codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_parent_startup_only_human_anchor",
      name: "Continue feature pipeline work",
      preview: "Continue feature pipeline work",
      modelProvider: null,
      createdAt: nowSeconds - 20,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("thr_parent_startup_only_human_anchor", {
    cwd: "C:\\write",
    repoName: "write",
    threadName: "Continue feature pipeline work"
  });
  codex.threadDetails.set("thr_parent_startup_only_human_anchor", {
    id: "thr_parent_startup_only_human_anchor",
    name: "stale giant prompt",
    preview: "stale giant prompt",
    modelProvider: null,
    createdAt: nowSeconds - 20,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_real_user",
        createdAt: nowSeconds - 10,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "real_user_prompt",
            createdAt: nowSeconds - 10,
            content: [{ type: "text", text: "Actual parent prompt." }]
          },
          {
            type: "message",
            id: "real_user_answer",
            role: "assistant",
            phase: "final_answer",
            createdAt: nowSeconds - 9,
            content: [{ type: "output_text", text: "Actual parent answer." }]
          }
        ]
      },
      {
        id: "turn_child_worker_instruction",
        createdAt: nowSeconds - 1,
        status: "completed",
        items: [
          {
            type: "message",
            id: "synthetic_worker_prompt",
            role: "user",
            content: [{ type: "input_text", text: "You are worker 2. Run read-only checks." }]
          },
          {
            type: "message",
            id: "synthetic_worker_answer",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "I am starting the worker task now." }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start();
    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Actual parent prompt\./);
    assert.match(mirrored, /Actual parent answer\./);
    assert.doesNotMatch(mirrored, /You are worker 2\. Run read-only checks\./);
    assert.doesNotMatch(mirrored, /I am starting the worker task now\./);
  } finally {
    await bridge.stop();
  }
});

test("conversation startup ignores synthetic child-worker turns from session-log backfill", async () => {
  const tailer = new FakeSessionEventTailer();
  const { codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_parent_session_startup_filter",
      name: "Parent startup filter",
      preview: "Parent startup filter",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("thr_parent_session_startup_filter", {
    cwd: "C:\\write",
    repoName: "write",
    threadName: "Parent startup filter"
  });
  codex.threadDetails.set("thr_parent_session_startup_filter", {
    id: "thr_parent_session_startup_filter",
    name: "Parent startup filter",
    preview: "Parent startup filter",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_parent_real",
        status: "completed",
        items: [
          {
            id: "turn_parent_real_user",
            type: "userMessage",
            text: "Real startup parent prompt."
          },
          {
            id: "turn_parent_real_answer",
            type: "agentMessage",
            phase: "final",
            text: "Real startup parent answer."
          }
        ]
      }
    ]
  });
  tailer.setLatestTurnBackfillEvents("thr_parent_session_startup_filter", [
    {
      type: "sessionUserMessage",
      threadId: "thr_parent_session_startup_filter",
      turnId: "turn_parent_real",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Real startup parent prompt.",
      eventKey: "evt_parent_real_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_parent_session_startup_filter",
      turnId: "turn_parent_real",
      streamOrder: 2,
      timestampMs: Date.now() + 1,
      text: "Real startup parent answer.",
      phase: "final_answer",
      eventKey: "evt_parent_real_answer",
      sourceOrder: "00000002"
    },
    {
      type: "sessionUserMessage",
      threadId: "thr_parent_session_startup_filter",
      turnId: "turn_child_synthetic",
      streamOrder: 3,
      timestampMs: Date.now() + 2,
      text: "You are worker 2. Run read-only checks.",
      eventKey: "evt_child_synthetic_user",
      sourceOrder: "00000003",
      isSyntheticSubagentInstruction: true
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_parent_session_startup_filter",
      turnId: "turn_child_synthetic",
      streamOrder: 4,
      timestampMs: Date.now() + 3,
      text: "I am starting the worker task now.",
      phase: "commentary",
      eventKey: "evt_child_synthetic_commentary",
      sourceOrder: "00000004"
    }
  ]);

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Real startup parent prompt\./);
    assert.match(mirrored, /Real startup parent answer\./);
    assert.doesNotMatch(mirrored, /You are worker 2\. Run read-only checks\./);
    assert.doesNotMatch(mirrored, /I am starting the worker task now\./);
  } finally {
    await bridge.stop();
  }
});

test("startup backfill skips commentary-only turns without a user anchor", async () => {
  const { codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_commentary_only",
      name: "Commentary only thread",
      preview: "Commentary only thread",
      modelProvider: null,
      createdAt: nowSeconds - 10,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("thr_startup_commentary_only", {
    cwd: "C:\\write",
    repoName: "write"
  });
  codex.threadDetails.set("thr_startup_commentary_only", {
    id: "thr_startup_commentary_only",
    name: "Commentary only thread",
    preview: "Commentary only thread",
    modelProvider: null,
    createdAt: nowSeconds - 10,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_commentary_only",
        createdAt: nowSeconds,
        status: "completed",
        items: [
          {
            type: "message",
            id: "assistant_commentary_only",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "This should not lead startup." }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start();
    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.doesNotMatch(mirrored, /This should not lead startup/);
  } finally {
    await bridge.stop();
  }
});

test("sub-agent mirrored messages use the sub-agent name in headings", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_subagent_named",
    parentCodexThreadId: "thr_parent_named",
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_thread_subagent_named",
    discordParentChannelId: "discord_channel_parent_named",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Lorentz",
    actorName: "Darwin",
    lastStatusType: "idle",
    channelKind: "subagent"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_subagent_named",
        turnId: "turn_subagent_named",
        item: {
          type: "agentMessage",
          id: "subagent_message_1",
          phase: "final",
          text: "Sub-agent update"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(discord.liveTextMessages.length, 1);
    assert.match(discord.liveTextMessages[0]?.content ?? "", /^# .*?\*\*Darwin\*\*/);
    assert.doesNotMatch(discord.liveTextMessages[0]?.content ?? "", /\*\*Codex\*\*/);
  } finally {
    await bridge.stop();
  }
});

test("sub-agent user-role session messages render as parent Codex instructions, not as human messages", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_for_subagent_user",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_for_subagent_user",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_subagent_user",
    parentCodexThreadId: "thr_parent_for_subagent_user",
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_thread_subagent_user",
    discordParentChannelId: "discord_channel_parent_for_subagent_user",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Run checks",
    actorName: "Darwin",
    lastStatusType: "idle",
    channelKind: "subagent"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_subagent_user",
      turnId: "turn_subagent_user",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Do the worker task now.",
      eventKey: "evt_subagent_user",
      sourceOrder: "00000001"
    });

    assert.equal(discord.sentTextMessages.length, 1);
    const rendered = discord.sentTextMessages[0]?.content ?? "";
    assert.match(rendered, /^# .*?\*\*Codex\*\*/);
    assert.doesNotMatch(rendered, /\*\*You\*\*/);
  } finally {
    await bridge.stop();
  }
});

test("sub-agent session replay suppresses copied parent-anchor turns before the worker prompt", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_anchor_replay",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_anchor_replay",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent anchor replay",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).handleSessionEvent({
      type: "sessionSubagentSpawned",
      threadId: "thr_parent_anchor_replay",
      turnId: "turn_parent_anchor_replay",
      childThreadId: "thr_child_anchor_replay",
      childAgentName: "Euler",
      prompt: "Run the worker task.",
      timestampMs: Date.now(),
      eventKey: "subagent-spawn:thr_child_anchor_replay",
      sourceOrder: "00000001:0000"
    });

    await (bridge as any).handleSessionEvent({
      type: "sessionUserMessage",
      threadId: "thr_child_anchor_replay",
      turnId: "turn_parent_anchor_replay",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Ok now rerun the same test I asked you in the beginning",
      eventKey: "evt_parent_anchor_user",
      sourceOrder: "00000002"
    });
    await (bridge as any).handleSessionEvent({
      type: "sessionUserMessage",
      threadId: "thr_child_anchor_replay",
      turnId: "turn_child_worker_prompt",
      streamOrder: 2,
      timestampMs: Date.now(),
      text: "You are Worker B. Do the bounded capability smoke test.",
      eventKey: "evt_child_worker_prompt",
      sourceOrder: "00000003",
      isSyntheticSubagentInstruction: true
    });

    const mirrored = discord.sentTextMessages.map((message) => message.content).join("\n");
    assert.doesNotMatch(mirrored, /rerun the same test/i);
    assert.match(mirrored, /bounded capability smoke test/i);
  } finally {
    await bridge.stop();
  }
});

test("conversation session stream suppresses synthetic child-worker turns and their same-turn activity", async () => {
  const { store, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_parent_session_live_filter",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_session_live_filter",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Parent live filter",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_parent_session_live_filter",
      turnId: "turn_child_synthetic_live",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "You are worker 2. Run read-only checks.",
      eventKey: "evt_child_synthetic_live_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: true
    });
    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_parent_session_live_filter",
      turnId: "turn_child_synthetic_live",
      streamOrder: 2,
      timestampMs: Date.now() + 1,
      text: "I am starting the worker task now.",
      phase: "commentary",
      eventKey: "evt_child_synthetic_live_commentary",
      sourceOrder: "00000002"
    });
    await (bridge as any).handleLocalShellCommandCompleted({
      type: "shellCommandCompleted",
      threadId: "thr_parent_session_live_filter",
      turnId: "turn_child_synthetic_live",
      callId: "call_child_synthetic_live",
      streamOrder: 3,
      timestampMs: Date.now() + 2,
      command: "Get-Date -Format o",
      cwd: "C:\\repo",
      output: "Exit code: 0",
      status: null,
      eventKey: "evt_child_synthetic_live_command",
      sourceOrder: "00000003"
    });

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.doesNotMatch(mirrored, /You are worker 2\. Run read-only checks\./);
    assert.doesNotMatch(mirrored, /I am starting the worker task now\./);
    assert.doesNotMatch(mirrored, /Get-Date -Format o/);
  } finally {
    await bridge.stop();
  }
});

test("conversation session stream ignores non-user activity until a real user anchor is mirrored", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();
  codex.metadata.set("thr_unanchored_live", { cwd: "C:\\repo", repoName: "repo" });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).hydrateThread(
      "thr_unanchored_live",
      {
        id: "thr_unanchored_live",
        name: "Unanchored live thread",
        preview: "Unanchored live thread",
        modelProvider: null,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        ephemeral: false,
        status: { type: "active", activeFlags: [] }
      },
      "auto"
    );

    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_unanchored_live",
      turnId: "turn_pre_anchor",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Old commentary before any human message.",
      phase: "commentary",
      eventKey: "evt_pre_anchor_commentary",
      sourceOrder: "00000001"
    });
    await (bridge as any).handleLocalShellCommandCompleted({
      type: "shellCommandCompleted",
      threadId: "thr_unanchored_live",
      turnId: "turn_pre_anchor",
      callId: "call_pre_anchor",
      streamOrder: 2,
      timestampMs: Date.now() + 1,
      command: "npm run build",
      cwd: "C:\\repo",
      output: "Exit code: 0",
      status: null,
      eventKey: "evt_pre_anchor_command",
      sourceOrder: "00000002"
    });
    await bridge.handleServerRequest({
      method: "mcpServer/elicitation/request",
      id: 321,
      params: {
        threadId: "thr_unanchored_live",
        turnId: "turn_pre_anchor",
        itemId: "mcp-elicitation:321",
        message: "Allow the browser tool?"
      }
    });

    assert.equal(discord.sentTextMessages.length, 0);
    assert.equal(discord.liveTextMessages.length, 0);
    assert.equal(discord.approvalCards.length, 0);
    assert.equal(store.findPendingApprovalByRequestId("321")?.discordMessageId ?? null, null);

    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_unanchored_live",
      turnId: "turn_with_anchor",
      streamOrder: 3,
      timestampMs: Date.now() + 2,
      text: "Actual fresh prompt",
      eventKey: "evt_anchor_user",
      sourceOrder: "00000003",
      isSyntheticSubagentInstruction: false
    });
    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_unanchored_live",
      turnId: "turn_with_anchor",
      streamOrder: 4,
      timestampMs: Date.now() + 3,
      text: "Fresh answer after the human anchor.",
      phase: "final_answer",
      eventKey: "evt_anchor_answer",
      sourceOrder: "00000004"
    });

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Actual fresh prompt/);
    assert.match(mirrored, /Fresh answer after the human anchor/);
    assert.doesNotMatch(mirrored, /Old commentary before any human message/);
    assert.doesNotMatch(mirrored, /npm run build/);
    assert.doesNotMatch(mirrored, /Allow the browser tool/);
  } finally {
    await bridge.stop();
  }
});

test("same-turn pending approval card is retried after the conversation user anchor is mirrored", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();
  codex.metadata.set("thr_approval_anchor_retry", { cwd: "C:\\repo", repoName: "repo" });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).hydrateThread(
      "thr_approval_anchor_retry",
      {
        id: "thr_approval_anchor_retry",
        name: "Approval anchor retry",
        preview: "Approval anchor retry",
        modelProvider: null,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        ephemeral: false,
        status: { type: "active", activeFlags: [] }
      },
      "auto"
    );

    await (bridge as any).handleDesktopIpcRequestUpserted({
      threadId: "thr_approval_anchor_retry",
      requestId: "req_approval_anchor_retry",
      request: {
        method: "item/commandExecution/requestApproval",
        id: "req_approval_anchor_retry",
        params: {
          threadId: "thr_approval_anchor_retry",
          turnId: "turn_approval_anchor_retry",
          itemId: "call_approval_anchor_retry",
          command: "Start-Process https://www.wikipedia.org",
          availableDecisions: ["accept", "cancel"]
        }
      }
    });

    assert.equal(discord.approvalCards.length, 0);
    assert.equal(store.findPendingApprovalByRequestId("req_approval_anchor_retry")?.discordMessageId, null);

    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_approval_anchor_retry",
      turnId: "turn_approval_anchor_retry",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Open Wikipedia.",
      eventKey: "evt_approval_anchor_retry_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });

    assert.equal(discord.approvalCards.length, 1);
    assert.equal(discord.approvalCards[0]?.channelId, "discord_channel_thr_approval_anchor_retry");
    assert.match(discord.approvalCards[0]?.preview ?? "", /wikipedia\.org/);
    assert.equal(store.findPendingApprovalByRequestId("req_approval_anchor_retry")?.discordMessageId, "approval_msg_1");
  } finally {
    await bridge.stop();
  }
});

test("conversation anchor gating survives a restart until a real user message is mirrored", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-bridge-"));
  const storePath = path.join(dir, "bridge.sqlite");
  const codex = new FakeCodexAdapter();
  const discord = new FakeDiscordAdapter();
  const summary = {
    id: "thr_restart_anchor",
    name: "Restart anchor thread",
    preview: "Restart anchor thread",
    modelProvider: null,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    ephemeral: false,
    status: { type: "active", activeFlags: [] as string[] }
  };
  codex.metadata.set("thr_restart_anchor", { cwd: "C:\\repo", repoName: "repo" });

  const createBridge = () =>
    createBridgeService({
      codexAdapter: codex as never,
      provider: discord as never,
      stateStore: new StateStore(storePath),
    });

  const firstBridge = createBridge();
  await firstBridge.start({ skipDiscovery: true });
  await (firstBridge as any).hydrateThread("thr_restart_anchor", summary, "auto");
  await firstBridge.stop();

  const secondBridge = createBridge();
  try {
    await secondBridge.start({ skipDiscovery: true });
    await (secondBridge as any).hydrateThread("thr_restart_anchor", summary, "auto");

    await (secondBridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_restart_anchor",
      turnId: "turn_restart_pre_anchor",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Restart commentary before any human message.",
      phase: "commentary",
      eventKey: "evt_restart_pre_anchor_commentary",
      sourceOrder: "00000001"
    });
    await (secondBridge as any).handleLocalShellCommandCompleted({
      type: "shellCommandCompleted",
      threadId: "thr_restart_anchor",
      turnId: "turn_restart_pre_anchor",
      callId: "call_restart_pre_anchor",
      streamOrder: 2,
      timestampMs: Date.now() + 1,
      command: "npm run build",
      cwd: "C:\\repo",
      output: "Exit code: 0",
      status: null,
      eventKey: "evt_restart_pre_anchor_command",
      sourceOrder: "00000002"
    });

    let mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.doesNotMatch(mirrored, /Restart commentary before any human message/);
    assert.doesNotMatch(mirrored, /npm run build/);

    await (secondBridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_restart_anchor",
      turnId: "turn_restart_with_anchor",
      streamOrder: 3,
      timestampMs: Date.now() + 2,
      text: "Actual restart anchor",
      eventKey: "evt_restart_anchor_user",
      sourceOrder: "00000003",
      isSyntheticSubagentInstruction: false
    });
    await (secondBridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_restart_anchor",
      turnId: "turn_restart_with_anchor",
      streamOrder: 4,
      timestampMs: Date.now() + 3,
      text: "Answer after restart anchor.",
      phase: "final_answer",
      eventKey: "evt_restart_anchor_answer",
      sourceOrder: "00000004"
    });

    mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Actual restart anchor/);
    assert.match(mirrored, /Answer after restart anchor/);
    assert.doesNotMatch(mirrored, /Restart commentary before any human message/);
    assert.doesNotMatch(mirrored, /npm run build/);
  } finally {
    await secondBridge.stop();
  }
});

test("conversation session stream requires a same-turn user anchor before later-turn commentary or commands can mirror", async () => {
  const { codex, discord, bridge } = createBridgeTestRig();
  codex.metadata.set("thr_turn_anchor_gate", { cwd: "C:\\repo", repoName: "repo" });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).hydrateThread(
      "thr_turn_anchor_gate",
      {
        id: "thr_turn_anchor_gate",
        name: "Turn anchor gate",
        preview: "Turn anchor gate",
        modelProvider: null,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        ephemeral: false,
        status: { type: "active", activeFlags: [] }
      },
      "auto"
    );

    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_turn_anchor_gate",
      turnId: "turn_old_anchor",
      streamOrder: 1,
      timestampMs: Date.now(),
      text: "Earlier retained prompt",
      eventKey: "evt_old_anchor_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    });
    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_turn_anchor_gate",
      turnId: "turn_old_anchor",
      streamOrder: 2,
      timestampMs: Date.now() + 1,
      text: "Earlier retained answer",
      phase: "final_answer",
      eventKey: "evt_old_anchor_answer",
      sourceOrder: "00000002"
    });

    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_turn_anchor_gate",
      turnId: "turn_missing_anchor",
      streamOrder: 3,
      timestampMs: Date.now() + 2,
      text: "This commentary must wait for the new user anchor.",
      phase: "commentary",
      eventKey: "evt_missing_anchor_commentary",
      sourceOrder: "00000003"
    });
    let mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Earlier retained prompt/);
    assert.match(mirrored, /Earlier retained answer/);
    assert.doesNotMatch(mirrored, /This commentary must wait for the new user anchor/);

    await (bridge as any).handleLocalSessionUserMessage({
      type: "sessionUserMessage",
      threadId: "thr_turn_anchor_gate",
      turnId: "turn_missing_anchor",
      streamOrder: 4,
      timestampMs: Date.now() + 4,
      text: "Actual latest prompt",
      eventKey: "evt_missing_anchor_user",
      sourceOrder: "00000004",
      isSyntheticSubagentInstruction: false
    });
    await (bridge as any).handleLocalSessionAgentMessage({
      type: "sessionAgentMessage",
      threadId: "thr_turn_anchor_gate",
      turnId: "turn_missing_anchor",
      streamOrder: 5,
      timestampMs: Date.now() + 5,
      text: "Actual latest answer",
      phase: "final_answer",
      eventKey: "evt_missing_anchor_answer",
      sourceOrder: "00000005"
    });

    mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Actual latest prompt/);
    assert.match(mirrored, /Actual latest answer/);
    assert.doesNotMatch(mirrored, /This commentary must wait for the new user anchor/);
  } finally {
    await bridge.stop();
  }
});

test("startup does not backfill existing mapped threads that already have Discord history", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_existing_startup",
      name: "Existing startup thread",
      preview: "Existing startup thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("thr_existing_startup", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_existing_startup", {
    id: "thr_existing_startup",
    name: "Existing startup thread",
    preview: "Existing startup thread",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_existing_startup",
        createdAt: nowSeconds,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_existing_startup",
            createdAt: nowSeconds,
            content: [{ type: "text", text: "Do not backfill me again" }]
          },
          {
            type: "message",
            id: "assistant_existing_startup",
            role: "assistant",
            phase: "final_answer",
            createdAt: nowSeconds,
            content: [{ type: "output_text", text: "This old history should stay quiet on startup." }]
          }
        ]
      }
    ]
  });

  store.upsertThreadBridge({
    codexThreadId: "thr_existing_startup",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_existing_startup",
    discordParentChannelId: null,
    statusMessageId: "status_msg_existing",
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(nowSeconds * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Existing startup thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: nowSeconds * 1000 - 10_000,
    latestMirroredCursor: "9999999999999:zzz"
  });
  discord.conversationChannelIds.add("discord_channel_thr_existing_startup");

  try {
    await bridge.start();

    assert.equal(discord.sentTextMessages.length, 0);
    assert.equal(discord.liveTextMessages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("startup backfills existing mapped threads when Discord recreates the conversation channel", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: sessionTailer as never,
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        startupBackfill: {
          leadingEventBudget: 20,
          trailingEventBudget: 20
        }
      }
    )
  });

  const baseSeconds = Math.floor(Date.now() / 1000);
  codex.threadDetails.set("thr_recreated_startup", {
    id: "thr_recreated_startup",
    name: "Recreated startup thread",
    preview: "Recovered startup anchor",
    modelProvider: null,
    createdAt: baseSeconds - 60,
    updatedAt: baseSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });
  codex.metadata.set("thr_recreated_startup", { cwd: "C:\\write", repoName: "write" });
  sessionTailer.setLatestTurnBackfillEvents("thr_recreated_startup", [
    {
      type: "sessionUserMessage",
      threadId: "thr_recreated_startup",
      turnId: "turn_recreated_startup",
      timestampMs: baseSeconds * 1000,
      text: "Recovered startup anchor",
      eventKey: "evt_recreated_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_recreated_startup",
      turnId: "turn_recreated_startup",
      timestampMs: baseSeconds * 1000 + 1,
      text: "Recovered startup answer",
      phase: "final_answer",
      eventKey: "evt_recreated_answer",
      sourceOrder: "00000002"
    }
  ]);

  store.upsertThreadBridge({
    codexThreadId: "thr_recreated_startup",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_old_recreated_startup",
    discordParentChannelId: null,
    statusMessageId: "status_msg_old_recreated_startup",
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(baseSeconds * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Recreated startup thread",
    lastStatusType: "active",
    channelKind: "conversation",
    latestMirroredTimestampMs: null,
    latestMirroredCursor: null,
    latestMirroredTurnCursor: null
  });

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.match(mirrored, /Recovered startup anchor/);
    assert.match(mirrored, /Recovered startup answer/);

    const persistedItems = store.listMirroredItems("thr_recreated_startup");
    assert.ok(persistedItems.some((record) => record.kind === "user"));
    assert.ok(persistedItems.some((record) => record.kind === "agentAnswer"));
    assert.equal(
      store.getThreadBridge("thr_recreated_startup")?.discordChannelId,
      "discord_channel_thr_recreated_startup"
    );
  } finally {
    await bridge.stop();
  }
});

test("startup backfills existing mapped threads when Discord remaps them onto a different existing conversation channel", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: sessionTailer as never,
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        startupBackfill: {
          leadingEventBudget: 20,
          trailingEventBudget: 20
        }
      }
    )
  });

  const baseSeconds = Math.floor(Date.now() / 1000);
  codex.threadDetails.set("thr_reused_existing_channel", {
    id: "thr_reused_existing_channel",
    name: "Reused existing channel thread",
    preview: "Recovered startup anchor",
    modelProvider: null,
    createdAt: baseSeconds - 60,
    updatedAt: baseSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });
  codex.metadata.set("thr_reused_existing_channel", { cwd: "C:\\write", repoName: "write" });
  sessionTailer.setLatestTurnBackfillEvents("thr_reused_existing_channel", [
    {
      type: "sessionUserMessage",
      threadId: "thr_reused_existing_channel",
      turnId: "turn_reused_existing_channel",
      timestampMs: baseSeconds * 1000,
      text: "Recovered startup anchor",
      eventKey: "evt_reused_existing_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_reused_existing_channel",
      turnId: "turn_reused_existing_channel",
      timestampMs: baseSeconds * 1000 + 1,
      text: "Recovered startup answer",
      phase: "final_answer",
      eventKey: "evt_reused_existing_answer",
      sourceOrder: "00000002"
    }
  ]);

  store.upsertThreadBridge({
    codexThreadId: "thr_reused_existing_channel",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_old_reused_existing_channel",
    discordParentChannelId: null,
    statusMessageId: "status_msg_old_reused_existing_channel",
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(baseSeconds * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Reused existing channel thread",
    lastStatusType: "active",
    channelKind: "conversation",
    latestMirroredTimestampMs: baseSeconds * 1000 - 10_000,
    latestMirroredCursor: "session:99999996:0000:old-command",
    latestMirroredTurnCursor: "turn:old-turn"
  });

  discord.conversationChannelIds.add("discord_channel_reused_existing_channel");
  (discord as any).ensureConversationChannel = async (
    codexThreadId: string,
    _title?: string,
    _categoryId?: string,
    _existingDiscordChannelId?: string | null
  ) => {
    discord.conversationEnsureCalls.push(codexThreadId);
    return { id: "discord_channel_reused_existing_channel", created: false };
  };

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.match(mirrored, /Recovered startup anchor/);
    assert.match(mirrored, /Recovered startup answer/);

    const persistedItems = store.listMirroredItems("thr_reused_existing_channel");
    assert.ok(persistedItems.some((record) => record.kind === "user"));
    assert.ok(persistedItems.some((record) => record.kind === "agentAnswer"));
    assert.equal(
      store.getThreadBridge("thr_reused_existing_channel")?.discordChannelId,
      "discord_channel_reused_existing_channel"
    );
  } finally {
    await bridge.stop();
  }
});

test("startup repairs anchorless existing conversation threads before mirroring more non-user activity", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: sessionTailer as never,
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        startupBackfill: {
          leadingEventBudget: 20,
          trailingEventBudget: 20
        }
      }
    )
  });

  const baseSeconds = Math.floor(Date.now() / 1000);
  codex.threadDetails.set("thr_anchor_repair", {
    id: "thr_anchor_repair",
    name: "Anchor repair thread",
    preview: "Recovered startup anchor",
    modelProvider: null,
    createdAt: baseSeconds - 60,
    updatedAt: baseSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });
  codex.metadata.set("thr_anchor_repair", { cwd: "C:\\write", repoName: "write" });
  sessionTailer.setLatestTurnBackfillEvents("thr_anchor_repair", [
    {
      type: "sessionUserMessage",
      threadId: "thr_anchor_repair",
      turnId: "turn_anchor_repair",
      timestampMs: baseSeconds * 1000,
      text: "Recovered startup anchor",
      eventKey: "evt_anchor_repair_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_anchor_repair",
      turnId: "turn_anchor_repair",
      timestampMs: baseSeconds * 1000 + 1,
      text: "Recovered startup answer",
      phase: "final_answer",
      eventKey: "evt_anchor_repair_answer",
      sourceOrder: "00000002"
    }
  ]);

  store.upsertThreadBridge({
    codexThreadId: "thr_anchor_repair",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_anchor_repair",
    discordParentChannelId: null,
    statusMessageId: "status_msg_anchor_repair",
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(baseSeconds * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Anchor repair thread",
    lastStatusType: "active",
    channelKind: "conversation",
    latestMirroredTimestampMs: baseSeconds * 1000 - 10_000,
    latestMirroredCursor: "session:99999999:0000:old-command",
    latestMirroredTurnCursor: "turn:old-turn"
  });
  store.upsertMirroredItem({
    threadId: "thr_anchor_repair",
    itemId: "session:old-command",
    turnId: "old-turn",
    kind: "command",
    discordMessageId: "msg_old_command",
    groupKey: "command",
    contentSignature: "old command",
    renderedContent: "old command",
    timestampMs: baseSeconds * 1000 - 10_000,
    cursor: "session:99999999:0000:old-command",
    turnCursor: "turn:old-turn",
    updatedAt: new Date(baseSeconds * 1000 - 10_000).toISOString()
  });
  discord.conversationChannelIds.add("discord_channel_thr_anchor_repair");

  try {
    await bridge.start();

    const persistedItems = store.listMirroredItems("thr_anchor_repair");
    assert.ok(persistedItems.some((record) => record.kind === "user"));
    assert.ok(persistedItems.some((record) => record.kind === "agentAnswer"));
    assert.ok(!persistedItems.some((record) => record.itemId === "session:old-command"));

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.match(mirrored, /Recovered startup anchor/);
    assert.match(mirrored, /Recovered startup answer/);
  } finally {
    await bridge.stop();
  }
});

test("startup anchor repair trusts recent session-log history even when thread/read retains a different turn snapshot", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: sessionTailer as never
  });

  const baseSeconds = Math.floor(Date.now() / 1000);
  codex.threadDetails.set("thr_anchor_repair_session_truth", {
    id: "thr_anchor_repair_session_truth",
    name: "Anchor repair session truth thread",
    preview: "Recovered startup anchor from session log",
    modelProvider: null,
    createdAt: baseSeconds - 60,
    updatedAt: baseSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_thread_read_snapshot_only",
        status: "interrupted",
        items: [
          {
            id: "turn_thread_read_snapshot_only_user",
            type: "userMessage",
            text: "Older retained snapshot that should stay out of Discord"
          },
          {
            id: "turn_thread_read_snapshot_only_commentary",
            type: "agentMessage",
            phase: "commentary",
            text: "Thread/read snapshot only knows this mismatched commentary."
          }
        ]
      }
    ]
  });
  codex.metadata.set("thr_anchor_repair_session_truth", { cwd: "C:\\write", repoName: "write" });
  sessionTailer.setLatestTurnBackfillEvents("thr_anchor_repair_session_truth", [
    {
      type: "sessionUserMessage",
      threadId: "thr_anchor_repair_session_truth",
      turnId: "turn_session_truth",
      timestampMs: baseSeconds * 1000,
      text: "Recovered startup anchor from session log",
      eventKey: "evt_anchor_repair_truth_user",
      sourceOrder: "00000001",
      isSyntheticSubagentInstruction: false
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_anchor_repair_session_truth",
      turnId: "turn_session_truth",
      timestampMs: baseSeconds * 1000 + 1,
      text: "Recovered startup answer from session log",
      phase: "final_answer",
      eventKey: "evt_anchor_repair_truth_answer",
      sourceOrder: "00000002"
    }
  ]);

  store.upsertThreadBridge({
    codexThreadId: "thr_anchor_repair_session_truth",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_anchor_repair_session_truth",
    discordParentChannelId: null,
    statusMessageId: "status_msg_anchor_repair_session_truth",
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(baseSeconds * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Anchor repair session truth thread",
    lastStatusType: "active",
    channelKind: "conversation",
    latestMirroredTimestampMs: baseSeconds * 1000 - 10_000,
    latestMirroredCursor: "session:99999998:0000:old-command",
    latestMirroredTurnCursor: "turn:old-turn"
  });
  store.upsertMirroredItem({
    threadId: "thr_anchor_repair_session_truth",
    itemId: "session:old-command",
    turnId: "old-turn",
    kind: "command",
    discordMessageId: "msg_old_anchor_repair_session_truth",
    groupKey: "command",
    contentSignature: "old command",
    renderedContent: "old command",
    timestampMs: baseSeconds * 1000 - 10_000,
    cursor: "session:99999998:0000:old-command",
    turnCursor: "turn:old-turn",
    updatedAt: new Date(baseSeconds * 1000 - 10_000).toISOString()
  });
  discord.conversationChannelIds.add("discord_channel_thr_anchor_repair_session_truth");

  try {
    await bridge.start();

    const persistedItems = store.listMirroredItems("thr_anchor_repair_session_truth");
    assert.ok(persistedItems.some((record) => record.kind === "user"));
    assert.ok(persistedItems.some((record) => record.kind === "agentAnswer"));
    assert.ok(!persistedItems.some((record) => record.itemId === "session:old-command"));

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.match(mirrored, /Recovered startup anchor from session log/);
    assert.match(mirrored, /Recovered startup answer from session log/);
    assert.doesNotMatch(mirrored, /Older retained snapshot that should stay out of Discord/);
    assert.doesNotMatch(mirrored, /Thread\/read snapshot only knows this mismatched commentary/);
  } finally {
    await bridge.stop();
  }
});

test("pending-anchor conversation threads do not advance their mirror cursor from suppressed non-user session events", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: sessionTailer as never
  });

  const baseSeconds = Math.floor(Date.now() / 1000);
  codex.threadDetails.set("thr_pending_anchor", {
    id: "thr_pending_anchor",
    name: "Pending anchor thread",
    preview: "Pending anchor thread",
    modelProvider: null,
    createdAt: baseSeconds - 60,
    updatedAt: baseSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });
  codex.metadata.set("thr_pending_anchor", { cwd: "C:\\write", repoName: "write" });

  store.upsertThreadBridge({
    codexThreadId: "thr_pending_anchor",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_old_pending_anchor",
    discordParentChannelId: null,
    statusMessageId: "status_msg_old_pending_anchor",
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(baseSeconds * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Pending anchor thread",
    lastStatusType: "active",
    channelKind: "conversation",
    latestMirroredTimestampMs: baseSeconds * 1000 - 10_000,
    latestMirroredCursor: "session:99999997:0000:old-command",
    latestMirroredTurnCursor: "turn:old-turn"
  });
  store.upsertMirroredItem({
    threadId: "thr_pending_anchor",
    itemId: "session:old-command",
    turnId: "old-turn",
    kind: "command",
    discordMessageId: "msg_old_pending_anchor",
    groupKey: "command",
    contentSignature: "old command",
    renderedContent: "old command",
    timestampMs: baseSeconds * 1000 - 10_000,
    cursor: "session:99999997:0000:old-command",
    turnCursor: "turn:old-turn",
    updatedAt: new Date(baseSeconds * 1000 - 10_000).toISOString()
  });

  try {
    await bridge.start({ skipDiscovery: true });

    await (bridge as any).maybeAttachThread(
      {
        summary: await codex.readThread("thr_pending_anchor"),
        source: "app-server",
        resolvedMetadata: {
          cwd: "C:\\write",
          repoName: "write",
          threadName: "Pending anchor thread",
          actorName: null,
          parentThreadId: null
        }
      },
      true,
      true
    );

    sessionTailer.setEvents("thr_pending_anchor", [
      {
        type: "sessionAgentMessage",
        threadId: "thr_pending_anchor",
        turnId: "turn_pending_anchor",
        timestampMs: baseSeconds * 1000 + 1,
        text: "Commentary without a mirrored user anchor",
        phase: "commentary",
        eventKey: "evt_pending_anchor_commentary",
        sourceOrder: "00000010"
      },
      {
        type: "shellCommandCompleted",
        threadId: "thr_pending_anchor",
        callId: "call_pending_anchor",
        turnId: "turn_pending_anchor",
        timestampMs: baseSeconds * 1000 + 2,
        command: "npm run build",
        cwd: "C:\\write",
        output: "Exit code: 0",
        status: null,
        eventKey: "shell-command:call_pending_anchor",
        sourceOrder: "00000011"
      }
    ]);

    await bridge.pollLocalSessionEvents();
    await (bridge as any).drainThreadEventQueue();

    const refreshedBridge = store.getThreadBridge("thr_pending_anchor");
    assert.equal(refreshedBridge?.latestMirroredCursor ?? null, null);
    assert.equal(store.listMirroredItems("thr_pending_anchor").length, 0);

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.doesNotMatch(mirrored, /Commentary without a mirrored user anchor/);
    assert.doesNotMatch(mirrored, /npm run build/);
  } finally {
    await bridge.stop();
  }
});

test("existing thread sync drops stale unseen commentary that predates the latest new user message", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  const baseSeconds = Math.floor(Date.now() / 1000);
  codex.metadata.set("thr_sync_trim", { cwd: "C:\\write", repoName: "write" });
  store.upsertThreadBridge({
    codexThreadId: "thr_sync_trim",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_sync_trim",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(baseSeconds * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Sync trim thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: (baseSeconds - 60) * 1000,
    latestMirroredCursor: `${String((baseSeconds - 60) * 1000).padStart(16, "0")}:00000000:item-old-anchor`
  });
  discord.conversationChannelIds.add("discord_channel_thr_sync_trim");

  codex.threadDetails.set("thr_sync_trim", {
    id: "thr_sync_trim",
    name: "Sync trim thread",
    preview: "Sync trim thread",
    modelProvider: null,
    createdAt: baseSeconds - 120,
    updatedAt: baseSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_sync_trim",
        createdAt: baseSeconds,
        status: "completed",
        items: [
          {
            type: "message",
            id: "item-old-commentary-1",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Old commentary that should stay quiet." }]
          },
          {
            type: "message",
            id: "item-old-commentary-2",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Another stale commentary item." }]
          },
          {
            type: "userMessage",
            id: "item-new-user",
            createdAt: baseSeconds + 1,
            content: [{ type: "text", text: "New user prompt." }]
          },
          {
            type: "message",
            id: "item-new-answer",
            role: "assistant",
            phase: "final_answer",
            createdAt: baseSeconds + 2,
            content: [{ type: "output_text", text: "Fresh answer after the new user prompt." }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).hydrateThread(
      "thr_sync_trim",
      {
        id: "thr_sync_trim",
        name: "Sync trim thread",
        preview: "Sync trim thread",
        modelProvider: null,
        createdAt: baseSeconds - 120,
        updatedAt: baseSeconds,
        ephemeral: false,
        status: { type: "active", activeFlags: [] }
      },
      "auto"
    );
    codex.emit("notification", {
      method: "thread/status/changed",
      params: {
        threadId: "thr_sync_trim",
        status: { type: "active", activeFlags: [] }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.match(mirrored, /New user prompt/);
    assert.match(mirrored, /Fresh answer after the new user prompt/);
    assert.doesNotMatch(mirrored, /Old commentary that should stay quiet/);
    assert.doesNotMatch(mirrored, /Another stale commentary item/);
  } finally {
    await bridge.stop();
  }
});

test("existing thread sync does not replay commentary without a new user anchor", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  const baseSeconds = Math.floor(Date.now() / 1000);
  codex.metadata.set("thr_sync_commentary_only", { cwd: "C:\\write", repoName: "write" });
  store.upsertThreadBridge({
    codexThreadId: "thr_sync_commentary_only",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_sync_commentary_only",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(baseSeconds * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Sync commentary thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: (baseSeconds - 60) * 1000,
    latestMirroredCursor: `${String((baseSeconds - 60) * 1000).padStart(16, "0")}:00000000:item-old-anchor`
  });
  store.upsertMirroredItem({
    threadId: "thr_sync_commentary_only",
    itemId: "item-old-anchor",
    turnId: "turn-old-anchor",
    kind: "user",
    discordMessageId: "msg-old-anchor",
    groupKey: "turn-old-anchor",
    contentSignature: "older mirrored prompt",
    renderedContent: "Older mirrored prompt",
    timestampMs: (baseSeconds - 60) * 1000,
    cursor: `${String((baseSeconds - 60) * 1000).padStart(16, "0")}:00000000:item-old-anchor`,
    turnCursor: `${String((baseSeconds - 60) * 1000).padStart(16, "0")}:turn-old-anchor`,
    updatedAt: new Date((baseSeconds - 60) * 1000).toISOString()
  });
  discord.conversationChannelIds.add("discord_channel_thr_sync_commentary_only");

  codex.threadDetails.set("thr_sync_commentary_only", {
    id: "thr_sync_commentary_only",
    name: "Sync commentary thread",
    preview: "Sync commentary thread",
    modelProvider: null,
    createdAt: baseSeconds - 120,
    updatedAt: baseSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_sync_commentary_only",
        createdAt: baseSeconds,
        status: "completed",
        items: [
          {
            type: "message",
            id: "item-commentary-only",
            role: "assistant",
            phase: "commentary",
            createdAt: baseSeconds + 1,
            content: [{ type: "output_text", text: "Old commentary should not replay by itself." }]
          },
          {
            type: "message",
            id: "item-final-only",
            role: "assistant",
            phase: "final_answer",
            createdAt: baseSeconds + 2,
            content: [{ type: "output_text", text: "A final answer may still sync." }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).hydrateThread(
      "thr_sync_commentary_only",
      {
        id: "thr_sync_commentary_only",
        name: "Sync commentary thread",
        preview: "Sync commentary thread",
        modelProvider: null,
        createdAt: baseSeconds - 120,
        updatedAt: baseSeconds,
        ephemeral: false,
        status: { type: "active", activeFlags: [] }
      },
      "auto"
    );
    codex.emit("notification", {
      method: "thread/status/changed",
      params: {
        threadId: "thr_sync_commentary_only",
        status: { type: "active", activeFlags: [] }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.doesNotMatch(mirrored, /Old commentary should not replay by itself/);
    assert.match(mirrored, /A final answer may still sync/);
  } finally {
    await bridge.stop();
  }
});

test("existing thread sync recovers late same-turn commentary while keeping the user prompt", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_same_turn",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_same_turn",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Same turn sync thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: 1_000,
    latestMirroredCursor: "0000000000001000:00000001:item-1",
    latestMirroredTurnCursor: "0000000000001000:turn-old"
  });

  const oldTurn = {
    id: "turn-old",
    createdAt: 1_000,
    status: "completed",
    items: [{ type: "message", role: "assistant", id: "item-1", content: [{ type: "output_text", text: "Older turn." }] }]
  };
  const partialCurrentTurn = {
    id: "turn-current",
    createdAt: 2_000,
    status: "inProgress",
    items: [
      { type: "message", role: "user", id: "item-2", content: [{ type: "text", text: "Please test this turn." }] },
      { type: "message", role: "assistant", phase: "commentary", id: "item-4", content: [{ type: "output_text", text: "Later commentary already seen." }] }
    ]
  };
  const fullCurrentTurn = {
    id: "turn-current",
    createdAt: 2_000,
    status: "inProgress",
    items: [
      { type: "message", role: "user", id: "item-2", content: [{ type: "text", text: "Please test this turn." }] },
      { type: "message", role: "assistant", phase: "commentary", id: "item-3", content: [{ type: "output_text", text: "Late commentary first." }] },
      { type: "message", role: "assistant", phase: "commentary", id: "item-4", content: [{ type: "output_text", text: "Later commentary already seen." }] },
      { type: "message", role: "assistant", phase: "commentary", id: "item-5", content: [{ type: "output_text", text: "Fresh trailing commentary." }] }
    ]
  };

  codex.threadDetails.set("thr_same_turn", {
    id: "thr_same_turn",
    name: "Same turn sync thread",
    preview: "Please test this turn.",
    modelProvider: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    ephemeral: false,
    status: { type: "active", activeFlags: [] },
    turns: [oldTurn, partialCurrentTurn]
  });

  try {
    await bridge.start({ skipDiscovery: true });

    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_same_turn",
        turnId: "turn-current",
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          id: "item-4",
          content: [{ type: "output_text", text: "Later commentary already seen." }]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.threadDetails.set("thr_same_turn", {
      id: "thr_same_turn",
      name: "Same turn sync thread",
      preview: "Please test this turn.",
      modelProvider: null,
      createdAt: 1_000,
      updatedAt: 2_100,
      ephemeral: false,
      status: { type: "active", activeFlags: [] },
      turns: [oldTurn, fullCurrentTurn]
    });

    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_same_turn",
        turnId: "turn-current",
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          id: "item-5",
          content: [{ type: "output_text", text: "Fresh trailing commentary." }]
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const userMessages = [
      ...discord.sentTextMessages.filter((message) => message.content.includes("**You**")),
      ...discord.liveTextMessages.filter((message) => message.content.includes("**You**"))
    ];
    assert.ok(userMessages.length >= 1);
    assert.match(userMessages.at(-1)?.content ?? "", /Please test this turn\./);

    const commentaryMessages = discord.liveTextMessages.filter(
      (message) => message.content.startsWith("### ") && message.content.includes("**Codex**")
    );
    assert.ok(commentaryMessages.length >= 2);
    const finalCommentary = commentaryMessages.at(-1)?.content ?? "";
    assert.match(finalCommentary, /Late commentary first\./);
    assert.match(finalCommentary, /Later commentary already seen\./);
    assert.match(finalCommentary, /Fresh trailing commentary\./);
    assert.ok(finalCommentary.indexOf("Late commentary first.") < finalCommentary.indexOf("Later commentary already seen."));
    assert.ok(finalCommentary.indexOf("Later commentary already seen.") < finalCommentary.indexOf("Fresh trailing commentary."));
  } finally {
    await bridge.stop();
  }
});

test("existing thread sync keeps newer commentary from the current mirrored turn", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  const baseSeconds = Math.floor(Date.now() / 1000);
  codex.metadata.set("thr_current_turn_commentary", { cwd: "C:\\write", repoName: "write" });
  store.upsertThreadBridge({
    codexThreadId: "thr_current_turn_commentary",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_current_turn_commentary",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(baseSeconds * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Current turn commentary thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: baseSeconds * 1000,
    latestMirroredCursor: `${String(baseSeconds * 1000).padStart(16, "0")}:00001467:item-1467`,
    latestMirroredTurnCursor: `${String(baseSeconds * 1000).padStart(16, "0")}:turn-current`
  });
  store.upsertMirroredItem({
    threadId: "thr_current_turn_commentary",
    itemId: "item-1467",
    turnId: "turn-current",
    kind: "user",
    discordMessageId: "msg-current-user",
    groupKey: "turn-current",
    contentSignature: "current prompt already mirrored",
    renderedContent: "Current prompt already mirrored",
    timestampMs: baseSeconds * 1000,
    cursor: `${String(baseSeconds * 1000).padStart(16, "0")}:00001467:item-1467`,
    turnCursor: `${String(baseSeconds * 1000).padStart(16, "0")}:turn-current`,
    updatedAt: new Date(baseSeconds * 1000).toISOString()
  });
  discord.conversationChannelIds.add("discord_channel_thr_current_turn_commentary");

  codex.threadDetails.set("thr_current_turn_commentary", {
    id: "thr_current_turn_commentary",
    name: "Current turn commentary thread",
    preview: "Current turn commentary thread",
    modelProvider: null,
    createdAt: baseSeconds - 120,
    updatedAt: baseSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn-older",
        createdAt: baseSeconds - 60,
        status: "completed",
        items: [
          {
            type: "message",
            id: "item-older-commentary",
            role: "assistant",
            phase: "commentary",
            createdAt: baseSeconds - 59,
            content: [{ type: "output_text", text: "Older commentary should stay quiet." }]
          }
        ]
      },
      {
        id: "turn-current",
        createdAt: baseSeconds,
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            id: "item-1467",
            createdAt: baseSeconds,
            content: [{ type: "text", text: "Current prompt already mirrored" }]
          },
          {
            type: "message",
            id: "item-1468",
            role: "assistant",
            phase: "commentary",
            createdAt: baseSeconds + 1,
            content: [{ type: "output_text", text: "Fresh commentary from the current turn." }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).hydrateThread(
      "thr_current_turn_commentary",
      {
        id: "thr_current_turn_commentary",
        name: "Current turn commentary thread",
        preview: "Current turn commentary thread",
        modelProvider: null,
        createdAt: baseSeconds - 120,
        updatedAt: baseSeconds,
        ephemeral: false,
        status: { type: "active", activeFlags: [] }
      },
      "auto"
    );
    codex.emit("notification", {
      method: "thread/status/changed",
      params: {
        threadId: "thr_current_turn_commentary",
        status: { type: "active", activeFlags: [] }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.match(mirrored, /Fresh commentary from the current turn/);
    assert.doesNotMatch(mirrored, /Older commentary should stay quiet/);
  } finally {
    await bridge.stop();
  }
});

test("backfilled messages are ordered chronologically even if Codex returns turns newest-first", async () => {
  const { codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_order",
      name: "Ordered thread",
      preview: "Ordered thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("thr_order", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_order", {
    id: "thr_order",
    name: "Ordered thread",
    preview: "Ordered thread",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_new",
        createdAt: nowSeconds,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_new",
            createdAt: nowSeconds,
            content: [{ type: "text", text: "Second question" }]
          },
          {
            type: "message",
            id: "agent_new",
            createdAt: nowSeconds,
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Second answer" }]
          }
        ]
      },
      {
        id: "turn_old",
        createdAt: nowSeconds - 60,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_old",
            createdAt: nowSeconds - 60,
            content: [{ type: "text", text: "First question" }]
          },
          {
            type: "message",
            id: "agent_old",
            createdAt: nowSeconds - 59,
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "First answer" }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start();

    const orderedMessages = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");

    assert.ok(orderedMessages.indexOf("First question") < orderedMessages.indexOf("Second question"));
    assert.ok(orderedMessages.indexOf("First answer") < orderedMessages.indexOf("Second answer"));
  } finally {
    await bridge.stop();
  }
});

test("status changes can sync new thread messages even when live item notifications are missing", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_sync",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_sync",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    attachMode: "auto",
    threadName: "Sync thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threadDetails.set("thr_sync", {
    id: "thr_sync",
    name: "Sync thread",
    preview: "Sync thread",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_sync",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_sync",
            content: [{ type: "text", text: "Did the sync fallback work?" }]
          },
          {
            type: "message",
            id: "agent_sync",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Yes, the sync fallback mirrored this turn." }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "thread/status/changed",
      params: {
        threadId: "thr_sync",
        status: { type: "idle" }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.equal(discord.sentTextMessages.length, 1);
    assert.match(discord.sentTextMessages[0]?.content ?? "", /sync fallback work/i);
    assert.equal(discord.liveTextMessages.length, 1);
    assert.match(discord.liveTextMessages[0]?.content ?? "", /^# .*?\*\*Codex\*\*/);
    assert.match(discord.liveTextMessages[0]?.content ?? "", /sync fallback mirrored/i);
  } finally {
    await bridge.stop();
  }
});

test("session-backed startup repair does not mirror current-turn thread/read items for existing mapped threads", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never
  });

  const baseSeconds = Math.floor(Date.now() / 1000);
  const currentTurnCursor = `${String(baseSeconds * 1000).padStart(16, "0")}:turn-repair-current`;
  const currentUserCursor = `${String(baseSeconds * 1000).padStart(16, "0")}:00000000:item-repair-user`;
  codex.metadata.set("thr_session_startup_repair", { cwd: "C:\\write", repoName: "write" });
  store.upsertThreadBridge({
    codexThreadId: "thr_session_startup_repair",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_session_startup_repair",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(baseSeconds * 1000).toISOString(),
    attachMode: "auto",
    threadName: "Session startup repair thread",
    lastStatusType: "active",
    channelKind: "conversation",
    latestMirroredTimestampMs: baseSeconds * 1000,
    latestMirroredCursor: currentUserCursor,
    latestMirroredTurnCursor: currentTurnCursor
  });
  store.upsertMirroredItem({
    threadId: "thr_session_startup_repair",
    itemId: "item-repair-user",
    turnId: "turn-repair-current",
    kind: "user",
    discordMessageId: "msg-session-repair-user",
    groupKey: "turn-repair-current",
    contentSignature: "Current prompt already mirrored",
    renderedContent: "Current prompt already mirrored",
    timestampMs: baseSeconds * 1000,
    cursor: currentUserCursor,
    turnCursor: currentTurnCursor,
    updatedAt: new Date(baseSeconds * 1000).toISOString()
  });
  discord.conversationChannelIds.add("discord_channel_thr_session_startup_repair");

  codex.threadDetails.set("thr_session_startup_repair", {
    id: "thr_session_startup_repair",
    name: "Session startup repair thread",
    preview: "Session startup repair thread",
    modelProvider: null,
    createdAt: baseSeconds - 120,
    updatedAt: baseSeconds + 2,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn-repair-older",
        createdAt: baseSeconds - 60,
        status: "completed",
        items: [
          {
            type: "message",
            id: "item-repair-older-commentary",
            role: "assistant",
            phase: "commentary",
            createdAt: baseSeconds - 59,
            content: [{ type: "output_text", text: "Older commentary should stay quiet." }]
          }
        ]
      },
      {
        id: "turn-repair-current",
        createdAt: baseSeconds,
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            id: "item-repair-user",
            createdAt: baseSeconds,
            content: [{ type: "text", text: "Current prompt already mirrored" }]
          },
          {
            type: "message",
            id: "item-repair-commentary",
            role: "assistant",
            phase: "commentary",
            createdAt: baseSeconds + 1,
            content: [{ type: "output_text", text: "Fresh commentary from the repaired startup turn." }]
          },
          {
            type: "commandExecution",
            id: "item-repair-command",
            createdAt: baseSeconds + 2,
            command: "Get-Date -Format o",
            cwd: "C:\\write",
            status: "completed",
            aggregatedOutput: "2026-04-20T08:00:00.0000000+02:00",
            exitCode: 0,
            durationMs: 42
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_session_startup_repair",
        turnId: "turn-repair-current",
        item: {
          type: "commandExecution",
          id: "item-repair-command",
          createdAt: baseSeconds + 2,
          command: "Get-Date -Format o",
          cwd: "C:\\write",
          status: "completed",
          aggregatedOutput: "2026-04-20T08:00:00.0000000+02:00",
          exitCode: 0,
          durationMs: 42
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.doesNotMatch(mirrored, /Fresh commentary from the repaired startup turn/);
    assert.doesNotMatch(mirrored, /Ran 1 command/);
    assert.doesNotMatch(mirrored, /Older commentary should stay quiet/);
    assert.equal(store.getMirroredItem("thr_session_startup_repair", "item-repair-commentary") ?? null, null);
    assert.equal(store.getMirroredItem("thr_session_startup_repair", "item-repair-command") ?? null, null);
    assert.equal(
      tailer.rememberedTurnHints.some(
        (hint) =>
          hint.threadId === "thr_session_startup_repair" &&
          hint.turnId === "turn-repair-current"
      ),
      true
    );
    assert.equal(
      tailer.pollThreadCalls.some((call) => call.threadId === "thr_session_startup_repair"),
      true
    );
  } finally {
    await bridge.stop();
  }
});

test("sync includes newer in-progress turn items after the cursor has advanced", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_in_progress",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_in_progress",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    attachMode: "auto",
    threadName: "In-progress sync thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: Date.now(),
    latestMirroredCursor: "0001775369854611:00000489:item-489"
  });

  codex.threadDetails.set("thr_in_progress", {
    id: "thr_in_progress",
    name: "In-progress sync thread",
    preview: "In-progress sync thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "019d61f4-b2f6-78be-a7c1-c98d4c5a1234",
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            id: "item-490",
            content: [{ type: "text", text: "Current prompt" }]
          },
          {
            type: "message",
            id: "item-491",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Current commentary" }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "thread/status/changed",
      params: {
        threadId: "thr_in_progress",
        status: { type: "idle" }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.ok(
      discord.sentTextMessages.some((message) => /Current prompt/.test(message.content))
    );
    assert.ok(
      discord.liveTextMessages.some((message) => /Current commentary/.test(message.content))
    );
  } finally {
    await bridge.stop();
  }
});

test("stable cursors prevent resending old messages when reread timestamps move", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_stable",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_stable",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Stable thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const baseSeconds = Math.floor(Date.now() / 1000);
  codex.threadDetails.set("thr_stable", {
    id: "thr_stable",
    name: "Stable thread",
    preview: "Stable thread",
    modelProvider: null,
    createdAt: baseSeconds,
    updatedAt: baseSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "turn_1",
        createdAt: baseSeconds,
        updatedAt: baseSeconds,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_1",
            createdAt: baseSeconds,
            updatedAt: baseSeconds,
            content: [{ type: "text", text: "Same question" }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });

    codex.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "thr_stable", status: { type: "idle" } }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(discord.sentTextMessages.length, 1);

    codex.threadDetails.set("thr_stable", {
      id: "thr_stable",
      name: "Stable thread",
      preview: "Stable thread",
      modelProvider: null,
      createdAt: baseSeconds,
      updatedAt: baseSeconds + 30,
      ephemeral: false,
      status: { type: "idle" as const },
      turns: [
        {
          id: "turn_1",
          createdAt: baseSeconds,
          updatedAt: baseSeconds + 30,
          status: "completed",
          items: [
            {
              type: "userMessage",
              id: "user_1",
              createdAt: baseSeconds,
              updatedAt: baseSeconds + 30,
              content: [{ type: "text", text: "Same question" }]
            }
          ]
        }
      ]
    });

    codex.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "thr_stable", status: { type: "idle" } }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.equal(discord.sentTextMessages.length, 1);
  } finally {
    await bridge.stop();
  }
});

test("completed turn timestamps do not make older items look new on reread", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  const turnId = "019d7000-1234-7abc-8def-1234567890ab";
  const turnCreatedSeconds = Math.floor(Date.now() / 1000) - 600;
  const turnCompletedSeconds = turnCreatedSeconds + 300;

  store.upsertThreadBridge({
    codexThreadId: "thr_completed_turn",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_completed_turn",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Completed turn thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: turnCreatedSeconds * 1000,
    latestMirroredCursor: `${String(turnCreatedSeconds * 1000).padStart(16, "0")}:00000500:item-500`
  });

  codex.threadDetails.set("thr_completed_turn", {
    id: "thr_completed_turn",
    name: "Completed turn thread",
    preview: "Completed turn thread",
    modelProvider: null,
    createdAt: turnCreatedSeconds,
    updatedAt: turnCompletedSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: turnId,
        createdAt: turnCreatedSeconds,
        completedAt: turnCompletedSeconds,
        status: "completed",
        items: [
          {
            type: "message",
            id: "item-490",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Old commentary from this turn" }]
          },
          {
            type: "message",
            id: "item-500",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Already mirrored final answer" }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "thr_completed_turn", status: { type: "idle" } }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.equal(discord.sentTextMessages.length, 0);
    assert.equal(discord.liveTextMessages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("turn-based cursors prevent resending old messages when items have no explicit timestamps", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_turn_cursor",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_turn_cursor",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Turn cursor thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  codex.threadDetails.set("thr_turn_cursor", {
    id: "thr_turn_cursor",
    name: "Turn cursor thread",
    preview: "Turn cursor thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "019d5c40-9d7c-7e62-9e77-4b37c687a9cc",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "item-422",
            content: [{ type: "text", text: "same question" }]
          },
          {
            type: "agentMessage",
            id: "item-423",
            text: "same answer",
            phase: "final_answer"
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });

    codex.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "thr_turn_cursor", status: { type: "idle" } }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const initialMessageCount = discord.sentTextMessages.length + discord.liveTextMessages.length;
    assert.equal(initialMessageCount, 2);

    codex.threadDetails.set("thr_turn_cursor", {
      id: "thr_turn_cursor",
      name: "Turn cursor thread",
      preview: "Turn cursor thread",
      modelProvider: null,
      createdAt: null,
      updatedAt: Math.floor(Date.now() / 1000),
      ephemeral: false,
      status: { type: "idle" as const },
      turns: [
        {
          id: "019d5c40-9d7c-7e62-9e77-4b37c687a9cc",
          status: "completed",
          items: [
            {
              type: "userMessage",
              id: "item-422",
              content: [{ type: "text", text: "same question" }]
            },
            {
              type: "agentMessage",
              id: "item-423",
              text: "same answer",
              phase: "final_answer"
            }
          ]
        }
      ]
    });

    codex.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "thr_turn_cursor", status: { type: "idle" } }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const finalMessageCount = discord.sentTextMessages.length + discord.liveTextMessages.length;
    assert.equal(finalMessageCount, initialMessageCount);
  } finally {
    await bridge.stop();
  }
});

test("legacy turn fallback cursors do not outrank newer numeric cursors", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "thr_legacy_cursor",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "discord_channel_thr_legacy_cursor",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Legacy cursor thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: 50_000,
    latestMirroredCursor: "0000000000050000:00000050:item-50",
    latestMirroredTurnCursor: "0000000000050000:turn-modern"
  });

  codex.threadDetails.set("thr_legacy_cursor", {
    id: "thr_legacy_cursor",
    name: "Legacy cursor thread",
    preview: "Legacy cursor thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: [
      {
        id: "legacy-turn-without-timestamp",
        status: "completed",
        items: [
          {
            type: "message",
            id: "item-4",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "This old commentary must not replay." }]
          }
        ]
      }
    ]
  });

  try {
    await bridge.start({ skipDiscovery: true });
    codex.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "thr_legacy_cursor", status: { type: "idle" } }
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.doesNotMatch(mirrored, /This old commentary must not replay/);
    assert.equal(discord.sentTextMessages.length, 0);
    assert.equal(discord.liveTextMessages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("after the first run, discovery auto-attaches active or freshly updated threads only", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "existing_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_existing",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Existing thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "idle_thread",
      name: "Idle thread",
      preview: "Idle thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    },
    {
      id: "stale_idle_thread",
      name: "Stale idle thread",
      preview: "Stale idle thread",
      modelProvider: null,
      createdAt: nowSeconds - 3600,
      updatedAt: nowSeconds - 3600,
      ephemeral: false,
      status: { type: "idle" as const }
    },
    {
      id: "active_thread",
      name: "Active thread",
      preview: "Active thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ] as any;
  codex.metadata.set("active_thread", { cwd: "C:\\repo", repoName: "repo" });
  codex.metadata.set("idle_thread", { cwd: "C:\\repo", repoName: "repo" });
  codex.metadata.set("stale_idle_thread", { cwd: "C:\\repo", repoName: "repo" });

  try {
    await bridge.start();

    assert.ok(store.getThreadBridge("active_thread"));
    assert.ok(store.getThreadBridge("idle_thread"));
    assert.equal(store.getThreadBridge("stale_idle_thread"), undefined);
  } finally {
    await bridge.stop();
  }
});

test("discovery skips unchanged active mapped app-server threads after they are already hydrated", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  const lastSeenAt = new Date(nowSeconds * 1000).toISOString();
  store.upsertThreadBridge({
    codexThreadId: "active_mapped_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_active_mapped",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt,
    attachMode: "auto",
    threadName: "Active mapped thread",
    lastStatusType: "active",
    channelKind: "conversation"
  });
  const activeSummary = {
    id: "active_mapped_thread",
    name: "Active mapped thread",
    preview: "Active mapped thread",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] }
  };
  codex.threads = [activeSummary] as any;
  codex.metadata.set("active_mapped_thread", { cwd: "C:\\repo", repoName: "repo" });

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).maybeAttachThread(
      {
        summary: activeSummary,
        source: "app-server"
      },
      false,
      true
    );
    assert.deepEqual(codex.resumedThreadIds, ["active_mapped_thread"]);

    codex.resumedThreadIds = [];
    await (bridge as any).runDiscoveryCycleInternal(false);

    assert.deepEqual(codex.resumedThreadIds, []);
  } finally {
    await bridge.stop();
  }
});

test("discovery auto-attaches recent CLI session threads even when app-server does not list them", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    policy: new Policy({
      allowFromDiscord: false,
      allowedUserIds: [],
      mentionApprovers: false
    }),
    runtimeConfig: createBridgeConfigFromPreset(
      "basic",
      {
        allowFromDiscord: false,
        allowedUserIds: [],
      }
    ),
    sessionEventTailer: sessionTailer as never
  });

  const nowMs = Date.now();
  sessionTailer.setCliThreads([
    {
      threadId: "cli_thread_1",
      name: "CLI discovered thread",
      preview: "CLI discovered thread",
      cwd: "C:\\Users\\Natale\\Desktop\\projects\\test-codex-cli",
      repoName: "test-codex-cli",
      createdAtMs: nowMs - 30_000,
      updatedAtMs: nowMs - 2_000,
      status: "idle",
      filePath: "C:\\Users\\Natale\\.codex\\sessions\\cli_thread_1.jsonl"
    }
  ]);
  codex.metadata.set("cli_thread_1", {
    cwd: "C:\\Users\\Natale\\Desktop\\projects\\test-codex-cli",
    repoName: "test-codex-cli"
  });
  codex.threadDetails.set("cli_thread_1", {
    id: "cli_thread_1",
    name: null,
    preview: "CLI discovered thread",
    modelProvider: null,
    createdAt: Math.floor((nowMs - 30_000) / 1000),
    updatedAt: Math.floor((nowMs - 2_000) / 1000),
    ephemeral: false,
    status: { type: "idle" as const },
    turns: []
  });

  try {
    await bridge.start();

    const mapped = store.getThreadBridge("cli_thread_1");
    assert.ok(mapped);
    assert.equal(mapped?.projectName, "test-codex-cli");
    assert.equal(mapped?.sourceKind, "cli-session");
    assert.deepEqual(codex.resumedThreadIds, []);
    assert.ok(discord.conversationChannelIds.has("discord_channel_cli_thread_1"));
  } finally {
    await bridge.stop();
  }
});

test("discovery preserves CLI source when app-server also lists the same local CLI session", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, bridge } = createBridgeTestRig({
    policy: new Policy({
      allowFromDiscord: false,
      allowedUserIds: [],
      mentionApprovers: false
    }),
    sourceKinds: ["vscode", "cli"],
    runtimeConfig: createBridgeConfigFromPreset(
      "basic",
      {
        allowFromDiscord: false,
        allowedUserIds: [],
      }
    ),
    sessionEventTailer: sessionTailer as never
  });

  const nowMs = Date.now();
  codex.threads = [
    {
      id: "cli_thread_duplicate",
      name: "App-server duplicate title",
      preview: "App-server duplicate title",
      modelProvider: null,
      createdAt: Math.floor((nowMs - 30_000) / 1000),
      updatedAt: Math.floor(nowMs / 1000),
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  sessionTailer.setCliThreads([
    {
      threadId: "cli_thread_duplicate",
      name: "CLI local title",
      preview: "CLI local title",
      cwd: "C:\\Users\\Natale\\Desktop\\projects\\test-codex-cli",
      repoName: "test-codex-cli",
      createdAtMs: nowMs - 30_000,
      updatedAtMs: nowMs - 2_000,
      status: "idle",
      filePath: "C:\\Users\\Natale\\.codex\\sessions\\cli_thread_duplicate.jsonl"
    }
  ]);
  codex.metadata.set("cli_thread_duplicate", {
    cwd: "C:\\Users\\Natale\\Desktop\\projects\\test-codex-cli",
    repoName: "test-codex-cli",
    threadName: "App-server metadata title"
  });

  try {
    await bridge.start();
    const mapped = store.getThreadBridge("cli_thread_duplicate");
    assert.ok(mapped);
    assert.equal(mapped?.sourceKind, "cli-session");
    assert.equal(mapped?.threadName, "CLI local title");
  } finally {
    await bridge.stop();
  }
});

test("discovery allowedThreadIds scopes startup attach to the configured runner thread", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    policy: new Policy({
      allowFromDiscord: false,
      allowedUserIds: [],
      mentionApprovers: false
    }),
    sourceKinds: ["vscode", "cli"],
    runtimeConfig: createBridgeConfigFromPreset(
      "basic",
      {
        allowFromDiscord: false,
        allowedUserIds: [],
      },
      {
        discovery: {
          allowedThreadIds: ["target_thread"],
          projectNamePrefix: "e2e-scope"
        }
      }
    ),
    sessionEventTailer: sessionTailer as never
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "target_thread",
      name: "Target thread",
      preview: "Target thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    },
    {
      id: "other_thread",
      name: "Other thread",
      preview: "Other thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ] as any;
  codex.metadata.set("target_thread", {
    cwd: "C:\\repo",
    repoName: "repo"
  });
  codex.metadata.set("other_thread", {
    cwd: "C:\\repo",
    repoName: "repo"
  });

  try {
    await bridge.start();

    const mappedTarget = store.getThreadBridge("target_thread");
    assert.ok(mappedTarget);
    assert.equal(mappedTarget?.projectName, "e2e-scope repo");
    assert.equal(mappedTarget?.projectKey, "e2e-scope::c:\\repo");
    assert.equal(store.getThreadBridge("other_thread"), undefined);
    assert.ok(discord.conversationChannelIds.has("discord_channel_target_thread"));
    assert.ok(!discord.conversationChannelIds.has("discord_channel_other_thread"));
  } finally {
    await bridge.stop();
  }
});

test("startup discovery skips stale local subagent threads whose parent no longer retains the spawning turn", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    policy: new Policy({
      allowFromDiscord: false,
      allowedUserIds: [],
      mentionApprovers: false
    }),
    runtimeConfig: createBridgeConfigFromPreset(
      "basic",
      {
        allowFromDiscord: false,
        allowedUserIds: [],
      },
      {
        retention: {
          maxTurnsPerThread: 2
        }
      }
    ),
    sessionEventTailer: sessionTailer as never
  });

  const nowMs = Date.now();
  codex.threads = [
    {
      id: "parent_thread_startup",
      name: "Parent startup thread",
      preview: "Parent startup thread",
      modelProvider: null,
      createdAt: Math.floor((nowMs - 60_000) / 1000),
      updatedAt: Math.floor(nowMs / 1000),
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ] as any;
  codex.metadata.set("parent_thread_startup", {
    cwd: "C:\\repo",
    repoName: "repo"
  });
  codex.threadDetails.set("parent_thread_startup", {
    id: "parent_thread_startup",
    name: "Parent startup thread",
    preview: "Parent startup thread",
    modelProvider: null,
    createdAt: Math.floor((nowMs - 60_000) / 1000),
    updatedAt: Math.floor(nowMs / 1000),
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  sessionTailer.setLocalThreads([
    {
      threadId: "stale_subagent_startup",
      name: "Stale subagent",
      preview: "Stale subagent",
      cwd: "C:\\repo",
      repoName: "repo",
      createdAtMs: nowMs - 20 * 60_000,
      updatedAtMs: nowMs - 10 * 60_000,
      status: "idle",
      filePath: "C:\\Users\\Natale\\.codex\\sessions\\stale_subagent_startup.jsonl",
      sourceKind: "cli-session",
      parentThreadId: "parent_thread_startup",
      actorName: "Halley"
    }
  ]);
  sessionTailer.setLatestTurnBackfillEvents("parent_thread_startup", [
    {
      type: "sessionUserMessage",
      threadId: "parent_thread_startup",
      turnId: "turn_recent_parent_1",
      timestampMs: nowMs - 5_000,
      text: "Recent retained prompt 1"
    },
    {
      type: "sessionAgentMessage",
      threadId: "parent_thread_startup",
      turnId: "turn_recent_parent_1",
      timestampMs: nowMs - 4_000,
      text: "Recent retained answer 1",
      phase: "final_answer"
    },
    {
      type: "sessionUserMessage",
      threadId: "parent_thread_startup",
      turnId: "turn_recent_parent_2",
      timestampMs: nowMs - 3_000,
      text: "Recent retained prompt 2"
    },
    {
      type: "sessionAgentMessage",
      threadId: "parent_thread_startup",
      turnId: "turn_recent_parent_2",
      timestampMs: nowMs - 2_000,
      text: "Recent retained answer 2",
      phase: "final_answer"
    }
  ]);

  try {
    await bridge.start();

    assert.ok(store.getThreadBridge("parent_thread_startup"));
    assert.equal(store.getThreadBridge("stale_subagent_startup"), undefined);
    assert.equal(discord.threadChannelIds.size, 0);
  } finally {
    await bridge.stop();
  }
});

test("live discovery does not attach a new subagent thread without an anchored parent-turn event", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    policy: new Policy({
      allowFromDiscord: false,
      allowedUserIds: [],
      mentionApprovers: false
    }),
    sessionEventTailer: sessionTailer as never
  });

  const nowMs = Date.now();
  store.upsertThreadBridge({
    codexThreadId: "parent_thread_live_discovery",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_parent_thread_live_discovery",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(nowMs - 10_000).toISOString(),
    attachMode: "auto",
    threadName: "Parent thread",
    actorName: "Codex",
    lastStatusType: "active",
    channelKind: "conversation"
  });

  codex.threads = [
    {
      id: "parent_thread_live_discovery",
      name: "Parent thread",
      preview: "Parent thread",
      modelProvider: null,
      createdAt: Math.floor((nowMs - 60_000) / 1000),
      updatedAt: Math.floor(nowMs / 1000),
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ] as any;
  codex.metadata.set("parent_thread_live_discovery", {
    cwd: "C:\\repo",
    repoName: "repo"
  });
  codex.threadDetails.set("parent_thread_live_discovery", {
    id: "parent_thread_live_discovery",
    name: "Parent thread",
    preview: "Parent thread",
    modelProvider: null,
    createdAt: Math.floor((nowMs - 60_000) / 1000),
    updatedAt: Math.floor(nowMs / 1000),
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  sessionTailer.setLocalThreads([
    {
      threadId: "live_subagent_without_anchor",
      name: "Sartre",
      preview: "Sartre",
      cwd: "C:\\repo",
      repoName: "repo",
      createdAtMs: nowMs - 30_000,
      updatedAtMs: nowMs - 5_000,
      status: "active",
      filePath: "C:\\Users\\Natale\\.codex\\sessions\\live_subagent_without_anchor.jsonl",
      sourceKind: "cli-session",
      parentThreadId: "parent_thread_live_discovery",
      actorName: "Sartre"
    }
  ]);

  try {
    await bridge.start({ skipDiscovery: true });
    await (bridge as any).runDiscoveryCycleInternal(false);

    assert.equal(store.getThreadBridge("live_subagent_without_anchor"), undefined);
    assert.equal(discord.threadChannelIds.size, 0);
  } finally {
    await bridge.stop();
  }
});

test("startup discovery skips stale local subagent threads whose spawn turn is not among the parent's retained mirrored turns", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    policy: new Policy({
      allowFromDiscord: false,
      allowedUserIds: [],
      mentionApprovers: false
    }),
    runtimeConfig: createBridgeConfigFromPreset(
      "basic",
      {
        allowFromDiscord: false,
        allowedUserIds: [],
      },
      {
        retention: {
          maxTurnsPerThread: 2
        }
      }
    ),
    sessionEventTailer: sessionTailer as never
  });

  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  codex.threads = [
    {
      id: "parent_thread_retained_window",
      name: "Parent retained window",
      preview: "Parent retained window",
      modelProvider: null,
      createdAt: Math.floor((nowMs - 60_000) / 1000),
      updatedAt: Math.floor(nowMs / 1000),
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ] as any;
  codex.metadata.set("parent_thread_retained_window", {
    cwd: "C:\\repo",
    repoName: "repo"
  });
  codex.threadDetails.set("parent_thread_retained_window", {
    id: "parent_thread_retained_window",
    name: "Parent retained window",
    preview: "Parent retained window",
    modelProvider: null,
    createdAt: Math.floor((nowMs - 60_000) / 1000),
    updatedAt: Math.floor(nowMs / 1000),
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_parent_older_stale",
        createdAt: nowSeconds - 180,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_parent_older_stale",
            createdAt: nowSeconds - 180,
            content: [{ type: "text", text: "Stale parent prompt" }]
          },
          {
            type: "message",
            id: "assistant_parent_older_stale",
            role: "assistant",
            phase: "final_answer",
            createdAt: nowSeconds - 179,
            content: [{ type: "output_text", text: "Stale parent answer" }]
          }
        ]
      },
      {
        id: "turn_parent_middle_retained",
        createdAt: nowSeconds - 120,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_parent_middle_retained",
            createdAt: nowSeconds - 120,
            content: [{ type: "text", text: "Retained parent prompt 1" }]
          },
          {
            type: "message",
            id: "assistant_parent_middle_retained",
            role: "assistant",
            phase: "final_answer",
            createdAt: nowSeconds - 119,
            content: [{ type: "output_text", text: "Retained parent answer 1" }]
          }
        ]
      },
      {
        id: "turn_parent_latest_retained",
        createdAt: nowSeconds - 60,
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user_parent_latest_retained",
            createdAt: nowSeconds - 60,
            content: [{ type: "text", text: "Retained parent prompt 2" }]
          },
          {
            type: "message",
            id: "assistant_parent_latest_retained",
            role: "assistant",
            phase: "final_answer",
            createdAt: nowSeconds - 59,
            content: [{ type: "output_text", text: "Retained parent answer 2" }]
          }
        ]
      }
    ]
  });

  sessionTailer.setLocalThreads([
    {
      threadId: "stale_child_omitted_turn",
      name: "Arendt",
      preview: "Arendt",
      cwd: "C:\\repo",
      repoName: "repo",
      createdAtMs: nowMs - 20 * 60_000,
      updatedAtMs: nowMs - 10 * 60_000,
      status: "idle",
      filePath: "C:\\Users\\Natale\\.codex\\sessions\\stale-child-omitted-turn.jsonl",
      sourceKind: "app-server",
      parentThreadId: "parent_thread_retained_window",
      actorName: "Arendt"
    }
  ]);
  sessionTailer.setLatestTurnBackfillEvents("parent_thread_retained_window", [
    {
      type: "sessionUserMessage",
      threadId: "parent_thread_retained_window",
      turnId: "turn_parent_older_stale",
      timestampMs: nowMs - 180_000,
      text: "Stale parent prompt"
    },
    {
      type: "sessionSubagentSpawned",
      threadId: "parent_thread_retained_window",
      turnId: "turn_parent_older_stale",
      childThreadId: "stale_child_omitted_turn",
      childAgentName: "Arendt",
      prompt: "Inspect the stale child thread",
      timestampMs: nowMs - 179_000
    },
    {
      type: "sessionUserMessage",
      threadId: "parent_thread_retained_window",
      turnId: "turn_parent_latest_retained",
      timestampMs: nowMs - 60_000,
      text: "Retained parent prompt 2"
    },
    {
      type: "sessionAgentMessage",
      threadId: "parent_thread_retained_window",
      turnId: "turn_parent_latest_retained",
      timestampMs: nowMs - 59_000,
      text: "Retained parent answer 2",
      phase: "final_answer"
    }
  ]);

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Retained parent prompt 1/);
    assert.match(mirrored, /Retained parent answer 1/);
    assert.match(mirrored, /Retained parent prompt 2/);
    assert.match(mirrored, /Retained parent answer 2/);
    assert.doesNotMatch(mirrored, /Stale parent prompt/);
    assert.equal(store.getThreadBridge("stale_child_omitted_turn"), undefined);
    assert.equal(discord.threadChannelIds.size, 0);
  } finally {
    await bridge.stop();
  }
});

test("startup refresh prunes stale mapped subagent threads from older turns even when they still have old approvals", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig({
    policy: new Policy({
      allowFromDiscord: false,
      allowedUserIds: [],
      mentionApprovers: false
    }),
    runtimeConfig: createBridgeConfigFromPreset(
      "basic",
      {
        allowFromDiscord: false,
        allowedUserIds: [],
      },
      {
        retention: {
          maxTurnsPerThread: 2
        }
      }
    )
  });

  const nowMs = Date.now();
  const oldMs = nowMs - 20 * 60_000;

  store.upsertThreadBridge({
    codexThreadId: "startup_parent_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_startup_parent_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(nowMs).toISOString(),
    attachMode: "auto",
    threadName: "Startup parent",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  store.upsertMirroredItem({
    threadId: "startup_parent_thread",
    itemId: "parent_turn_002_user",
    turnId: "turn-parent-002",
    kind: "user",
    discordMessageId: "msg_parent_turn_002_user",
    groupKey: "turn-parent-002",
    contentSignature: "Retained parent prompt 2",
    renderedContent: "Retained parent prompt 2",
    timestampMs: nowMs - 5_000,
    cursor: `${String(nowMs - 5_000).padStart(16, "0")}:00000001:parent_turn_002_user`,
    turnCursor: `${String(nowMs - 5_000).padStart(16, "0")}:turn-parent-002`,
    updatedAt: new Date(nowMs - 5_000).toISOString()
  });
  store.upsertMirroredItem({
    threadId: "startup_parent_thread",
    itemId: "parent_turn_003_user",
    turnId: "turn-parent-003",
    kind: "user",
    discordMessageId: "msg_parent_turn_003_user",
    groupKey: "turn-parent-003",
    contentSignature: "Retained parent prompt 3",
    renderedContent: "Retained parent prompt 3",
    timestampMs: nowMs - 2_000,
    cursor: `${String(nowMs - 2_000).padStart(16, "0")}:00000001:parent_turn_003_user`,
    turnCursor: `${String(nowMs - 2_000).padStart(16, "0")}:turn-parent-003`,
    updatedAt: new Date(nowMs - 2_000).toISOString()
  });

  store.upsertThreadBridge({
    codexThreadId: "startup_child_old_pending",
    parentCodexThreadId: "startup_parent_thread",
    parentAnchorTurnId: null,
    parentAnchorTurnCursor: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_thread_startup_child_old_pending",
    discordParentChannelId: "discord_channel_startup_parent_thread",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(oldMs).toISOString(),
    attachMode: "auto",
    threadName: "Tesla",
    actorName: "Tesla",
    lastStatusType: "idle",
    channelKind: "subagent"
  });
  discord.seedThreadStarterNotification(
    "discord_thread_startup_child_old_pending",
    "discord_msg_thread_started_startup_child_old_pending"
  );

  store.upsertThreadBridge({
    codexThreadId: "startup_child_old_active",
    parentCodexThreadId: "startup_parent_thread",
    parentAnchorTurnId: null,
    parentAnchorTurnCursor: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_thread_startup_child_old_active",
    discordParentChannelId: "discord_channel_startup_parent_thread",
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(oldMs - 5_000).toISOString(),
    attachMode: "auto",
    threadName: "Mencius",
    actorName: "Mencius",
    lastStatusType: "active",
    channelKind: "subagent"
  });
  discord.seedThreadStarterNotification(
    "discord_thread_startup_child_old_active",
    "discord_msg_thread_started_startup_child_old_active"
  );

  store.upsertPendingApproval({
    token: "startup_pending_child_token",
    requestId: "session-log:call_startup_pending_child",
    threadId: "startup_child_old_pending",
    turnId: "turn-child-stale-pending",
    itemId: "call_startup_pending_child",
    kind: "commandExecution",
    sanitizedPreview: "Start-Process https://example.com/?probe=stale-startup-pending",
    cwd: "C:\\repo",
    reason: "Stale pending approval",
    availableDecisions: [],
    decisionPayloads: {},
    expiresAt: new Date(oldMs + 30_000).toISOString(),
    discordMessageId: "approval_msg_stale_startup_pending",
    status: "pending",
    details: "{}",
    createdAt: new Date(oldMs).toISOString()
  });
  store.upsertPendingApproval({
    token: "startup_expired_child_token",
    requestId: "session-log:call_startup_expired_child",
    threadId: "startup_child_old_active",
    turnId: "turn-child-stale-expired",
    itemId: "call_startup_expired_child",
    kind: "commandExecution",
    sanitizedPreview: "Start-Process https://example.com/?probe=stale-startup-expired",
    cwd: "C:\\repo",
    reason: "Stale expired approval",
    availableDecisions: [],
    decisionPayloads: {},
    expiresAt: new Date(oldMs - 30_000).toISOString(),
    discordMessageId: "approval_msg_stale_startup_expired",
    status: "expired",
    details: "{}",
    createdAt: new Date(oldMs - 60_000).toISOString()
  });

  const nowSeconds = Math.floor(nowMs / 1000);
  const oldSeconds = Math.floor(oldMs / 1000);
  codex.threads = [
    {
      id: "startup_parent_thread",
      name: "Startup parent",
      preview: "Startup parent",
      modelProvider: null,
      createdAt: nowSeconds - 600,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    },
    {
      id: "startup_child_old_pending",
      name: "Tesla",
      preview: "Tesla",
      modelProvider: null,
      createdAt: oldSeconds - 60,
      updatedAt: oldSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    },
    {
      id: "startup_child_old_active",
      name: "Mencius",
      preview: "Mencius",
      modelProvider: null,
      createdAt: oldSeconds - 120,
      updatedAt: oldSeconds - 30,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ] as any;

  codex.metadata.set("startup_parent_thread", { cwd: "C:\\repo", repoName: "repo" });
  codex.metadata.set("startup_child_old_pending", {
    cwd: "C:\\repo",
    repoName: "repo",
    parentThreadId: "startup_parent_thread",
    actorName: "Tesla"
  });
  codex.metadata.set("startup_child_old_active", {
    cwd: "C:\\repo",
    repoName: "repo",
    parentThreadId: "startup_parent_thread",
    actorName: "Mencius"
  });

  codex.threadDetails.set("startup_parent_thread", {
    id: "startup_parent_thread",
    name: "Startup parent",
    preview: "Startup parent",
    modelProvider: null,
    createdAt: nowSeconds - 600,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: []
  });
  codex.threadDetails.set("startup_child_old_pending", {
    id: "startup_child_old_pending",
    name: "Tesla",
    preview: "Tesla",
    modelProvider: null,
    createdAt: oldSeconds - 60,
    updatedAt: oldSeconds,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: []
  });
  codex.threadDetails.set("startup_child_old_active", {
    id: "startup_child_old_active",
    name: "Mencius",
    preview: "Mencius",
    modelProvider: null,
    createdAt: oldSeconds - 120,
    updatedAt: oldSeconds - 30,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  try {
    await bridge.start();

    assert.ok(store.getThreadBridge("startup_parent_thread"));
    assert.equal(store.getThreadBridge("startup_child_old_pending"), undefined);
    assert.equal(store.getThreadBridge("startup_child_old_active"), undefined);
    assert.equal(store.findPendingApprovalByToken("startup_pending_child_token"), undefined);
    assert.equal(store.findPendingApprovalByToken("startup_expired_child_token"), undefined);
    assert.ok(discord.deletedLocationIds.includes("discord_thread_startup_child_old_pending"));
    assert.ok(discord.deletedLocationIds.includes("discord_thread_startup_child_old_active"));
    assert.ok(discord.deletedMessageIds.includes("discord_msg_thread_started_startup_child_old_pending"));
    assert.ok(discord.deletedMessageIds.includes("discord_msg_thread_started_startup_child_old_active"));
  } finally {
    await bridge.stop();
  }
});

test("startup fast-forwards local logs for existing mapped threads so old shell events are not replayed", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: sessionTailer as never
  });

  const now = new Date().toISOString();
  store.upsertThreadBridge({
    codexThreadId: "existing_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_existing",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: now,
    attachMode: "auto",
    threadName: "Existing thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: Date.now(),
    latestMirroredCursor: "0001775457000000:item-999"
  });

  sessionTailer.setEvents("existing_thread", [
    {
      type: "shellCommandCompleted",
      threadId: "existing_thread",
      callId: "old-call-1",
      timestampMs: Date.now() - 30 * 60 * 1000,
      command: "Get-Content old.txt",
      cwd: "C:\\repo",
      output: "",
      status: "completed"
    }
  ]);

  try {
    await bridge.start();

    assert.deepEqual(sessionTailer.fastForwardedThreadIds, ["existing_thread"]);
    assert.equal(sessionTailer.desktopFastForwardCount, 1);
    assert.equal(discord.liveTextMessages.length, 0);
    assert.equal(discord.sentTextMessages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("startup backfill inserts an explicit skip notice when session-log history is truncated", async () => {
  const tailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never,
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        startupBackfill: {
          leadingEventBudget: 2,
          trailingEventBudget: 2
        },
        retention: {
          maxTurnsPerThread: 1
        }
      }
    )
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_truncated_session_log",
      name: "Startup truncated session log",
      preview: "Startup truncated session log",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_startup_truncated_session_log", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_startup_truncated_session_log", {
    id: "thr_startup_truncated_session_log",
    name: "Startup truncated session log",
    preview: "Startup truncated session log",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  tailer.setLatestTurnBackfillEvents("thr_startup_truncated_session_log", [
    {
      type: "sessionUserMessage",
      threadId: "thr_startup_truncated_session_log",
      turnId: "turn_startup_truncated_session_log",
      itemId: "session_user_truncated_session_log",
      timestampMs: Date.now(),
      text: "Please continue the startup-recovered conversation."
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_truncated_session_log",
      turnId: "turn_startup_truncated_session_log",
      itemId: "session_agent_head_one",
      timestampMs: Date.now() + 1,
      text: "Head event 1 should be kept.",
      phase: "final_answer"
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_truncated_session_log",
      turnId: "turn_startup_truncated_session_log",
      itemId: "session_agent_head_two",
      timestampMs: Date.now() + 2,
      text: "Head event 2 should be kept.",
      phase: "final_answer"
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_truncated_session_log",
      turnId: "turn_startup_truncated_session_log",
      itemId: "session_agent_middle_one",
      timestampMs: Date.now() + 3,
      text: "Middle event 1 should be skipped.",
      phase: "final_answer"
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_truncated_session_log",
      turnId: "turn_startup_truncated_session_log",
      itemId: "session_agent_middle_two",
      timestampMs: Date.now() + 4,
      text: "Middle event 2 should be skipped.",
      phase: "final_answer"
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_truncated_session_log",
      turnId: "turn_startup_truncated_session_log",
      itemId: "session_agent_tail_one",
      timestampMs: Date.now() + 5,
      text: "Tail event 1 should be kept.",
      phase: "final_answer"
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_truncated_session_log",
      turnId: "turn_startup_truncated_session_log",
      itemId: "session_agent_tail_two",
      timestampMs: Date.now() + 6,
      text: "Tail event 2 should be kept.",
      phase: "final_answer"
    }
  ]);

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Please continue the startup-recovered conversation/);
    assert.match(mirrored, /Head event 1 should be kept/);
    assert.match(mirrored, /Head event 2 should be kept/);
    assert.match(mirrored, /Tail event 1 should be kept/);
    assert.match(mirrored, /Tail event 2 should be kept/);
    assert.match(mirrored, /Startup backfill skipped about 2 intermediate events in this turn/);
    assert.doesNotMatch(mirrored, /Middle event 1 should be skipped/);
    assert.doesNotMatch(mirrored, /Middle event 2 should be skipped/);

    const mirroredItems = store.listMirroredItems("thr_startup_truncated_session_log");
    const startupNotice = mirroredItems.find((record) => record.itemId.startsWith("startup-backfill-gap:"));
    assert.ok(startupNotice);
    assert.equal(startupNotice.turnCursor, "turn:turn_startup_truncated_session_log");
    assert.ok(
      mirroredItems.some(
        (record) =>
          record.kind === "user" &&
          /Please continue the startup-recovered conversation\./.test(record.renderedContent)
      )
    );
  } finally {
    await bridge.stop();
  }
});

test("startup attach replays same-turn live session events that land during startup backfill", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: sessionTailer as never,
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        startupBackfill: {
          leadingEventBudget: 20,
          trailingEventBudget: 20
        }
      }
    )
  });

  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const threadId = "thr_startup_live_handoff";
  const turnId = "turn_startup_live_handoff";
  const sessionFilePath = "C:\\Users\\Natale\\.codex\\sessions\\startup-live-handoff.jsonl";
  codex.threads = [
    {
      id: threadId,
      name: "Startup live handoff",
      preview: "Startup live handoff",
      modelProvider: null,
      createdAt: nowSeconds - 60,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set(threadId, { cwd: "C:\\repo", repoName: "repo" });
  codex.threadDetails.set(threadId, {
    id: threadId,
    name: "Startup live handoff",
    preview: "Startup live handoff",
    modelProvider: null,
    createdAt: nowSeconds - 60,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });
  sessionTailer.setLocalThreads([
    {
      threadId,
      name: "Startup live handoff",
      preview: "Startup live handoff",
      cwd: "C:\\repo",
      repoName: "repo",
      createdAtMs: now - 60_000,
      updatedAtMs: now,
      status: "active",
      filePath: sessionFilePath,
      sourceKind: "app-server",
      parentThreadId: null,
      actorName: null
    }
  ]);
  sessionTailer.setCapturedFrontier(threadId, {
    filePath: sessionFilePath,
    offset: 1024
  });
  sessionTailer.setLatestTurnBackfillEvents(threadId, [
    {
      type: "sessionUserMessage",
      threadId,
      turnId,
      timestampMs: now - 5_000,
      text: "Please rerun the live test from this current turn.",
      sourceFilePath: sessionFilePath,
      sourceOffset: 900,
      sourceOrder: "0000000000000900:0000",
      eventKey: "line:900:0"
    },
    {
      type: "sessionAgentMessage",
      threadId,
      turnId,
      timestampMs: now - 4_800,
      text: "Historical startup backfill commentary should stay in its own historical Discord block.",
      phase: "commentary",
      sourceFilePath: sessionFilePath,
      sourceOffset: 901,
      sourceOrder: "0000000000000901:0000",
      eventKey: "line:901:0"
    },
    {
      type: "shellCommandCompleted",
      threadId,
      callId: "call_startup_backfill_history",
      turnId,
      timestampMs: now - 4_600,
      command: "Get-Process -Id 12345",
      cwd: "C:\\repo",
      output: "Handles  NPM(K)    PM(K)",
      status: "completed",
      sourceFilePath: sessionFilePath,
      sourceOffset: 902,
      sourceOrder: "0000000000000902:0000",
      eventKey: "line:902:0"
    }
  ]);
  sessionTailer.setEvents(threadId, [
    {
      type: "sessionAgentMessage",
      threadId,
      turnId,
      timestampMs: now - 4_000,
      text: "This commentary landed during startup recovery and must not be skipped.",
      phase: "commentary",
      sourceFilePath: sessionFilePath,
      sourceOffset: 1025,
      sourceOrder: "0000000000001025:0000",
      eventKey: "line:1025:0"
    },
    {
      type: "shellCommandCompleted",
      threadId,
      callId: "call_startup_live_handoff",
      turnId,
      timestampMs: now - 3_000,
      command: "Get-Date -Format o",
      cwd: "C:\\repo",
      output: "2026-04-20T10:00:00.0000000+02:00",
      status: "completed",
      sourceFilePath: sessionFilePath,
      sourceOffset: 1026,
      sourceOrder: "0000000000001026:0000",
      eventKey: "line:1026:0"
    }
  ]);

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    const commentaryCreateIds = new Set(
      discord.liveTextMessages
        .filter(
          (message) =>
            message.action === "create" &&
            (/Historical startup backfill commentary/.test(message.content) ||
              /This commentary landed during startup recovery and must not be skipped\./.test(message.content))
        )
        .map((message) => message.messageId)
    );
    const commandSummaryCreateIds = new Set(
      discord.liveTextMessages
        .filter((message) => message.action === "create" && /Ran 1 command/.test(message.content))
        .map((message) => message.messageId)
    );
    assert.ok(sessionTailer.replayedFrontierThreadIds.includes(threadId));
    assert.match(mirrored, /Please rerun the live test from this current turn/);
    assert.match(mirrored, /Historical startup backfill commentary should stay in its own historical Discord block/);
    assert.match(mirrored, /This commentary landed during startup recovery and must not be skipped/);
    assert.match(mirrored, /Ran 1 command/);
    assert.equal(
      commentaryCreateIds.size,
      2,
      "startup-window live commentary should create a fresh Discord message instead of editing the historical backfill block"
    );
    assert.equal(
      commandSummaryCreateIds.size,
      2,
      "startup backfill and startup-window live command activity should each create their own summary message under summary mode"
    );
    assert.equal(
      discord.liveTextMessages.filter((message) => message.action === "edit" && /Ran 1 command/.test(message.content)).length,
      0,
      "startup-window live command activity should not edit an earlier historical backfill block"
    );
  } finally {
    await bridge.stop();
  }
});

test("startup backfill inserts an explicit skip notice when thread/read fallback is truncated", async () => {
  const tailer = new FakeSessionEventTailer();
  const { codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never,
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        startupBackfill: {
          leadingEventBudget: 1,
          trailingEventBudget: 1
        }
      }
    )
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_truncated_thread_read",
      name: "Startup truncated thread/read",
      preview: "Startup truncated thread/read",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_startup_truncated_thread_read", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_startup_truncated_thread_read", {
    id: "thr_startup_truncated_thread_read",
    name: "Startup truncated thread/read",
    preview: "Startup truncated thread/read",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: [
      {
        id: "turn_startup_truncated_thread_read",
        status: "completed",
        items: [
          {
            id: "turn_read_user_anchor",
            type: "userMessage",
            text: "Please resume from the retained Codex snapshot."
          },
          {
            id: "turn_read_head_answer",
            type: "agentMessage",
            phase: "final_answer",
            text: "Head fallback event should be kept."
          },
          {
            id: "turn_read_middle_answer_one",
            type: "agentMessage",
            phase: "final_answer",
            text: "Middle fallback event 1 should be skipped."
          },
          {
            id: "turn_read_middle_answer_two",
            type: "agentMessage",
            phase: "final_answer",
            text: "Middle fallback event 2 should be skipped."
          },
          {
            id: "turn_read_tail_answer",
            type: "agentMessage",
            phase: "final_answer",
            text: "Tail fallback event should be kept."
          }
        ]
      }
    ]
  });

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Please resume from the retained Codex snapshot/);
    assert.match(mirrored, /Head fallback event should be kept/);
    assert.match(mirrored, /Tail fallback event should be kept/);
    assert.match(mirrored, /Startup backfill skipped about 2 intermediate events in this turn/);
    assert.doesNotMatch(mirrored, /Middle fallback event 1 should be skipped/);
    assert.doesNotMatch(mirrored, /Middle fallback event 2 should be skipped/);
  } finally {
    await bridge.stop();
  }
});

test("startup backfill notice uses remaining-events wording when no trailing events are retained", async () => {
  const tailer = new FakeSessionEventTailer();
  const { codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: tailer as never,
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        startupBackfill: {
          leadingEventBudget: 1,
          trailingEventBudget: 0
        }
      }
    )
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "thr_startup_tail_omitted",
      name: "Startup tail omitted",
      preview: "Startup tail omitted",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ];
  codex.metadata.set("thr_startup_tail_omitted", { cwd: "C:\\write", repoName: "write" });
  codex.threadDetails.set("thr_startup_tail_omitted", {
    id: "thr_startup_tail_omitted",
    name: "Startup tail omitted",
    preview: "Startup tail omitted",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  tailer.setLatestTurnBackfillEvents("thr_startup_tail_omitted", [
    {
      type: "sessionUserMessage",
      threadId: "thr_startup_tail_omitted",
      turnId: "turn_startup_tail_omitted",
      itemId: "session_user_tail_omitted",
      timestampMs: Date.now(),
      text: "Please continue from the retained startup context."
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_tail_omitted",
      turnId: "turn_startup_tail_omitted",
      itemId: "session_agent_head_tail_omitted",
      timestampMs: Date.now() + 1,
      text: "Only this head event should be retained.",
      phase: "final_answer"
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_tail_omitted",
      turnId: "turn_startup_tail_omitted",
      itemId: "session_agent_omitted_one",
      timestampMs: Date.now() + 2,
      text: "Omitted event 1.",
      phase: "final_answer"
    },
    {
      type: "sessionAgentMessage",
      threadId: "thr_startup_tail_omitted",
      turnId: "turn_startup_tail_omitted",
      itemId: "session_agent_omitted_two",
      timestampMs: Date.now() + 3,
      text: "Omitted event 2.",
      phase: "final_answer"
    }
  ]);

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.match(mirrored, /Please continue from the retained startup context/);
    assert.match(mirrored, /Only this head event should be retained/);
    assert.match(mirrored, /Startup backfill omitted about 2 remaining events in this turn/);
    assert.doesNotMatch(mirrored, /Startup backfill skipped about 2 intermediate events in this turn/);
    assert.doesNotMatch(mirrored, /Omitted event 1/);
    assert.doesNotMatch(mirrored, /Omitted event 2/);
  } finally {
    await bridge.stop();
  }
});

test("startup refresh repairs recent missing messages for existing mapped threads", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: sessionTailer as never
  });

  const now = Date.now();
  store.upsertThreadBridge({
    codexThreadId: "existing_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_existing",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(now).toISOString(),
    attachMode: "auto",
    threadName: "Existing thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: now - 60_000,
    latestMirroredCursor: `${String(now - 60_000).padStart(16, "0")}:00000000:item-old-anchor`,
    latestMirroredTurnCursor: `${String(now - 60_000).padStart(16, "0")}:turn-old-anchor`
  });
  store.upsertMirroredItem({
    threadId: "existing_thread",
    itemId: "item-old-anchor",
    turnId: "turn-old-anchor",
    kind: "user",
    discordMessageId: "msg-old-anchor",
    groupKey: "turn-old-anchor",
    contentSignature: "older mirrored prompt",
    renderedContent: "Older mirrored prompt",
    timestampMs: now - 60_000,
    cursor: `${String(now - 60_000).padStart(16, "0")}:00000000:item-old-anchor`,
    turnCursor: `${String(now - 60_000).padStart(16, "0")}:turn-old-anchor`,
    updatedAt: new Date(now - 60_000).toISOString()
  });

  discord.conversationChannelIds.add("discord_channel_existing");
  codex.metadata.set("existing_thread", { cwd: "C:\\repo", repoName: "repo" });
  codex.threadDetails.set("existing_thread", {
    id: "existing_thread",
    name: "Existing thread",
    preview: "Existing thread",
    modelProvider: null,
    createdAt: Math.floor((now - 3600_000) / 1000),
    updatedAt: Math.floor(now / 1000),
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  sessionTailer.setLatestTurnBackfillEvents("existing_thread", [
    {
      type: "sessionUserMessage",
      threadId: "existing_thread",
      turnId: "turn_recent",
      timestampMs: now - 5_000,
      text: "Missing latest user prompt"
    },
    {
      type: "sessionAgentMessage",
      threadId: "existing_thread",
      turnId: "turn_recent",
      timestampMs: now - 4_000,
      text: "Missing latest Codex answer",
      phase: "final_answer"
    }
  ]);

  try {
    await bridge.start();

    assert.ok(sessionTailer.fastForwardedThreadIds.includes("existing_thread"));
    assert.ok(
      discord.sentTextMessages.some((message) => message.content.includes("Missing latest user prompt"))
    );
    assert.ok(
      discord.liveTextMessages.some((message) => message.content.includes("Missing latest Codex answer"))
    );
  } finally {
    await bridge.stop();
  }
});

test("startup refresh budgets missing session events after the latest mirrored source frontier", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: sessionTailer as never,
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        startupBackfill: {
          leadingEventBudget: 2,
          trailingEventBudget: 2
        }
      }
    )
  });

  const now = Date.now();
  const sourceFilePath = "C:\\Users\\Natale\\.codex\\sessions\\existing-thread.jsonl";
  const anchorSourceOrder = "0000000000000100:0000";
  const anchorEventKey = "line:100:0";
  store.upsertThreadBridge({
    codexThreadId: "existing_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_existing",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(now).toISOString(),
    attachMode: "auto",
    threadName: "Existing thread",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: now - 60_000,
    latestMirroredCursor: `session:${anchorSourceOrder}:${anchorEventKey}`,
    latestMirroredTurnCursor: `${String(now - 60_000).padStart(16, "0")}:turn-existing`,
    latestMirroredSourceFilePath: sourceFilePath,
    latestMirroredSourceOffset: 100,
    latestMirroredSourceEventKey: anchorEventKey
  });
  store.upsertMirroredItem({
    threadId: "existing_thread",
    itemId: `session:${anchorEventKey}`,
    turnId: "turn_existing",
    kind: "user",
    discordMessageId: "msg-old-anchor",
    groupKey: "turn-existing",
    contentSignature: "older mirrored prompt",
    renderedContent: "Older mirrored prompt",
    timestampMs: now - 60_000,
    cursor: `session:${anchorSourceOrder}:${anchorEventKey}`,
    turnCursor: `${String(now - 60_000).padStart(16, "0")}:turn-existing`,
    updatedAt: new Date(now - 60_000).toISOString()
  });
  store.upsertRetainedTurn({
    threadId: "existing_thread",
    turnKey: "turn:turn_existing",
    turnId: "turn_existing",
    turnCursor: `${String(now - 60_000).padStart(16, "0")}:turn-existing`,
    anchorItemId: `session:${anchorEventKey}`,
    anchorText: "Older mirrored prompt",
    source: "codex-read",
    updatedAt: new Date(now - 60_000).toISOString()
  });

  discord.conversationChannelIds.add("discord_channel_existing");
  codex.metadata.set("existing_thread", { cwd: "C:\\repo", repoName: "repo" });
  codex.threadDetails.set("existing_thread", {
    id: "existing_thread",
    name: "Existing thread",
    preview: "Existing thread",
    modelProvider: null,
    createdAt: Math.floor((now - 3600_000) / 1000),
    updatedAt: Math.floor(now / 1000),
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  sessionTailer.setBackfillEventsSince("existing_thread", [
    {
      type: "sessionUserMessage",
      threadId: "existing_thread",
      turnId: "turn_existing",
      timestampMs: now - 60_000,
      text: "Older mirrored prompt",
      sourceFilePath,
      sourceOffset: 100,
      sourceOrder: anchorSourceOrder,
      eventKey: anchorEventKey
    },
    ...Array.from({ length: 25 }, (_, index) => {
      const offset = 101 + index;
      return {
        type: "sessionAgentMessage" as const,
        threadId: "existing_thread",
        turnId: "turn_existing",
        timestampMs: now - 59_000 + index,
        text: `Recovered startup commentary ${index + 1}`,
        phase: "commentary",
        sourceFilePath,
        sourceOffset: offset,
        sourceOrder: `${String(offset).padStart(16, "0")}:0000`,
        eventKey: `line:${offset}:0`
      };
    })
  ]);

  try {
    await bridge.start();

    assert.ok(sessionTailer.fastForwardedThreadIds.includes("existing_thread"));
    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    const mirroredAgentItems = store
      .listMirroredItems("existing_thread")
      .filter((record) => record.kind === "agentCommentary");
    assert.equal(mirroredAgentItems.length, 4);
    assert.ok(
      mirroredAgentItems.some((record) => record.renderedContent.includes("Recovered startup commentary 1"))
    );
    assert.ok(
      mirroredAgentItems.some((record) => record.renderedContent.includes("Recovered startup commentary 2"))
    );
    assert.ok(
      mirroredAgentItems.some((record) => record.renderedContent.includes("Recovered startup commentary 24"))
    );
    assert.ok(
      mirroredAgentItems.some((record) => record.renderedContent.includes("Recovered startup commentary 25"))
    );
    assert.match(mirrored, /Startup backfill skipped about 21 intermediate events in this turn/);
    assert.doesNotMatch(mirrored, /Recovered startup commentary 3/);
    assert.doesNotMatch(mirrored, /Recovered startup commentary 23/);
    assert.equal(
      store.getThreadBridge("existing_thread")?.latestMirroredCursor,
      "session:0000000000000125:0000:line:125:0"
    );
  } finally {
    await bridge.stop();
  }
});

test("startup frontier backfill falls back to full recent-turn replay when a newer turn would begin mid-stream", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: sessionTailer as never,
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      },
      {
        startupBackfill: {
          leadingEventBudget: 20,
          trailingEventBudget: 20
        }
      }
    )
  });

  const now = Date.now();
  const sourceFilePath = "C:\\Users\\Natale\\.codex\\sessions\\frontier-fallback.jsonl";
  const anchorSourceOrder = "0000000000000100:0000";
  const anchorEventKey = "line:100:0";
  store.upsertThreadBridge({
    codexThreadId: "existing_thread_frontier_fallback",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_existing_frontier_fallback",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(now).toISOString(),
    attachMode: "auto",
    threadName: "Existing frontier fallback",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: now - 60_000,
    latestMirroredCursor: `session:${anchorSourceOrder}:${anchorEventKey}`,
    latestMirroredTurnCursor: `${String(now - 60_000).padStart(16, "0")}:turn-existing-frontier`,
    latestMirroredSourceFilePath: sourceFilePath,
    latestMirroredSourceOffset: 100,
    latestMirroredSourceEventKey: anchorEventKey
  });
  store.upsertMirroredItem({
    threadId: "existing_thread_frontier_fallback",
    itemId: `session:${anchorEventKey}`,
    turnId: "turn_existing_frontier",
    kind: "user",
    discordMessageId: "msg-existing-frontier-anchor",
    groupKey: "turn-existing-frontier",
    contentSignature: "Existing mirrored prompt",
    renderedContent: "Existing mirrored prompt",
    timestampMs: now - 60_000,
    cursor: `session:${anchorSourceOrder}:${anchorEventKey}`,
    turnCursor: `${String(now - 60_000).padStart(16, "0")}:turn-existing-frontier`,
    updatedAt: new Date(now - 60_000).toISOString()
  });

  discord.conversationChannelIds.add("discord_channel_existing_frontier_fallback");
  codex.metadata.set("existing_thread_frontier_fallback", { cwd: "C:\\repo", repoName: "repo" });
  codex.threadDetails.set("existing_thread_frontier_fallback", {
    id: "existing_thread_frontier_fallback",
    name: "Existing frontier fallback",
    preview: "Existing frontier fallback",
    modelProvider: null,
    createdAt: Math.floor((now - 3600_000) / 1000),
    updatedAt: Math.floor(now / 1000),
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });

  sessionTailer.setBackfillEventsSince("existing_thread_frontier_fallback", [
    {
      type: "sessionAgentMessage",
      threadId: "existing_thread_frontier_fallback",
      turnId: "turn_existing_frontier",
      timestampMs: now - 59_000,
      text: "Anchored commentary from the already mirrored turn.",
      phase: "commentary",
      sourceFilePath,
      sourceOffset: 101,
      sourceOrder: "0000000000000101:0000",
      eventKey: "line:101:0"
    },
    {
      type: "sessionAgentMessage",
      threadId: "existing_thread_frontier_fallback",
      turnId: "turn_recent_frontier",
      timestampMs: now - 58_000,
      text: "This mid-turn commentary should not leapfrog the missing user anchor.",
      phase: "commentary",
      sourceFilePath,
      sourceOffset: 102,
      sourceOrder: "0000000000000102:0000",
      eventKey: "line:102:0"
    }
  ]);
  sessionTailer.setLatestTurnBackfillEvents("existing_thread_frontier_fallback", [
    {
      type: "sessionUserMessage",
      threadId: "existing_thread_frontier_fallback",
      turnId: "turn_recent_frontier",
      timestampMs: now - 57_000,
      text: "Recovered latest user prompt",
      sourceOrder: "0000000000000200:0000",
      eventKey: "line:200:0"
    },
    {
      type: "sessionAgentMessage",
      threadId: "existing_thread_frontier_fallback",
      turnId: "turn_recent_frontier",
      timestampMs: now - 56_000,
      text: "Recovered latest Codex answer",
      phase: "final_answer",
      sourceOrder: "0000000000000201:0000",
      eventKey: "line:201:0"
    }
  ]);

  try {
    await bridge.start();

    const mirrored = [
      ...discord.sentTextMessages.map((message) => message.content),
      ...discord.liveTextMessages.map((message) => message.content)
    ].join("\n");
    assert.ok(sessionTailer.fastForwardedThreadIds.includes("existing_thread_frontier_fallback"));
    assert.match(mirrored, /Recovered latest user prompt/);
    assert.match(mirrored, /Recovered latest Codex answer/);
    assert.doesNotMatch(mirrored, /This mid-turn commentary should not leapfrog the missing user anchor/);
  } finally {
    await bridge.stop();
  }
});

test("startup frontier backfill records stale replayed child anchors without eagerly attaching child threads", async () => {
  const sessionTailer = new FakeSessionEventTailer();
  const { store, codex, discord, bridge } = createBridgeTestRig({
    sessionEventTailer: sessionTailer as never
  });

  const now = Date.now();
  const sourceFilePath = "C:\\Users\\Natale\\.codex\\sessions\\2026\\04\\16\\rollout-existing-thread.jsonl";
  store.upsertThreadBridge({
    codexThreadId: "existing_thread_spawn",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_existing_thread_spawn",
    discordParentChannelId: null,
    statusMessageId: "status_existing_thread_spawn",
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date(now).toISOString(),
    attachMode: "auto",
    threadName: "Existing thread spawn",
    lastStatusType: "active",
    channelKind: "conversation",
    latestMirroredTimestampMs: now - 60_000,
    latestMirroredCursor: "session:0000000000000100:0000:line:100:0",
    latestMirroredTurnCursor: "turn:turn_existing_spawn",
    latestMirroredSourceFilePath: sourceFilePath,
    latestMirroredSourceOffset: 100,
    latestMirroredSourceEventKey: "line:100:0"
  });
  store.upsertMirroredItem({
    threadId: "existing_thread_spawn",
    itemId: "existing_anchor",
    turnId: "turn_existing_spawn",
    kind: "user",
    discordMessageId: "existing_anchor_message",
    groupKey: null,
    contentSignature: "existing_anchor_signature",
    renderedContent: "Existing mirrored prompt",
    timestampMs: now - 60_000,
    cursor: "session:0000000000000100:0000:line:100:0",
    turnCursor: "turn:turn_existing_spawn",
    updatedAt: new Date(now - 60_000).toISOString()
  });
  store.upsertRetainedTurn({
    threadId: "existing_thread_spawn",
    turnKey: "turn:turn_existing_spawn",
    turnId: "turn_existing_spawn",
    turnCursor: "turn:turn_existing_spawn",
    anchorItemId: "existing_anchor",
    anchorText: "Existing mirrored prompt",
    source: "codex-read",
    updatedAt: new Date(now - 60_000).toISOString()
  });

  discord.conversationChannelIds.add("discord_channel_existing_thread_spawn");
  codex.metadata.set("existing_thread_spawn", { cwd: "C:\\repo", repoName: "repo" });
  codex.threadDetails.set("existing_thread_spawn", {
    id: "existing_thread_spawn",
    name: "Existing thread spawn",
    preview: "Existing thread spawn",
    modelProvider: null,
    createdAt: Math.floor((now - 3600_000) / 1000),
    updatedAt: Math.floor(now / 1000),
    ephemeral: false,
    status: { type: "active" as const, activeFlags: [] },
    turns: []
  });
  codex.metadata.set("child_thread_spawn", {
    cwd: "C:\\repo",
    repoName: "repo",
    parentThreadId: "existing_thread_spawn",
    actorName: "Darwin",
    threadName: "Spawned helper"
  });

  sessionTailer.setBackfillEventsSince("existing_thread_spawn", [
    {
      type: "sessionSubagentSpawned",
      threadId: "existing_thread_spawn",
      turnId: "turn_existing_spawn",
      childThreadId: "child_thread_spawn",
      childAgentName: "Darwin",
      prompt: "Inspect scripts",
      timestampMs: now - 59_000,
      sourceFilePath,
      sourceOffset: 101,
      sourceOrder: "0000000000000101:0000",
      eventKey: "line:101:0"
    }
  ]);

  try {
    await bridge.start();

    const childBridge = store.getThreadBridge("child_thread_spawn");
    const childAnchor = store.getChildThreadAnchor("child_thread_spawn");
    assert.equal(childBridge, undefined);
    assert.equal(childAnchor?.parentThreadId, "existing_thread_spawn");
    assert.equal(childAnchor?.parentTurnId, "turn_existing_spawn");
    assert.equal(childAnchor?.parentTurnCursor, "turn:turn_existing_spawn");
    assert.equal(discord.threadChannelIds.has("discord_subagent_1"), false);
    assert.ok(sessionTailer.fastForwardedThreadIds.includes("existing_thread_spawn"));
  } finally {
    await bridge.stop();
  }
});

test("startup discovery does not immediately reattach mapped threads already refreshed in phase A", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "existing_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_existing_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Existing thread",
    actorName: "Codex",
    lastStatusType: "idle",
    channelKind: "conversation",
    latestMirroredTimestampMs: null,
    latestMirroredCursor: null
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "existing_thread",
      name: "Existing thread",
      preview: "Existing thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    },
    {
      id: "new_thread",
      name: "New thread",
      preview: "New thread",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ] as any;
  codex.metadata.set("existing_thread", { cwd: "C:\\repo", repoName: "repo" });
  codex.metadata.set("new_thread", { cwd: "C:\\repo", repoName: "repo" });

  try {
    await bridge.start();

    assert.equal(discord.conversationEnsureCalls.filter((threadId) => threadId === "existing_thread").length, 1);
    assert.equal(discord.conversationEnsureCalls.filter((threadId) => threadId === "new_thread").length, 1);
  } finally {
    await bridge.stop();
  }
});

test("startup refresh continues when a mapped thread resume fails with missing rollout", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  const now = new Date().toISOString();
  store.upsertThreadBridge({
    codexThreadId: "healthy_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_healthy_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: now,
    attachMode: "auto",
    threadName: "Healthy thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  store.upsertThreadBridge({
    codexThreadId: "stale_missing_rollout",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_stale_missing_rollout",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: now,
    attachMode: "auto",
    threadName: "Stale thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });

  codex.metadata.set("healthy_thread", { cwd: "C:\\repo", repoName: "repo" });
  codex.metadata.set("stale_missing_rollout", { cwd: "C:\\repo", repoName: "repo" });
  codex.threadDetails.set("healthy_thread", {
    id: "healthy_thread",
    name: "Healthy thread",
    preview: "Healthy thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: []
  });
  codex.threadDetails.set("stale_missing_rollout", {
    id: "stale_missing_rollout",
    name: "Stale thread",
    preview: "Stale thread",
    modelProvider: null,
    createdAt: null,
    updatedAt: null,
    ephemeral: false,
    status: { type: "idle" as const },
    turns: []
  });
  codex.resumeErrors.set(
    "stale_missing_rollout",
    new Error("no rollout found for thread id stale_missing_rollout")
  );

  try {
    await bridge.start();
    assert.ok(codex.resumedThreadIds.includes("healthy_thread"));
    assert.ok(codex.resumedThreadIds.includes("stale_missing_rollout"));
    assert.ok(store.getThreadBridge("healthy_thread"));
    assert.ok(store.getThreadBridge("stale_missing_rollout"));
  } finally {
    await bridge.stop();
  }
});

test("existing mapped app-server threads adopt a fresher metadata title over stale stored and summary names", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  store.upsertThreadBridge({
    codexThreadId: "cli_like_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_cli_like_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "original-title",
    lastStatusType: "idle",
    channelKind: "conversation",
    sourceKind: "app-server"
  });

  codex.threads = [
    {
      id: "cli_like_thread",
      name: "stale-first-message-derived-name",
      preview: "stale-first-message-derived-name",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("cli_like_thread", {
    cwd: "C:\\repo",
    repoName: "repo",
    threadName: "Continue feature pipeline work"
  });

  try {
    await bridge.start();
    const mapped = store.getThreadBridge("cli_like_thread");
    assert.equal(mapped?.threadName, "Continue feature pipeline work");
  } finally {
    await bridge.stop();
  }
});

test("existing mapped app-server threads ignore synthetic turn-aborted metadata titles and recover to the latest real summary title", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  store.upsertThreadBridge({
    codexThreadId: "abort_named_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_abort_named_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName:
      "<turn_aborted>The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background.</turn_aborted>",
    lastStatusType: "idle",
    channelKind: "conversation",
    sourceKind: "app-server"
  });

  codex.threads = [
    {
      id: "abort_named_thread",
      name: "test, ignore",
      preview: "test, ignore",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.threadDetails.set("abort_named_thread", {
    id: "abort_named_thread",
    name: "test, ignore",
    preview: "test, ignore",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const }
  });
  codex.metadata.set("abort_named_thread", {
    cwd: "C:\\repo",
    repoName: "repo",
    threadName:
      "<turn_aborted>The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background.</turn_aborted>"
  });

  try {
    await bridge.start();
    const mapped = store.getThreadBridge("abort_named_thread");
    assert.equal(mapped?.threadName, "test, ignore");
  } finally {
    await bridge.stop();
  }
});

test("new app-server threads skip synthetic turn-aborted titles and fall back to a non-synthetic preview", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "abort_preview_thread",
      name:
        "<turn_aborted>The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background.</turn_aborted>",
      preview: "send the request again",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active", activeFlags: [] }
    }
  ] as any;
  codex.metadata.set("abort_preview_thread", {
    cwd: "C:\\repo",
    repoName: "repo",
    threadName:
      "<turn_aborted>The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background.</turn_aborted>"
  });

  try {
    await bridge.start();
    const mapped = store.getThreadBridge("abort_preview_thread");
    assert.equal(mapped?.threadName, "send the request again");
    assert.equal(discord.conversationEnsureRequests.at(-1)?.title, "send the request again");
  } finally {
    await bridge.stop();
  }
});

test("new Codex guardian auto-review threads are skipped by session metadata source", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  codex.threads = [
    {
      id: "guardian_auto_review_thread",
      name: "Assess approval request",
      preview: "Assess approval request",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "active" as const, activeFlags: [] }
    }
  ] as any;
  codex.metadata.set("guardian_auto_review_thread", {
    cwd: "C:\\repo",
    repoName: "repo",
    threadName: "Assess approval request",
    sourceSubagentOther: "guardian"
  });

  try {
    await bridge.start();

    assert.equal(store.getThreadBridge("guardian_auto_review_thread"), undefined);
    assert.deepEqual(discord.conversationEnsureCalls, []);
    assert.deepEqual(discord.deletedLocationIds, []);
  } finally {
    await bridge.stop();
  }
});

test("existing mapped Codex guardian auto-review threads are pruned on startup", async () => {
  const { store, codex, discord, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  store.upsertThreadBridge({
    codexThreadId: "mapped_guardian_auto_review_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_mapped_guardian_auto_review_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Assess approval request",
    lastStatusType: "idle",
    channelKind: "conversation",
    sourceKind: "app-server"
  });
  discord.conversationChannelIds.add("discord_channel_mapped_guardian_auto_review_thread");
  codex.threadDetails.set("mapped_guardian_auto_review_thread", {
    id: "mapped_guardian_auto_review_thread",
    name: "Assess approval request",
    preview: "Assess approval request",
    modelProvider: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    ephemeral: false,
    status: { type: "idle" as const }
  });
  codex.metadata.set("mapped_guardian_auto_review_thread", {
    cwd: "C:\\repo",
    repoName: "repo",
    threadName: "Assess approval request",
    sourceSubagentOther: "guardian"
  });

  try {
    await bridge.start();

    assert.equal(store.getThreadBridge("mapped_guardian_auto_review_thread"), undefined);
    assert.ok(discord.deletedLocationIds.includes("discord_channel_mapped_guardian_auto_review_thread"));
    assert.deepEqual(discord.conversationEnsureCalls, []);
  } finally {
    await bridge.stop();
  }
});

test("existing mapped CLI threads keep their stored fallback name instead of adopting a newer discovered title", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  store.upsertThreadBridge({
    codexThreadId: "cli_like_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_channel_cli_like_thread",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "original-title",
    lastStatusType: "idle",
    channelKind: "conversation",
    sourceKind: "cli-session"
  });

  codex.threads = [
    {
      id: "cli_like_thread",
      name: "renamed-from-latest-message",
      preview: "renamed-from-latest-message",
      modelProvider: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
      ephemeral: false,
      status: { type: "idle" as const }
    }
  ] as any;
  codex.metadata.set("cli_like_thread", { cwd: "C:\\repo", repoName: "repo" });

  try {
    await bridge.start();
    const mapped = store.getThreadBridge("cli_like_thread");
    assert.equal(mapped?.threadName, "original-title");
  } finally {
    await bridge.stop();
  }
});

test("CLI discovery uses the first user message as the stable thread name", async () => {
  const codexHome = mkdtempSync(path.join(tmpdir(), "codex-mobile-codex-home-"));
  const sessionsDir = path.join(codexHome, "sessions", "2026", "04", "06");
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(
    sessionsDir,
    "rollout-2026-04-06T07-47-11-019d6154-aa76-74c3-ba4e-58e34911b226.jsonl"
  );
  writeFileSync(
    filePath,
    [
      JSON.stringify({
        timestamp: "2026-04-06T07:47:11.000Z",
        type: "session_meta",
        payload: {
          id: "019d6154-aa76-74c3-ba4e-58e34911b226",
          source: "cli",
          originator: "codex-tui",
          cwd: "C:\\Users\\Natale\\Desktop\\projects\\test-codex-cli",
          timestamp: "2026-04-06T07:47:11.000Z"
        }
      }),
      JSON.stringify({
        timestamp: "2026-04-06T07:47:12.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "tell me a joke"
        }
      }),
      JSON.stringify({
        timestamp: "2026-04-06T07:48:12.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "another"
        }
      })
    ].join("\n") + "\n",
    "utf8"
  );

  const store = new StateStore(path.join(codexHome, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(codexHome, store, createLogger("silent"));

  try {
    const threads = await tailer.listRecentCliThreads(10, 48 * 60 * 60 * 1000);
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.name, "tell me a joke");
    assert.equal(threads[0]?.preview, "another");
  } finally {
    store.close();
  }
});

test("session tailer summarizes apply_patch edits with per-file line counts", async () => {
  const threadId = "019d8aaa-aa76-74c3-ba4e-58e34911b111";
  const codexHome = mkdtempSync(path.join(tmpdir(), "codex-mobile-codex-home-"));
  const sessionsDir = path.join(codexHome, "sessions", "2026", "04", "08");
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(
    sessionsDir,
    `rollout-2026-04-08T09-00-00-${threadId}.jsonl`
  );
  const patchInput = [
    "*** Begin Patch",
    "*** Update File: src/foo.ts",
    "@@",
    "-const a = 1;",
    "+const a = 2;",
    "+const b = 3;",
    "*** Add File: tmp/new.txt",
    "+line 1",
    "+line 2",
    "*** Delete File: old.txt",
    "*** End Patch"
  ].join("\n");

  writeFileSync(
    filePath,
    [
      JSON.stringify({
        timestamp: "2026-04-08T09:00:00.000Z",
        type: "session_meta",
        payload: {
          id: threadId,
          source: "cli",
          originator: "codex-tui",
          cwd: "C:\\Users\\Natale\\Desktop\\projects\\test-codex-cli",
          timestamp: "2026-04-08T09:00:00.000Z"
        }
      }),
      JSON.stringify({
        timestamp: "2026-04-08T09:00:05.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call_apply_patch_1",
          name: "apply_patch",
          input: patchInput
        }
      })
    ].join("\n") + "\n",
    "utf8"
  );

  const store = new StateStore(path.join(codexHome, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(codexHome, store, createLogger("silent"));

  try {
    const events = await tailer.pollThread(threadId);
    const applyPatchEvent = events.find((event) => event.type === "sessionApplyPatchCompleted");
    assert.ok(applyPatchEvent);
    assert.match((applyPatchEvent as { summary: string }).summary, /edited `src\/foo\.ts` \+2 -1/);
    assert.match((applyPatchEvent as { summary: string }).summary, /added `tmp\/new\.txt` \+2 -0/);
    assert.match((applyPatchEvent as { summary: string }).summary, /deleted `old\.txt` \+0 -0/);
  } finally {
    store.close();
  }
});

test("CLI discovery ignores injected AGENTS.md instruction blocks when deriving thread names", async () => {
  const codexHome = mkdtempSync(path.join(tmpdir(), "codex-mobile-codex-home-"));
  const sessionsDir = path.join(codexHome, "sessions", "2026", "04", "06");
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(
    sessionsDir,
    "rollout-2026-04-06T08-30-00-019d7000-aa76-74c3-ba4e-58e34911b999.jsonl"
  );
  writeFileSync(
    filePath,
    [
      JSON.stringify({
        timestamp: "2026-04-06T08:30:00.000Z",
        type: "session_meta",
        payload: {
          id: "019d7000-aa76-74c3-ba4e-58e34911b999",
          source: "cli",
          originator: "codex-tui",
          cwd: "C:\\Users\\Natale\\Desktop\\projects\\test-codex-cli",
          timestamp: "2026-04-06T08:30:00.000Z"
        }
      }),
      JSON.stringify({
        timestamp: "2026-04-06T08:30:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message:
            "AGENTS.md instructions for C:\\Users\\Natale\\Desktop\\projects\\test-codex-cli\n\n<INSTRUCTIONS>\n## JavaScript REPL (Node)\n</INSTRUCTIONS>\n<environment_context>\n</environment_context>"
        }
      }),
      JSON.stringify({
        timestamp: "2026-04-06T08:30:10.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "open example.com"
        }
      })
    ].join("\n") + "\n",
    "utf8"
  );

  const store = new StateStore(path.join(codexHome, "bridge.sqlite"));
  const tailer = new CodexSessionEventTailer(codexHome, store, createLogger("silent"));

  try {
    const threads = await tailer.listRecentCliThreads(10, 48 * 60 * 60 * 1000);
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.name, "open example.com");
    assert.equal(threads[0]?.preview, "open example.com");
  } finally {
    store.close();
  }
});

test("bridge monitors desktop and CLI sessions together while keeping desktop approvals enabled", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-bridge-"));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const store = new StateStore(path.join(dir, "bridge.sqlite"));
  const codex = new FakeCodexAdapter();
  codex.threads = [
    {
      id: "desktop_thread",
      name: "Desktop thread",
      preview: "Desktop preview",
      modelProvider: null,
      createdAt: nowSeconds - 60,
      updatedAt: nowSeconds - 5,
      ephemeral: false,
      status: { type: "active", activeFlags: [] }
    }
  ];
  codex.metadata.set("desktop_thread", {
    cwd: "C:\\repo",
    repoName: "repo"
  });
  const discord = new FakeDiscordAdapter();
  const tailer = new FakeSessionEventTailer();
  tailer.setCliThreads([
    {
      threadId: "cli_thread",
      name: "CLI discovered thread",
      preview: "CLI preview",
      cwd: "C:\\Users\\Natale\\Desktop\\projects\\test-codex-cli",
      repoName: "test-codex-cli",
      createdAtMs: Date.now() - 30_000,
      updatedAtMs: Date.now() - 5_000,
      status: "active",
      filePath: "session.jsonl"
    }
  ]);
  const desktopIpc = new FakeDesktopIpcClient();
  const bridge = createBridgeService({
    codexAdapter: codex as never,
    provider: discord as never,
    stateStore: store,
    policy: new Policy({
      allowFromDiscord: true,
      allowedUserIds: ["user_1"],
      mentionApprovers: true
    }),
    runtimeConfig: createBridgeConfigFromPreset(
      "recommended",
      {
        allowFromDiscord: true,
        allowedUserIds: ["user_1"],
      }
    ),
    sessionEventTailer: tailer as never,
    desktopIpcClient: desktopIpc as never
  });

  try {
    await bridge.start();

    assert.equal(codex.startCalls, 1);
    assert.equal(desktopIpc.started, true);
    assert.equal(store.getThreadBridge("desktop_thread")?.discordChannelId, "discord_channel_desktop_thread");
    assert.equal(store.getThreadBridge("cli_thread")?.discordChannelId, "discord_channel_cli_thread");
  } finally {
    await bridge.stop();
  }
});

test("stale Discord channel mappings are repaired instead of crashing status updates", async () => {
  const { store, codex, bridge } = createBridgeTestRig();

  store.upsertThreadBridge({
    codexThreadId: "stale_thread",
    parentCodexThreadId: null,
    projectKey: "c:\\write",
    projectName: "write",
    discordChannelId: "missing_channel",
    discordParentChannelId: null,
    statusMessageId: "missing_status",
    cwd: "C:\\write",
    repoName: "write",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Stale thread",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  codex.metadata.set("stale_thread", { cwd: "C:\\write", repoName: "write" });

  try {
    await bridge.start();
    await (bridge as any).flushStatusUpdate("stale_thread");

    const repaired = store.getThreadBridge("stale_thread");
    assert.equal(repaired?.discordChannelId, "discord_channel_stale_thread");
    assert.equal(repaired?.statusMessageId, "status_msg_discord_channel_stale_thread");
  } finally {
    await bridge.stop();
  }
});

