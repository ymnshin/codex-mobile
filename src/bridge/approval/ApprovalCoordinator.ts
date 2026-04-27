import type {
  ApprovalCardView,
  ApprovalDecision,
  CodexServerRequest,
  DiscordCommandResult,
  PendingApprovalRecord,
  ToolUserInputRequest,
  ToolUserInputState
} from "../../domain.js";
import type {
  DesktopIpcApprovalRemovedSnapshot,
  DesktopIpcApprovalRequestSnapshot
} from "../../codex/CodexDesktopIpcClient.js";
import type { ProviderActorContext } from "../../providers/types.js";
import {
  canRenderDiscordToolInput,
  canRenderDiscordApprovalDecisions,
  supportsApprovalFeedback,
  TELL_CODEX_DIFFERENTLY_LABEL
} from "../../util/approvalDecisions.js";
import { renderApprovalDetails, shortThreadId } from "../../util/formatting.js";
import { redactSensitiveText } from "../../util/redaction.js";
import { withLogScope } from "../../util/terminalLogging.js";
import {
  APPROVAL_SESSION_SETTLE_DELAY_MS,
  APPROVAL_SESSION_SETTLE_PASSES,
  type BridgeRuntimeContext
} from "../runtime/BridgeRuntimeContext.js";
import type { BridgeRuntimeState } from "../runtime/BridgeRuntimeState.js";
import {
  buildApprovalRecordFromServerRequest,
  createPendingApprovalRecord,
  formatApprovalDecisionResolution,
  resolveFeedbackDecision
} from "./approvalModel.js";
import { markThreadTurnInProgress } from "../runtime/BridgeRuntimeState.js";
import {
  persistEffectiveApprovalRecord,
  resolveReusableRequestApprovalRecord
} from "./approvalPersistence.js";
import {
  isActionableReadOnlySessionLogApprovalPlaceholder,
  isReadOnlySessionLogApprovalPlaceholder,
  isRestartEnabledActionableReadOnlySessionLogApprovalPlaceholder
} from "./approvalPlaceholders.js";
import { canMarkApprovalStale } from "./approvalState.js";

interface ApprovalCoordinatorDependencies {
  appendCanonicalEvent(input: {
    threadId: string;
    source: "app-server" | "desktop-ipc";
    eventKind:
      | "approvalUpsert"
      | "approvalResolved"
      | "approvalHold"
      | "approvalRelease";
    itemKind?: string | null;
    turnId?: string | null;
    turnCursor?: string | null;
    itemId?: string | null;
    requestId?: string | null;
    summary?: string | null;
    detail?: string | null;
    createdAt?: string | null;
  }): void;
  canMirrorNonUserActivity(
    threadId: string,
    turnId?: string | null,
    turnCursor?: string | null
  ): boolean;
  closeCommandActivityGroup(threadId: string): void;
  delay(milliseconds: number): Promise<void>;
  drainThreadEventQueue(threadIds?: Iterable<string>): Promise<void>;
  ensureThreadStateForRequest(threadId: string, preferredName: string): Promise<import("../../domain.js").ThreadRuntimeState>;
  enqueueThreadEvent(threadId: string, work: () => Promise<void>): Promise<void>;
  extractStableTimestampMs(input: unknown): number | null;
  flushPendingCommentaryBeforeApproval(threadId: string): Promise<void>;
  handleSessionEvent(event: import("../../codex/CodexSessionEventTailer.js").CodexSessionEvent): Promise<void>;
  pollDesktopApprovalEvents(): Promise<Set<string>>;
  pollLocalSessionEvents(): Promise<Set<string>>;
  persistThreadState(state: import("../../domain.js").ThreadRuntimeState): void;
  printProgress(message: string): void;
  queueStatusUpdate(threadId: string): void;
  resolveMirroredActorName(threadId: string | null): string;
  shouldPreferSessionStreamForThread(threadId: string): boolean;
  steerTurnInternally(threadId: string, turnId: string, text: string): Promise<string>;
  updateStateLastActivityAt(
    state: import("../../domain.js").ThreadRuntimeState,
    timestampMs: number | null | undefined
  ): void;
}

