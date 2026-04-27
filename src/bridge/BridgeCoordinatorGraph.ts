import type {
  ProjectBridgeRecord,
  ThreadRuntimeState
} from "../domain.js";
import {
  buildShellDecisionPayloads,
  classifyNativeResolutionStatus
} from "./approval/nativeApprovalInterop.js";
import { SessionEventCoordinator } from "./events/SessionEventCoordinator.js";
import { NotificationRouter } from "./events/NotificationRouter.js";
import { normalizeSubagentThreadName as normalizeSubagentDisplayName } from "./messageRendering.js";
import {
  selectInitialContextTurns as selectStartupContextTurns,
  selectRecentCompletedTurns as selectCompletedTurnsForStartup,
  selectRecentSyncableTurns as selectSyncableTurnsForStartup,
  trimInitialContextCandidatesToConversationAnchor as trimStartupContextCandidatesToConversationAnchor,
  trimSessionBackfillEventsToConversationAnchor as trimStartupBackfillEventsToConversationAnchor
} from "./startupSelection.js";
import {
  buildStartupDeduplicationKey as buildThreadStartupDeduplicationKey,
  resolveProgressThreadName as resolveThreadProgressName
} from "./threadMetadata.js";
import { buildStatusCardView } from "./statusCards.js";
import { InteractiveArtifactCoordinator } from "./artifacts/InteractiveArtifactCoordinator.js";
import { CleanupCoordinator } from "./artifacts/CleanupCoordinator.js";
import { ApprovalCoordinator } from "./approval/ApprovalCoordinator.js";
import { CanonicalLedgerCoordinator } from "./canonical/CanonicalLedgerCoordinator.js";
import { ProviderCommandCoordinator } from "./commands/ProviderCommandCoordinator.js";
import { ThreadContextCoordinator } from "./context/ThreadContextCoordinator.js";
import { DiscoveryCoordinator } from "./discovery/DiscoveryCoordinator.js";
import { ThreadHydrator } from "./discovery/ThreadHydrator.js";
import { MirrorCandidateExtractor } from "./mirror/MirrorCandidateExtractor.js";
import { MirrorPublisher } from "./mirror/MirrorPublisher.js";
import { MirrorStateCoordinator } from "./mirror/MirrorStateCoordinator.js";
import { MirrorSyncCoordinator } from "./mirror/MirrorSyncCoordinator.js";
import type { BridgeRuntimeContext } from "./runtime/BridgeRuntimeContext.js";
import {
  BridgeRuntimeState,
  type MirrorCandidate
} from "./runtime/BridgeRuntimeState.js";
import { StatusCoordinator } from "./status/StatusCoordinator.js";

export interface BridgeCoordinatorGraph {
  readonly statusCoordinator: StatusCoordinator;
  readonly approvalCoordinator: ApprovalCoordinator;
  readonly canonicalLedgerCoordinator: CanonicalLedgerCoordinator;
  readonly interactiveArtifactCoordinator: InteractiveArtifactCoordinator;
  readonly threadContextCoordinator: ThreadContextCoordinator;
  readonly threadHydrator: ThreadHydrator;
  readonly discoveryCoordinator: DiscoveryCoordinator;
  readonly mirrorCandidateExtractor: MirrorCandidateExtractor;
  readonly mirrorStateCoordinator: MirrorStateCoordinator;
  readonly mirrorPublisher: MirrorPublisher;
  readonly mirrorSyncCoordinator: MirrorSyncCoordinator;
  readonly sessionEventCoordinator: SessionEventCoordinator;
  readonly notificationRouter: NotificationRouter;
  readonly cleanupCoordinator: CleanupCoordinator;
  readonly providerCommandCoordinator: ProviderCommandCoordinator;
}

export interface BridgeCoordinatorGraphCallbacks {
  deleteMappedThread(threadId: string, reason: string): Promise<number>;
  drainThreadEventQueue(threadIds?: Iterable<string>): Promise<void>;
  enforceConversationChannelLimit(
    projectBridge: ProjectBridgeRecord,
    projectKey: string,
    incomingThreadId: string
  ): Promise<void>;
  enqueueThreadEvent(threadId: string, work: () => Promise<void>): Promise<void>;
  flushStatusUpdate(threadId: string): Promise<void>;
  isUnknownDiscordChannelError(error: unknown): boolean;
  persistThreadState(state: ThreadRuntimeState): void;
  queueMessageSync(threadId: string): void;
  queueStatusUpdate(threadId: string): void;
  readLatestTurnBackfillTurnId(threadId: string): Promise<string | null>;
  shouldStop(): boolean;
  stopPolling(): void;
}

