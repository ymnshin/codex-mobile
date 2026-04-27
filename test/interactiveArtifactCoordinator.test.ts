import test from "node:test";
import assert from "node:assert/strict";
import { InteractiveArtifactCoordinator } from "../src/bridge/artifacts/InteractiveArtifactCoordinator.js";

function createApproval(overrides: Record<string, unknown> = {}) {
  return {
    token: "approval_token",
    requestId: "42",
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "item_1",
    kind: "commandExecution" as const,
    sanitizedPreview: "npm test",
    cwd: "C:\\repo",
    reason: "Need tests",
    availableDecisions: ["accept", "decline"],
    decisionPayloads: {},
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    discordMessageId: "approval_msg_1",
    status: "pending" as const,
    details: "{}",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    ...overrides
  };
}

function createMessageDetail(overrides: Record<string, unknown> = {}) {
  return {
    token: "detail_token",
    threadId: "thread_1",
    kind: "command" as const,
    title: "Command details",
    buttonLabel: "Show details",
    detail: "More information",
    discordMessageId: "discord_message_1",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

test("InteractiveArtifactCoordinator expires pending approval cards and disables mirrored messages", async () => {
  const approvals = [
    createApproval(),
    createApproval({
      token: "approval_token_no_bridge",
      threadId: "thread_missing",
      discordMessageId: null
    }),
    createApproval({
      token: "approval_token_not_pending",
      status: "approved",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })
  ];
  const statusUpdates: Array<{ token: string; status: string }> = [];
  const disabledCards: Array<{ channelId: string; messageId: string; token: string }> = [];

  const coordinator = new InteractiveArtifactCoordinator(
    {
      stateStore: {
        listPendingApprovals: () => approvals,
        setPendingApprovalStatus: (token: string, status: string) => {
          statusUpdates.push({ token, status });
          const record = approvals.find((approval) => approval.token === token);
          if (record) {
            (record as { status: string }).status = status;
          }
        },
        getThreadBridge: (threadId: string) =>
          threadId === "thread_1"
            ? { discordChannelId: "discord_channel_1" }
            : null
      },
      provider: {
        disableApprovalCard: async (
          channelId: string,
          messageId: string,
          _resolutionText: string,
          view: { token: string }
        ) => {
          disabledCards.push({ channelId, messageId, token: view.token });
        }
      },
      logger: {
        warn: () => undefined
      }
    } as never,
    {
      buildApprovalCardView: (approval) => ({ token: approval.token } as never),
      isUnknownDiscordChannelError: () => false
    }
  );

  await coordinator.cleanupExpiredApprovalCards();

  assert.deepEqual(statusUpdates, [
    { token: "approval_token", status: "expired" },
    { token: "approval_token_no_bridge", status: "expired" }
  ]);
  assert.deepEqual(disabledCards, [
    {
      channelId: "discord_channel_1",
      messageId: "approval_msg_1",
      token: "approval_token"
    }
  ]);
});

test("InteractiveArtifactCoordinator removes expired detail buttons and refreshes remaining ones", async () => {
  const details = [
    createMessageDetail(),
    createMessageDetail({
      token: "detail_token_fresh",
      buttonLabel: "Open details",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }),
    createMessageDetail({
      token: "detail_token_other_message",
      discordMessageId: "discord_message_2",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })
  ];
  const deletedTokens: string[] = [];
  const buttonRefreshes: Array<{
    channelId: string;
    messageId: string;
    buttons: Array<{ token: string; label: string }>;
  }> = [];

  const coordinator = new InteractiveArtifactCoordinator(
    {
      stateStore: {
        listExpiredMessageDetails: () =>
          details.filter((detail) => Date.parse(detail.expiresAt) <= Date.now()),
        deleteMessageDetail: (token: string) => {
          deletedTokens.push(token);
          const index = details.findIndex((detail) => detail.token === token);
          if (index >= 0) {
            details.splice(index, 1);
          }
        },
        getThreadBridge: () => ({ discordChannelId: "discord_channel_1" }),
        listMessageDetailsByDiscordMessageId: (messageId: string) =>
          details.filter((detail) => detail.discordMessageId === messageId)
      },
      provider: {
        updateMessageDetailsButtons: async (
          channelId: string,
          messageId: string,
          buttons: Array<{ token: string; label: string }>
        ) => {
          buttonRefreshes.push({ channelId, messageId, buttons });
        }
      },
      logger: {
        warn: () => undefined
      }
    } as never,
    {
      buildApprovalCardView: () => ({ token: "" } as never),
      isUnknownDiscordChannelError: () => false
    }
  );

  await coordinator.cleanupExpiredMessageDetails();

  assert.deepEqual(deletedTokens, ["detail_token"]);
  assert.deepEqual(buttonRefreshes, [
    {
      channelId: "discord_channel_1",
      messageId: "discord_message_1",
      buttons: [{ token: "detail_token_fresh", label: "Open details" }]
    }
  ]);
});

test("InteractiveArtifactCoordinator ignores unknown-channel message detail errors", async () => {
  const warnings: string[] = [];
  const coordinator = new InteractiveArtifactCoordinator(
    {
      stateStore: {
        listExpiredMessageDetails: () => [createMessageDetail()],
        deleteMessageDetail: () => undefined,
        getThreadBridge: () => ({ discordChannelId: "discord_channel_1" }),
        listMessageDetailsByDiscordMessageId: () => []
      },
      provider: {
        updateMessageDetailsButtons: async () => {
          throw { code: 10003 };
        }
      },
      logger: {
        warn: (_payload: unknown, message: string) => warnings.push(message)
      }
    } as never,
    {
      buildApprovalCardView: () => ({ token: "" } as never),
      isUnknownDiscordChannelError: (error: unknown) =>
        Boolean(error && typeof error === "object" && (error as { code?: number }).code === 10003)
    }
  );

  await coordinator.cleanupExpiredMessageDetails();

  assert.deepEqual(warnings, []);
});

test("InteractiveArtifactCoordinator prunes retained approval and audit state using retention cutoffs", () => {
  const calls: Array<{ kind: string; cutoff: string }> = [];
  const originalNow = Date.now;
  Date.now = () => Date.UTC(2026, 3, 19, 13, 0, 0);

  try {
    const coordinator = new InteractiveArtifactCoordinator(
      {
        stateStore: {
          deleteInactiveApprovalsOlderThan: (cutoff: string) => {
            calls.push({ kind: "approvals", cutoff });
            return 0;
          },
          deleteAuditLogOlderThan: (cutoff: string) => {
            calls.push({ kind: "audit", cutoff });
            return 0;
          }
        }
      } as never,
      {
        buildApprovalCardView: () => ({ token: "" } as never),
        isUnknownDiscordChannelError: () => false
      }
    );

    coordinator.cleanupRetainedState();
  } finally {
    Date.now = originalNow;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.kind, "approvals");
  assert.equal(calls[1]?.kind, "audit");
  assert.ok(Date.parse(calls[0]!.cutoff) > Date.parse(calls[1]!.cutoff));
});
