import { randomBytes } from "node:crypto";
import type { ApprovalCardView, MessageDetailRecord, PendingApprovalRecord } from "../domain.js";
import {
  DEFAULT_APPROVAL_TTL_MINUTES,
  type BridgeApprovalsConfig,
  type BridgeMessageWriteBackConfig
} from "../config.js";
import type { ProviderActorContext } from "../providers/types.js";

export class Policy {
  private readonly approvalsConfig: BridgeApprovalsConfig;
  private readonly messageWriteBacksConfig: BridgeMessageWriteBackConfig;

  constructor(
    approvalsConfig: BridgeApprovalsConfig,
    messageWriteBacksConfig: BridgeMessageWriteBackConfig = {
      allowFromDiscord: approvalsConfig.allowFromDiscord,
      allowedUserIds: approvalsConfig.allowedUserIds
    }
  ) {
    this.approvalsConfig = approvalsConfig;
    this.messageWriteBacksConfig = messageWriteBacksConfig;
  }

  isAuthorizedActor(actor: ProviderActorContext): boolean {
    const allowedUsers = new Set(this.approvalsConfig.allowedUserIds);
    return allowedUsers.has(actor.userId);
  }

  isAuthorizedMessageWriteBackActor(actor: ProviderActorContext): boolean {
    const allowedUsers = new Set(this.approvalsConfig.allowedUserIds);
    return allowedUsers.has(actor.userId);
  }

  createOpaqueToken(): string {
    return randomBytes(18).toString("base64url");
  }

  createApprovalToken(): string {
    return this.createOpaqueToken();
  }

  expiresAt(from = Date.now()): Date {
    return new Date(from + (this.approvalsConfig.approvalTtlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES) * 60 * 1000);
  }

  ensureApprovalsEnabled(): void {
    if (!this.approvalsConfig.allowFromDiscord) {
      throw new Error("Discord approvals are disabled in bridge.config.json.");
    }
  }

  ensureMessageWriteBacksEnabled(): void {
    if (!this.messageWriteBacksConfig.allowFromDiscord) {
      throw new Error("Discord message write-backs are disabled in bridge.config.json.");
    }
  }

  ensureAuthorized(actor: ProviderActorContext): void {
    if (!this.isAuthorizedActor(actor)) {
      throw new Error("This Discord user is not allowed to approve Codex actions.");
    }
  }

  ensureCommandAuthorized(actor: ProviderActorContext): void {
    if (!this.isAuthorizedActor(actor)) {
      throw new Error("This Discord user is not allowed to control the Codex bridge.");
    }
  }

  ensureMessageWriteBackAuthorized(actor: ProviderActorContext): void {
    this.ensureMessageWriteBacksEnabled();
    if (!this.isAuthorizedMessageWriteBackActor(actor)) {
      throw new Error("This Discord user is not allowed to send Codex messages.");
    }
  }

  ensurePendingApproval(record: PendingApprovalRecord | undefined, now = Date.now()): PendingApprovalRecord {
    if (!record) {
      throw new Error("This approval request could not be found.");
    }

    if (record.status !== "pending" || record.restartDisabledAt) {
      throw new Error("This approval request is no longer active.");
    }

    if (new Date(record.expiresAt).getTime() <= now) {
      throw new Error("This approval request has expired.");
    }

    return record;
  }

  ensureAllowedDecision(record: PendingApprovalRecord, decision: string): void {
    if (!record.availableDecisions.includes(decision)) {
      throw new Error(`This approval request does not allow the \`${decision}\` decision.`);
    }
  }

  buildApprovalDetails(record: PendingApprovalRecord): ApprovalCardView {
    const hasInteractiveToolInput =
      record.kind === "toolUserInput" &&
      (record.toolInput?.questions.length ?? 0) > 0 &&
      record.reason === null;
    return {
      token: record.token,
      threadId: record.threadId,
      shortThreadId: record.threadId.slice(0, 8),
      kind: record.kind,
      createdAt: new Date(record.createdAt),
      availableDecisions: record.availableDecisions,
      actionsEnabled:
        this.approvalsConfig.allowFromDiscord &&
        record.status === "pending" &&
        !record.restartDisabledAt &&
        (record.availableDecisions.length > 0 || hasInteractiveToolInput),
      sanitizedPreview: record.sanitizedPreview,
      cwd: record.cwd,
      reason: record.reason,
      expiresAt: new Date(record.expiresAt),
      details: record.details,
      toolInput: record.toolInput ?? null,
      mentionText: this.approvalsConfig.mentionApprovers
        ? this.buildMentionText()
        : null,
      mentionUserIds: this.approvalsConfig.mentionApprovers
        ? this.approvalsConfig.allowedUserIds
        : []
    };
  }

  buildMessageDetails(record: MessageDetailRecord): string {
    return `**${record.title}**\n${record.detail}`;
  }

  private buildMentionText(): string | null {
    const userMentions = this.approvalsConfig.allowedUserIds.map((userId) => `<@${userId}>`);
    return userMentions.length > 0 ? userMentions.join(" ") : null;
  }
}
