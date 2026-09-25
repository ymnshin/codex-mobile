import type {
  DiscordCommandResult,
  ThreadBridgeRecord,
  ThreadRuntimeState,
  WriteBackQueueRecord
} from "../../domain.js";
import type { ProviderActorContext } from "../../providers/types.js";
import { shortThreadId, statusLabel } from "../../util/formatting.js";
import { formatStartupTimingMs } from "../../util/startupTiming.js";
import { withLogScope } from "../../util/terminalLogging.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import type {
  BridgeRuntimeState,
  CleanProgressReporter,
  HydrateThreadOptions
} from "../runtime/BridgeRuntimeState.js";
import {
  hasSteerableActiveTurn,
  markThreadTurnCompleted,
  markThreadTurnInProgress
} from "../runtime/BridgeRuntimeState.js";
import type { DesktopConversationState } from "../../codex/CodexDesktopIpcClient.js";
import { DesktopSteerPayloadBuilder, type DesktopSteerRestoreStateSource } from "./DesktopSteerPayloadBuilder.js";
import { EMPTY_QUEUE_RECOVERY, queueRetryDelay, WriteBackNotDispatchedError,
  type QueueRecoveryState, type QueuePauseReason, type WriteBackAvailability } from "../../codex/WriteBackAvailability.js";

type InternalSteerSource = "approval-feedback" | "internal" | "discord";
const WRITE_BACK_MAX_TEXT_LENGTH = 2000;
const PROPOSED_PLAN_ACTION_MAX_TEXT_LENGTH = 12000;
const WRITE_BACK_MAX_PENDING_PER_THREAD = 10;
const WRITE_BACK_PREVIEW_MAX_LENGTH = 180;
const BRIDGE_REMOTE_CLI_ORIGINATOR = "codex-mobile";

interface WriteBackTurnStartOptions {
  skipResumeForCliSession?: boolean;
}

interface ProviderCommandCoordinatorDependencies {
  clearQueuedStatusUpdate(threadId: string): void;
  cleanupThread(threadId: string, reason: string, progressReporter?: CleanProgressReporter): Promise<number>;
  drainThreadEventQueue(threadIds?: Iterable<string>): Promise<void>;
  detachThread(threadId: string): ThreadBridgeRecord | null;
  flushStatusUpdate(threadId: string): Promise<void>;
  hydrateThread(
    threadId: string,
    summary: import("../../domain.js").CodexThreadSummary,
    attachMode: "auto" | "manual",
    hydrateOptions?: HydrateThreadOptions
  ): Promise<import("../runtime/BridgeRuntimeState.js").HydratedThreadResult>;
  pollThreadSessionEvents(threadId: string): Promise<void>;
  persistThreadState(state: ThreadRuntimeState): void;
  printProgress(message: string): void;
  readLatestTurnBackfillTurnId(threadId: string): Promise<string | null>;
  queueStatusUpdate(threadId: string): void;
  resetBridge(progressReporter?: CleanProgressReporter): Promise<{
    deletedCategories: number;
    deletedLocations: number;
  }>;
}

