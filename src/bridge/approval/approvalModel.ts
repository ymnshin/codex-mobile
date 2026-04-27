import type {
  ApprovalDecision,
  ApprovalKind,
  ApplyPatchApprovalRequest,
  CodexServerRequest,
  CommandApprovalRequest,
  ExecCommandApprovalRequest,
  FileChangeApprovalRequest,
  McpElicitationRequest,
  PendingApprovalRecord,
  PermissionsApprovalRequest,
  ToolUserInputState
} from "../../domain.js";
import type { Policy } from "../../policy/Policy.js";
import { redactSensitiveText, truncateForDiscord } from "../../util/redaction.js";

interface ApprovalRecordSeed {
  requestId: string;
  threadId: string;
  turnId: string;
  feedbackTurnId?: string | null;
  itemId: string;
  kind: ApprovalKind;
  preview: string;
  cwd: string | null;
  reason: string | null;
  availableDecisions: string[];
  decisionPayloads: Record<string, unknown>;
  details: string;
  createdAtMs?: number | null;
  discordMessageId?: string | null;
  toolInput?: ToolUserInputState | null;
}

interface NativeApprovalBuildHelpers {
  policy: Policy;
  extractStableTimestampMs: (input: unknown) => number | null;
  resolveThreadIdForRequest: (requestId: string, params: Record<string, unknown>) => string | null;
}

export function createPendingApprovalRecord(
  policy: Policy,
  input: ApprovalRecordSeed
): PendingApprovalRecord {
  const sanitizedPreview = truncateForDiscord(redactSensitiveText(input.preview), 300);
  const createdAtMs = input.createdAtMs ?? Date.now();
  return {
    token: policy.createApprovalToken(),
    requestId: input.requestId,
    threadId: input.threadId,
    turnId: input.turnId,
    feedbackTurnId: input.feedbackTurnId ?? null,
    itemId: input.itemId,
    kind: input.kind,
    sanitizedPreview,
    cwd: input.cwd,
    reason: input.reason ? redactSensitiveText(input.reason) : null,
    availableDecisions: input.availableDecisions,
    decisionPayloads: input.decisionPayloads,
    expiresAt: policy.expiresAt(createdAtMs).toISOString(),
    discordMessageId: input.discordMessageId ?? null,
    status: "pending",
    details: input.details,
    createdAt: new Date(createdAtMs).toISOString(),
    restartDisabledAt: null,
    toolInput: input.toolInput ?? null
  };
}