export class ApprovalCoordinator {
  private readonly deferredRequestsById = new Map<string, CodexServerRequest>();

  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: ApprovalCoordinatorDependencies
  ) {}

  async handleServerRequest(request: CodexServerRequest): Promise<void> {
    const resolvedRequest = await this.enrichRequestWithThreadHint(request);
    const requestId = String(resolvedRequest.id);
    const threadId = this.resolveThreadIdForRequest(requestId, resolvedRequest.params);
    const effectiveRequest = threadId ? this.withThreadHint(resolvedRequest, threadId) : resolvedRequest;
    const work = async () => {
      this.context.logger.info({ method: request.method, requestId }, "Received app-server request.");
      await this.presentApprovalRequest(effectiveRequest);
    };
    if (!threadId) {
      this.deferRequestIfNeeded(requestId, resolvedRequest);
      return;
    }
    this.clearDeferredApprovalRequest(requestId);
    await this.deps.enqueueThreadEvent(threadId, work);
  }

  async handleDesktopIpcRequestUpserted(snapshot: DesktopIpcApprovalRequestSnapshot): Promise<void> {
    this.clearDeferredApprovalRequest(snapshot.requestId);
    await this.deps.enqueueThreadEvent(snapshot.threadId, async () => {
      await this.presentApprovalRequest(this.withThreadHint(snapshot.request, snapshot.threadId), "desktop-ipc");
    });
  }

  async handleDesktopIpcRequestRemoved(snapshot: DesktopIpcApprovalRemovedSnapshot): Promise<void> {
    this.clearDeferredApprovalRequest(snapshot.requestId);
    await this.deps.enqueueThreadEvent(snapshot.threadId, async () => {
      this.runtime.desktopRequestThreadHints.delete(snapshot.requestId);
      const approval = this.context.stateStore.findPendingApprovalByRequestId(snapshot.requestId);
      this.deps.appendCanonicalEvent({
        threadId: snapshot.threadId,
        source: "desktop-ipc",
        eventKind: "approvalRelease",
        requestId: snapshot.requestId,
        summary: "Desktop IPC approval request was removed from the live thread state.",
        detail: snapshot.request?.method ?? null
      });
      if (approval && canMarkApprovalStale(approval.status, approval.restartDisabledAt ?? null)) {
        this.context.stateStore.setPendingApprovalStatus(approval.token, "stale");
        await this.disableResolvedApprovalCard(approval, "No longer pending in Codex Desktop");
        this.clearWaitingOnApproval(approval.threadId, null);
      } else if (approval) {
        this.clearWaitingOnApproval(approval.threadId, null);
      }
      this.context.logger.debug(
        { threadId: snapshot.threadId, requestId: snapshot.requestId, method: snapshot.request?.method ?? null },
        "Desktop IPC request was removed from the live thread state."
      );
    });
  }

  async handleThreadHintAvailable(requestId: string): Promise<void> {
    const deferred = this.deferredRequestsById.get(requestId);
    if (!deferred) {
      return;
    }
    const existing = this.context.stateStore.findPendingApprovalByRequestId(requestId);
    if (existing && !existing.restartDisabledAt) {
      this.clearDeferredApprovalRequest(requestId);
      return;
    }

    const threadId = this.runtime.desktopRequestThreadHints.get(requestId);
    if (!threadId) {
      return;
    }

    this.context.logger.debug(
      { requestId, threadId, method: deferred.method },
      "Replaying deferred approval request after a thread hint became available."
    );
    this.clearDeferredApprovalRequest(requestId);
    await this.handleServerRequest(this.withThreadHint(deferred, threadId));
  }

  async handleCommandExecutionPlaceholderAvailable(callId: string): Promise<void> {
    for (const [requestId, request] of this.deferredRequestsById.entries()) {
      if (request.method !== "execCommandApproval") {
        continue;
      }
      if (this.extractCallIdFromRequestParams(request.params as Record<string, unknown>) !== callId) {
        continue;
      }

      const threadId = this.findThreadIdFromPendingCommandPlaceholder(callId);
      if (!threadId) {
        continue;
      }

      this.context.logger.debug(
        { requestId, callId, threadId },
        "Replaying deferred exec approval request after a matching local shell placeholder became available."
      );
      this.clearDeferredApprovalRequest(requestId);
      await this.handleServerRequest(this.withThreadHint(request, threadId));
    }
  }

  clearDeferredApprovalRequest(requestId: string): void {
    this.deferredRequestsById.delete(requestId);
  }

  async handleApprovalAction(
    actor: ProviderActorContext | string,
    token: string,
    decision: ApprovalDecision
  ): Promise<DiscordCommandResult> {
    try {
      const actorContext = this.normalizeActorContext(actor);
      this.context.policy.ensureApprovalsEnabled();
      this.context.policy.ensureAuthorized(actorContext);
      const approval = this.context.policy.ensurePendingApproval(this.context.stateStore.findPendingApprovalByToken(token));
      this.context.policy.ensureAllowedDecision(approval, decision);
      const responsePayload =
        Object.prototype.hasOwnProperty.call(approval.decisionPayloads, decision)
          ? approval.decisionPayloads[decision]
          : decision;
      this.context.stateStore.setPendingApprovalStatus(token, "decisionSent");
      try {
        await this.respondToApprovalRequest(approval, decision, responsePayload);
      } catch (error) {
        this.context.stateStore.setPendingApprovalStatus(token, "pending");
        throw error;
      }
      try {
        this.context.stateStore.appendAuditLog({
          timestamp: new Date().toISOString(),
          discordUserId: actorContext.userId,
          threadId: approval.threadId,
          turnId: approval.turnId,
          requestId: approval.requestId,
          decision,
          sanitizedPreview: approval.sanitizedPreview
        });
        await this.disableResolvedApprovalCard(
          approval,
          formatApprovalDecisionResolution(decision, "Discord")
        );
      } catch (error) {
        this.context.logger.warn(
          { error, token, requestId: approval.requestId },
          "Approval decision was sent, but follow-up Discord updates failed."
        );
      }
      return { content: "", ephemeral: false };
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : "Failed to process this approval.",
        ephemeral: true
      };
    }
  }

  async handleToolInputOption(
    actor: ProviderActorContext | string,
    token: string,
    questionIndex: number,
    optionIndex: number
  ): Promise<DiscordCommandResult> {
    try {
      const approval = this.getAuthorizedToolInputApproval(actor, token);
      const question = approval.toolInput?.questions[questionIndex];
      const option = question?.options[optionIndex];
      if (!question || !option) {
        return { content: "This answer option is no longer available.", ephemeral: true };
      }
      if (option.isOther) {
        return { content: "Use the Other button to enter a custom answer.", ephemeral: true };
      }
      return await this.recordToolInputAnswer(approval, question.id, option.label, this.normalizeActorContext(actor));
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : "Failed to answer this Codex question.",
        ephemeral: true
      };
    }
  }

  async handleToolInputOther(
    actor: ProviderActorContext | string,
    token: string,
    questionIndex: number,
    answer: string
  ): Promise<DiscordCommandResult> {
    try {
      const approval = this.getAuthorizedToolInputApproval(actor, token);
      const question = approval.toolInput?.questions[questionIndex];
      if (!question) {
        return { content: "This question is no longer available.", ephemeral: true };
      }
      if (!question.options.some((option) => option.isOther)) {
        return { content: "This question does not accept a custom answer.", ephemeral: true };
      }
      const trimmedAnswer = answer.trim();
      if (!trimmedAnswer) {
        return { content: "Enter an answer before submitting.", ephemeral: true };
      }
      return await this.recordToolInputAnswer(approval, question.id, trimmedAnswer, this.normalizeActorContext(actor));
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : "Failed to answer this Codex question.",
        ephemeral: true
      };
    }
  }

  async handleApprovalFeedback(
    actor: ProviderActorContext | string,
    token: string,
    feedback: string
  ): Promise<DiscordCommandResult> {
    try {
      const actorContext = this.normalizeActorContext(actor);
      this.context.policy.ensureApprovalsEnabled();
      this.context.policy.ensureAuthorized(actorContext);
      const approval = this.context.policy.ensurePendingApproval(this.context.stateStore.findPendingApprovalByToken(token));
      const trimmedFeedback = feedback.trim();
      if (!trimmedFeedback) {
        return {
          content: "Enter a short note for Codex before sending this rejection.",
          ephemeral: true
        };
      }

      const useDesktopFeedbackDecline =
        this.canRouteApprovalThroughDesktopIpc(approval) &&
        !Object.prototype.hasOwnProperty.call(approval.decisionPayloads, "decline") &&
        Object.prototype.hasOwnProperty.call(approval.decisionPayloads, "cancel");
      const useDesktopFeedbackSteer = this.canRouteFeedbackSteerThroughDesktopIpc(approval);
      const decision = useDesktopFeedbackDecline ? "decline" : resolveFeedbackDecision(approval);
      const responsePayload =
        useDesktopFeedbackDecline
          ? "decline"
          : Object.prototype.hasOwnProperty.call(approval.decisionPayloads, decision)
            ? approval.decisionPayloads[decision]
            : decision;
      const responseRoute = this.describeApprovalResponseRoute(approval);
      const feedbackRoute = this.describeFeedbackDeliveryRoute(approval, useDesktopFeedbackSteer);
      const decisionStartedAt = Date.now();
      this.deps.printProgress(
        withLogScope(
          "approval",
          `Sending decision ${decision} for ${approval.requestId} through ${responseRoute}; next step is ${feedbackRoute}.`
        )
      );
      this.context.stateStore.setPendingApprovalStatus(token, "decisionSent");

      try {
        await this.respondToApprovalRequest(approval, decision, responsePayload);
      } catch (error) {
        this.context.stateStore.setPendingApprovalStatus(token, "pending");
        throw error;
      }
      const decisionCompletedAt = Date.now();
      this.deps.printProgress(
        withLogScope(
          "steer",
          `Approval ${approval.requestId} decision ${decision} completed in ${decisionCompletedAt - decisionStartedAt}ms; starting ${feedbackRoute}.`
        )
      );

      let feedbackDelivered = false;
      let feedbackDeliveryFailed = false;
      let feedbackAttemptStartedAt: number | null = null;
      try {
        feedbackAttemptStartedAt = Date.now();
        if (approval.feedbackTurnId) {
          if (useDesktopFeedbackSteer) {
            await this.deps.steerTurnInternally(
              approval.threadId,
              approval.feedbackTurnId,
              trimmedFeedback
            );
            this.deps.printProgress(
              withLogScope(
                "steer",
                `Delivered feedback into turn ${approval.feedbackTurnId} for approval ${approval.requestId} in ${Date.now() - feedbackAttemptStartedAt}ms.`
              )
            );
          } else {
            const steeredTurnId = await this.steerAnchoredFeedbackViaAppServer(
              approval.threadId,
              approval.feedbackTurnId,
              trimmedFeedback
            );
            this.deps.printProgress(
              withLogScope(
                "steer",
                `Delivered feedback into turn ${steeredTurnId} for approval ${approval.requestId} in ${Date.now() - feedbackAttemptStartedAt}ms.`
              )
            );
          }
        } else {
          await this.context.codexAdapter.resumeThread(approval.threadId);
          await this.context.codexAdapter.startTurn(approval.threadId, trimmedFeedback);
          this.deps.printProgress(
            withLogScope(
              "steer",
              `Started feedback follow-up turn for approval ${approval.requestId} in ${Date.now() - feedbackAttemptStartedAt}ms.`
            )
          );
        }
        feedbackDelivered = true;
      } catch (error) {
        const feedbackAttemptDurationMs =
          feedbackAttemptStartedAt === null ? null : Date.now() - feedbackAttemptStartedAt;
        const decisionToFeedbackGapMs =
          feedbackAttemptStartedAt === null ? null : feedbackAttemptStartedAt - decisionCompletedAt;
        const feedbackErrorMessage = error instanceof Error ? error.message : String(error);
        if (approval.feedbackTurnId && this.canFallbackAnchoredFeedbackToFollowUpTurn(approval)) {
          this.context.logger.warn(
            {
              scope: "steer",
              error,
              errorMessage: feedbackErrorMessage,
              threadId: approval.threadId,
              requestId: approval.requestId,
              feedbackTurnId: approval.feedbackTurnId,
              responseRoute,
              feedbackRoute,
              decisionDurationMs: decisionCompletedAt - decisionStartedAt,
              decisionToFeedbackGapMs,
              feedbackAttemptDurationMs
            },
            withLogScope("steer", "Anchored approval feedback steer failed; attempting follow-up turn fallback.")
          );
          this.deps.printProgress(
            withLogScope(
              "steer",
              `Anchored feedback delivery for approval ${approval.requestId} failed after ${feedbackAttemptDurationMs ?? 0}ms (${feedbackErrorMessage}); attempting follow-up turn fallback.`
            )
          );
          const followUpStartedAt = Date.now();
          try {
            await this.context.codexAdapter.resumeThread(approval.threadId);
            await this.context.codexAdapter.startTurn(approval.threadId, trimmedFeedback);
            this.deps.printProgress(
              withLogScope(
                "steer",
                `Started feedback follow-up turn for approval ${approval.requestId} after steer delivery failed in ${Date.now() - followUpStartedAt}ms.`
              )
            );
            feedbackDelivered = true;
          } catch (followUpError) {
            feedbackDeliveryFailed = true;
            const followUpErrorMessage = followUpError instanceof Error ? followUpError.message : String(followUpError);
            this.context.logger.warn(
              {
                scope: "steer",
                error: followUpError,
                errorMessage: followUpErrorMessage,
                threadId: approval.threadId,
                requestId: approval.requestId,
                feedbackTurnId: approval.feedbackTurnId,
                responseRoute,
                feedbackRoute: "follow-up-turn",
                decisionDurationMs: decisionCompletedAt - decisionStartedAt,
                decisionToFeedbackGapMs,
                feedbackAttemptDurationMs,
                followUpAttemptDurationMs: Date.now() - followUpStartedAt
              },
              withLogScope("steer", "Failed to deliver approval feedback to Codex.")
            );
            this.deps.printProgress(
              withLogScope(
                "steer",
                `Feedback follow-up turn for approval ${approval.requestId} failed after ${Date.now() - followUpStartedAt}ms (${followUpErrorMessage}).`
              )
            );
          }
        } else {
          feedbackDeliveryFailed = true;
          this.context.logger.warn(
            {
              scope: "steer",
              error,
              errorMessage: feedbackErrorMessage,
              threadId: approval.threadId,
              requestId: approval.requestId,
              feedbackTurnId: approval.feedbackTurnId,
              responseRoute,
              feedbackRoute,
              decisionDurationMs: decisionCompletedAt - decisionStartedAt,
              decisionToFeedbackGapMs,
              feedbackAttemptDurationMs
            },
            withLogScope("steer", "Failed to deliver approval feedback to Codex.")
          );
          this.deps.printProgress(
            withLogScope(
              "steer",
              `Feedback delivery for approval ${approval.requestId} failed after ${feedbackAttemptDurationMs ?? 0}ms (${feedbackErrorMessage}).`
            )
          );
        }
      }

      try {
        this.context.stateStore.appendAuditLog({
          timestamp: new Date().toISOString(),
          discordUserId: actorContext.userId,
          threadId: approval.threadId,
          turnId: approval.turnId,
          requestId: approval.requestId,
          decision: `${decision}:withFeedback`,
          sanitizedPreview: approval.sanitizedPreview
        });

        await this.disableResolvedApprovalCard(
        approval,
        decision === "cancel"
          ? feedbackDelivered
            ? "⛔ Cancelled in Discord with feedback"
            : feedbackDeliveryFailed
              ? "⛔ Cancelled in Discord. Feedback could not be delivered."
              : "⛔ Cancelled in Discord"
          : feedbackDelivered
            ? "⛔ Rejected in Discord with feedback"
            : feedbackDeliveryFailed
              ? "⛔ Rejected in Discord. Feedback could not be delivered."
              : "⛔ Rejected in Discord"
        );
      } catch (error) {
        this.context.logger.warn(
          { error, token, requestId: approval.requestId, scope: "approval" },
          withLogScope("approval", "Approval feedback decision was sent, but follow-up Discord updates failed.")
        );
      }

      return {
        content: feedbackDeliveryFailed
          ? decision === "cancel"
            ? "Cancelled the request, but could not deliver your note back to Codex."
            : "Rejected the request, but could not deliver your note back to Codex."
          : "",
        ephemeral: true
      };
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : "Failed to reject this approval with feedback.",
        ephemeral: true
      };
    }
  }

  async handleApprovalDetails(actor: ProviderActorContext | string, token: string): Promise<DiscordCommandResult> {
    try {
      this.context.policy.ensureAuthorized(this.normalizeActorContext(actor));
      const approval = this.context.stateStore.findPendingApprovalByToken(token);
      if (!approval) {
        return { content: "This approval request could not be found.", ephemeral: true };
      }
      return { content: renderApprovalDetails(this.context.policy.buildApprovalDetails(approval)), ephemeral: true };
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : "Failed to load approval details.",
        ephemeral: true
      };
    }
  }

  async handleMessageDetails(actor: ProviderActorContext | string, token: string): Promise<DiscordCommandResult> {
    try {
      this.context.policy.ensureAuthorized(this.normalizeActorContext(actor));
      const details = this.context.stateStore.findMessageDetailByToken(token);
      if (!details) {
        return { content: "This detail entry could not be found.", ephemeral: true };
      }
      if (Date.parse(details.expiresAt) <= Date.now()) {
        return { content: "This detail entry has expired.", ephemeral: true };
      }
      return {
        content: this.context.policy.buildMessageDetails(details),
        ephemeral: true
      };
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : "Failed to load message details.",
        ephemeral: true
      };
    }
  }

  private getAuthorizedToolInputApproval(
    actor: ProviderActorContext | string,
    token: string
  ): PendingApprovalRecord {
    const actorContext = this.normalizeActorContext(actor);
    this.context.policy.ensureApprovalsEnabled();
    this.context.policy.ensureAuthorized(actorContext);
    const approval = this.context.policy.ensurePendingApproval(this.context.stateStore.findPendingApprovalByToken(token));
    if (approval.kind !== "toolUserInput" || !approval.toolInput) {
      throw new Error("This Codex question could not be found.");
    }
    return approval;
  }

  private async recordToolInputAnswer(
    approval: PendingApprovalRecord,
    questionId: string,
    answer: string,
    actor: ProviderActorContext
  ): Promise<DiscordCommandResult> {
    const updatedApproval = this.context.stateStore.setPendingApprovalToolInputSelection(
      approval.token,
      questionId,
      answer
    );
    if (!updatedApproval?.toolInput) {
      return { content: "This Codex question is no longer available.", ephemeral: true };
    }

    if (!this.isToolInputComplete(updatedApproval.toolInput)) {
      await this.refreshApprovalCard(updatedApproval);
      return { content: "", ephemeral: false };
    }

    const responsePayload = this.buildToolInputResponsePayload(updatedApproval.toolInput);
    this.context.stateStore.setPendingApprovalStatus(updatedApproval.token, "decisionSent");
    try {
      await this.respondToApprovalRequest(updatedApproval, "toolUserInput", responsePayload);
    } catch (error) {
      this.context.stateStore.setPendingApprovalStatus(updatedApproval.token, "pending");
      throw error;
    }

    try {
      this.context.stateStore.appendAuditLog({
        timestamp: new Date().toISOString(),
        discordUserId: actor.userId,
        threadId: updatedApproval.threadId,
        turnId: updatedApproval.turnId,
        requestId: updatedApproval.requestId,
        decision: "toolUserInput:answered",
        sanitizedPreview: updatedApproval.sanitizedPreview
      });
      await this.disableResolvedApprovalCard(updatedApproval, "Answered in Discord");
    } catch (error) {
      this.context.logger.warn(
        { error, token: updatedApproval.token, requestId: updatedApproval.requestId },
        "Tool input answer was sent, but follow-up Discord updates failed."
      );
    }

    return { content: "", ephemeral: false };
  }

  private isToolInputComplete(toolInput: ToolUserInputState): boolean {
    return toolInput.questions.every((question) => {
      const answer = toolInput.selectedAnswers[question.id];
      return typeof answer === "string" && answer.trim().length > 0;
    });
  }

  private buildToolInputResponsePayload(toolInput: ToolUserInputState): unknown {
    return {
      answers: Object.fromEntries(
        toolInput.questions.map((question) => [
          question.id,
          {
            answers: [toolInput.selectedAnswers[question.id] ?? ""]
          }
        ])
      )
    };
  }

  buildApprovalCardView(approval: PendingApprovalRecord): ApprovalCardView {
    return {
      ...this.context.policy.buildApprovalDetails(approval),
      sourceKind: this.resolveApprovalSourceKind(approval),
      actorLabel: this.deps.resolveMirroredActorName(approval.threadId)
    };
  }

  private async disableResolvedApprovalCard(
    approval: PendingApprovalRecord,
    resolutionText: string
  ): Promise<void> {
    const bridge = this.context.stateStore.getThreadBridge(approval.threadId);
    if (!bridge || !approval.discordMessageId) {
      return;
    }

    try {
      await this.context.provider.disableApprovalCard(
        bridge.discordChannelId,
        approval.discordMessageId,
        resolutionText,
        this.buildApprovalCardView(approval)
      );
    } catch (error) {
      this.context.logger.warn(
        {
          error,
          token: approval.token,
          requestId: approval.requestId,
          threadId: approval.threadId,
          channelId: bridge.discordChannelId,
          messageId: approval.discordMessageId
        },
        "Failed to disable resolved approval card."
      );
    }
  }

  private async refreshApprovalCard(approval: PendingApprovalRecord): Promise<void> {
    const bridge = this.context.stateStore.getThreadBridge(approval.threadId);
    if (!bridge || !approval.discordMessageId) {
      return;
    }

    try {
      const messageId = await this.context.provider.postApprovalCard(
        bridge.discordChannelId,
        approval.discordMessageId,
        this.buildApprovalCardView(approval)
      );
      this.context.stateStore.setPendingApprovalMessageId(approval.token, messageId);
    } catch (error) {
      this.context.logger.warn(
        {
          error,
          token: approval.token,
          requestId: approval.requestId,
          threadId: approval.threadId,
          channelId: bridge.discordChannelId,
          messageId: approval.discordMessageId
        },
        "Failed to refresh tool input card."
      );
    }
  }

  async mirrorApprovalCard(
    approvalRecord: PendingApprovalRecord,
    options: { timestampMs: number | null; drainSessionBacklog: boolean; existingMessageId: string | null }
  ): Promise<void> {
    if (options.drainSessionBacklog) {
      await this.drainSessionBacklogBeforeApproval(approvalRecord.threadId, options.timestampMs);
    }
    if (!this.deps.canMirrorNonUserActivity(approvalRecord.threadId, approvalRecord.turnId, null)) {
      return;
    }

    const state = await this.deps.ensureThreadStateForRequest(
      approvalRecord.threadId,
      approvalRecord.sanitizedPreview
    );
    markThreadTurnInProgress(state, approvalRecord.feedbackTurnId ?? approvalRecord.turnId);
    state.status = { type: "active", activeFlags: ["waitingOnApproval"] };
    state.latestCommandPreview = approvalRecord.sanitizedPreview;
    this.deps.updateStateLastActivityAt(state, options.timestampMs);
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(state.threadId);

    const bridge = this.context.stateStore.getThreadBridge(approvalRecord.threadId);
    if (!bridge) {
      return;
    }

    await this.deps.flushPendingCommentaryBeforeApproval(approvalRecord.threadId);
    this.deps.closeCommandActivityGroup(approvalRecord.threadId);

    const messageId = await this.context.provider.postApprovalCard(
      bridge.discordChannelId,
      options.existingMessageId,
      this.buildApprovalCardView(approvalRecord)
    );
    this.context.stateStore.setPendingApprovalMessageId(approvalRecord.token, messageId);
  }

  async retryPendingApprovalCardsForTurn(
    threadId: string,
    turnId: string | null,
    _turnCursor: string | null,
    timestampMs: number | null
  ): Promise<void> {
    if (!turnId) {
      return;
    }

    const approvals = this.context.stateStore
      .listPendingApprovals()
      .filter(
        (approval) =>
          approval.threadId === threadId &&
          approval.status === "pending" &&
          approval.restartDisabledAt === null &&
          approval.discordMessageId === null &&
          (approval.turnId === turnId || approval.feedbackTurnId === turnId)
      );

    for (const approval of approvals) {
      await this.mirrorApprovalCard(approval, {
        timestampMs: timestampMs ?? Date.parse(approval.createdAt),
        drainSessionBacklog: false,
        existingMessageId: null
      });
    }
  }

  private async presentApprovalRequest(
    request: CodexServerRequest,
    source: "app-server" | "desktop-ipc" = "app-server"
  ): Promise<void> {
    if (request.method === "item/tool/requestUserInput" || request.method === "tool/requestUserInput") {
      await this.handleToolUserInputRequest(request as ToolUserInputRequest);
      return;
    }

    const approvalRecord = buildApprovalRecordFromServerRequest(request, {
      policy: this.context.policy,
      extractStableTimestampMs: (input) => this.deps.extractStableTimestampMs(input),
      resolveThreadIdForRequest: (requestId, params) => this.resolveThreadIdForRequest(requestId, params)
    });
    if (!approvalRecord) {
      this.context.logger.info({ method: request.method, source }, "Ignoring unsupported approval request source.");
      return;
    }

    this.deps.printProgress(
      withLogScope(
        "approval",
        `Approval request ${approvalRecord.requestId} (${approvalRecord.kind}) for ${shortThreadId(approvalRecord.threadId)} via ${source}.`
      )
    );
    this.deps.appendCanonicalEvent({
      threadId: approvalRecord.threadId,
      source,
      eventKind: "approvalUpsert",
      itemKind: approvalRecord.kind,
      turnId: approvalRecord.turnId,
      itemId: approvalRecord.itemId,
      requestId: approvalRecord.requestId,
      summary: `Approval request ${approvalRecord.requestId} (${approvalRecord.kind}) arrived via ${source}.`,
      detail: approvalRecord.sanitizedPreview,
      createdAt: approvalRecord.createdAt
    });

    const existingByRequest = this.context.stateStore.findPendingApprovalByRequestId(approvalRecord.requestId);
    const { reusableExisting: reusableByRequest, shouldIgnoreReplay } =
      resolveReusableRequestApprovalRecord(existingByRequest);
    if (shouldIgnoreReplay) {
      this.context.logger.debug(
        { requestId: approvalRecord.requestId, status: existingByRequest?.status ?? null, source },
        "Ignoring already-resolved approval replay."
      );
      return;
    }
    const reusableExisting =
      reusableByRequest ?? this.findUpgradableSessionPlaceholder(approvalRecord);
    const effectiveNextRecord =
      reusableExisting && isReadOnlySessionLogApprovalPlaceholder(reusableExisting)
        ? this.preserveSessionPlaceholderAnchors(approvalRecord, reusableExisting)
        : approvalRecord;
    const effectiveApprovalRecord = persistEffectiveApprovalRecord(
      this.context.stateStore,
      effectiveNextRecord,
      reusableExisting
    );

    await this.mirrorApprovalCard(effectiveApprovalRecord, {
      timestampMs: Date.parse(effectiveApprovalRecord.createdAt),
      drainSessionBacklog: true,
      existingMessageId: effectiveApprovalRecord.discordMessageId
    });
  }

  private async handleToolUserInputRequest(request: ToolUserInputRequest): Promise<void> {
    const threadId = this.resolveThreadIdForRequest(String(request.id), request.params);
    if (!threadId) {
      this.context.logger.info({ method: request.method, params: request.params }, "Ignoring tool/requestUserInput without threadId.");
      return;
    }

    const questions = Array.isArray(request.params.questions)
      ? request.params.questions.filter(
          (question): question is NonNullable<ToolUserInputRequest["params"]["questions"]>[number] =>
            Boolean(question) && typeof question === "object" && typeof question.id === "string"
        )
      : [];
    const toolInput = this.normalizeToolInputQuestions(questions);
    const primaryQuestion = questions.length === 1 ? questions[0] : null;
    const questionOptions =
      primaryQuestion && Array.isArray(primaryQuestion.options)
        ? primaryQuestion.options
            .map((option) => (typeof option?.label === "string" ? option.label.trim() : ""))
            .filter((label): label is string => Boolean(label))
        : [];
    const decisionPayloads =
      primaryQuestion && questionOptions.length > 0
        ? Object.fromEntries(
            questionOptions.map((label) => [
              label,
              {
                answers: {
                  [primaryQuestion.id]: {
                    answers: [label]
                  }
                }
              }
            ])
          )
        : {};
    const availableDecisions = Object.keys(decisionPayloads);
    const previewSource =
      primaryQuestion?.question?.trim() ||
      primaryQuestion?.header?.trim() ||
      (questions.length > 0 ? "Tool input requested" : "Tool approval requested");
    const preview =
      questions.length > 1
        ? `${previewSource} (${questions.length} questions)`
        : previewSource;
    const details = redactSensitiveText(JSON.stringify(request.params, null, 2));
    const itemId =
      (typeof request.params.itemId === "string" && request.params.itemId) ||
      primaryQuestion?.id ||
      `tool-request:${String(request.id)}`;
    const turnId =
      (typeof request.params.turnId === "string" && request.params.turnId) ||
      itemId;
    const existingByRequest = this.context.stateStore.findPendingApprovalByRequestId(String(request.id));
    const { reusableExisting, shouldIgnoreReplay } = resolveReusableRequestApprovalRecord(existingByRequest);
    if (shouldIgnoreReplay) {
      this.context.logger.debug(
        { requestId: String(request.id), status: existingByRequest?.status ?? null },
        "Ignoring already-resolved tool approval replay."
      );
      return;
    }
    const approvalRecord = createPendingApprovalRecord(this.context.policy, {
      requestId: String(request.id),
      threadId,
      turnId,
      feedbackTurnId:
        typeof request.params.turnId === "string" && request.params.turnId
          ? request.params.turnId
          : null,
      itemId,
      kind: "toolUserInput",
      preview,
      cwd: null,
      reason:
        toolInput
          ? null
          : availableDecisions.length > 0
          ? null
          : questions.length > 1
            ? "This tool prompt requires multiple answers. Complete it in Codex Desktop."
            : "Complete this tool prompt in Codex Desktop.",
      availableDecisions,
      decisionPayloads,
      details,
      discordMessageId: reusableExisting?.discordMessageId ?? null,
      toolInput
    });
    if (
      approvalRecord.toolInput &&
      !canRenderDiscordToolInput({
        token: approvalRecord.token,
        toolInput: approvalRecord.toolInput
      })
    ) {
      approvalRecord.toolInput = null;
      approvalRecord.availableDecisions = [];
      approvalRecord.decisionPayloads = {};
      approvalRecord.reason = "This tool prompt can't be answered safely from Discord. Complete it in Codex Desktop.";
    }
    if (
      approvalRecord.availableDecisions.length > 0 &&
      !approvalRecord.toolInput &&
      !canRenderDiscordApprovalDecisions({
        token: approvalRecord.token,
        decisions: approvalRecord.availableDecisions,
        includeFeedback: supportsApprovalFeedback(approvalRecord.availableDecisions)
      })
    ) {
      approvalRecord.availableDecisions = [];
      approvalRecord.decisionPayloads = {};
      approvalRecord.reason = "This tool prompt can't be answered safely from Discord. Complete it in Codex Desktop.";
    }

    const effectiveApprovalRecord = persistEffectiveApprovalRecord(
      this.context.stateStore,
      approvalRecord,
      reusableExisting
    );

    await this.mirrorApprovalCard(effectiveApprovalRecord, {
      timestampMs: Date.parse(effectiveApprovalRecord.createdAt),
      drainSessionBacklog: true,
      existingMessageId: effectiveApprovalRecord.discordMessageId
    });
  }

  private normalizeToolInputQuestions(
    questions: NonNullable<ToolUserInputRequest["params"]["questions"]>
  ): ToolUserInputState | null {
    if (questions.length === 0) {
      return null;
    }

    const normalizedQuestions = questions.map((question, index) => {
      const explicitOptions = Array.isArray(question.options)
        ? question.options
            .map((option) => {
              const label = typeof option?.label === "string" ? option.label.trim() : "";
              if (!label) {
                return null;
              }
              return {
                label,
                description:
                  typeof option.description === "string" && option.description.trim().length > 0
                    ? option.description.trim()
                    : null,
                isOther: option.isOther === true || label.trim().toLowerCase() === "other"
              };
            })
            .filter((option): option is NonNullable<typeof option> => option !== null)
        : [];
      const options =
        explicitOptions.length > 0 &&
        explicitOptions.length < 5 &&
        !explicitOptions.some((option) => option.isOther)
          ? [
              ...explicitOptions,
              {
                label: TELL_CODEX_DIFFERENTLY_LABEL,
                description: null,
                isOther: true
              }
            ]
          : explicitOptions;
      return {
        id: question.id,
        header:
          typeof question.header === "string" && question.header.trim().length > 0
            ? question.header.trim()
            : null,
        question:
          question.question?.trim() ||
          question.header?.trim() ||
          `Question ${index + 1}`,
        options
      };
    });

    if (normalizedQuestions.some((question) => question.options.length === 0)) {
      return null;
    }

    return {
      questions: normalizedQuestions,
      selectedAnswers: {}
    };
  }

  private findUpgradableSessionPlaceholder(nextRecord: PendingApprovalRecord): PendingApprovalRecord | null {
    if (nextRecord.kind !== "commandExecution") {
      return null;
    }

    // Standalone CLI shell approvals only give the bridge a local session-log
    // placeholder. If a matching native approval request later arrives through
    // app-server, reuse the existing Discord card instead of posting a second one.
    const existing = this.context.stateStore.findPendingApprovalByItem(
      nextRecord.threadId,
      nextRecord.itemId,
      nextRecord.kind
    );
    if (!existing) {
      return null;
    }
    if (existing.requestId === nextRecord.requestId) {
      return existing;
    }
    if (!isActionableReadOnlySessionLogApprovalPlaceholder(existing)) {
      return null;
    }

    return existing;
  }

  private preserveSessionPlaceholderAnchors(
    nextRecord: PendingApprovalRecord,
    placeholder: PendingApprovalRecord
  ): PendingApprovalRecord {
    return {
      ...nextRecord,
      turnId:
        nextRecord.feedbackTurnId === null || nextRecord.feedbackTurnId === undefined
          ? placeholder.turnId || nextRecord.turnId
          : nextRecord.turnId,
      feedbackTurnId: nextRecord.feedbackTurnId ?? placeholder.feedbackTurnId ?? placeholder.turnId ?? null
    };
  }

  private withThreadHint(request: CodexServerRequest, threadId: string): CodexServerRequest {
    const params =
      request.params && typeof request.params === "object"
        ? ({ ...(request.params as Record<string, unknown>) })
        : {};

    if (typeof params.threadId !== "string" || params.threadId.trim().length === 0) {
      params.threadId = threadId;
    }
    if (typeof params.conversationId !== "string" || params.conversationId.trim().length === 0) {
      params.conversationId = threadId;
    }

    return {
      ...request,
      params
    };
  }

  private async enrichRequestWithThreadHint(request: CodexServerRequest): Promise<CodexServerRequest> {
    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};
    const requestId = String(request.id);
    if (this.extractThreadIdFromRequestParams(params)) {
      return request;
    }

    const hinted = await this.waitForThreadHint(request, requestId);
    return hinted ? this.withThreadHint(request, hinted) : request;
  }

  private async waitForThreadHint(request: CodexServerRequest, requestId: string): Promise<string | null> {
    const existingHint = this.runtime.desktopRequestThreadHints.get(requestId);
    if (existingHint) {
      return existingHint;
    }
    if (!this.requestCanUseLocalThreadHints(request)) {
      return null;
    }

    for (let pass = 0; pass < APPROVAL_SESSION_SETTLE_PASSES; pass += 1) {
      const polledThreadIds = await this.deps.pollLocalSessionEvents();
      this.mergeThreadIds(polledThreadIds, await this.deps.pollDesktopApprovalEvents());
      await this.deps.drainThreadEventQueue(polledThreadIds);

      const hinted = this.runtime.desktopRequestThreadHints.get(requestId);
      if (hinted) {
        this.context.logger.debug(
          { requestId, hintedThreadId: hinted, method: request.method, pass },
          "Recovered a thread hint for an app-server approval request from local session/desktop events."
        );
        return hinted;
      }

      const placeholderThreadId = this.findThreadIdFromPendingCommandPlaceholder(
        this.extractCallIdFromRequestParams(
          (request.params && typeof request.params === "object"
            ? request.params
            : {}) as Record<string, unknown>
        )
      );
      if (placeholderThreadId) {
        this.context.logger.debug(
          { requestId, hintedThreadId: placeholderThreadId, method: request.method, pass },
          "Recovered a thread id for an app-server exec approval request from a local session placeholder."
        );
        return placeholderThreadId;
      }

      if (pass < APPROVAL_SESSION_SETTLE_PASSES - 1) {
        await this.deps.delay(APPROVAL_SESSION_SETTLE_DELAY_MS);
      }
    }

    return null;
  }

  private requestCanUseLocalThreadHints(request: CodexServerRequest): boolean {
    return (
      request.method === "execCommandApproval" ||
      request.method === "item/permissions/requestApproval" ||
      request.method === "item/tool/requestUserInput" ||
      request.method === "tool/requestUserInput" ||
      request.method === "mcpServer/elicitation/request"
    );
  }

  private mergeThreadIds(target: Set<string>, source: Iterable<string>): void {
    for (const threadId of source) {
      target.add(threadId);
    }
  }

  private extractThreadIdFromRequestParams(params: Record<string, unknown>): string | null {
    const candidates = ["threadId", "conversationId", "thread_id", "conversation_id"];
    for (const candidate of candidates) {
      const value = params[candidate];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
    return null;
  }

  private extractCallIdFromRequestParams(params: Record<string, unknown>): string | null {
    const value = params.callId;
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  }

  private findThreadIdFromPendingCommandPlaceholder(callId: string | null): string | null {
    if (!callId) {
      return null;
    }

    const candidates = this.context.stateStore
      .listPendingApprovals()
      .filter(
        (record) =>
          record.kind === "commandExecution" &&
          record.itemId === callId &&
          isRestartEnabledActionableReadOnlySessionLogApprovalPlaceholder(record)
      );
    if (candidates.length === 1) {
      return candidates[0]?.threadId ?? null;
    }
    if (candidates.length > 1) {
      this.context.logger.warn(
        {
          callId,
          threadIds: candidates.map((candidate) => candidate.threadId)
        },
        "Could not resolve a unique thread id from matching session approval placeholders."
      );
    }
    return null;
  }

  private resolveThreadIdForRequest(requestId: string, params: Record<string, unknown>): string | null {
    const explicit = this.extractThreadIdFromRequestParams(params);
    if (explicit) {
      return explicit;
    }

    const hinted = this.runtime.desktopRequestThreadHints.get(requestId);
    if (hinted) {
      return hinted;
    }

    const placeholderThreadId = this.findThreadIdFromPendingCommandPlaceholder(
      this.extractCallIdFromRequestParams(params)
    );
    if (placeholderThreadId) {
      return placeholderThreadId;
    }

    this.context.logger.warn(
      { requestId, params },
      "Could not resolve a thread id for server request without an explicit or unambiguous hint."
    );
    return null;
  }

  private async drainSessionBacklogBeforeApproval(
    threadId: string,
    approvalTimestampMs: number | null
  ): Promise<void> {
    if (!this.deps.shouldPreferSessionStreamForThread(threadId)) {
      return;
    }

    const tailer = this.context.sessionEventTailer;
    let latestSeenTimestampMs: number | null = null;
    for (let pass = 0; pass < APPROVAL_SESSION_SETTLE_PASSES; pass += 1) {
      // Approval ordering is best-effort. Do not block approval mirroring on an
      // expensive recursive search for a child-thread session log that may not
      // exist yet until Codex Desktop opens that thread.
      const events = await tailer.pollThread(threadId, { allowFilesystemScan: false });
      for (const event of events) {
        if (typeof event.timestampMs === "number" && Number.isFinite(event.timestampMs)) {
          latestSeenTimestampMs =
            latestSeenTimestampMs === null
              ? event.timestampMs
              : Math.max(latestSeenTimestampMs, event.timestampMs);
        }
        await this.deps.handleSessionEvent(event);
      }

      const reachedApprovalBoundary =
        approvalTimestampMs === null ||
        (latestSeenTimestampMs !== null && latestSeenTimestampMs >= approvalTimestampMs);
      const finalPass = pass >= APPROVAL_SESSION_SETTLE_PASSES - 1;
      if (finalPass || events.length === 0 || reachedApprovalBoundary) {
        break;
      }

      await this.deps.delay(APPROVAL_SESSION_SETTLE_DELAY_MS);
    }
  }

  private normalizeActorContext(actor: ProviderActorContext | string): ProviderActorContext {
    if (typeof actor === "string") {
      return {
        userId: actor,
        roleIds: [],
        username: null
      };
    }
    return actor;
  }

  private deferRequestIfNeeded(requestId: string, request: CodexServerRequest): void {
    if (!this.requestCanUseLocalThreadHints(request)) {
      this.context.logger.info(
        { requestId, method: request.method },
        "Ignoring approval request without thread correlation because this method cannot recover local thread hints."
      );
      return;
    }

    this.deferredRequestsById.set(requestId, request);
    this.context.logger.info(
      { requestId, method: request.method },
      "Deferring approval request until a thread hint becomes available."
    );
  }

  private clearWaitingOnApproval(threadId: string, timestampMs: number | null): void {
    const state = this.runtime.threadState.get(threadId);
    if (!state || state.status.type !== "active") {
      return;
    }

    state.status = {
      type: "active",
      activeFlags: (state.status.activeFlags ?? []).filter((flag) => flag !== "waitingOnApproval")
    };
    this.deps.updateStateLastActivityAt(state, timestampMs);
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(state.threadId);
  }

  private async respondToApprovalRequest(
    approval: PendingApprovalRecord,
    decision: ApprovalDecision,
    responsePayload: unknown
  ): Promise<void> {
    if (this.context.desktopIpcClient?.isReady() && this.canRouteApprovalThroughDesktopIpc(approval)) {
      await this.respondToApprovalViaDesktopIpc(approval, decision, responsePayload);
      this.deps.printProgress(
        withLogScope("approval", `Sent decision ${decision} for ${approval.requestId} through Codex Desktop IPC.`)
      );
      return;
    }

    await this.context.codexAdapter.respondToServerRequest(approval.requestId, responsePayload);
    this.deps.printProgress(
      withLogScope("approval", `Sent decision ${decision} for ${approval.requestId} through app-server.`)
    );
  }

  private async steerAnchoredFeedbackViaAppServer(
    threadId: string,
    turnId: string,
    feedback: string
  ): Promise<string> {
    await this.context.codexAdapter.resumeThread(threadId);
    await this.context.codexAdapter.steerTurn(threadId, turnId, feedback);
    return turnId;
  }

  private resolveApprovalSourceKind(
    approval: PendingApprovalRecord
  ): "app-server" | "cli-session" | null {
    return (
      this.runtime.threadState.get(approval.threadId)?.sourceKind ??
      this.context.stateStore.getThreadBridge(approval.threadId)?.sourceKind ??
      null
    );
  }

  private canRouteApprovalThroughDesktopIpc(approval: PendingApprovalRecord): boolean {
    const desktopIpcClient = this.context.desktopIpcClient;
    if (!desktopIpcClient?.isReady()) {
      return false;
    }
    const sourceKind = this.resolveApprovalSourceKind(approval) ?? "app-server";
    if (sourceKind === "cli-session") {
      return false;
    }
    if (
      !desktopIpcClient.hasRequest(approval.threadId, approval.requestId) &&
      desktopIpcClient.getConversationState(approval.threadId) === null
    ) {
      return false;
    }
    return (
      approval.kind === "commandExecution" ||
      approval.kind === "fileChange" ||
      approval.kind === "toolUserInput" ||
      approval.kind === "mcpElicitation"
    );
  }

  private canRouteFeedbackSteerThroughDesktopIpc(approval: PendingApprovalRecord): boolean {
    const desktopIpcClient = this.context.desktopIpcClient;
    if (!desktopIpcClient?.isReady()) {
      return false;
    }

    const sourceKind = this.resolveApprovalSourceKind(approval) ?? "app-server";
    if (sourceKind === "cli-session") {
      return false;
    }

    return (
      desktopIpcClient.hasRequest(approval.threadId, approval.requestId) ||
      desktopIpcClient.getConversationState(approval.threadId) !== null
    );
  }

  private canFallbackAnchoredFeedbackToFollowUpTurn(approval: PendingApprovalRecord): boolean {
    return this.resolveApprovalSourceKind(approval) === "cli-session";
  }

  private describeApprovalResponseRoute(approval: PendingApprovalRecord): "Codex Desktop IPC" | "app-server" {
    return this.context.desktopIpcClient?.isReady() && this.canRouteApprovalThroughDesktopIpc(approval)
      ? "Codex Desktop IPC"
      : "app-server";
  }

  private describeFeedbackDeliveryRoute(
    approval: PendingApprovalRecord,
    useDesktopFeedbackSteer: boolean
  ): string {
    if (!approval.feedbackTurnId) {
      return "a new follow-up turn";
    }
    return useDesktopFeedbackSteer
      ? `Desktop anchored steer into turn ${approval.feedbackTurnId}`
      : `app-server anchored steer into turn ${approval.feedbackTurnId}`;
  }

  private async respondToApprovalViaDesktopIpc(
    approval: PendingApprovalRecord,
    decision: ApprovalDecision,
    responsePayload: unknown
  ): Promise<void> {
    const client = this.context.desktopIpcClient;
    if (!client) {
      throw new Error("Codex Desktop IPC is not available.");
    }

    const wrappedDecision =
      responsePayload && typeof responsePayload === "object" && "decision" in (responsePayload as Record<string, unknown>)
        ? (responsePayload as { decision: unknown }).decision
        : decision;

    switch (approval.kind) {
      case "commandExecution":
        await client.sendCommandApprovalDecision(approval.threadId, approval.requestId, wrappedDecision);
        return;
      case "fileChange":
        await client.sendFileApprovalDecision(approval.threadId, approval.requestId, wrappedDecision);
        return;
      case "toolUserInput":
        await client.submitUserInputResponse(approval.threadId, approval.requestId, responsePayload);
        return;
      case "mcpElicitation":
        await client.submitMcpElicitationResponse(approval.threadId, approval.requestId, responsePayload);
        return;
      default:
        await this.context.codexAdapter.respondToServerRequest(approval.requestId, responsePayload);
    }
  }
}