export function createBridgeCoordinatorGraph(
  runtimeContext: BridgeRuntimeContext,
  runtime: BridgeRuntimeState,
  callbacks: BridgeCoordinatorGraphCallbacks
): BridgeCoordinatorGraph {
  let statusCoordinator: StatusCoordinator;
  let approvalCoordinator: ApprovalCoordinator;
  let canonicalLedgerCoordinator: CanonicalLedgerCoordinator;
  let interactiveArtifactCoordinator: InteractiveArtifactCoordinator;
  let threadContextCoordinator: ThreadContextCoordinator;
  let threadHydrator: ThreadHydrator;
  let discoveryCoordinator: DiscoveryCoordinator;
  let mirrorStateCoordinator: MirrorStateCoordinator;
  let mirrorPublisher: MirrorPublisher;
  let mirrorSyncCoordinator: MirrorSyncCoordinator;
  let sessionEventCoordinator: SessionEventCoordinator;
  let notificationRouter: NotificationRouter;
  let cleanupCoordinator: CleanupCoordinator;
  let providerCommandCoordinator: ProviderCommandCoordinator;

  const mirrorCandidateExtractor = new MirrorCandidateExtractor(runtimeContext, runtime);
  const startupSelectionDeps = {
    extractTurnBaseTimestampMs: (turn: unknown) => mirrorCandidateExtractor.extractTurnBaseTimestampMs(turn),
    extractTurnItems: (turn: unknown) => mirrorCandidateExtractor.extractTurnItems(turn),
    extractTurnStatus: (turn: unknown) => mirrorCandidateExtractor.extractTurnStatus(turn),
    countUserMessagesInTurn: (threadId: string, turn: unknown) =>
      mirrorCandidateExtractor.countUserMessagesInTurn(threadId, turn),
    isSyntheticOnlyConversationTurn: (threadId: string, turn: unknown) =>
      mirrorCandidateExtractor.isSyntheticOnlyConversationTurn(threadId, turn),
    compareChronology: (
      leftTimestampMs: number | null,
      leftIndex: number,
      rightTimestampMs: number | null,
      rightIndex: number
    ) => mirrorCandidateExtractor.compareChronology(leftTimestampMs, leftIndex, rightTimestampMs, rightIndex),
    mirroredTurnKey: (turnId: string | null, turnCursor: string | null) =>
      mirrorStateCoordinator.mirroredTurnKey(turnId, turnCursor),
    buildTurnCursor: (turn: unknown, turnOrder: number) =>
      mirrorCandidateExtractor.buildTurnCursor(turn, turnOrder),
    resolveChannelKind: (threadId: string): "conversation" | "subagent" =>
      (runtime.threadState.get(threadId)?.channelKind ??
        runtimeContext.stateStore.getThreadBridge(threadId)?.channelKind ??
        "conversation") as "conversation" | "subagent"
  };

  mirrorStateCoordinator = new MirrorStateCoordinator(runtimeContext, runtime, {
    buildTurnCursor: (turn, turnOrder) => mirrorCandidateExtractor.buildTurnCursor(turn, turnOrder),
    deleteMappedThread: (threadId, reason) => callbacks.deleteMappedThread(threadId, reason),
    extractUuidV7TimestampMs: (value) => mirrorCandidateExtractor.extractUuidV7TimestampMs(value)
  });
  mirrorPublisher = new MirrorPublisher(runtimeContext, runtime, {
    allowLateSameTurnCandidate: (threadId, candidate) =>
      mirrorStateCoordinator.allowLateSameTurnCandidate(threadId, candidate),
    canMirrorNonUserActivity: (threadId, turnId, turnCursor) =>
      mirrorStateCoordinator.canMirrorNonUserActivity(threadId, turnId, turnCursor),
    buildCandidateDevDetail: (threadId, candidate) =>
      mirrorStateCoordinator.buildCandidateDevDetail(threadId, candidate),
    buildMirrorCursor: (timestampMs, itemId, orderKey) =>
      mirrorCandidateExtractor.buildMirrorCursor(timestampMs, itemId, orderKey),
    compareItemCursor: (left, right) => mirrorStateCoordinator.compareItemCursor(left, right),
    compareTurnCursor: (left, right) => mirrorStateCoordinator.compareTurnCursor(left, right),
    ensureMirrorStateHydrated: (threadId) => mirrorStateCoordinator.ensureMirrorStateHydrated(threadId),
    enforceTurnRetention: (threadId) => mirrorStateCoordinator.enforceTurnRetention(threadId),
    extractFileActivityCounts: (item) => mirrorCandidateExtractor.extractFileActivityCounts(item),
    markUserTurnMirrored: (threadId, itemId, turnId, turnCursor, text) =>
      mirrorStateCoordinator.markUserTurnMirrored(threadId, itemId, turnId, turnCursor, text),
    mirroredItemKey: (threadId, itemId) => mirrorStateCoordinator.mirroredItemKey(threadId, itemId),
    mirroredTurnKey: (turnId, turnCursor) => mirrorStateCoordinator.mirroredTurnKey(turnId, turnCursor),
    rememberMirroredItem: (record) => mirrorStateCoordinator.rememberMirroredItem(record),
    rememberThreadMirrorCursor: (threadId, timestampMs, cursor, turnCursor) =>
      mirrorStateCoordinator.rememberThreadMirrorCursor(threadId, timestampMs, cursor, turnCursor),
    renderActivityHeading: (threadId) => mirrorCandidateExtractor.renderActivityHeading(threadId),
    renderCodexHeading: (level, label) => mirrorCandidateExtractor.renderCodexHeading(level, label),
    renderCodexMessageLabel: (threadId, phase, isLive) =>
      mirrorCandidateExtractor.renderCodexMessageLabel(threadId, phase, isLive),
    renderFileEditHeading: (threadId) => mirrorCandidateExtractor.renderFileEditHeading(threadId),
    renderMirroredBlock: (heading, body) => mirrorCandidateExtractor.renderMirroredBlock(heading, body),
    renderUserHeading: (level, threadId) => mirrorCandidateExtractor.renderUserHeading(level, threadId),
    resolveUserHeadingLevel: (threadId, itemId, turnId, turnCursor) =>
      mirrorStateCoordinator.resolveUserHeadingLevel(threadId, itemId, turnId, turnCursor),
    shouldMirrorCandidate: (threadId, cursor) =>
      mirrorStateCoordinator.shouldMirrorCandidate(threadId, cursor),
    shouldMirrorTurnCandidate: (threadId, turnCursor) =>
      mirrorStateCoordinator.shouldMirrorTurnCandidate(threadId, turnCursor),
    shouldSkipDuplicateUserText: (threadId, itemId, turnId, turnCursor, text) =>
      mirrorStateCoordinator.shouldSkipDuplicateUserText(threadId, itemId, turnId, turnCursor, text),
    retryPendingApprovalCardsForTurn: (threadId, turnId, turnCursor, timestampMs) =>
      approvalCoordinator.retryPendingApprovalCardsForTurn(threadId, turnId, turnCursor, timestampMs),
    traceMirror: (event, payload) => mirrorStateCoordinator.traceMirror(event, payload)
  });
  statusCoordinator = new StatusCoordinator(runtimeContext, runtime, {
    buildStatusCardView: (state) => buildStatusCardView(state),
    hydrateThread: (threadId, details, attachMode, hydrateOptions) =>
      threadHydrator.hydrateThread(threadId, details, attachMode, hydrateOptions),
    isUnknownDiscordChannelError: (error) => callbacks.isUnknownDiscordChannelError(error),
    shouldStop: () => callbacks.shouldStop(),
    syntheticSummary: (threadId, preferredName, status) =>
      mirrorStateCoordinator.syntheticSummary(threadId, preferredName, status),
    toPersistedLastSeenIso: (lastActivityAt, fallbackIso) =>
      mirrorStateCoordinator.toPersistedLastSeenIso(lastActivityAt, fallbackIso),
    tryReadThread: (threadId) => mirrorStateCoordinator.tryReadThread(threadId)
  });
  canonicalLedgerCoordinator = new CanonicalLedgerCoordinator(runtimeContext, runtime);
  approvalCoordinator = new ApprovalCoordinator(runtimeContext, runtime, {
    appendCanonicalEvent: (input) => canonicalLedgerCoordinator.appendCanonicalEvent(input),
    canMirrorNonUserActivity: (threadId, turnId, turnCursor) =>
      mirrorStateCoordinator.canMirrorNonUserActivity(threadId, turnId, turnCursor),
    closeCommandActivityGroup: (threadId) => mirrorPublisher.closeCommandActivityGroup(threadId),
    delay: async (milliseconds) => {
      if (!(milliseconds > 0)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    },
    drainThreadEventQueue: (threadIds) => callbacks.drainThreadEventQueue(threadIds),
    ensureThreadStateForRequest: (threadId, preferredName) =>
      threadContextCoordinator.ensureThreadStateForRequest(threadId, preferredName),
    enqueueThreadEvent: (threadId, work) => callbacks.enqueueThreadEvent(threadId, work),
    extractStableTimestampMs: (input) => mirrorCandidateExtractor.extractStableTimestampMs(input),
    flushPendingCommentaryBeforeApproval: (threadId) =>
      mirrorSyncCoordinator.flushPendingCommentaryBeforeApproval(threadId),
    handleSessionEvent: (event) => sessionEventCoordinator.handleSessionEvent(event),
    pollDesktopApprovalEvents: () => sessionEventCoordinator.pollDesktopApprovalEvents(),
    pollLocalSessionEvents: () => sessionEventCoordinator.pollLocalSessionEvents(),
    persistThreadState: (state) => callbacks.persistThreadState(state),
    printProgress: (message) => mirrorStateCoordinator.printProgress(message),
    queueStatusUpdate: (threadId) => callbacks.queueStatusUpdate(threadId),
    resolveMirroredActorName: (threadId) => mirrorCandidateExtractor.resolveMirroredActorName(threadId),
    shouldPreferSessionStreamForThread: (threadId) => mirrorCandidateExtractor.shouldPreferSessionStreamForThread(threadId),
    steerTurnInternally: (threadId, turnId, text) =>
      providerCommandCoordinator.steerTurnInternally(threadId, turnId, text),
    updateStateLastActivityAt: (state, timestampMs) =>
      mirrorStateCoordinator.updateStateLastActivityAt(state, timestampMs)
  });
  sessionEventCoordinator = new SessionEventCoordinator(runtimeContext, runtime, {
    appendCanonicalEvent: (input) => canonicalLedgerCoordinator.appendCanonicalEvent(input),
    buildApprovalCardView: (approval) => approvalCoordinator.buildApprovalCardView(approval),
    buildMirrorCursor: (timestampMs, itemId, orderKey) =>
      mirrorCandidateExtractor.buildMirrorCursor(timestampMs, itemId, orderKey),
    buildSessionEventCursor: (sourceOrder, eventKey) =>
      mirrorCandidateExtractor.buildSessionEventCursor(sourceOrder, eventKey),
    buildSessionEventDevDetail: (threadId, itemId, kind, timestampMs, cursor, turnId, status, rawEvent) =>
      mirrorStateCoordinator.buildSessionEventDevDetail(threadId, itemId, kind, timestampMs, cursor, turnId, status, rawEvent),
    buildSessionEventItemId: (kind, baseId, eventKey, sourceOrder) =>
      mirrorCandidateExtractor.buildSessionEventItemId(kind, baseId, eventKey, sourceOrder),
    buildSessionTurnCursor: (turnId) => mirrorCandidateExtractor.buildSessionTurnCursor(turnId),
    buildShellDecisionPayloads,
    canMirrorNonUserActivity: (threadId, turnId, turnCursor) =>
      mirrorStateCoordinator.canMirrorNonUserActivity(threadId, turnId, turnCursor),
    classifyNativeResolutionStatus,
    drainWriteBackQueue: async (threadId) => {
      await providerCommandCoordinator.drainNextQueuedWriteBackMessage(threadId);
    },
    enqueueThreadEvent: (threadId, work) => callbacks.enqueueThreadEvent(threadId, work),
    enforceTurnRetention: (threadId) => mirrorStateCoordinator.enforceTurnRetention(threadId),
    ensureThreadStateForRequest: (threadId, preferredName) =>
      threadContextCoordinator.ensureThreadStateForRequest(threadId, preferredName),
    extractSessionSourceFrontier: (event) => mirrorCandidateExtractor.extractSessionSourceFrontier(event),
    flushMessageSync: (threadId) => mirrorSyncCoordinator.flushMessageSync(threadId),
    flushStatusUpdate: (threadId) => callbacks.flushStatusUpdate(threadId),
    hydrateThread: (threadId, summary, attachMode, hydrateOptions) =>
      threadHydrator.hydrateThread(threadId, summary, attachMode, hydrateOptions),
    isCommentaryPhase: (phase) => mirrorCandidateExtractor.isCommentaryPhase(phase),
    mirrorApprovalCard: (approvalRecord, options) => approvalCoordinator.mirrorApprovalCard(approvalRecord, options),
    persistThreadState: (state) => callbacks.persistThreadState(state),
    printProgress: (message) => mirrorStateCoordinator.printProgress(message),
    publishCommentaryAgentMessage: (...args) => mirrorPublisher.publishCommentaryAgentMessage(...args),
    publishCompletedAgentMessage: (...args) => mirrorPublisher.publishCompletedAgentMessage(...args),
    publishCompletedCommandMessage: (...args) => mirrorPublisher.publishCompletedCommandMessage(...args),
    publishCompletedFileChangeMessage: (...args) => mirrorPublisher.publishCompletedFileChangeMessage(...args),
    publishCompletedUserMessage: (...args) => mirrorPublisher.publishCompletedUserMessage(...args),
    queueThreadSessionPollHint: (threadId) => sessionEventCoordinator.queueThreadSessionPollHint(threadId),
    queueStatusUpdate: (threadId) => callbacks.queueStatusUpdate(threadId),
    rememberRetainedTurn: (input) => canonicalLedgerCoordinator.rememberRetainedTurn(input),
    rememberChildThreadParent: (childThreadId, parentThreadId) =>
      threadContextCoordinator.rememberChildThreadParent(childThreadId, parentThreadId),
    rememberSuppressedSyntheticSessionTurn: (threadId, turnId) =>
      mirrorCandidateExtractor.rememberSuppressedSyntheticSessionTurn(threadId, turnId),
    rememberThreadMirrorCursor: (threadId, timestampMs, cursor, turnCursor, sourceFrontier) =>
      mirrorStateCoordinator.rememberThreadMirrorCursor(threadId, timestampMs, cursor, turnCursor, sourceFrontier),
    renderCommandDetail: (preview, status, timestampMs) =>
      mirrorCandidateExtractor.renderCommandDetail(preview, status, timestampMs),
    resolveThreadIdForDesktopEvent: (event) =>
      threadContextCoordinator.resolveThreadIdForDesktopEvent(event),
    resolveThreadMetadata: (threadId, preferred, options) =>
      threadHydrator.resolveThreadMetadata(threadId, preferred, options),
    resolveStoredChildThreadAnchor: (childThreadId) =>
      canonicalLedgerCoordinator.getChildThreadAnchor(childThreadId),
    retryDeferredCommandApprovalRequest: (callId) =>
      approvalCoordinator.handleCommandExecutionPlaceholderAvailable(callId),
    retryDeferredApprovalRequest: (requestId) =>
      approvalCoordinator.handleThreadHintAvailable(requestId),
    scheduleDetachedSessionEvent: (event) =>
      sessionEventCoordinator.scheduleDetachedSessionEvent(event),
    scheduleThreadSessionEvent: (threadId, event) =>
      sessionEventCoordinator.scheduleThreadSessionEvent(threadId, event),
    shouldMirrorLiveCursor: (threadId, cursor) => mirrorStateCoordinator.shouldMirrorLiveCursor(threadId, cursor),
    shouldHoldNonUserActivityUntilTurnAnchor: (threadId, turnId, turnCursor, cursor) =>
      mirrorStateCoordinator.shouldHoldNonUserActivityUntilTurnAnchor(threadId, turnId, turnCursor, cursor),
    shouldSuppressSyntheticSessionTurn: (threadId, turnId) =>
      mirrorCandidateExtractor.shouldSuppressSyntheticSessionTurn(threadId, turnId),
    shouldSuppressSyntheticSessionUserEvent: (threadId, event) =>
      mirrorCandidateExtractor.shouldSuppressSyntheticSessionUserEvent(threadId, event),
    syntheticSummary: (threadId, preferredName, status) =>
      mirrorStateCoordinator.syntheticSummary(threadId, preferredName, status),
    tryReadThread: (threadId) => mirrorStateCoordinator.tryReadThread(threadId),
    upsertChildThreadAnchor: (record) => canonicalLedgerCoordinator.upsertChildThreadAnchor(record),
    updateStateLastActivityAt: (state, timestampMs) =>
      mirrorStateCoordinator.updateStateLastActivityAt(state, timestampMs)
  });
  notificationRouter = new NotificationRouter(runtimeContext, runtime, {
    appendCanonicalEvent: (input) => canonicalLedgerCoordinator.appendCanonicalEvent(input),
    buildApprovalCardView: (approval) => approvalCoordinator.buildApprovalCardView(approval),
    clearDeferredApprovalRequest: (requestId) => approvalCoordinator.clearDeferredApprovalRequest(requestId),
    initializeSpawnedSubagentThread: (childThreadId) =>
      sessionEventCoordinator.initializeSpawnedSubagentThread(childThreadId),
    buildLifecycleDevDetail: (threadId, turnId, item, kind, timestampMs, cursor, phase, status) =>
      mirrorStateCoordinator.buildLifecycleDevDetail(threadId, turnId, item, kind, timestampMs, cursor, phase, status),
    buildMirrorCursor: (timestampMs, itemId, orderKey) =>
      mirrorCandidateExtractor.buildMirrorCursor(timestampMs, itemId, orderKey),
    buildNotificationCursor: (turnId, itemId) =>
      mirrorCandidateExtractor.buildNotificationCursor(turnId, itemId),
    buildTurnCursor: (turn, turnOrder) => mirrorCandidateExtractor.buildTurnCursor(turn, turnOrder),
    canMirrorNonUserActivity: (threadId, turnId, turnCursor) =>
      mirrorStateCoordinator.canMirrorNonUserActivity(threadId, turnId, turnCursor),
    drainWriteBackQueue: async (threadId) => {
      await providerCommandCoordinator.drainNextQueuedWriteBackMessage(threadId);
    },
    enforceTurnRetention: (threadId) => mirrorStateCoordinator.enforceTurnRetention(threadId),
    enqueueThreadEvent: (threadId, work) => callbacks.enqueueThreadEvent(threadId, work),
    extractAssistantMessage: (item) => mirrorCandidateExtractor.extractAssistantMessage(item),
    extractCommandDetail: (item) => mirrorCandidateExtractor.extractCommandDetail(item),
    extractCommandPreviewInfo: (item) => mirrorCandidateExtractor.extractCommandPreviewInfo(item),
    extractFileActivityCounts: (item) => mirrorCandidateExtractor.extractFileActivityCounts(item),
    extractFileChangeSummary: (item) => mirrorCandidateExtractor.extractFileChangeSummary(item),
    extractStableTimestampMs: (input) => mirrorCandidateExtractor.extractStableTimestampMs(input),
    extractUserMessageText: (item, threadId) => mirrorCandidateExtractor.extractUserMessageText(item, threadId),
    extractUuidV7TimestampMs: (identifier) => mirrorCandidateExtractor.extractUuidV7TimestampMs(identifier),
    flushStatusUpdate: (threadId) => callbacks.flushStatusUpdate(threadId),
    handleSubagentNotificationEnvelope: (parentThreadId, envelope) =>
      notificationRouter.handleSubagentNotificationEnvelope(parentThreadId, envelope),
    hydrateThread: (threadId, summary, attachMode, hydrateOptions) =>
      threadHydrator.hydrateThread(threadId, summary, attachMode, hydrateOptions),
    isCommentaryPhase: (phase) => mirrorCandidateExtractor.isCommentaryPhase(phase),
    persistThreadState: (state) => callbacks.persistThreadState(state),
    printProgress: (message) => mirrorStateCoordinator.printProgress(message),
    publishCommentaryAgentMessage: (...args) => mirrorPublisher.publishCommentaryAgentMessage(...args),
    publishCompletedAgentMessage: (...args) => mirrorPublisher.publishCompletedAgentMessage(...args),
    publishCompletedCommandMessage: (threadId, itemId, preview, detail, status, timestampMs, timestampIsApproximate, previewWasTruncated, sortCursor, turnId, turnCursor, devDetail) =>
      mirrorPublisher.publishCompletedCommandMessage(threadId, itemId, preview, detail, status, timestampMs, timestampIsApproximate, previewWasTruncated, sortCursor, turnId, turnCursor, devDetail),
    publishCompletedFileChangeMessage: (...args) => mirrorPublisher.publishCompletedFileChangeMessage(...args),
    publishCompletedUserMessage: (...args) => mirrorPublisher.publishCompletedUserMessage(...args),
    publishLiveAgentDelta: (threadId, delta, timestampMs, itemId, cursor, turnId, turnCursor) =>
      mirrorPublisher.publishLiveAgentDelta(
        threadId,
        delta,
        timestampMs,
        itemId,
        cursor,
        turnId,
        turnCursor
      ),
    queueMessageSync: (threadId) => callbacks.queueMessageSync(threadId),
    queueStatusUpdate: (threadId) => callbacks.queueStatusUpdate(threadId),
    queueThreadSessionPollHint: (threadId) => sessionEventCoordinator.queueThreadSessionPollHint(threadId),
    rememberSessionTurnHint: (threadId, turnId) =>
      runtimeContext.sessionEventTailer.rememberTurnHint(threadId, turnId),
    recordIgnoredHint: (input) => canonicalLedgerCoordinator.recordIgnoredHint(input),
    rememberChildThreadParent: (childThreadId, parentThreadId) =>
      threadContextCoordinator.rememberChildThreadParent(childThreadId, parentThreadId),
    rememberThreadMirrorCursor: (threadId, timestampMs, cursor, turnCursor) =>
      mirrorStateCoordinator.rememberThreadMirrorCursor(threadId, timestampMs, cursor, turnCursor),
    resolveThreadMetadata: (threadId, preferred, options) =>
      threadHydrator.resolveThreadMetadata(threadId, preferred, options),
    shouldHoldNonUserActivityUntilTurnAnchor: (threadId, turnId, turnCursor, cursor) =>
      mirrorStateCoordinator.shouldHoldNonUserActivityUntilTurnAnchor(threadId, turnId, turnCursor, cursor),
    shouldMirrorLiveCursor: (threadId, cursor) => mirrorStateCoordinator.shouldMirrorLiveCursor(threadId, cursor),
    shouldPreferSessionStreamForThread: (threadId) => mirrorCandidateExtractor.shouldPreferSessionStreamForThread(threadId),
    syntheticSummary: (threadId, preferredName, status) =>
      mirrorStateCoordinator.syntheticSummary(threadId, preferredName, status),
    syncRecentTurnMessages: (threadId) => mirrorSyncCoordinator.syncRecentTurnMessages(threadId),
    tryReadThread: (threadId) => mirrorStateCoordinator.tryReadThread(threadId),
    updateStateLastActivityAt: (state, timestampMs) =>
      mirrorStateCoordinator.updateStateLastActivityAt(state, timestampMs)
  });
  threadContextCoordinator = new ThreadContextCoordinator(runtimeContext, runtime, {
    getChildThreadAnchor: (childThreadId) => canonicalLedgerCoordinator.getChildThreadAnchor(childThreadId),
    hydrateThread: (threadId, summary, attachMode, hydrateOptions) =>
      threadHydrator.hydrateThread(threadId, summary, attachMode, hydrateOptions),
    resolveThreadMetadata: (threadId, preferred, options) =>
      threadHydrator.resolveThreadMetadata(threadId, preferred, options),
    syntheticSummary: (threadId, preferredName, status) =>
      mirrorStateCoordinator.syntheticSummary(threadId, preferredName, status),
    tryReadThread: (threadId) => mirrorStateCoordinator.tryReadThread(threadId)
  });
  threadHydrator = new ThreadHydrator(runtimeContext, runtime, {
    deriveThreadLastActivityAt: (summary, runtimeLastActivityAt, bridgeLastSeenAt) =>
      mirrorStateCoordinator.deriveThreadLastActivityAt(summary, runtimeLastActivityAt, bridgeLastSeenAt),
    enforceConversationChannelLimit: (projectBridge, projectKey, threadId) =>
      callbacks.enforceConversationChannelLimit(projectBridge, projectKey, threadId),
    ensureParentBridge: (parentThreadId, attachMode) =>
      threadContextCoordinator.ensureParentBridge(parentThreadId, attachMode),
    lookupProjectContext: (threadId) => threadContextCoordinator.lookupProjectContext(threadId),
    normalizeSubagentThreadName: (name, threadId) => normalizeSubagentDisplayName(name, threadId),
    hasRetainedConversationTurn: (threadId) => canonicalLedgerCoordinator.hasRetainedTurn(threadId),
    printProgress: (message) => mirrorStateCoordinator.printProgress(message),
    resetThreadBridgeLocation: (threadId, reason) =>
      cleanupCoordinator.resetMappedThreadLocation(threadId, reason).then(() => undefined),
    toPersistedLastSeenIso: (lastActivityAt, fallbackIso) =>
      mirrorStateCoordinator.toPersistedLastSeenIso(lastActivityAt, fallbackIso)
  });
  discoveryCoordinator = new DiscoveryCoordinator(runtimeContext, runtime, {
    backfillLatestTurnMessages: (threadId, options) =>
      mirrorSyncCoordinator.backfillLatestTurnMessages(threadId, options),
    buildStartupDeduplicationKey: (thread, metadata) => buildThreadStartupDeduplicationKey(thread, metadata),
    beginStartupAttachWindow: (threadId) => statusCoordinator.beginStartupAttachWindow(threadId),
    beginStartupMirrorBatch: (threadId) => mirrorPublisher.beginStartupMirrorBatch(threadId),
    cleanupExpiredInteractiveArtifacts: () =>
      interactiveArtifactCoordinator.cleanupExpiredInteractiveArtifacts(),
    closeGroupedMessages: (threadId) => mirrorStateCoordinator.closeGroupedMessages(threadId),
    captureThreadSessionFrontier: (threadId, options) =>
      sessionEventCoordinator.captureThreadSessionFrontier(threadId, options),
    markThreadSessionFrontier: async (threadId, sourceFrontier) => {
      const marker = runtimeContext.sessionEventTailer.markThreadFrontier;
      return typeof marker === "function" ? marker.call(runtimeContext.sessionEventTailer, threadId, sourceFrontier) : false;
    },
    deleteMappedThread: (threadId, reason) => callbacks.deleteMappedThread(threadId, reason),
    describeStatusMix: (threads) => mirrorCandidateExtractor.describeStatusMix(threads),
    drainThreadEventQueue: (threadIds) => callbacks.drainThreadEventQueue(threadIds),
    fastForwardThread: (threadId) => runtimeContext.sessionEventTailer.fastForwardThread(threadId),
    endStartupAttachWindow: (threadId) => statusCoordinator.endStartupAttachWindow(threadId),
    endStartupMirrorBatch: (threadId) => mirrorPublisher.endStartupMirrorBatch(threadId),
    flushStatusUpdate: (threadId, options) => statusCoordinator.flushStatusUpdate(threadId, options),
    hasPersistedConversationUserAnchor: (threadId) =>
      canonicalLedgerCoordinator.hasRetainedTurn(threadId),
    hydrateThread: (threadId, summary, attachMode, hydrateOptions) =>
      threadHydrator.hydrateThread(threadId, summary, attachMode, hydrateOptions),
    getChildThreadAnchor: (childThreadId) =>
      canonicalLedgerCoordinator.getChildThreadAnchor(childThreadId),
    listRetainedTurns: (threadId) =>
      canonicalLedgerCoordinator.listRetainedTurns(threadId),
    pollDesktopApprovalEvents: () => sessionEventCoordinator.pollDesktopApprovalEvents(),
    pollLocalSessionEvents: () => sessionEventCoordinator.pollLocalSessionEvents(),
    printProgress: (message) => mirrorStateCoordinator.printProgress(message),
    queueMessageSync: (threadId) => callbacks.queueMessageSync(threadId),
    queueStatusUpdate: (threadId) => callbacks.queueStatusUpdate(threadId),
    replayThreadSessionEventsFromFrontier: (threadId, sourceFrontier, options) =>
      sessionEventCoordinator.replayThreadSessionEventsFromFrontier(threadId, sourceFrontier, options),
    resetThreadMirrorState: (threadId) => mirrorStateCoordinator.resetThreadMirrorState(threadId),
    resolveParentThreadId: (threadId, allowThreadScan = true) =>
      threadContextCoordinator.resolveParentThreadIdForThread(threadId, allowThreadScan),
    resolveProgressThreadName: (candidate, existing, current) =>
      resolveThreadProgressName(
        candidate,
        existing,
        current,
        runtime.resolvedMetadataByThread.get(candidate.summary.id) ?? null
      ),
    resolveThreadMetadata: (threadId, preferred, options) =>
      threadHydrator.resolveThreadMetadata(threadId, preferred, options),
    seedMirrorCursorFromStableFrontier: (threadId) =>
      mirrorSyncCoordinator.seedMirrorCursorFromStableFrontier(threadId),
    shouldPreferSessionStreamForThread: (threadId) => mirrorCandidateExtractor.shouldPreferSessionStreamForThread(threadId),
    tryReadThread: (threadId) => mirrorStateCoordinator.tryReadThread(threadId)
  });
  mirrorSyncCoordinator = new MirrorSyncCoordinator(runtimeContext, runtime, {
    buildSessionTurnCursor: (turnId) => mirrorCandidateExtractor.buildSessionTurnCursor(turnId),
    buildSessionEventCursor: (sourceOrder, eventKey) =>
      mirrorCandidateExtractor.buildSessionEventCursor(sourceOrder, eventKey),
    buildMirrorCandidateCursor: (turn, item, itemOrder) =>
      mirrorCandidateExtractor.buildMirrorCandidateCursor(turn, item, itemOrder),
    collectMirrorCandidates: (threadId, turns) => mirrorCandidateExtractor.collectMirrorCandidates(threadId, turns),
    compareItemCursor: (left, right) => mirrorStateCoordinator.compareItemCursor(left, right),
    ensureMirrorStateHydrated: (threadId) => mirrorStateCoordinator.ensureMirrorStateHydrated(threadId),
    extractTurnItems: (turn) => mirrorCandidateExtractor.extractTurnItems(turn),
    extractTurnStatus: (turn) => mirrorCandidateExtractor.extractTurnStatus(turn),
    hasMirroredUserAnchorForTurn: (threadId, turnId, turnCursor) =>
      mirrorStateCoordinator.hasMirroredUserAnchorForTurn(threadId, turnId, turnCursor),
    handleSessionEvent: (event) => sessionEventCoordinator.handleSessionEvent(event),
    mirrorCandidates: (threadId, candidates, options) =>
      mirrorPublisher.mirrorCandidates(threadId, candidates, options),
    mirroredItemKey: (threadId, itemId) => mirrorStateCoordinator.mirroredItemKey(threadId, itemId),
    printProgress: (message) => mirrorStateCoordinator.printProgress(message),
    publishStartupBackfillNotice: (threadId, itemId, text, turnId, turnCursor) =>
      mirrorPublisher.publishStartupBackfillNotice(threadId, itemId, text, turnId, turnCursor),
    rememberThreadMirrorCursor: (threadId, timestampMs, cursor, turnCursor) =>
      mirrorStateCoordinator.rememberThreadMirrorCursor(threadId, timestampMs, cursor, turnCursor),
    selectInitialContextTurns: (threadId, turns) =>
      selectStartupContextTurns(
        threadId,
        turns,
        runtimeContext.runtimeConfig.retention.maxTurnsPerThread,
        startupSelectionDeps
      ),
    selectRecentCompletedTurns: (turns) => selectCompletedTurnsForStartup(turns, startupSelectionDeps),
    selectRecentSyncableTurns: (threadId, turns) =>
      selectSyncableTurnsForStartup(threadId, turns, startupSelectionDeps),
    shouldStop: () => callbacks.shouldStop(),
    shouldPreferSessionStreamForThread: (threadId) => mirrorCandidateExtractor.shouldPreferSessionStreamForThread(threadId),
    trimInitialContextCandidatesToConversationAnchor: (threadId, candidates) =>
      trimStartupContextCandidatesToConversationAnchor(threadId, candidates, startupSelectionDeps) as MirrorCandidate[],
    trimSessionBackfillEventsToConversationAnchor: (threadId, events) =>
      trimStartupBackfillEventsToConversationAnchor(threadId, events, startupSelectionDeps)
  });
  interactiveArtifactCoordinator = new InteractiveArtifactCoordinator(runtimeContext, {
    buildApprovalCardView: (approval) => approvalCoordinator.buildApprovalCardView(approval),
    isUnknownDiscordChannelError: (error) => callbacks.isUnknownDiscordChannelError(error)
  });
  cleanupCoordinator = new CleanupCoordinator(runtimeContext, runtime, {
    clearQueuedStatusUpdate: (threadId) => statusCoordinator.clearQueuedStatusUpdate(threadId),
    clearUserTurnMirrorState: (threadId) => mirrorStateCoordinator.clearUserTurnMirrorState(threadId),
    clearAllUserTurnMirrorState: () => mirrorStateCoordinator.clearAllUserTurnMirrorState(),
    resetThreadMirrorState: (threadId) => mirrorStateCoordinator.resetThreadMirrorState(threadId),
    stopPolling: () => callbacks.stopPolling()
  });
  providerCommandCoordinator = new ProviderCommandCoordinator(runtimeContext, runtime, {
    clearQueuedStatusUpdate: (threadId) => statusCoordinator.clearQueuedStatusUpdate(threadId),
    cleanupThread: (threadId, reason, progressReporter) =>
      cleanupCoordinator.deleteMappedThread(threadId, reason, progressReporter),
    drainThreadEventQueue: (threadIds) => callbacks.drainThreadEventQueue(threadIds),
    detachThread: (threadId) => cleanupCoordinator.detachMappedThread(threadId),
    flushStatusUpdate: (threadId) => callbacks.flushStatusUpdate(threadId),
    hydrateThread: (threadId, summary, attachMode, hydrateOptions) =>
      threadHydrator.hydrateThread(threadId, summary, attachMode, hydrateOptions),
    pollThreadSessionEvents: async (threadId) => {
      await sessionEventCoordinator.pollThreadSessionEvents(threadId, {
        allowFilesystemScan: false
      });
    },
    persistThreadState: (state) => callbacks.persistThreadState(state),
    printProgress: (message) => mirrorStateCoordinator.printProgress(message),
    readLatestTurnBackfillTurnId: (threadId) => callbacks.readLatestTurnBackfillTurnId(threadId),
    queueStatusUpdate: (threadId) => callbacks.queueStatusUpdate(threadId),
    resetBridge: (progressReporter) => cleanupCoordinator.resetDiscordBridgeState(progressReporter)
  });

  return {
    statusCoordinator,
    approvalCoordinator,
    canonicalLedgerCoordinator,
    interactiveArtifactCoordinator,
    threadContextCoordinator,
    threadHydrator,
    discoveryCoordinator,
    mirrorCandidateExtractor,
    mirrorStateCoordinator,
    mirrorPublisher,
    mirrorSyncCoordinator,
    sessionEventCoordinator,
    notificationRouter,
    cleanupCoordinator,
    providerCommandCoordinator
  };
}