export function buildApprovalRecordFromServerRequest(
  request: CodexServerRequest,
  helpers: NativeApprovalBuildHelpers
): PendingApprovalRecord | null {
  if (request.method === "item/commandExecution/requestApproval") {
    const nativeRequest = request as CommandApprovalRequest;
    const decisionSpecs = buildWrappedDecisionPayloads(
      nativeRequest.params.availableDecisions,
      ["accept", "decline"]
    );
    const decisionPayloads = ensureHiddenFeedbackDecline(
      decisionSpecs.availableDecisions,
      decisionSpecs.decisionPayloads
    );
    return createPendingApprovalRecord(helpers.policy, {
      requestId: String(nativeRequest.id),
      threadId: nativeRequest.params.threadId,
      turnId: nativeRequest.params.turnId,
      feedbackTurnId: nativeRequest.params.turnId,
      itemId: nativeRequest.params.itemId,
      kind: "commandExecution",
      preview:
        nativeRequest.params.command ||
        nativeRequest.params.reason ||
        "Command approval requested",
      cwd: typeof nativeRequest.params.cwd === "string" ? nativeRequest.params.cwd : null,
      reason: typeof nativeRequest.params.reason === "string" ? nativeRequest.params.reason : null,
      availableDecisions: decisionSpecs.availableDecisions,
      decisionPayloads,
      details: redactSensitiveText(JSON.stringify(nativeRequest.params, null, 2)),
      createdAtMs: helpers.extractStableTimestampMs(nativeRequest.params)
    });
  }

  if (request.method === "execCommandApproval") {
    const nativeRequest = request as ExecCommandApprovalRequest;
    const threadId = helpers.resolveThreadIdForRequest(String(nativeRequest.id), nativeRequest.params);
    if (!threadId) {
      return null;
    }
    return createPendingApprovalRecord(helpers.policy, {
      requestId: String(nativeRequest.id),
      threadId,
      turnId: nativeRequest.params.callId,
      feedbackTurnId: null,
      itemId: nativeRequest.params.callId,
      kind: "commandExecution",
      preview:
        nativeRequest.params.command.join(" ") ||
        nativeRequest.params.reason ||
        "Command approval requested",
      cwd: nativeRequest.params.cwd,
      reason: typeof nativeRequest.params.reason === "string" ? nativeRequest.params.reason : null,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      decisionPayloads: {
        accept: { decision: "approved" },
        acceptForSession: { decision: "approved_for_session" },
        decline: { decision: "denied" },
        cancel: { decision: "abort" }
      },
      details: redactSensitiveText(JSON.stringify(nativeRequest.params, null, 2)),
      createdAtMs: helpers.extractStableTimestampMs(nativeRequest.params)
    });
  }

  if (request.method === "item/fileChange/requestApproval") {
    const nativeRequest = request as FileChangeApprovalRequest;
    const decisionSpecs = buildWrappedDecisionPayloads(
      nativeRequest.params.availableDecisions,
      ["accept", "decline"]
    );
    return createPendingApprovalRecord(helpers.policy, {
      requestId: String(nativeRequest.id),
      threadId: nativeRequest.params.threadId,
      turnId: nativeRequest.params.turnId,
      feedbackTurnId: nativeRequest.params.turnId,
      itemId: nativeRequest.params.itemId,
      kind: "fileChange",
      preview: nativeRequest.params.reason || "File change approval requested",
      cwd: null,
      reason: typeof nativeRequest.params.reason === "string" ? nativeRequest.params.reason : null,
      availableDecisions: decisionSpecs.availableDecisions,
      decisionPayloads: decisionSpecs.decisionPayloads,
      details: redactSensitiveText(JSON.stringify(nativeRequest.params, null, 2)),
      createdAtMs: helpers.extractStableTimestampMs(nativeRequest.params)
    });
  }

  if (request.method === "applyPatchApproval") {
    const nativeRequest = request as ApplyPatchApprovalRequest;
    const threadId = helpers.resolveThreadIdForRequest(String(nativeRequest.id), nativeRequest.params);
    if (!threadId) {
      return null;
    }
    return createPendingApprovalRecord(helpers.policy, {
      requestId: String(nativeRequest.id),
      threadId,
      turnId: nativeRequest.params.callId,
      feedbackTurnId: null,
      itemId: nativeRequest.params.callId,
      kind: "fileChange",
      preview: nativeRequest.params.reason || "File change approval requested",
      cwd: typeof nativeRequest.params.grantRoot === "string" ? nativeRequest.params.grantRoot : null,
      reason: typeof nativeRequest.params.reason === "string" ? nativeRequest.params.reason : null,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      decisionPayloads: {
        accept: { decision: "approved" },
        acceptForSession: { decision: "approved_for_session" },
        decline: { decision: "denied" },
        cancel: { decision: "abort" }
      },
      details: redactSensitiveText(JSON.stringify(nativeRequest.params, null, 2)),
      createdAtMs: helpers.extractStableTimestampMs(nativeRequest.params)
    });
  }

  if (request.method === "item/permissions/requestApproval") {
    const nativeRequest = request as PermissionsApprovalRequest;
    const threadId = helpers.resolveThreadIdForRequest(String(nativeRequest.id), nativeRequest.params);
    if (!threadId) {
      return null;
    }
    const itemId =
      (typeof nativeRequest.params.itemId === "string" && nativeRequest.params.itemId) ||
      `permission:${String(nativeRequest.id)}`;
    const turnId =
      (typeof nativeRequest.params.turnId === "string" && nativeRequest.params.turnId) ||
      itemId;
    const decisionSpecs = buildWrappedDecisionPayloads(
      nativeRequest.params.availableDecisions,
      ["accept", "decline"]
    );
    return createPendingApprovalRecord(helpers.policy, {
      requestId: String(nativeRequest.id),
      threadId,
      turnId,
      feedbackTurnId:
        typeof nativeRequest.params.turnId === "string" && nativeRequest.params.turnId
          ? nativeRequest.params.turnId
          : null,
      itemId,
      kind: "permissions",
      preview: extractApprovalPreview(nativeRequest.params, "Permission approval requested"),
      cwd: typeof nativeRequest.params.cwd === "string" ? nativeRequest.params.cwd : null,
      reason: typeof nativeRequest.params.reason === "string" ? nativeRequest.params.reason : null,
      availableDecisions: decisionSpecs.availableDecisions,
      decisionPayloads: decisionSpecs.decisionPayloads,
      details: redactSensitiveText(JSON.stringify(nativeRequest.params, null, 2)),
      createdAtMs: helpers.extractStableTimestampMs(nativeRequest.params)
    });
  }

  if (request.method === "mcpServer/elicitation/request") {
    const nativeRequest = request as McpElicitationRequest;
    const threadId = helpers.resolveThreadIdForRequest(String(nativeRequest.id), nativeRequest.params);
    if (!threadId) {
      return null;
    }
    const itemId =
      (typeof nativeRequest.params.itemId === "string" && nativeRequest.params.itemId) ||
      `mcp-elicitation:${String(nativeRequest.id)}`;
    const turnId =
      (typeof nativeRequest.params.turnId === "string" && nativeRequest.params.turnId) ||
      itemId;
    return createPendingApprovalRecord(helpers.policy, {
      requestId: String(nativeRequest.id),
      threadId,
      turnId,
      feedbackTurnId:
        typeof nativeRequest.params.turnId === "string" && nativeRequest.params.turnId
          ? nativeRequest.params.turnId
          : null,
      itemId,
      kind: "mcpElicitation",
      preview: extractApprovalPreview(nativeRequest.params, "MCP tool approval requested"),
      cwd: null,
      reason: typeof nativeRequest.params.reason === "string" ? nativeRequest.params.reason : null,
      availableDecisions: ["accept", "acceptWithExecpolicyAmendment", "cancel"],
      decisionPayloads: {
        accept: { action: "accept", content: {}, _meta: null },
        // MCP elicitation currently exposes a single accept action in Codex responses.
        // Keep "approve similar" as a first-class Discord decision while routing it
        // through the same accepted payload shape.
        acceptWithExecpolicyAmendment: { action: "accept", content: {}, _meta: null },
        // Keep decline payload available for feedback-driven rejection even when
        // the explicit reject button is hidden on MCP cards.
        decline: { action: "decline", _meta: null },
        cancel: { action: "cancel", _meta: null }
      },
      details: redactSensitiveText(JSON.stringify(nativeRequest.params, null, 2)),
      createdAtMs: helpers.extractStableTimestampMs(nativeRequest.params)
    });
  }

  return null;
}