export class ProviderCommandCoordinator {
  private readonly desktopSteerPayload: DesktopSteerPayloadBuilder;
  private readonly startingWriteBackThreads = new Set<string>();
  private readonly completedDuringWriteBackStarts = new Map<string, Set<string>>();

  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: ProviderCommandCoordinatorDependencies
  ) {
    this.desktopSteerPayload = new DesktopSteerPayloadBuilder({
      logger: context.logger,
      runtimeConfig: context.runtimeConfig,
      printProgress: deps.printProgress
    });
  }

  async handleStatusCommand(actor: ProviderActorContext): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const bridges = this.context.stateStore.listThreadBridgesByKind("conversation");
    if (bridges.length === 0) {
      return { content: "No Codex conversations are mapped yet." };
    }
    return {
      content: bridges
        .slice(0, 20)
        .map((bridge) => {
          const state = this.runtime.threadState.get(bridge.codexThreadId);
          const label = state ? statusLabel(state.status) : "Unknown";
          const items = this.context.stateStore.listWriteBackQueueItems(bridge.codexThreadId);
          const recovery = this.getQueueRecovery(bridge.codexThreadId);
          const counts = ["pending", "sending", "uncertain"].map((status) => `${status}: ${items.filter((item) => item.status === status).length}`).join(", ");
          return `\`${shortThreadId(bridge.codexThreadId)}\` ${bridge.projectName} ${label} <#${bridge.discordChannelId}>\n${counts}; pause: ${recovery.reason ?? "none"}; last: ${recovery.lastFailure ?? "none"}; retry: ${recovery.nextRetryAt ? new Date(recovery.nextRetryAt).toISOString() : "—"}`;
        })
        .join("\n").slice(0, 1900)
    };
  }

  async steerActiveTurnInternally(
    text: string,
    threadId: string
  ): Promise<DiscordCommandResult> {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return {
        content: "Steer text cannot be empty.",
        ephemeral: true
      };
    }

    const targetThreadId = threadId.trim();
    if (!targetThreadId) {
      return {
        content: "Thread id cannot be empty.",
        ephemeral: true
      };
    }

    return this.steerResolvedThread(targetThreadId, trimmedText, "internal");
  }

  async handleSendCommand(
    actor: ProviderActorContext,
    channelId: string,
    text: string,
    mode: "queue" | "steer",
    sourceDiscordMessageId?: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeMessageWriteBack(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const target = this.resolveMappedThreadFromChannel(channelId);
    if (!target.ok) {
      return target.result;
    }
    if (sourceDiscordMessageId && (
      mode !== "queue" || !/^\d{17,20}$/.test(sourceDiscordMessageId) ||
      !this.context.runtimeConfig.messageWriteBacks.plainTextChannelIds?.includes(channelId) ||
      !this.context.runtimeConfig.discovery.allowedThreadIds.includes(target.bridge.codexThreadId)
    )) {
      return { content: "Plain-text input is not enabled for this mapped conversation.", ephemeral: true };
    }

    const trimmedText = text.trim();
    const textError = this.validateWriteBackText(trimmedText);
    if (textError) {
      return textError;
    }

    if (mode === "steer") {
      return this.handleSteerWriteBack(actor, target.bridge, trimmedText);
    }

    return this.handleQueueWriteBack(actor, target.bridge, trimmedText, sourceDiscordMessageId);
  }

  async handleRetractCommand(
    actor: ProviderActorContext,
    channelId: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeMessageWriteBack(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const target = this.resolveMappedThreadFromChannel(channelId);
    if (!target.ok) {
      return target.result;
    }

    // Unconfirmed deliveries block FIFO. Retract acknowledges them without sending again.
    const uncertain = this.context.stateStore.retractUncertainWriteBackQueueItem(target.bridge.codexThreadId);
    const retracted = uncertain ?? this.context.stateStore.retractLatestPendingWriteBackQueueItem(target.bridge.codexThreadId);
    if (!retracted) {
      return {
        content: "There is no pending queued Codex message to retract in this channel.",
        ephemeral: true
      };
    }

    this.appendWriteBackCanonicalEvent(retracted, "writeBackRetracted", "Retracted queued Discord message.");
    return {
      content: uncertain ? "Unconfirmed queue entry withdrawn. This does not undo a turn that may already have started. Check Codex before posting it again."
        : this.formatWriteBackMessage("Retracted the latest pending queued message.", retracted.text),
      ephemeral: true
    };
  }

  async handleWriteBackButton(
    actor: ProviderActorContext,
    action: "retract" | "steer",
    queueItemId: number
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeMessageWriteBack(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    if (!Number.isSafeInteger(queueItemId) || queueItemId <= 0) {
      return {
        content: "This queued Codex message could not be found.",
        ephemeral: true
      };
    }

    if (action === "retract") {
      const retracted = this.context.stateStore.markWriteBackQueueItemRetracted(queueItemId);
      if (!retracted) {
        return {
          content: "This queued Codex message is no longer pending.",
          ephemeral: true
        };
      }
      this.appendWriteBackCanonicalEvent(retracted, "writeBackRetracted", "Retracted queued Discord message.");
      return {
        content: this.formatWriteBackMessage("Retracted queued message.", retracted.text),
        ephemeral: true
      };
    }

    const queued = this.context.stateStore.getWriteBackQueueItem(queueItemId);
    if (queued?.status === "pending") {
      const health = await this.context.codexAdapter.checkWriteBackAvailability();
      if (!health.ready) {
        await this.pauseQueue(queued.threadId, health);
        return { content: "Codex is unavailable; the queued message is preserved. Use /codex status.", ephemeral: true };
      }
    }
    const claimed = this.context.stateStore.claimWriteBackQueueItem(queueItemId);
    if (!claimed) {
      return {
        content: "This queued Codex message is no longer pending.",
        ephemeral: true
      };
    }

    try {
      this.context.stateStore.markWriteBackDispatchStarted(claimed.id);
      const steeredTurnId = await this.steerResolvedThreadOrThrow(claimed.threadId, claimed.text, "discord");
      this.context.stateStore.markWriteBackQueueItemSent(claimed.id);
      const sent = this.context.stateStore.getWriteBackQueueItem(claimed.id) ?? claimed;
      this.appendWriteBackCanonicalEvent(
        sent,
        "writeBackSent",
        `Steered active turn ${steeredTurnId} from queued Discord message.`
      );
      return {
        content: this.formatWriteBackMessage("Sent queued message to the active turn.", claimed.text),
        ephemeral: true
      };
    } catch (error) {
      const safe = error instanceof WriteBackNotDispatchedError || this.isInactiveSteerError(error);
      if (safe) this.context.stateStore.restoreWriteBackQueueItemPending(claimed.id, "connection");
      else this.context.stateStore.markWriteBackQueueItemUncertain(claimed.id);
      await this.pauseQueue(claimed.threadId, { ready: false, reason: safe ? "connection" : "uncertain" });
      return {
        content: safe ? "Codex did not accept the queued message. It remains pending; use /codex status."
          : "Delivery is unconfirmed. Automatic retry stopped; check Codex and use /codex retract.",
        ephemeral: true
      };
    }
  }

  async handleProposedPlanAction(
    actor: ProviderActorContext,
    token: string,
    action: "accept"
  ): Promise<DiscordCommandResult> {
    if (action !== "accept") {
      return { content: "This proposed-plan action is not available.", ephemeral: true };
    }
    return this.sendProposedPlanFollowUp(actor, token, "accepted");
  }

  async handleProposedPlanFeedback(
    actor: ProviderActorContext,
    token: string,
    feedback: string
  ): Promise<DiscordCommandResult> {
    const trimmedFeedback = feedback.trim();
    if (!trimmedFeedback) {
      return {
        content: "Enter a short note for Codex before sending this plan feedback.",
        ephemeral: true
      };
    }
    return this.sendProposedPlanFollowUp(actor, token, "feedbackSent", trimmedFeedback);
  }

  async drainNextQueuedWriteBackMessage(
    threadId: string,
    options: WriteBackTurnStartOptions = {}
  ): Promise<WriteBackQueueRecord | null> {
    if (this.isThreadBusy(threadId) || this.startingWriteBackThreads.has(threadId)) {
      return null;
    }

    this.startingWriteBackThreads.add(threadId);
    let claimed: WriteBackQueueRecord | null = null;
    try {
      const recovery = this.getQueueRecovery(threadId);
      if (recovery.nextRetryAt > Date.now()) return null;
      if (!this.context.stateStore.countPendingWriteBackQueueItems(threadId)) return null;
      const availability = await this.context.codexAdapter.checkWriteBackAvailability(recovery.reason === "auth");
      if (!availability.ready) { await this.pauseQueue(threadId, availability); return null; }
      if (this.isThreadBusy(threadId)) return null;
      claimed = this.context.stateStore.claimNextPendingWriteBackQueueItem(threadId);
      if (!claimed) return null;
      const mapped = this.context.stateStore.getThreadBridge(threadId);
      const allowedThreads = this.context.runtimeConfig.discovery?.allowedThreadIds ?? [];
      const sourceId = this.context.stateStore.getDiscordMessageIdForQueueItem(claimed.id);
      if (this.authorizeMessageWriteBack({ userId: claimed.actorUserId, roleIds: [], username: null }) ||
          mapped?.discordChannelId !== claimed.discordChannelId ||
          (allowedThreads.length > 0 && !allowedThreads.includes(threadId)) ||
          (sourceId && (!allowedThreads.includes(threadId) || !this.context.runtimeConfig.messageWriteBacks.plainTextChannelIds?.includes(claimed.discordChannelId)))) {
        this.context.stateStore.markWriteBackQueueItemFailed(claimed.id, "authorization_changed");
        return null;
      }
      const startedTurn = await this.startWriteBackTurn(claimed.threadId, claimed.text, options, claimed.id);
      if (!startedTurn?.alreadyCompleted) this.markWriteBackTurnStarted(claimed.threadId, startedTurn?.turnId);
      this.context.stateStore.markWriteBackQueueItemSent(claimed.id);
      this.clearQueuePause(threadId);
      const sent = this.context.stateStore.getWriteBackQueueItem(claimed.id) ?? claimed;
      this.appendWriteBackCanonicalEvent(sent, "writeBackSent", "Started new Codex turn from queued Discord message.");
      if (startedTurn?.inProgress && !startedTurn.alreadyCompleted) await this.reactToDiscordInput(sent, "🤔", true);
      return sent;
    } catch (error) {
      if (!claimed) { await this.pauseQueue(threadId, { ready: false, reason: "connection" }); return null; }
      // A timed-out/disconnected start might have executed. Health recovery is not delivery proof.
      const rejected = error instanceof WriteBackNotDispatchedError;
      if (rejected) this.context.stateStore.restoreWriteBackQueueItemPending(claimed.id, error.reason);
      else this.context.stateStore.markWriteBackQueueItemUncertain(claimed.id);
      const health = await this.context.codexAdapter.checkWriteBackAvailability(rejected && error.reason === "auth")
        .catch((): WriteBackAvailability => ({ ready: false, reason: "connection" }));
      await this.pauseQueue(threadId, rejected ? { ready: false, reason: error.reason, ...(health.retryAt ? { retryAt: health.retryAt } : {}) }
        : { ready: false, reason: "uncertain" });
      return this.context.stateStore.getWriteBackQueueItem(claimed.id) ?? null;
    } finally {
      this.startingWriteBackThreads.delete(threadId);
    }
  }

  getQueueRecovery(threadId: string): QueueRecoveryState {
    try {
      return { ...EMPTY_QUEUE_RECOVERY, ...JSON.parse(this.context.stateStore.getBridgeMetaValue(`queue_recovery:${threadId}`) ?? "{}") };
    } catch { return { ...EMPTY_QUEUE_RECOVERY }; }
  }

  private saveQueueRecovery(threadId: string, state: QueueRecoveryState): void {
    this.context.stateStore.setBridgeMetaValue(`queue_recovery:${threadId}`, JSON.stringify(state));
  }

  private clearQueuePause(threadId: string): void {
    const previous = this.getQueueRecovery(threadId);
    this.saveQueueRecovery(threadId, { ...previous, reason: null, nextRetryAt: 0, failures: 0 });
  }

  private async pauseQueue(threadId: string, availability: WriteBackAvailability): Promise<void> {
    const state = this.getQueueRecovery(threadId);
    const now = Date.now();
    const reason = availability.reason ?? "connection";
    const notify = now - state.lastNotifiedAt >= 300_000;
    this.saveQueueRecovery(threadId, { reason, lastFailure: reason, failures: state.failures + 1,
      nextRetryAt: reason === "uncertain" ? 0 : Math.max(now + queueRetryDelay(state.failures + 1), availability.retryAt ?? 0),
      lastNotifiedAt: notify ? now : state.lastNotifiedAt });
    this.context.logger.warn({ category: reason }, "Write-back queue paused; input retained.");
    if (!notify) return;
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge) return;
    const messages: Record<QueuePauseReason, string> = {
      auth: "Codex の認証を確認できないため、投稿を保存して待機しています。Desktop で認証が復旧すると自動再開します。",
      usage: "Codex の利用上限に達したため、投稿を保存して待機しています。上限リセット後に自動再確認します。",
      desktop: "Codex Desktop の会話への接続を待っています。投稿は保存済みで、接続復旧後に自動再開します。",
      connection: "Codex の接続・利用状況を確認できないため、投稿を保存して再接続を待っています。",
      uncertain: "Codex への送信結果を確認できません。重複実行を避けて自動再送を停止しました。Desktop を確認し、/codex retract で不明な受付を撤回してください。"
    };
    try { await this.context.provider.sendTextMessage(bridge.discordChannelId, `${messages[reason]}\n/codex status: 状態確認 /codex retry: 安全な保留分を再確認`); }
    catch { this.context.logger.warn({ category: "queue_notice_unavailable" }, "Queue notification unavailable; input retained."); }
  }

  async handleRetryCommand(actor: ProviderActorContext, channelId: string): Promise<DiscordCommandResult> {
    const denied = this.authorizeMessageWriteBack(actor);
    if (denied) return denied;
    const target = this.resolveMappedThreadFromChannel(channelId);
    if (!target.ok) return target.result;
    const threadId = target.bridge.codexThreadId;
    const previous = this.getQueueRecovery(threadId);
    // This only rechecks safe pending work; it never resets uncertain/sent items.
    this.saveQueueRecovery(threadId, { ...previous, nextRetryAt: 0 });
    await this.runQueueWatchdog(threadId);
    return { content: `Queue rechecked. pause: ${this.getQueueRecovery(threadId).reason ?? "none"}. Use /codex status for details.`, ephemeral: true };
  }

  async runQueueWatchdog(onlyThreadId?: string): Promise<void> {
    for (const bridge of this.context.stateStore.listThreadBridgesByKind("conversation")) {
      const threadId = bridge.codexThreadId;
      if (onlyThreadId && onlyThreadId !== threadId) continue;
      const config = this.context.runtimeConfig;
      if (!config.messageWriteBacks.allowFromDiscord || this.startingWriteBackThreads.has(threadId) ||
          (config.discovery.allowedThreadIds.length && !config.discovery.allowedThreadIds.includes(threadId))) continue;
      this.context.stateStore.recoverExpiredWriteBackClaims(threadId);
      const records = this.context.stateStore.listWriteBackQueueItems(threadId);
      if (records.some((item) => item.status === "uncertain")) {
        if (this.getQueueRecovery(threadId).reason !== "uncertain") await this.pauseQueue(threadId, { ready: false, reason: "uncertain" });
        continue;
      }
      if (!records.some((item) => item.status === "pending") || records.some((item) => item.status === "sending")) continue;
      const recovery = this.getQueueRecovery(threadId);
      if (recovery.nextRetryAt > Date.now()) continue;
      const health = await this.context.codexAdapter.checkWriteBackAvailability(recovery.reason === "auth");
      if (!health.ready) { await this.pauseQueue(threadId, health); continue; }
      try {
        // A read-only snapshot, never resume/take ownership merely to inspect idle state.
        const details = await this.context.codexAdapter.readThread(threadId, true);
        const latest = details.turns?.at(-1) as { id: string; status: string } | undefined;
        if (details.status.type === "active" || latest?.status === "inProgress") continue;
        const state = this.runtime.threadState.get(threadId);
        const tracked = state?.lastTurnId ?? bridge.lastTurnId;
        if (this.isThreadBusy(threadId)) {
          // Only the exact tracked turn's terminal evidence can clear a stale busy flag.
          if (!latest || latest.id !== tracked || !["completed", "interrupted", "failed"].includes(latest.status)) continue;
          if (state) { markThreadTurnCompleted(state, latest.status as "completed" | "interrupted" | "failed"); this.deps.persistThreadState(state); }
          else this.context.stateStore.upsertThreadBridge({ ...bridge, lastStatusType: "idle", lastTurnStatus: "completed" });
          await this.finishDiscordInputTurn(threadId, latest.id);
        } else if (details.status.type !== "idle" && !latest) continue;
        await this.drainNextQueuedWriteBackMessage(threadId, { skipResumeForCliSession: true });
      } catch { await this.pauseQueue(threadId, { ready: false, reason: "connection" }); }
    }
  }

  async finishDiscordInputTurn(threadId: string, turnId: string): Promise<void> {
    this.completedDuringWriteBackStarts.get(threadId)?.add(turnId);
    for (const record of this.context.stateStore.listDiscordMessageQueueItemsForTurn(threadId, turnId)) {
      await this.reactToDiscordInput(record, "🤔", false);
    }
  }

  private async reactToDiscordInput(record: WriteBackQueueRecord, reaction: "📨" | "🤔", present: boolean): Promise<void> {
    const config = this.context.runtimeConfig;
    const bridge = this.context.stateStore.getThreadBridge(record.threadId);
    if (!this.context.provider.setInputReaction || !config.messageWriteBacks.allowFromDiscord ||
        !config.messageWriteBacks.allowedUserIds.includes(record.actorUserId) ||
        !config.messageWriteBacks.plainTextChannelIds?.includes(record.discordChannelId) ||
        !config.discovery.allowedThreadIds.includes(record.threadId) ||
        bridge?.discordChannelId !== record.discordChannelId) return;
    const messageId = this.context.stateStore.getDiscordMessageIdForQueueItem(record.id);
    if (!messageId) return;
    if (reaction === "🤔" && !this.context.stateStore.claimDiscordInputThinkingReaction(record.id, present)) return;
    try {
      await this.context.provider.setInputReaction(record.discordChannelId, messageId, reaction, present);
    } catch {
      this.context.logger.warn({ queueId: record.id, reaction, present }, "Input reaction unavailable; write-back processing continues.");
    }
  }

  private async handleQueueWriteBack(
    actor: ProviderActorContext,
    bridge: ThreadBridgeRecord,
    trimmedText: string,
    sourceDiscordMessageId?: string
  ): Promise<DiscordCommandResult> {
    if (sourceDiscordMessageId && this.context.stateStore.hasDiscordMessageInput(sourceDiscordMessageId)) {
      return { content: "", ephemeral: true };
    }
    const pendingBefore = this.context.stateStore.countPendingWriteBackQueueItems(bridge.codexThreadId);
    if (pendingBefore >= WRITE_BACK_MAX_PENDING_PER_THREAD) {
      return {
        content: `This Codex thread already has ${WRITE_BACK_MAX_PENDING_PER_THREAD} pending queued message(s). Retract one before queueing another.`,
        ephemeral: true
      };
    }

    const input = {
      threadId: bridge.codexThreadId,
      discordChannelId: bridge.discordChannelId,
      actorUserId: actor.userId,
      text: trimmedText
    };
    const queued = sourceDiscordMessageId
      ? this.context.stateStore.createDiscordMessageQueueItemOnce(sourceDiscordMessageId, input)
      : this.context.stateStore.createWriteBackQueueItem(input);
    if (!queued) return { content: "", ephemeral: true };
    this.appendWriteBackCanonicalEvent(queued, "writeBackQueued", "Queued Discord message for Codex.");
    await this.reactToDiscordInput(queued, "📨", true);

    const busy = this.isThreadBusy(bridge.codexThreadId);
    if (!busy) {
      const sent = await this.drainNextQueuedWriteBackMessage(bridge.codexThreadId, {
        skipResumeForCliSession: true
      });
      if (sent?.id === queued.id && sent.status === "sent") {
        return {
          content: this.formatWriteBackMessage("Started a new Codex turn.", queued.text),
          ephemeral: true
        };
      }
      if (sent?.id === queued.id && sent.status === "uncertain") {
        return {
          content: "送信結果が不明なため自動再送を停止しました。/codex status を確認してください。",
          ephemeral: true
        };
      }
    }

    const position = this.context.stateStore
      .listWriteBackQueueItems(bridge.codexThreadId)
      .filter((record) => record.status === "pending")
      .findIndex((record) => record.id === queued.id) + 1;
    const canSteer = this.isThreadSteerable(bridge.codexThreadId);
    return {
      content:
        position > 0
          ? this.formatWriteBackMessage(`Queued for the next turn. Position ${position}.`, queued.text)
          : this.formatWriteBackMessage("Queued for the next turn.", queued.text),
      ephemeral: true,
      buttons: this.buildWriteBackButtons(queued, canSteer)
    };
  }

  private async sendProposedPlanFollowUp(
    actor: ProviderActorContext,
    token: string,
    completionStatus: "accepted" | "feedbackSent",
    feedback?: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizePlanAction(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const existing = this.context.stateStore.findProposedPlanActionByToken(token);
    if (!existing) {
      return { content: "This proposed plan could not be found.", ephemeral: true };
    }
    if (Date.parse(existing.expiresAt) <= Date.now()) {
      return { content: "This proposed plan action has expired.", ephemeral: true };
    }
    if (existing.status !== "pending") {
      return {
        content: "This proposed plan has already been answered.",
        ephemeral: true
      };
    }

    const claimed = this.context.stateStore.claimPendingProposedPlanAction(token);
    if (!claimed) {
      return {
        content: "This proposed plan has already been answered.",
        ephemeral: true
      };
    }

    const bridge = this.context.stateStore.getThreadBridge(claimed.threadId);
    if (!bridge?.discordChannelId) {
      this.context.stateStore.restoreProposedPlanActionPending(token, "Mapped Discord channel was not found.");
      return {
        content: "This proposed plan is not attached to a mapped Discord channel anymore.",
        ephemeral: true
      };
    }

    const outboundText =
      completionStatus === "accepted"
        ? `PLEASE IMPLEMENT THIS PLAN:\n${claimed.planText.trim()}`
        : this.formatProposedPlanFeedback(feedback ?? "");
    const trimmedText = outboundText.trim();
    const textError = this.validateWriteBackText(trimmedText, PROPOSED_PLAN_ACTION_MAX_TEXT_LENGTH);
    if (textError) {
      this.context.stateStore.restoreProposedPlanActionPending(token, textError.content);
      return textError;
    }

    try {
      if (completionStatus === "feedbackSent") {
        if (claimed.turnId) {
          try {
            const steeredTurnId = await this.steerTurnInternally(claimed.threadId, claimed.turnId, trimmedText);
            this.context.stateStore.completeProposedPlanAction(token, completionStatus);
            await this.disableCompletedProposedPlanButtons(claimed, bridge.discordChannelId);
            this.appendWriteBackCanonicalEvent(
              {
                id: 0,
                threadId: claimed.threadId,
                discordChannelId: bridge.discordChannelId,
                actorUserId: actor.userId,
                text: trimmedText,
                status: "sent",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                sentAt: new Date().toISOString(),
                error: null
              },
              "writeBackSent",
              `Steered proposed-plan feedback into turn ${steeredTurnId}.`
            );
            return {
              content: this.formatWriteBackMessage("Sent plan feedback to Codex.", trimmedText),
              ephemeral: true
            };
          } catch (error) {
            if (!this.isInactiveSteerError(error)) {
              throw error;
            }
            this.context.logger.info(
              { error, token, threadId: claimed.threadId, turnId: claimed.turnId },
              "Proposed-plan feedback could not steer the original turn; falling back to a follow-up turn."
            );
          }
        }

        const fallbackResult = await this.handleQueueWriteBack(actor, bridge, trimmedText);
        if (!this.isAcceptedWriteBackResult(fallbackResult)) {
          this.context.stateStore.restoreProposedPlanActionPending(token, fallbackResult.content);
          return fallbackResult;
        }
        this.context.stateStore.completeProposedPlanAction(token, completionStatus);
        await this.disableCompletedProposedPlanButtons(claimed, bridge.discordChannelId);
        return {
          ...fallbackResult,
          content: this.formatProposedPlanFollowUpResult("Sent plan feedback to Codex.", fallbackResult)
        };
      }

      const result = await this.handleQueueWriteBack(actor, bridge, trimmedText);
      if (!this.isAcceptedWriteBackResult(result)) {
        this.context.stateStore.restoreProposedPlanActionPending(token, result.content);
        return result;
      }
      this.context.stateStore.completeProposedPlanAction(token, completionStatus);
      await this.disableCompletedProposedPlanButtons(claimed, bridge.discordChannelId);
      return {
        ...result,
        content:
          completionStatus === "accepted"
            ? this.formatProposedPlanFollowUpResult("Accepted the proposed plan.", result)
            : this.formatProposedPlanFollowUpResult("Sent plan feedback to Codex.", result)
      };
    } catch (error) {
      const errorMessage = this.formatErrorMessage(error, "Failed to send proposed-plan response.");
      this.context.stateStore.restoreProposedPlanActionPending(token, errorMessage);
      return {
        content: errorMessage,
        ephemeral: true
      };
    }
  }

  private formatProposedPlanFeedback(feedback: string): string {
    return `Please revise the proposed plan based on this feedback:\n${feedback.trim()}`;
  }

  private formatProposedPlanFollowUpResult(prefix: string, result: DiscordCommandResult): string {
    const startedTurnPrefix = "Started a new Codex turn.";
    const content = result.content.startsWith(`${startedTurnPrefix}\n`)
      ? result.content.slice(startedTurnPrefix.length + 1)
      : result.content === startedTurnPrefix
        ? ""
        : result.content;
    const trimmedContent = content.trim();
    return trimmedContent ? `${prefix}\n${trimmedContent}` : prefix;
  }

  private async handleSteerWriteBack(
    actor: ProviderActorContext,
    bridge: ThreadBridgeRecord,
    trimmedText: string
  ): Promise<DiscordCommandResult> {
    const threadId = bridge.codexThreadId;
    if (!this.isThreadBusy(threadId)) {
      return {
        content: "This Codex thread is idle. Omit `mode` or use `mode:queue` to start a new turn.",
        ephemeral: true
      };
    }

    try {
      await this.steerResolvedThreadOrThrow(threadId, trimmedText, "discord");
      this.appendWriteBackCanonicalEvent(
        {
          id: 0,
          threadId,
          discordChannelId: bridge.discordChannelId,
          actorUserId: actor.userId,
          text: trimmedText,
          status: "sent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sentAt: new Date().toISOString(),
          error: null
        },
        "writeBackSent",
        "Steered active turn from Discord message."
      );
      return {
        content: this.formatWriteBackMessage("Sent to the active turn.", trimmedText),
        ephemeral: true
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `There is no active Codex turn to steer in thread \`${threadId}\`.`
      ) {
        return {
          content: error.message,
          ephemeral: true
        };
      }
      return {
        content:
          error instanceof Error
            ? `Failed to steer Codex thread \`${threadId}\`: ${error.message}`
            : `Failed to steer Codex thread \`${threadId}\`.`,
        ephemeral: true
      };
    }
  }

  private resolveMappedThreadFromChannel(
    channelId: string
  ): { ok: true; bridge: ThreadBridgeRecord } | { ok: false; result: DiscordCommandResult } {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) {
      return {
        ok: false,
        result: {
          content: "This command must be used from a mapped Codex Discord channel.",
          ephemeral: true
        }
      };
    }

    const bridge = this.context.stateStore.findThreadBridgeByDiscordChannelId(normalizedChannelId);
    if (!bridge) {
      return {
        ok: false,
        result: {
          content: "This Discord channel is not mapped to a Codex thread.",
          ephemeral: true
        }
      };
    }

    return { ok: true, bridge };
  }

  private validateWriteBackText(
    trimmedText: string,
    maxLength = WRITE_BACK_MAX_TEXT_LENGTH
  ): DiscordCommandResult | null {
    if (!trimmedText) {
      return {
        content: "Message text cannot be empty.",
        ephemeral: true
      };
    }
    if (trimmedText.length > maxLength) {
      return {
        content: `Message text is too long. Keep it at or below ${maxLength} characters.`,
        ephemeral: true
      };
    }
    return null;
  }

  private isAcceptedWriteBackResult(result: DiscordCommandResult): boolean {
    return (
      result.content.startsWith("Started a new Codex turn.") ||
      result.content.startsWith("Queued for the next turn.")
    );
  }

  private isInactiveSteerError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    return message.includes("active turn already ended") || message.includes("no active codex turn to steer");
  }

  private async disableCompletedProposedPlanButtons(
    record: { token: string; discordMessageId: string | null },
    discordChannelId: string
  ): Promise<void> {
    if (!record.discordMessageId) {
      return;
    }

    try {
      const detailButtons = this.context.stateStore
        .listMessageDetailsByDiscordMessageId(record.discordMessageId)
        .map((detail) => ({
          token: detail.token,
          label: detail.buttonLabel
        }));
      await this.context.provider.updateMessageDetailsButtons(
        discordChannelId,
        record.discordMessageId,
        detailButtons
      );
    } catch (error) {
      this.context.logger.warn(
        { error, token: record.token, discordChannelId, discordMessageId: record.discordMessageId },
        "Failed to remove completed proposed-plan action buttons."
      );
    }
  }

  private isThreadBusy(threadId: string): boolean {
    this.reconcileCompletedTurnFromCanonicalEvents(threadId);
    const state = this.runtime.threadState.get(threadId);
    if (state) {
      return this.isRuntimeStateBusy(state);
    }
    const persisted = this.context.stateStore.getThreadBridge(threadId);
    return Boolean(
      persisted?.lastTurnStatus === "in_progress" ||
        persisted?.lastStatusType === "active"
    );
  }

  private isRuntimeStateBusy(state: ThreadRuntimeState | undefined): boolean {
    return Boolean(
      state?.lastTurnStatus === "in_progress" ||
        state?.status.type === "active"
    );
  }

  private isThreadSteerable(threadId: string): boolean {
    this.reconcileCompletedTurnFromCanonicalEvents(threadId);
    return hasSteerableActiveTurn(this.runtime.threadState.get(threadId));
  }

  private reconcileCompletedTurnFromCanonicalEvents(threadId: string): void {
    const state = this.runtime.threadState.get(threadId);
    const persisted = this.context.stateStore.getThreadBridge(threadId);
    const trackedTurnId =
      state?.lastTurnStatus === "in_progress"
        ? state.lastTurnId
        : persisted?.lastTurnStatus === "in_progress"
          ? persisted.lastTurnId
          : null;
    if (!trackedTurnId) {
      return;
    }

    const hasFinalAnswer = this.context.stateStore
      .listCanonicalThreadEvents(threadId, 100)
      .some(
        (event) =>
          event.eventKind === "content" &&
          event.itemKind === "agentAnswer" &&
          event.turnId === trackedTurnId
      );
    if (!hasFinalAnswer) {
      return;
    }

    if (state) {
      markThreadTurnCompleted(state, "completed");
      this.deps.persistThreadState(state);
      this.deps.queueStatusUpdate(threadId);
      return;
    }

    if (persisted) {
      this.context.stateStore.upsertThreadBridge({
        ...persisted,
        lastStatusType: "idle",
        lastTurnStatus: "completed"
      });
    }
  }

  private markWriteBackTurnStarted(threadId: string, turnId?: string): void {
    const state = this.runtime.threadState.get(threadId);
    if (!state) {
      const bridge = this.context.stateStore.getThreadBridge(threadId);
      if (bridge) this.context.stateStore.upsertThreadBridge({ ...bridge, lastTurnId: turnId ?? null,
        lastStatusType: "active", lastTurnStatus: "in_progress" });
      return;
    }
    state.lastTurnId = turnId ?? null;
    markThreadTurnInProgress(state, turnId ?? null);
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(threadId);
  }

  private appendWriteBackCanonicalEvent(
    record: WriteBackQueueRecord,
    eventKind: "writeBackQueued" | "writeBackSent" | "writeBackFailed" | "writeBackRetracted",
    summary: string
  ): void {
    this.context.stateStore.appendCanonicalThreadEvent({
      threadId: record.threadId,
      source: "discord",
      eventKind,
      itemKind: "writeBack",
      turnId: null,
      turnCursor: null,
      itemId: record.id > 0 ? `write-back:${record.id}` : null,
      requestId: null,
      summary,
      detail: JSON.stringify(
        {
          id: record.id,
          status: record.status,
          actorUserId: record.actorUserId,
          discordChannelId: record.discordChannelId,
          error: record.error
        },
        null,
        2
      ),
      createdAt: new Date().toISOString()
    });
  }

  private buildWriteBackButtons(record: WriteBackQueueRecord, canSteer: boolean): NonNullable<DiscordCommandResult["buttons"]> {
    return [
      ...(canSteer
        ? [
            {
              customId: `codex:writeback:steer:${record.id}`,
              label: "Steer instead",
              style: "primary" as const
            }
          ]
        : []),
      {
        customId: `codex:writeback:retract:${record.id}`,
        label: "Retract",
        style: "danger" as const
      }
    ];
  }

  private formatWriteBackMessage(prefix: string, text: string): string {
    return `${prefix}\n> ${this.formatWriteBackPreview(text)}`;
  }

  private formatWriteBackPreview(text: string): string {
    const singleLine = text.trim().replace(/\s+/g, " ");
    if (singleLine.length <= WRITE_BACK_PREVIEW_MAX_LENGTH) {
      return singleLine;
    }
    return `${singleLine.slice(0, WRITE_BACK_PREVIEW_MAX_LENGTH - 3).trimEnd()}...`;
  }

  private formatErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? `${fallback} ${error.message}` : fallback;
  }

  private async startWriteBackTurn(
    threadId: string,
    text: string,
    options: WriteBackTurnStartOptions = {},
    queueId?: number
  ): Promise<{ turnId: string; inProgress: boolean; alreadyCompleted: boolean } | null> {
    const sourceKind =
      this.runtime.threadState.get(threadId)?.sourceKind ??
      this.context.stateStore.getThreadBridge(threadId)?.sourceKind ??
      "app-server";
    if (sourceKind === "cli-session" && options.skipResumeForCliSession) {
      if (queueId !== undefined) this.context.stateStore.markWriteBackDispatchStarted(queueId);
      await this.context.codexAdapter.startTurn(threadId, text);
      return null;
    }

    if (sourceKind === "app-server" && (await this.isBridgeRemoteCliThread(threadId))) {
      if (queueId !== undefined) this.context.stateStore.markWriteBackDispatchStarted(queueId);
      await this.context.codexAdapter.startTurn(threadId, text);
      return null;
    }

    const desktopIpcClient = this.context.desktopIpcClient;
    if (sourceKind !== "cli-session" && desktopIpcClient) {
      const completedTurns = new Set<string>();
      this.completedDuringWriteBackStarts.set(threadId, completedTurns);
      try {
        const result = await desktopIpcClient.startTurn(threadId, {
          input: [{ type: "text", text }],
          attachments: []
        }, () => { if (queueId !== undefined) this.context.stateStore.markWriteBackDispatchStarted(queueId); });
        // The exact returned ID links the original; a pending RPC is not start evidence.
        const turn = (result as { result?: { turn?: { id?: unknown; status?: unknown } } } | null)?.result?.turn;
        if (queueId !== undefined && typeof turn?.id === "string" && turn.id.trim()) {
          this.context.stateStore.bindDiscordMessageInputTurn(queueId, turn.id);
          const alreadyCompleted = completedTurns.has(turn.id) ||
            turn.status === "completed" || turn.status === "interrupted" || turn.status === "failed";
          if (alreadyCompleted) this.context.stateStore.claimDiscordInputThinkingReaction(queueId, false);
          return { turnId: turn.id, inProgress: turn.status === "inProgress", alreadyCompleted };
        }
        return null;
      } finally {
        this.completedDuringWriteBackStarts.delete(threadId);
      }
    }

    try { await this.context.codexAdapter.resumeThread(threadId, { timeoutMs: 10_000 }); }
    catch { throw new WriteBackNotDispatchedError("connection"); }
    if (queueId !== undefined) this.context.stateStore.markWriteBackDispatchStarted(queueId);
    await this.context.codexAdapter.startTurn(threadId, text);
    return null;
  }

  private async isBridgeRemoteCliThread(threadId: string): Promise<boolean> {
    try {
      const metadata = await this.context.codexAdapter.resolveMetadata(threadId, {
        allowFilesystemScan: false
      });
      return metadata.originator?.trim().toLowerCase() === BRIDGE_REMOTE_CLI_ORIGINATOR;
    } catch (error) {
      this.context.logger.debug({ error, threadId }, "Failed to resolve session originator for write-back route.");
      return false;
    }
  }

  async steerTurnInternally(targetThreadId: string, expectedTurnId: string, text: string): Promise<string> {
    const normalizedThreadId = targetThreadId.trim();
    if (!normalizedThreadId) {
      throw new Error("Thread id cannot be empty.");
    }

    const normalizedTurnId = expectedTurnId.trim();
    if (!normalizedTurnId) {
      throw new Error("Turn id cannot be empty.");
    }

    const trimmedText = text.trim();
    if (!trimmedText) {
      throw new Error("Steer text cannot be empty.");
    }

    const runtimeState = this.runtime.threadState.get(normalizedThreadId);
    this.logSteerState("before-resume", normalizedThreadId, runtimeState, "approval-feedback");
    await this.context.codexAdapter.resumeThread(normalizedThreadId);
    return this.sendSteerInstruction(
      normalizedThreadId,
      {
        lastTurnId: normalizedTurnId,
        sourceKind:
          runtimeState?.sourceKind ?? this.context.stateStore.getThreadBridge(normalizedThreadId)?.sourceKind ?? null
      },
      trimmedText,
      {
        preferredTurnId: normalizedTurnId,
        preservePreferredTurnId: true
      }
    );
  }

  private async steerResolvedThread(
    targetThreadId: string,
    trimmedText: string,
    source: InternalSteerSource
  ): Promise<DiscordCommandResult> {
    try {
      const steeredTurnId = await this.steerResolvedThreadOrThrow(targetThreadId, trimmedText, source);
      return {
        content: `Steered active turn \`${steeredTurnId}\` in Codex thread \`${targetThreadId}\`.`
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `There is no active Codex turn to steer in thread \`${targetThreadId}\`.`
      ) {
        return {
          content: error.message,
          ephemeral: true
        };
      }
      return {
        content:
          error instanceof Error
            ? `Failed to steer Codex thread \`${targetThreadId}\`: ${error.message}`
            : `Failed to steer Codex thread \`${targetThreadId}\`.`,
        ephemeral: true
      };
    }
  }

  private async steerResolvedThreadOrThrow(
    targetThreadId: string,
    trimmedText: string,
    source: InternalSteerSource
  ): Promise<string> {
    this.logSteerState("before-resume", targetThreadId, this.runtime.threadState.get(targetThreadId), source);
    await this.context.codexAdapter.resumeThread(targetThreadId);
    const state = await this.resolveSteerableActiveTurn(targetThreadId);
    if (!hasSteerableActiveTurn(state)) {
      this.logSteerState("refusing-no-active-turn", targetThreadId, state, source);
      throw new Error(`There is no active Codex turn to steer in thread \`${targetThreadId}\`.`);
    }

    this.logSteerState("resolved-active-turn", targetThreadId, state, source);
    return this.sendSteerInstruction(targetThreadId, state, trimmedText);
  }

  private async resolveSteerableActiveTurn(targetThreadId: string) {
    let state = this.runtime.threadState.get(targetThreadId);
    this.logSteerState("runtime-check", targetThreadId, state);
    if (hasSteerableActiveTurn(state)) {
      return state;
    }

    try {
      await this.deps.drainThreadEventQueue([targetThreadId]);
    } catch (error) {
      this.context.logger.debug({ error, targetThreadId }, "Failed to drain pending thread events before steering.");
    }
    state = this.runtime.threadState.get(targetThreadId);
    this.logSteerState("after-drain", targetThreadId, state);
    if (hasSteerableActiveTurn(state)) {
      return state;
    }

    try {
      await this.deps.pollThreadSessionEvents(targetThreadId);
      await this.deps.drainThreadEventQueue([targetThreadId]);
    } catch (error) {
      this.context.logger.debug({ error, targetThreadId }, "Failed to poll fresh session events before steering.");
    }
    state = this.runtime.threadState.get(targetThreadId);
    this.logSteerState("after-session-poll", targetThreadId, state);
    if (hasSteerableActiveTurn(state)) {
      return state;
    }

    try {
      const recoveredTurnId = await this.deps.readLatestTurnBackfillTurnId(targetThreadId);
      if (recoveredTurnId) {
        if (state) {
          markThreadTurnInProgress(state, recoveredTurnId);
        }
      }
    } catch (error) {
      this.context.logger.debug(
        { error, targetThreadId },
        "Failed to recover an active turn from session backfill before steering."
      );
    }
    state = this.runtime.threadState.get(targetThreadId);
    this.logSteerState("after-session-backfill", targetThreadId, state);
    if (hasSteerableActiveTurn(state)) {
      return state;
    }

    const persistedBridge = this.context.stateStore.getThreadBridge(targetThreadId);
    if (persistedBridge?.lastTurnId && persistedBridge.lastTurnStatus === "in_progress") {
      if (state) {
        markThreadTurnInProgress(state, persistedBridge.lastTurnId);
      } else {
        state = {
          threadId: targetThreadId,
          parentThreadId: persistedBridge.parentCodexThreadId,
          projectKey: persistedBridge.projectKey,
          projectName: persistedBridge.projectName,
          channelKind: persistedBridge.channelKind,
          sourceKind: persistedBridge.sourceKind ?? "app-server",
          name: persistedBridge.threadName,
          actorName: persistedBridge.actorName ?? null,
          preview: null,
          cwd: persistedBridge.cwd,
          repoName: persistedBridge.repoName,
          status: { type: persistedBridge.lastStatusType === "active" ? "active" : "idle" },
          lastActivityAt: persistedBridge.lastSeenAt ? new Date(persistedBridge.lastSeenAt).getTime() : null,
          latestCommandPreview: null,
          latestAgentMessage: null,
          lastTurnId: persistedBridge.lastTurnId,
          lastTurnStatus: "in_progress"
        } as unknown as NonNullable<typeof state>;
        this.runtime.threadState.set(targetThreadId, state);
      }
    }
    this.logSteerState("after-store-recovery", targetThreadId, state);
    if (hasSteerableActiveTurn(state)) {
      return state;
    }

    try {
      const details = await this.context.codexAdapter.readThread(targetThreadId, true);
      const recoveredTurnId = this.desktopSteerPayload.findInProgressTurnId(details.turns);
      if (recoveredTurnId) {
        if (state) {
          markThreadTurnInProgress(state, recoveredTurnId);
        } else {
          state = {
            threadId: targetThreadId,
            parentThreadId: null,
            projectKey: "",
            projectName: "",
            channelKind: "conversation",
            sourceKind: "app-server",
            name: details.name ?? details.preview ?? targetThreadId,
            actorName: null,
            preview: details.preview ?? null,
            cwd: null,
            repoName: null,
            status: details.status,
            lastActivityAt: null,
            latestCommandPreview: null,
            latestAgentMessage: null,
            lastTurnId: recoveredTurnId,
            lastTurnStatus: "in_progress"
          } as unknown as NonNullable<typeof state>;
          this.runtime.threadState.set(targetThreadId, state);
        }
      }
    } catch (error) {
      this.context.logger.debug({ error, targetThreadId }, "Failed to recover an active turn from thread/read before steering.");
    }
    this.logSteerState("after-thread-read", targetThreadId, state);
    return state;
  }

  private async sendSteerInstruction(
    targetThreadId: string,
    state: { lastTurnId: string; sourceKind?: "app-server" | "cli-session" | null },
    trimmedText: string,
    options: {
      preferredTurnId?: string;
      preservePreferredTurnId?: boolean;
    } = {}
  ): Promise<string> {
    const preferredTurnId =
      typeof options.preferredTurnId === "string" && options.preferredTurnId.trim().length > 0
        ? options.preferredTurnId.trim()
        : state.lastTurnId;
    const desktopIpcClient = this.context.desktopIpcClient;
    if (
      desktopIpcClient?.isReady() &&
      state.sourceKind !== "cli-session" &&
      !(state.sourceKind === "app-server" && (await this.isBridgeRemoteCliThread(targetThreadId)))
    ) {
      let restoreStateSource: DesktopSteerRestoreStateSource = "none";
      let desktopConversationState = desktopIpcClient.getConversationState(targetThreadId);
      let waitedForConversationState = false;
      let waitForConversationStateDurationMs = 0;
      if (!desktopConversationState) {
        waitedForConversationState = true;
        const waitStartedAt = Date.now();
        desktopConversationState = await desktopIpcClient.waitForConversationState(targetThreadId);
        waitForConversationStateDurationMs = Date.now() - waitStartedAt;
      }
      if (desktopConversationState) {
        restoreStateSource = "desktop-ipc";
      } else {
        desktopConversationState = await this.readSteerConversationStateFromThread(targetThreadId);
        if (desktopConversationState) {
          restoreStateSource = "thread-read";
        }
      }

      const desktopTurnId =
        options.preservePreferredTurnId
          ? preferredTurnId
          : this.desktopSteerPayload.findDesktopInProgressTurnId(desktopConversationState) ?? preferredTurnId;
      const restoreMessage =
        desktopConversationState !== null
          ? this.desktopSteerPayload.buildDesktopRestoreMessage(targetThreadId, desktopConversationState, desktopTurnId)
          : null;
      const steerPayloadSummary = this.desktopSteerPayload.summarizeDesktopSteerPayload(desktopConversationState, restoreMessage);
      this.deps.printProgress(
        withLogScope(
          "steer-payload",
          `Prepared Desktop steer payload for ${shortThreadId(targetThreadId)}: source=${restoreStateSource} turns=${steerPayloadSummary.conversationTurnCount ?? 0} items=${steerPayloadSummary.rollbackItemCount ?? 0} restore=${this.desktopSteerPayload.formatLogBytes(steerPayloadSummary.restoreMessageBytes)} thread=${this.desktopSteerPayload.formatLogBytes(steerPayloadSummary.restoreThreadBytes)} rollback=${this.desktopSteerPayload.formatLogBytes(steerPayloadSummary.restoreRollbackResponseBytes)} context=${this.desktopSteerPayload.formatLogBytes(steerPayloadSummary.restoreContextBytes)} dup=${this.desktopSteerPayload.formatLogBytes(steerPayloadSummary.estimatedDuplicatedThreadBytes)} wait=${formatStartupTimingMs(waitForConversationStateDurationMs)}.`
        )
      );

      this.context.logger.info(
        {
          scope: "steer-payload",
          targetThreadId,
          runtimeTurnId: state.lastTurnId,
          preferredTurnId,
          desktopTurnId,
          restoreStateSource,
          waitedForConversationState,
          waitForConversationStateDurationMs,
          ...steerPayloadSummary
        },
        withLogScope("steer-payload", "Prepared Desktop steer payload summary.")
      );

      this.context.logger.debug(
        {
          scope: "steer-payload",
          targetThreadId,
          runtimeTurnId: state.lastTurnId,
          preferredTurnId,
          desktopTurnId,
          restoreStateSource,
          waitedForConversationState,
          waitForConversationStateDurationMs,
          hasDesktopConversationState: Boolean(desktopConversationState),
          desktopConversationStateKeys: desktopConversationState ? Object.keys(desktopConversationState).slice(0, 12) : [],
          restoreMessageKeys: restoreMessage ? Object.keys(restoreMessage).slice(0, 16) : []
        },
        withLogScope("steer-payload", "Prepared Desktop steer payload context.")
      );
      void this.desktopSteerPayload.dumpOversizedDesktopSteerPayload({
        targetThreadId,
        runtimeTurnId: state.lastTurnId,
        preferredTurnId,
        desktopTurnId,
        restoreStateSource,
        waitedForConversationState,
        waitForConversationStateDurationMs,
        desktopConversationState,
        restoreMessage,
        steerPayloadSummary
      });

      try {
        await desktopIpcClient.steerTurn(
          targetThreadId,
          desktopTurnId,
          [
            {
              type: "text",
              text: trimmedText
            }
          ],
          {
            ...(restoreMessage ? { restoreMessage } : {})
          }
        );
        return desktopTurnId;
      } catch (error) {
        this.context.logger.warn(
          {
            scope: "steer",
            error,
            errorMessage: error instanceof Error ? error.message : String(error),
            targetThreadId,
            turnId: desktopTurnId
          },
          withLogScope("steer", "Desktop IPC steer failed; refusing to report success without follower confirmation.")
        );
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    await this.context.codexAdapter.steerTurn(targetThreadId, preferredTurnId, trimmedText);
    return preferredTurnId;
  }

  private async readSteerConversationStateFromThread(
    targetThreadId: string
  ): Promise<DesktopConversationState | null> {
    try {
      const details = await this.context.codexAdapter.readThread(targetThreadId, true);
      if (!Array.isArray(details.turns) || details.turns.length === 0) {
        return null;
      }

      const runtimeState = this.runtime.threadState.get(targetThreadId);
      const persistedBridge = this.context.stateStore.getThreadBridge(targetThreadId);
      return {
        id: targetThreadId,
        turns: details.turns,
        requests: [],
        cwd: runtimeState?.cwd ?? persistedBridge?.cwd ?? null,
        updatedAt: details.updatedAt ?? null,
        threadRuntimeStatus: details.status
      };
    } catch (error) {
      this.context.logger.debug(
        { error, targetThreadId },
        "Failed to read thread turn params for Desktop steer restore fallback."
      );
      return null;
    }
  }

  private logSteerState(
    stage: string,
    targetThreadId: string,
    state: BridgeRuntimeState["threadState"] extends Map<string, infer T> ? T | undefined : unknown,
    source?: InternalSteerSource
  ): void {
    this.context.logger.debug(
      {
        stage,
        source: source ?? "resolver",
        targetThreadId,
        hasTrackedThreadState: Boolean(state),
        pendingThreadEventChain: this.runtime.threadEventChains.has(targetThreadId),
        statusType:
          state && typeof state === "object" && "status" in state && state.status && typeof state.status === "object"
            ? (state.status as { type?: unknown }).type ?? null
            : null,
        activeFlags:
          state &&
          typeof state === "object" &&
          "status" in state &&
          state.status &&
          typeof state.status === "object" &&
          Array.isArray((state.status as { activeFlags?: unknown }).activeFlags)
            ? (state.status as { activeFlags?: string[] }).activeFlags ?? []
            : [],
        lastTurnId:
          state && typeof state === "object" && "lastTurnId" in state
            ? (state.lastTurnId as string | null | undefined) ?? null
            : null,
        lastTurnStatus:
          state && typeof state === "object" && "lastTurnStatus" in state
            ? (state.lastTurnStatus as string | null | undefined) ?? null
            : null,
        hasCwd:
          state && typeof state === "object" && "cwd" in state
            ? Boolean((state as { cwd?: unknown }).cwd)
            : false,
        hasRepoName:
          state && typeof state === "object" && "repoName" in state
            ? Boolean((state as { repoName?: unknown }).repoName)
            : false,
        sourceKindTracked:
          state && typeof state === "object" && "sourceKind" in state
            ? ((state as { sourceKind?: unknown }).sourceKind as string | null | undefined) ?? null
            : null
      },
      "Steer state snapshot."
    );
  }

  async handleAttachCommand(
    actor: ProviderActorContext,
    threadId: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const existing = this.context.stateStore.getThreadBridge(threadId);
    const details = await this.context.codexAdapter.readThread(threadId, false);
    await this.deps.hydrateThread(threadId, details, "manual");
    await this.context.codexAdapter.resumeThread(threadId);
    if (existing) {
      this.deps.queueStatusUpdate(threadId);
    } else {
      await this.deps.flushStatusUpdate(threadId);
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    return bridge
      ? { content: `Attached Codex thread \`${threadId}\` to <#${bridge.discordChannelId}>.` }
      : { content: `Attached Codex thread \`${threadId}\`.` };
  }

  async handleDetachCommand(
    actor: ProviderActorContext,
    threadId: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const resolved = this.resolveMappedThreadId(threadId);
    if (!resolved.ok) {
      return resolved.result;
    }
    const { threadId: resolvedThreadId, bridge } = resolved;

    try {
      await this.context.provider.detachDiscordLocation(bridge.discordChannelId, resolvedThreadId);
    } catch (error) {
      this.context.logger.warn(
        { error, threadId: resolvedThreadId, channelId: bridge.discordChannelId },
        "Failed to detach the Discord location before removing the mapping."
      );
    }

    this.deps.clearQueuedStatusUpdate(resolvedThreadId);
    this.deps.detachThread(resolvedThreadId);
    return {
      content: `Detached Codex thread \`${resolvedThreadId}\` from <#${bridge.discordChannelId}>.`
    };
  }

  async handleCleanIdCommand(
    actor: ProviderActorContext,
    threadId: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const resolved = this.resolveMappedThreadId(threadId);
    if (!resolved.ok) {
      return resolved.result;
    }
    const { threadId: resolvedThreadId } = resolved;

    const deletedLocations = await this.deps.cleanupThread(
      resolvedThreadId,
      `Clean Discord mapping for Codex thread ${resolvedThreadId}`
    );
    return {
      content: `Cleaned Codex thread \`${resolvedThreadId}\`. Deleted ${deletedLocations} Discord location(s).`
    };
  }

  async handleCleanAllCommand(actor: ProviderActorContext): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const result = await this.deps.resetBridge();
    return {
      content: `Cleaned the bridge. Deleted ${result.deletedLocations} Discord location(s) and ${result.deletedCategories} categor${result.deletedCategories === 1 ? "y" : "ies"}.`
    };
  }

  async handleHelpCommand(actor: ProviderActorContext): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    return {
      content:
        "Use `/codex help`, `/codex attach <thread_id>`, `/codex detach <thread_id>`, `/codex cleanid <thread_id>`, and `/codex cleanall`. Optional extras: `/codex status` lists mapped conversations."
    };
  }

  private resolveMappedThreadId(
    threadIdInput: string
  ): { ok: true; threadId: string; bridge: ThreadBridgeRecord } | { ok: false; result: DiscordCommandResult } {
    const normalizedInput = threadIdInput.trim();
    if (!normalizedInput) {
      return {
        ok: false,
        result: { content: "Thread id cannot be empty.", ephemeral: true }
      };
    }

    const exactBridge = this.context.stateStore.getThreadBridge(normalizedInput);
    if (exactBridge) {
      return { ok: true, threadId: exactBridge.codexThreadId, bridge: exactBridge };
    }

    const normalizedPrefix = normalizedInput.toLowerCase();
    const matches = this.context.stateStore
      .listThreadBridgesByKind("conversation")
      .filter((bridge) => bridge.codexThreadId.toLowerCase().startsWith(normalizedPrefix));
    if (matches.length === 1) {
      const bridge = matches[0]!;
      return { ok: true, threadId: bridge.codexThreadId, bridge };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        result: {
          content: `Codex thread id \`${normalizedInput}\` matches multiple mapped conversations. Use the full thread id:\n${matches
            .map((bridge) => `- \`${bridge.codexThreadId}\``)
            .join("\n")}`,
          ephemeral: true
        }
      };
    }

    return {
      ok: false,
      result: { content: `No Discord mapping exists for Codex thread \`${normalizedInput}\`.` }
    };
  }

  private authorizeCommand(actor: ProviderActorContext): DiscordCommandResult | null {
    try {
      this.context.policy.ensureCommandAuthorized(actor);
      return null;
    } catch (error) {
      return {
        content:
          error instanceof Error
            ? error.message
            : "This Discord user is not allowed to control the Codex bridge.",
        ephemeral: true
      };
    }
  }

  private authorizePlanAction(actor: ProviderActorContext): DiscordCommandResult | null {
    try {
      this.context.policy.ensureApprovalsEnabled();
      this.context.policy.ensureAuthorized(actor);
      return null;
    } catch (error) {
      return {
        content:
          error instanceof Error
            ? error.message
            : "This Discord user is not allowed to approve Codex actions.",
        ephemeral: true
      };
    }
  }

  private authorizeMessageWriteBack(actor: ProviderActorContext): DiscordCommandResult | null {
    try {
      this.context.policy.ensureMessageWriteBackAuthorized(actor);
      return null;
    } catch (error) {
      return {
        content:
          error instanceof Error
            ? error.message
            : "This Discord user is not allowed to send Codex messages.",
        ephemeral: true
      };
    }
  }

}
