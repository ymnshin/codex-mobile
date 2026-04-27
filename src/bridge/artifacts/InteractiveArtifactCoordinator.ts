import type { ApprovalCardView } from "../../domain.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import {
  AUDIT_LOG_RETENTION_MS,
  INACTIVE_APPROVAL_RETENTION_MS
} from "../runtime/BridgeRuntimeContext.js";

interface InteractiveArtifactCoordinatorDependencies {
  buildApprovalCardView(approval: import("../../domain.js").PendingApprovalRecord): ApprovalCardView;
  isUnknownDiscordChannelError(error: unknown): boolean;
}

export class InteractiveArtifactCoordinator {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly deps: InteractiveArtifactCoordinatorDependencies
  ) {}

  async cleanupExpiredInteractiveArtifacts(): Promise<void> {
    await this.cleanupExpiredApprovalCards();
    await this.cleanupExpiredMessageDetails();
    this.cleanupRetainedState();
  }

  async cleanupExpiredApprovalCards(): Promise<void> {
    const now = Date.now();
    const approvals = this.context.stateStore
      .listPendingApprovals()
      .filter((approval) => approval.status === "pending" && Date.parse(approval.expiresAt) <= now);

    for (const approval of approvals) {
      this.context.stateStore.setPendingApprovalStatus(approval.token, "expired");
      const bridge = this.context.stateStore.getThreadBridge(approval.threadId);
      if (!bridge || !approval.discordMessageId) {
        continue;
      }
      try {
        await this.context.provider.disableApprovalCard(
          bridge.discordChannelId,
          approval.discordMessageId,
          "\u23F0 Approval expired",
          this.deps.buildApprovalCardView(approval)
        );
      } catch (error) {
        this.context.logger.warn(
          { error, approvalToken: approval.token, channelId: bridge.discordChannelId },
          "Failed to disable an expired approval card."
        );
      }
    }
  }

  async cleanupExpiredMessageDetails(): Promise<void> {
    const expired = this.context.stateStore.listExpiredMessageDetails(new Date().toISOString());
    if (expired.length === 0) {
      return;
    }

    const affectedMessages = new Map<string, { threadId: string; messageId: string }>();
    for (const detail of expired) {
      if (detail.discordMessageId) {
        affectedMessages.set(detail.discordMessageId, {
          threadId: detail.threadId,
          messageId: detail.discordMessageId
        });
      }
      this.context.stateStore.deleteMessageDetail(detail.token);
    }

    for (const affected of affectedMessages.values()) {
      const bridge = this.context.stateStore.getThreadBridge(affected.threadId);
      if (!bridge) {
        continue;
      }
      const remainingButtons = this.context.stateStore
        .listMessageDetailsByDiscordMessageId(affected.messageId)
        .filter((detail) => Date.parse(detail.expiresAt) > Date.now())
        .map((detail) => ({
          token: detail.token,
          label: detail.buttonLabel
        }));
      try {
        await this.context.provider.updateMessageDetailsButtons(
          bridge.discordChannelId,
          affected.messageId,
          remainingButtons
        );
      } catch (error) {
        if (!this.deps.isUnknownDiscordChannelError(error)) {
          this.context.logger.warn(
            { error, threadId: affected.threadId, messageId: affected.messageId },
            "Failed to update message detail buttons after expiration."
          );
        }
      }
    }
  }

  cleanupRetainedState(): void {
    const now = Date.now();
    this.context.stateStore.deleteInactiveApprovalsOlderThan(
      new Date(now - INACTIVE_APPROVAL_RETENTION_MS).toISOString()
    );
    this.context.stateStore.deleteAuditLogOlderThan(
      new Date(now - AUDIT_LOG_RETENTION_MS).toISOString()
    );
  }
}