export function extractApprovalPreview(params: Record<string, unknown>, fallback: string): string {
  const candidates = ["command", "message", "prompt", "title", "question", "reason"];
  for (const candidate of candidates) {
    const value = params[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return fallback;
}

export function buildWrappedDecisionPayloads(
  rawDecisions: unknown,
  fallback: string[]
): { availableDecisions: string[]; decisionPayloads: Record<string, unknown> } {
  const decisionSpecs = normalizeDecisionSpecs(rawDecisions, fallback);
  return {
    availableDecisions: decisionSpecs.map((spec) => spec.key),
    decisionPayloads: Object.fromEntries(
      decisionSpecs.map((spec) => [
        spec.key,
        {
          decision: spec.payload
        }
      ])
    )
  };
}

function normalizeDecisionSpecs(
  rawDecisions: unknown,
  fallback: string[]
): Array<{ key: string; payload: unknown }> {
  const rawList = Array.isArray(rawDecisions) ? rawDecisions : fallback;
  const normalized: Array<{ key: string; payload: unknown }> = [];

  for (const rawDecision of rawList) {
    if (typeof rawDecision === "string" && rawDecision.trim().length > 0) {
      normalized.push({ key: rawDecision, payload: rawDecision });
      continue;
    }

    if (!rawDecision || typeof rawDecision !== "object" || Array.isArray(rawDecision)) {
      continue;
    }

    const entries = Object.entries(rawDecision as Record<string, unknown>).filter(
      ([key]) => key.trim().length > 0
    );
    if (entries.length !== 1) {
      continue;
    }

    const [key, payload] = entries[0]!;
    normalized.push({ key, payload: { [key]: payload } });
  }

  return normalized.length > 0
    ? normalized
    : fallback.map((decision) => ({ key: decision, payload: decision }));
}

function ensureHiddenFeedbackDecline(
  availableDecisions: string[],
  decisionPayloads: Record<string, unknown>
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(decisionPayloads, "decline")) {
    return decisionPayloads;
  }
  if (!availableDecisions.includes("cancel")) {
    return decisionPayloads;
  }

  return {
    ...decisionPayloads,
    // Wrapped command approvals can hide reject as "cancel" even though the
    // underlying approval flow still supports feedback-driven decline.
    decline: { decision: "decline" }
  };
}

export function resolveFeedbackDecision(approval: PendingApprovalRecord): ApprovalDecision {
  if (Object.prototype.hasOwnProperty.call(approval.decisionPayloads, "decline")) {
    return "decline";
  }
  if (approval.availableDecisions.includes("decline")) {
    return "decline";
  }
  if (Object.prototype.hasOwnProperty.call(approval.decisionPayloads, "cancel")) {
    return "cancel";
  }
  if (approval.availableDecisions.includes("cancel")) {
    return "cancel";
  }
  throw new Error("This approval request does not support rejecting it from Discord.");
}

export function formatApprovalDecisionResolution(
  decision: string,
  origin: "Discord" | "terminal" | "Codex"
): string {
  const location = origin === "terminal" ? "from terminal" : `in ${origin}`;
  switch (decision) {
    case "accept":
      return `✅ Approved once ${location}`;
    case "acceptForSession":
      return `✅ Approved for session ${location}`;
    case "acceptWithExecpolicyAmendment":
      return `✅ Approved similar actions ${location}`;
    case "decline":
      return `⛔ Rejected ${location}`;
    case "cancel":
      return `⛔ Cancelled ${location}`;
    default:
      return `✅ Decision sent ${location}: ${decision}`;
  }
}
