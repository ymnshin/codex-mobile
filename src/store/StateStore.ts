import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AuditLogRecord,
  CanonicalThreadEventRecord,
  ChildThreadAnchorRecord,
  DesktopLogCursorRecord,
  MessageDetailRecord,
  MirroredItemRecord,
  PendingApprovalRecord,
  ProposedPlanActionRecord,
  ProposedPlanActionStatus,
  ProjectBridgeRecord,
  RetainedTurnRecord,
  SessionLogCursorRecord,
  ThreadBridgeRecord,
  WriteBackQueueRecord,
  WriteBackQueueStatus
} from "../domain.js";

type ApprovalRow = Record<string, unknown>;

export class StateStore {
  private readonly database: any;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS project_bridges (
        project_key TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        discord_category_id TEXT NOT NULL UNIQUE,
        created_by_bridge INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_bridges (
        codex_thread_id TEXT PRIMARY KEY,
        discord_channel_id TEXT,
        status_message_id TEXT,
        cwd TEXT,
        repo_name TEXT,
        last_seen_at TEXT NOT NULL,
        attach_mode TEXT NOT NULL,
        thread_name TEXT,
        actor_name TEXT,
        last_status_type TEXT,
        last_turn_id TEXT,
        last_turn_status TEXT,
        parent_codex_thread_id TEXT,
        parent_anchor_turn_id TEXT,
        parent_anchor_turn_cursor TEXT,
        project_key TEXT,
        project_name TEXT,
        discord_parent_channel_id TEXT,
        channel_kind TEXT,
        source_kind TEXT,
        latest_mirrored_timestamp_ms INTEGER,
        latest_mirrored_cursor TEXT,
        latest_mirrored_turn_cursor TEXT,
        latest_mirrored_source_file_path TEXT,
        latest_mirrored_source_offset INTEGER,
        latest_mirrored_source_event_key TEXT
      );

      CREATE TABLE IF NOT EXISTS pending_approvals (
        token TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        feedback_turn_id TEXT,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        sanitized_preview TEXT NOT NULL,
        cwd TEXT,
        reason TEXT,
        available_decisions TEXT NOT NULL,
        decision_payloads TEXT NOT NULL DEFAULT '{}',
        expires_at TEXT NOT NULL,
        discord_message_id TEXT,
        status TEXT NOT NULL,
        details TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restart_disabled_at TEXT,
        tool_input TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        sanitized_preview TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mirrored_items (
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        discord_message_id TEXT NOT NULL,
        group_key TEXT,
        content_signature TEXT NOT NULL,
        rendered_content TEXT NOT NULL,
        timestamp_ms INTEGER,
        cursor TEXT,
        turn_cursor TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, item_id)
      );

      CREATE TABLE IF NOT EXISTS mirrored_item_messages (
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        discord_message_id TEXT NOT NULL,
        message_order INTEGER NOT NULL,
        PRIMARY KEY (thread_id, item_id, discord_message_id),
        FOREIGN KEY (thread_id, item_id) REFERENCES mirrored_items(thread_id, item_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_log_cursors (
        thread_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS desktop_log_cursors (
        file_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_details (
        token TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        button_label TEXT NOT NULL,
        detail TEXT NOT NULL,
        discord_message_id TEXT,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retained_turns (
        thread_id TEXT NOT NULL,
        turn_key TEXT NOT NULL,
        turn_id TEXT,
        turn_cursor TEXT,
        anchor_item_id TEXT,
        anchor_text TEXT,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, turn_key)
      );

      CREATE TABLE IF NOT EXISTS child_thread_anchors (
        child_thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        parent_turn_id TEXT,
        parent_turn_cursor TEXT,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS canonical_thread_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        item_kind TEXT,
        turn_id TEXT,
        turn_cursor TEXT,
        item_id TEXT,
        request_id TEXT,
        summary TEXT,
        detail TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS write_back_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codex_thread_id TEXT NOT NULL,
        discord_channel_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discord_message_inputs (
        message_id TEXT PRIMARY KEY,
        queue_id INTEGER NOT NULL UNIQUE,
        turn_id TEXT,
        echo_item_id TEXT,
        thinking_reaction_state TEXT
      );

      CREATE TABLE IF NOT EXISTS proposed_plan_actions (
        token TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        item_id TEXT NOT NULL,
        plan_text TEXT NOT NULL,
        status TEXT NOT NULL,
        discord_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        expires_at TEXT NOT NULL,
        error TEXT
      );
    `);

    const queueColumns = this.database.pragma("table_info(write_back_queue)") as Array<{ name: string }>;
    for (const column of ["lease_expires_at", "dispatch_started_at"]) {
      if (!queueColumns.some((entry) => entry.name === column)) {
        this.database.exec(`ALTER TABLE write_back_queue ADD COLUMN ${column} TEXT`);
      }
    }
    const inputColumns = this.database.pragma("table_info(discord_message_inputs)") as Array<{ name: string }>;
    if (!inputColumns.some((column) => column.name === "thinking_reaction_state")) {
      this.database.exec("ALTER TABLE discord_message_inputs ADD COLUMN thinking_reaction_state TEXT");
    }

    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_bridges_category_id ON project_bridges(discord_category_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_bridges_discord_channel_id ON thread_bridges(discord_channel_id);
      CREATE INDEX IF NOT EXISTS idx_thread_bridges_parent_thread_id ON thread_bridges(parent_codex_thread_id);
      CREATE INDEX IF NOT EXISTS idx_thread_bridges_project_key ON thread_bridges(project_key);
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_request_id ON pending_approvals(request_id);
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_item ON pending_approvals(thread_id, item_id, kind);
      CREATE INDEX IF NOT EXISTS idx_mirrored_items_thread_id ON mirrored_items(thread_id);
      CREATE INDEX IF NOT EXISTS idx_mirrored_items_cursor ON mirrored_items(thread_id, cursor);
      CREATE INDEX IF NOT EXISTS idx_mirrored_items_turn_id ON mirrored_items(thread_id, turn_id);
      CREATE INDEX IF NOT EXISTS idx_mirrored_items_turn_cursor ON mirrored_items(thread_id, turn_cursor);
      CREATE INDEX IF NOT EXISTS idx_mirrored_item_messages_message_id ON mirrored_item_messages(discord_message_id);
      CREATE INDEX IF NOT EXISTS idx_session_log_cursors_updated_at ON session_log_cursors(updated_at);
      CREATE INDEX IF NOT EXISTS idx_desktop_log_cursors_updated_at ON desktop_log_cursors(updated_at);
      CREATE INDEX IF NOT EXISTS idx_message_details_thread_id ON message_details(thread_id);
      CREATE INDEX IF NOT EXISTS idx_message_details_expires_at ON message_details(expires_at);
      CREATE INDEX IF NOT EXISTS idx_proposed_plan_actions_thread_id ON proposed_plan_actions(thread_id);
      CREATE INDEX IF NOT EXISTS idx_proposed_plan_actions_message_id ON proposed_plan_actions(discord_message_id);
      CREATE INDEX IF NOT EXISTS idx_proposed_plan_actions_expires_at ON proposed_plan_actions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_retained_turns_thread_id ON retained_turns(thread_id);
      CREATE INDEX IF NOT EXISTS idx_retained_turns_turn_cursor ON retained_turns(thread_id, turn_cursor);
      CREATE INDEX IF NOT EXISTS idx_child_thread_anchors_parent_thread_id ON child_thread_anchors(parent_thread_id);
      CREATE INDEX IF NOT EXISTS idx_canonical_thread_events_thread_id ON canonical_thread_events(thread_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_write_back_queue_thread_status ON write_back_queue(codex_thread_id, status, id);
      CREATE INDEX IF NOT EXISTS idx_write_back_queue_status ON write_back_queue(status, id);
    `);
  }

  private setSchemaMetaValue(key: string, value: string): void {
    this.database
      .prepare(`
        INSERT INTO schema_meta (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(key, value, new Date().toISOString());
  }

  setBridgeMetaValue(key: string, value: string): void {
    this.setSchemaMetaValue(key, value);
  }

  getBridgeMetaValue(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  upsertProjectBridge(record: ProjectBridgeRecord): void {
    this.database
      .prepare(`
        INSERT INTO project_bridges (
          project_key,
          project_name,
          discord_category_id,
          created_by_bridge,
          updated_at
        ) VALUES (
          @projectKey,
          @projectName,
          @discordCategoryId,
          @createdByBridge,
          @updatedAt
        )
        ON CONFLICT(project_key) DO UPDATE SET
          project_name = excluded.project_name,
          discord_category_id = excluded.discord_category_id,
          created_by_bridge = excluded.created_by_bridge,
          updated_at = excluded.updated_at
      `)
      .run({
        ...record,
        createdByBridge: record.createdByBridge ? 1 : 0
      });
  }

  getProjectBridge(projectKey: string): ProjectBridgeRecord | undefined {
    return this.selectOne(
      `SELECT * FROM project_bridges WHERE project_key = ?`,
      [projectKey],
      (row) => this.mapProjectBridge(row)
    );
  }

  listProjectBridges(): ProjectBridgeRecord[] {
    return this.selectMany(
      `SELECT * FROM project_bridges ORDER BY project_name ASC`,
      [],
      (row) => this.mapProjectBridge(row)
    );
  }

  upsertThreadBridge(record: ThreadBridgeRecord): void {
    this.database
      .prepare(`
        INSERT INTO thread_bridges (
          codex_thread_id,
          parent_codex_thread_id,
          parent_anchor_turn_id,
          parent_anchor_turn_cursor,
          project_key,
          project_name,
          discord_channel_id,
          discord_parent_channel_id,
          status_message_id,
          cwd,
          repo_name,
          last_seen_at,
          attach_mode,
          thread_name,
          actor_name,
          last_status_type,
          last_turn_id,
          last_turn_status,
          channel_kind,
          source_kind,
          latest_mirrored_timestamp_ms,
          latest_mirrored_cursor,
          latest_mirrored_turn_cursor,
          latest_mirrored_source_file_path,
          latest_mirrored_source_offset,
          latest_mirrored_source_event_key
        ) VALUES (
          @codexThreadId,
          @parentCodexThreadId,
          @parentAnchorTurnId,
          @parentAnchorTurnCursor,
          @projectKey,
          @projectName,
          @discordChannelId,
          @discordParentChannelId,
          @statusMessageId,
          @cwd,
          @repoName,
          @lastSeenAt,
          @attachMode,
          @threadName,
          @actorName,
          @lastStatusType,
          @lastTurnId,
          @lastTurnStatus,
          @channelKind,
          @sourceKind,
          @latestMirroredTimestampMs,
          @latestMirroredCursor,
          @latestMirroredTurnCursor,
          @latestMirroredSourceFilePath,
          @latestMirroredSourceOffset,
          @latestMirroredSourceEventKey
        )
        ON CONFLICT(codex_thread_id) DO UPDATE SET
          parent_codex_thread_id = excluded.parent_codex_thread_id,
          parent_anchor_turn_id = excluded.parent_anchor_turn_id,
          parent_anchor_turn_cursor = excluded.parent_anchor_turn_cursor,
          project_key = excluded.project_key,
          project_name = excluded.project_name,
          discord_channel_id = excluded.discord_channel_id,
          discord_parent_channel_id = excluded.discord_parent_channel_id,
          status_message_id = excluded.status_message_id,
          cwd = excluded.cwd,
          repo_name = excluded.repo_name,
          last_seen_at = excluded.last_seen_at,
          attach_mode = excluded.attach_mode,
          thread_name = excluded.thread_name,
          actor_name = excluded.actor_name,
          last_status_type = excluded.last_status_type,
          last_turn_id = excluded.last_turn_id,
          last_turn_status = excluded.last_turn_status,
          channel_kind = excluded.channel_kind,
          source_kind = excluded.source_kind,
          latest_mirrored_timestamp_ms = excluded.latest_mirrored_timestamp_ms,
          latest_mirrored_cursor = excluded.latest_mirrored_cursor,
          latest_mirrored_turn_cursor = excluded.latest_mirrored_turn_cursor,
          latest_mirrored_source_file_path = excluded.latest_mirrored_source_file_path,
          latest_mirrored_source_offset = excluded.latest_mirrored_source_offset,
          latest_mirrored_source_event_key = excluded.latest_mirrored_source_event_key
      `)
      .run({
        actorName: null,
        lastTurnId: null,
        lastTurnStatus: null,
        parentAnchorTurnId: null,
        parentAnchorTurnCursor: null,
        sourceKind: "app-server",
        latestMirroredTimestampMs: null,
        latestMirroredCursor: null,
        latestMirroredTurnCursor: null,
        latestMirroredSourceFilePath: null,
        latestMirroredSourceOffset: null,
        latestMirroredSourceEventKey: null,
        ...record
      });
  }

  getThreadBridge(codexThreadId: string): ThreadBridgeRecord | undefined {
    return this.selectOne(
      `SELECT * FROM thread_bridges WHERE codex_thread_id = ?`,
      [codexThreadId],
      (row) => this.mapThreadBridge(row)
    );
  }

  findThreadBridgeByDiscordChannelId(discordChannelId: string): ThreadBridgeRecord | undefined {
    return this.selectOne(
      `SELECT * FROM thread_bridges WHERE discord_channel_id = ? LIMIT 1`,
      [discordChannelId],
      (row) => this.mapThreadBridge(row)
    );
  }

  listThreadBridges(): ThreadBridgeRecord[] {
    return this.selectMany(
      `SELECT * FROM thread_bridges ORDER BY last_seen_at DESC`,
      [],
      (row) => this.mapThreadBridge(row)
    );
  }

  listThreadBridgesByKind(channelKind: ThreadBridgeRecord["channelKind"]): ThreadBridgeRecord[] {
    return this.selectMany(
      `SELECT * FROM thread_bridges WHERE channel_kind = ? ORDER BY last_seen_at DESC`,
      [channelKind],
      (row) => this.mapThreadBridge(row)
    );
  }

  deleteThreadBridge(codexThreadId: string): void {
    this.database
      .prepare(`DELETE FROM thread_bridges WHERE codex_thread_id = ?`)
      .run(codexThreadId);
    this.database
      .prepare(`DELETE FROM session_log_cursors WHERE thread_id = ?`)
      .run(codexThreadId);
    this.database
      .prepare(`DELETE FROM message_details WHERE thread_id = ?`)
      .run(codexThreadId);
    this.database
      .prepare(`DELETE FROM proposed_plan_actions WHERE thread_id = ?`)
      .run(codexThreadId);
  }

  updateThreadMirrorCursor(
    codexThreadId: string,
    latestMirroredTimestampMs: number | null,
    latestMirroredCursor: string | null,
    latestMirroredTurnCursor: string | null,
    latestMirroredSourceFrontier?: {
      filePath: string | null;
      offset: number | null;
      eventKey: string | null;
    }
  ): void {
    this.database
      .prepare(`
        UPDATE thread_bridges
        SET
          latest_mirrored_timestamp_ms = ?,
          latest_mirrored_cursor = ?,
          latest_mirrored_turn_cursor = ?,
          latest_mirrored_source_file_path = ?,
          latest_mirrored_source_offset = ?,
          latest_mirrored_source_event_key = ?
        WHERE codex_thread_id = ?
      `)
      .run(
        latestMirroredTimestampMs,
        latestMirroredCursor,
        latestMirroredTurnCursor,
        latestMirroredSourceFrontier?.filePath ?? null,
        latestMirroredSourceFrontier?.offset ?? null,
        latestMirroredSourceFrontier?.eventKey ?? null,
        codexThreadId
      );
  }

  deletePendingApprovalsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM pending_approvals WHERE thread_id = ?`)
      .run(threadId);
  }

  upsertMirroredItem(record: MirroredItemRecord): void {
    this.database
      .prepare(`
        INSERT INTO mirrored_items (
          thread_id,
          item_id,
          turn_id,
          kind,
          discord_message_id,
          group_key,
          content_signature,
          rendered_content,
          timestamp_ms,
          cursor,
          turn_cursor,
          updated_at
        ) VALUES (
          @threadId,
          @itemId,
          @turnId,
          @kind,
          @discordMessageId,
          @groupKey,
          @contentSignature,
          @renderedContent,
          @timestampMs,
          @cursor,
          @turnCursor,
          @updatedAt
        )
        ON CONFLICT(thread_id, item_id) DO UPDATE SET
          turn_id = excluded.turn_id,
          kind = excluded.kind,
          discord_message_id = excluded.discord_message_id,
          group_key = excluded.group_key,
          content_signature = excluded.content_signature,
          rendered_content = excluded.rendered_content,
          timestamp_ms = excluded.timestamp_ms,
          cursor = excluded.cursor,
          turn_cursor = excluded.turn_cursor,
          updated_at = excluded.updated_at
      `)
      .run(record);
    this.replaceMirroredItemMessageIds(
      record.threadId,
      record.itemId,
      this.normalizeMirroredItemMessageIds(record.discordMessageIds, record.discordMessageId)
    );
  }

  getMirroredItem(threadId: string, itemId: string): MirroredItemRecord | undefined {
    return this.selectOne(
      `SELECT * FROM mirrored_items WHERE thread_id = ? AND item_id = ?`,
      [threadId, itemId],
      (row) => this.mapMirroredItem(row)
    );
  }

  listMirroredItems(threadId: string): MirroredItemRecord[] {
    return this.selectMany(
      `SELECT * FROM mirrored_items WHERE thread_id = ? ORDER BY timestamp_ms ASC, cursor ASC, item_id ASC`,
      [threadId],
      (row) => this.mapMirroredItem(row)
    );
  }

  deleteMirroredItem(threadId: string, itemId: string): void {
    this.database
      .prepare(`DELETE FROM mirrored_item_messages WHERE thread_id = ? AND item_id = ?`)
      .run(threadId, itemId);
    this.database
      .prepare(`DELETE FROM mirrored_items WHERE thread_id = ? AND item_id = ?`)
      .run(threadId, itemId);
  }

  deleteMirroredItemsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM mirrored_item_messages WHERE thread_id = ?`)
      .run(threadId);
    this.database
      .prepare(`DELETE FROM mirrored_items WHERE thread_id = ?`)
      .run(threadId);
  }

  replaceMirroredItemMessageIds(threadId: string, itemId: string, discordMessageIds: string[]): void {
    const normalizedIds = this.normalizeMirroredItemMessageIds(discordMessageIds, null);
    const transaction = this.database.transaction((ids: string[]) => {
      this.database
        .prepare(`DELETE FROM mirrored_item_messages WHERE thread_id = ? AND item_id = ?`)
        .run(threadId, itemId);
      const insert = this.database.prepare(`
          INSERT INTO mirrored_item_messages (
            thread_id,
            item_id,
            discord_message_id,
            message_order
          ) VALUES (?, ?, ?, ?)
        `);
      ids.forEach((messageId, index) => {
        insert.run(threadId, itemId, messageId, index);
      });
    });
    transaction(normalizedIds);
  }

  listMirroredItemMessageIds(threadId: string, itemId: string): string[] {
    return this.selectMany(
      `
        SELECT discord_message_id
        FROM mirrored_item_messages
        WHERE thread_id = ? AND item_id = ?
        ORDER BY message_order ASC, discord_message_id ASC
      `,
      [threadId, itemId],
      (row) => String(row.discord_message_id)
    );
  }

  deleteMessageDetailsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM message_details WHERE thread_id = ?`)
      .run(threadId);
  }

  deleteProposedPlanActionsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM proposed_plan_actions WHERE thread_id = ?`)
      .run(threadId);
  }

  upsertMessageDetail(record: MessageDetailRecord): void {
    this.database
      .prepare(`
        INSERT INTO message_details (
          token,
          thread_id,
          kind,
          title,
          button_label,
          detail,
          discord_message_id,
          expires_at,
          updated_at
        ) VALUES (
          @token,
          @threadId,
          @kind,
          @title,
          @buttonLabel,
          @detail,
          @discordMessageId,
          @expiresAt,
          @updatedAt
        )
        ON CONFLICT(token) DO UPDATE SET
          thread_id = excluded.thread_id,
          kind = excluded.kind,
          title = excluded.title,
          button_label = excluded.button_label,
          detail = excluded.detail,
          discord_message_id = excluded.discord_message_id,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `)
      .run(record);
  }

  findMessageDetailByToken(token: string): MessageDetailRecord | undefined {
    return this.selectOne(
      `SELECT * FROM message_details WHERE token = ?`,
      [token],
      (row) => this.mapMessageDetail(row)
    );
  }

  listMessageDetailsByDiscordMessageId(discordMessageId: string): MessageDetailRecord[] {
    return this.selectMany(
      `SELECT * FROM message_details WHERE discord_message_id = ? ORDER BY updated_at ASC, token ASC`,
      [discordMessageId],
      (row) => this.mapMessageDetail(row)
    );
  }

  listExpiredMessageDetails(beforeIso: string): MessageDetailRecord[] {
    return this.selectMany(
      `SELECT * FROM message_details WHERE expires_at <= ? ORDER BY expires_at ASC`,
      [beforeIso],
      (row) => this.mapMessageDetail(row)
    );
  }

  deleteMessageDetail(token: string): void {
    this.database
      .prepare(`DELETE FROM message_details WHERE token = ?`)
      .run(token);
  }

  upsertProposedPlanAction(record: ProposedPlanActionRecord): void {
    this.database
      .prepare(`
        INSERT INTO proposed_plan_actions (
          token,
          thread_id,
          turn_id,
          item_id,
          plan_text,
          status,
          discord_message_id,
          created_at,
          updated_at,
          completed_at,
          expires_at,
          error
        ) VALUES (
          @token,
          @threadId,
          @turnId,
          @itemId,
          @planText,
          @status,
          @discordMessageId,
          @createdAt,
          @updatedAt,
          @completedAt,
          @expiresAt,
          @error
        )
        ON CONFLICT(token) DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          item_id = excluded.item_id,
          plan_text = excluded.plan_text,
          status = excluded.status,
          discord_message_id = excluded.discord_message_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          expires_at = excluded.expires_at,
          error = excluded.error
      `)
      .run(record);
  }

  findProposedPlanActionByToken(token: string): ProposedPlanActionRecord | undefined {
    return this.selectOne(
      `SELECT * FROM proposed_plan_actions WHERE token = ?`,
      [token],
      (row) => this.mapProposedPlanActionRecord(row)
    );
  }

  listProposedPlanActions(threadId?: string): ProposedPlanActionRecord[] {
    return this.selectMany(
      threadId
        ? `SELECT * FROM proposed_plan_actions WHERE thread_id = ? ORDER BY created_at ASC, token ASC`
        : `SELECT * FROM proposed_plan_actions ORDER BY created_at ASC, token ASC`,
      threadId ? [threadId] : [],
      (row) => this.mapProposedPlanActionRecord(row)
    );
  }

  claimPendingProposedPlanAction(token: string): ProposedPlanActionRecord | null {
    const claim = this.database.transaction(() => {
      const now = new Date().toISOString();
      const result = this.database
        .prepare(`
          UPDATE proposed_plan_actions
          SET status = 'sending',
              updated_at = ?,
              error = NULL
          WHERE token = ?
            AND status = 'pending'
            AND expires_at > ?
        `)
        .run(now, token, now);
      if (Number(result.changes ?? 0) === 0) {
        return null;
      }
      return this.findProposedPlanActionByToken(token) ?? null;
    });
    return claim();
  }

  completeProposedPlanAction(
    token: string,
    status: Extract<ProposedPlanActionStatus, "accepted" | "feedbackSent">
  ): ProposedPlanActionRecord | null {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE proposed_plan_actions
        SET status = ?,
            updated_at = ?,
            completed_at = ?,
            error = NULL
        WHERE token = ? AND status = 'sending'
      `)
      .run(status, now, now, token);
    if (Number(result.changes ?? 0) === 0) {
      return null;
    }
    return this.findProposedPlanActionByToken(token) ?? null;
  }

  restoreProposedPlanActionPending(token: string, error: string | null = null): void {
    this.database
      .prepare(`
        UPDATE proposed_plan_actions
        SET status = 'pending',
            updated_at = ?,
            error = ?
        WHERE token = ? AND status = 'sending'
      `)
      .run(new Date().toISOString(), error, token);
  }

  upsertSessionLogCursor(record: SessionLogCursorRecord): void {
    this.database
      .prepare(`
        INSERT INTO session_log_cursors (
          thread_id,
          file_path,
          byte_offset,
          updated_at
        ) VALUES (
          @threadId,
          @filePath,
          @byteOffset,
          @updatedAt
        )
        ON CONFLICT(thread_id) DO UPDATE SET
          file_path = excluded.file_path,
          byte_offset = excluded.byte_offset,
          updated_at = excluded.updated_at
      `)
      .run(record);
  }

  getSessionLogCursor(threadId: string): SessionLogCursorRecord | undefined {
    return this.selectOne(
      `SELECT * FROM session_log_cursors WHERE thread_id = ?`,
      [threadId],
      (row) => this.mapSessionLogCursor(row)
    );
  }

  deleteSessionLogCursor(threadId: string): void {
    this.database
      .prepare(`DELETE FROM session_log_cursors WHERE thread_id = ?`)
      .run(threadId);
  }

  upsertDesktopLogCursor(record: DesktopLogCursorRecord): void {
    this.database
      .prepare(`
        INSERT INTO desktop_log_cursors (
          file_path,
          byte_offset,
          updated_at
        ) VALUES (
          @filePath,
          @byteOffset,
          @updatedAt
        )
        ON CONFLICT(file_path) DO UPDATE SET
          byte_offset = excluded.byte_offset,
          updated_at = excluded.updated_at
      `)
      .run(record);
  }

  getDesktopLogCursor(filePath: string): DesktopLogCursorRecord | undefined {
    return this.selectOne(
      `SELECT * FROM desktop_log_cursors WHERE file_path = ?`,
      [filePath],
      (row) => this.mapDesktopLogCursor(row)
    );
  }

  deleteDesktopLogCursor(filePath: string): void {
    this.database
      .prepare(`DELETE FROM desktop_log_cursors WHERE file_path = ?`)
      .run(filePath);
  }

  upsertRetainedTurn(record: RetainedTurnRecord): void {
    this.database
      .prepare(`
        INSERT INTO retained_turns (
          thread_id,
          turn_key,
          turn_id,
          turn_cursor,
          anchor_item_id,
          anchor_text,
          source,
          updated_at
        ) VALUES (
          @threadId,
          @turnKey,
          @turnId,
          @turnCursor,
          @anchorItemId,
          @anchorText,
          @source,
          @updatedAt
        )
        ON CONFLICT(thread_id, turn_key) DO UPDATE SET
          turn_id = excluded.turn_id,
          turn_cursor = excluded.turn_cursor,
          anchor_item_id = excluded.anchor_item_id,
          anchor_text = excluded.anchor_text,
          source = excluded.source,
          updated_at = excluded.updated_at
      `)
      .run(record);
  }

  listRetainedTurns(threadId: string): RetainedTurnRecord[] {
    return this.selectMany(
      `
        SELECT * FROM retained_turns
        WHERE thread_id = ?
        ORDER BY COALESCE(turn_cursor, turn_key) ASC, updated_at ASC
      `,
      [threadId],
      (row) => this.mapRetainedTurn(row)
    );
  }

  deleteRetainedTurn(threadId: string, turnKey: string): void {
    this.database
      .prepare(`DELETE FROM retained_turns WHERE thread_id = ? AND turn_key = ?`)
      .run(threadId, turnKey);
  }

  deleteRetainedTurnsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM retained_turns WHERE thread_id = ?`)
      .run(threadId);
  }

  upsertChildThreadAnchor(record: ChildThreadAnchorRecord): void {
    this.database
      .prepare(`
        INSERT INTO child_thread_anchors (
          child_thread_id,
          parent_thread_id,
          parent_turn_id,
          parent_turn_cursor,
          source,
          updated_at
        ) VALUES (
          @childThreadId,
          @parentThreadId,
          @parentTurnId,
          @parentTurnCursor,
          @source,
          @updatedAt
        )
        ON CONFLICT(child_thread_id) DO UPDATE SET
          parent_thread_id = excluded.parent_thread_id,
          parent_turn_id = excluded.parent_turn_id,
          parent_turn_cursor = excluded.parent_turn_cursor,
          source = excluded.source,
          updated_at = excluded.updated_at
      `)
      .run(record);
  }

  getChildThreadAnchor(childThreadId: string): ChildThreadAnchorRecord | null {
    return (
      this.selectOne(
      `SELECT * FROM child_thread_anchors WHERE child_thread_id = ? LIMIT 1`,
      [childThreadId],
      (row) => this.mapChildThreadAnchor(row)
      ) ?? null
    );
  }

  listChildThreadAnchorsForParent(parentThreadId: string): ChildThreadAnchorRecord[] {
    return this.selectMany(
      `
        SELECT * FROM child_thread_anchors
        WHERE parent_thread_id = ?
        ORDER BY updated_at ASC, child_thread_id ASC
      `,
      [parentThreadId],
      (row) => this.mapChildThreadAnchor(row)
    );
  }

  deleteChildThreadAnchor(childThreadId: string): void {
    this.database
      .prepare(`DELETE FROM child_thread_anchors WHERE child_thread_id = ?`)
      .run(childThreadId);
  }

  appendCanonicalThreadEvent(
    record: Omit<CanonicalThreadEventRecord, "id">
  ): void {
    this.database
      .prepare(`
        INSERT INTO canonical_thread_events (
          thread_id,
          source,
          event_kind,
          item_kind,
          turn_id,
          turn_cursor,
          item_id,
          request_id,
          summary,
          detail,
          created_at
        ) VALUES (
          @threadId,
          @source,
          @eventKind,
          @itemKind,
          @turnId,
          @turnCursor,
          @itemId,
          @requestId,
          @summary,
          @detail,
          @createdAt
        )
      `)
      .run(record);
  }

  appendCanonicalThreadEventIfNew(
    record: Omit<CanonicalThreadEventRecord, "id">
  ): boolean {
    const result = this.database
      .prepare(`
        INSERT INTO canonical_thread_events (
          thread_id,
          source,
          event_kind,
          item_kind,
          turn_id,
          turn_cursor,
          item_id,
          request_id,
          summary,
          detail,
          created_at
        )
        SELECT
          @threadId,
          @source,
          @eventKind,
          @itemKind,
          @turnId,
          @turnCursor,
          @itemId,
          @requestId,
          @summary,
          @detail,
          @createdAt
        WHERE NOT EXISTS (
          SELECT 1
          FROM canonical_thread_events
          WHERE
            thread_id = @threadId AND
            source = @source AND
            event_kind = @eventKind AND
            COALESCE(item_kind, '') = COALESCE(@itemKind, '') AND
            COALESCE(turn_id, '') = COALESCE(@turnId, '') AND
            COALESCE(turn_cursor, '') = COALESCE(@turnCursor, '') AND
            COALESCE(item_id, '') = COALESCE(@itemId, '') AND
            COALESCE(request_id, '') = COALESCE(@requestId, '')
          LIMIT 1
        )
      `)
      .run(record);
    return Number(result.changes ?? 0) > 0;
  }

  listCanonicalThreadEvents(threadId: string, limit: number): CanonicalThreadEventRecord[] {
    return this.selectMany(
      `
        SELECT * FROM canonical_thread_events
        WHERE thread_id = ?
        ORDER BY id DESC
        LIMIT ?
      `,
      [threadId, Math.max(1, Math.floor(limit))],
      (row) => this.mapCanonicalThreadEvent(row)
    ).reverse();
  }

  deleteCanonicalThreadEventsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM canonical_thread_events WHERE thread_id = ?`)
      .run(threadId);
  }

  clearBridgeState(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.database.exec(`
        DROP TABLE IF EXISTS discord_message_inputs;
        DROP TABLE IF EXISTS write_back_queue;
        DROP TABLE IF EXISTS canonical_thread_events;
        DROP TABLE IF EXISTS child_thread_anchors;
        DROP TABLE IF EXISTS retained_turns;
        DROP TABLE IF EXISTS proposed_plan_actions;
        DROP TABLE IF EXISTS desktop_log_cursors;
        DROP TABLE IF EXISTS session_log_cursors;
        DROP TABLE IF EXISTS mirrored_item_messages;
        DROP TABLE IF EXISTS mirrored_items;
        DROP TABLE IF EXISTS message_details;
        DROP TABLE IF EXISTS pending_approvals;
        DROP TABLE IF EXISTS audit_log;
        DROP TABLE IF EXISTS thread_bridges;
        DROP TABLE IF EXISTS project_bridges;
        DROP TABLE IF EXISTS schema_meta;
      `);
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
    this.initializeSchema();
  }

  updateStatusMessageId(codexThreadId: string, statusMessageId: string): void {
    this.database
      .prepare(`UPDATE thread_bridges SET status_message_id = ? WHERE codex_thread_id = ?`)
      .run(statusMessageId, codexThreadId);
  }

  createWriteBackQueueItem(input: {
    threadId: string;
    discordChannelId: string;
    actorUserId: string;
    text: string;
  }): WriteBackQueueRecord {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        INSERT INTO write_back_queue (
          codex_thread_id,
          discord_channel_id,
          actor_user_id,
          text,
          status,
          created_at,
          updated_at,
          sent_at,
          error
        ) VALUES (
          @threadId,
          @discordChannelId,
          @actorUserId,
          @text,
          'pending',
          @now,
          @now,
          NULL,
          NULL
        )
      `)
      .run({
        ...input,
        now
      });
    const id = Number(result.lastInsertRowid);
    const record = this.getWriteBackQueueItem(id);
    if (!record) {
      throw new Error(`Failed to create write-back queue item ${id}.`);
    }
    return record;
  }

  createDiscordMessageQueueItemOnce(messageId: string, input: {
    threadId: string;
    discordChannelId: string;
    actorUserId: string;
    text: string;
  }): WriteBackQueueRecord | null {
    return this.database.transaction(() => {
      if (this.hasDiscordMessageInput(messageId)) {
        return null;
      }
      const record = this.createWriteBackQueueItem(input);
      this.database.prepare("INSERT INTO discord_message_inputs (message_id, queue_id) VALUES (?, ?)")
        .run(messageId, record.id);
      return record;
    })();
  }

  hasDiscordMessageInput(messageId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM discord_message_inputs WHERE message_id = ?").get(messageId));
  }

  getDiscordMessageIdForQueueItem(queueId: number): string | null {
    const row = this.database.prepare("SELECT message_id FROM discord_message_inputs WHERE queue_id = ?")
      .get(queueId) as { message_id: string } | undefined;
    return row?.message_id ?? null;
  }

  bindDiscordMessageInputTurn(queueId: number, turnId: string): void {
    this.database.prepare("UPDATE discord_message_inputs SET turn_id = ? WHERE queue_id = ? AND turn_id IS NULL")
      .run(turnId, queueId);
  }

  claimDiscordInputThinkingReaction(queueId: number, present: boolean): boolean {
    if (!present) {
      return this.database.transaction(() => {
        const source = this.database.prepare(`
          SELECT thinking_reaction_state FROM discord_message_inputs WHERE queue_id = ? AND turn_id IS NOT NULL
        `).get(queueId) as { thinking_reaction_state: string | null } | undefined;
        if (!source || source.thinking_reaction_state === "finished") return false;
        this.database.prepare("UPDATE discord_message_inputs SET thinking_reaction_state = 'finished' WHERE queue_id = ?")
          .run(queueId);
        return source.thinking_reaction_state === "started";
      })();
    }
    const result = this.database.prepare(`
      UPDATE discord_message_inputs SET thinking_reaction_state = 'started'
      WHERE queue_id = ? AND turn_id IS NOT NULL
        AND thinking_reaction_state IS NULL
    `).run(queueId);
    return result.changes > 0;
  }

  listDiscordMessageQueueItemsForTurn(threadId: string, turnId: string): WriteBackQueueRecord[] {
    return this.selectMany(`
      SELECT queue.* FROM discord_message_inputs AS source
      JOIN write_back_queue AS queue ON queue.id = source.queue_id
      WHERE queue.codex_thread_id = ? AND source.turn_id = ?
    `, [threadId, turnId], (row) => this.mapWriteBackQueueRecord(row));
  }

  claimDiscordMessageEcho(threadId: string, turnId: string, text: string, itemId: string): boolean {
    return this.database.transaction(() => {
      const source = this.database.prepare(`
        SELECT source.message_id, source.echo_item_id FROM discord_message_inputs AS source
        JOIN write_back_queue AS queue ON queue.id = source.queue_id
        WHERE queue.codex_thread_id = ? AND source.turn_id = ? AND queue.text = ?
        LIMIT 1
      `).get(threadId, turnId, text.trim()) as { message_id: string; echo_item_id: string | null } | undefined;
      if (!source) return false;
      if (source.echo_item_id !== null) return source.echo_item_id === itemId;
      this.database.prepare("UPDATE discord_message_inputs SET echo_item_id = ? WHERE message_id = ?")
        .run(itemId, source.message_id);
      return true;
    })();
  }

  getWriteBackQueueItem(id: number): WriteBackQueueRecord | undefined {
    return this.selectOne(
      `SELECT * FROM write_back_queue WHERE id = ? LIMIT 1`,
      [id],
      (row) => this.mapWriteBackQueueRecord(row)
    );
  }

  listWriteBackQueueItems(threadId?: string): WriteBackQueueRecord[] {
    return this.selectMany(
      threadId
        ? `SELECT * FROM write_back_queue WHERE codex_thread_id = ? ORDER BY id ASC`
        : `SELECT * FROM write_back_queue ORDER BY id ASC`,
      threadId ? [threadId] : [],
      (row) => this.mapWriteBackQueueRecord(row)
    );
  }

  countPendingWriteBackQueueItems(threadId: string): number {
    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM write_back_queue
        WHERE codex_thread_id = ? AND status = 'pending'
      `)
      .get(threadId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  claimNextPendingWriteBackQueueItem(threadId: string): WriteBackQueueRecord | null {
    const claim = this.database.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM write_back_queue WHERE codex_thread_id = ? AND status IN ('sending', 'uncertain') LIMIT 1").get(threadId)) return null;
      const row = this.database
        .prepare(`
          SELECT * FROM write_back_queue
          WHERE codex_thread_id = ? AND status = 'pending'
          ORDER BY id ASC
          LIMIT 1
        `)
        .get(threadId) as Record<string, unknown> | undefined;
      if (!row) {
        return null;
      }
      const id = Number(row.id);
      const now = new Date().toISOString();
      const result = this.database
        .prepare(`
          UPDATE write_back_queue
          SET status = 'sending',
              updated_at = ?,
              error = NULL, lease_expires_at = ?, dispatch_started_at = NULL
          WHERE id = ? AND status = 'pending'
        `)
        .run(now, new Date(Date.now() + 120_000).toISOString(), id);
      if (Number(result.changes ?? 0) === 0) {
        return null;
      }
      return this.getWriteBackQueueItem(id) ?? null;
    });
    return claim();
  }

  claimWriteBackQueueItem(id: number): WriteBackQueueRecord | null {
    const claim = this.database.transaction(() => {
      const now = new Date().toISOString();
      const result = this.database
        .prepare(`
          UPDATE write_back_queue
          SET status = 'sending',
              updated_at = ?,
              error = NULL, lease_expires_at = ?, dispatch_started_at = NULL
          WHERE id = ? AND status = 'pending'
        `)
        .run(now, new Date(Date.now() + 120_000).toISOString(), id);
      if (Number(result.changes ?? 0) === 0) {
        return null;
      }
      return this.getWriteBackQueueItem(id) ?? null;
    });
    return claim();
  }

  markWriteBackQueueItemSent(id: number): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        UPDATE write_back_queue
        SET status = 'sent',
            updated_at = ?,
            sent_at = ?,
            error = NULL
        WHERE id = ?
      `)
      .run(now, now, id);
  }

  markWriteBackDispatchStarted(id: number): void {
    this.database.prepare("UPDATE write_back_queue SET dispatch_started_at = ? WHERE id = ? AND status = 'sending'")
      .run(new Date().toISOString(), id);
  }

  markWriteBackQueueItemUncertain(id: number): void {
    this.database.prepare("UPDATE write_back_queue SET status = 'uncertain', error = 'uncertain', updated_at = ? WHERE id = ? AND status = 'sending'")
      .run(new Date().toISOString(), id);
  }

  /** A missing phase on legacy sending rows is ambiguous, never safe to retry. */
  recoverExpiredWriteBackClaims(threadId: string, now = Date.now()): void {
    this.database.prepare(`UPDATE write_back_queue SET
      status = CASE WHEN dispatch_started_at IS NULL AND lease_expires_at IS NOT NULL THEN 'pending' ELSE 'uncertain' END,
      error = CASE WHEN dispatch_started_at IS NULL AND lease_expires_at IS NOT NULL THEN NULL ELSE 'uncertain' END,
      updated_at = ?
      WHERE codex_thread_id = ? AND status = 'sending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
      .run(new Date(now).toISOString(), threadId, new Date(now).toISOString());
  }

  retractUncertainWriteBackQueueItem(threadId: string): WriteBackQueueRecord | null {
    const row = this.database.prepare("SELECT id FROM write_back_queue WHERE codex_thread_id = ? AND status = 'uncertain' ORDER BY id LIMIT 1")
      .get(threadId) as { id: number } | undefined;
    if (!row) return null;
    this.database.prepare("UPDATE write_back_queue SET status = 'retracted', updated_at = ? WHERE id = ? AND status = 'uncertain'")
      .run(new Date().toISOString(), row.id);
    return this.getWriteBackQueueItem(row.id) ?? null;
  }

  markWriteBackQueueItemFailed(id: number, error: string): void {
    this.setWriteBackQueueItemTerminalStatus(id, "failed", error);
  }

  markWriteBackQueueItemRetracted(id: number): WriteBackQueueRecord | null {
    return this.transitionPendingWriteBackQueueItem(id, "retracted");
  }

  retractLatestPendingWriteBackQueueItem(threadId: string): WriteBackQueueRecord | null {
    const retract = this.database.transaction(() => {
      const row = this.database
        .prepare(`
          SELECT * FROM write_back_queue
          WHERE codex_thread_id = ? AND status = 'pending'
          ORDER BY id DESC
          LIMIT 1
        `)
        .get(threadId) as Record<string, unknown> | undefined;
      if (!row) {
        return null;
      }
      return this.transitionPendingWriteBackQueueItem(Number(row.id), "retracted");
    });
    return retract();
  }

  restoreWriteBackQueueItemPending(id: number, error: string | null = null): void {
    this.database
      .prepare(`
        UPDATE write_back_queue
        SET status = 'pending',
            updated_at = ?,
            error = ?
        WHERE id = ? AND status = 'sending'
      `)
      .run(new Date().toISOString(), error, id);
  }

  private transitionPendingWriteBackQueueItem(
    id: number,
    status: Extract<WriteBackQueueStatus, "retracted">
  ): WriteBackQueueRecord | null {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE write_back_queue
        SET status = ?,
            updated_at = ?,
            error = NULL
        WHERE id = ? AND status = 'pending'
      `)
      .run(status, now, id);
    if (Number(result.changes ?? 0) === 0) {
      return null;
    }
    return this.getWriteBackQueueItem(id) ?? null;
  }

  private setWriteBackQueueItemTerminalStatus(
    id: number,
    status: Extract<WriteBackQueueStatus, "failed">,
    error: string | null
  ): void {
    this.database
      .prepare(`
        UPDATE write_back_queue
        SET status = ?,
            updated_at = ?,
            error = ?
        WHERE id = ?
      `)
      .run(status, new Date().toISOString(), error, id);
  }

  upsertPendingApproval(record: PendingApprovalRecord): void {
    this.database
      .prepare(`
        INSERT INTO pending_approvals (
          token,
          request_id,
          thread_id,
          turn_id,
          feedback_turn_id,
          item_id,
          kind,
          sanitized_preview,
          cwd,
          reason,
          available_decisions,
          decision_payloads,
          expires_at,
          discord_message_id,
          status,
          details,
          created_at,
          restart_disabled_at,
          tool_input
        ) VALUES (
          @token,
          @requestId,
          @threadId,
          @turnId,
          @feedbackTurnId,
          @itemId,
          @kind,
          @sanitizedPreview,
          @cwd,
          @reason,
          @availableDecisions,
          @decisionPayloads,
          @expiresAt,
          @discordMessageId,
          @status,
          @details,
          @createdAt,
          @restartDisabledAt,
          @toolInput
        )
        ON CONFLICT(token) DO UPDATE SET
          request_id = excluded.request_id,
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          feedback_turn_id = excluded.feedback_turn_id,
          item_id = excluded.item_id,
          kind = excluded.kind,
          sanitized_preview = excluded.sanitized_preview,
          cwd = excluded.cwd,
          reason = excluded.reason,
          available_decisions = excluded.available_decisions,
          decision_payloads = excluded.decision_payloads,
          expires_at = excluded.expires_at,
          discord_message_id = excluded.discord_message_id,
          status = excluded.status,
          details = excluded.details,
          created_at = excluded.created_at,
          restart_disabled_at = excluded.restart_disabled_at,
          tool_input = excluded.tool_input
      `)
      .run({
        ...record,
        feedbackTurnId: record.feedbackTurnId ?? null,
        availableDecisions: JSON.stringify(record.availableDecisions),
        decisionPayloads: JSON.stringify(record.decisionPayloads),
        restartDisabledAt: record.restartDisabledAt ?? null,
        toolInput: record.toolInput ? JSON.stringify(record.toolInput) : null
      });
  }

  findPendingApprovalByToken(token: string): PendingApprovalRecord | undefined {
    return this.selectOne(
      `SELECT * FROM pending_approvals WHERE token = ?`,
      [token],
      (row) => this.mapPendingApproval(row)
    );
  }

  findPendingApprovalByRequestId(requestId: string): PendingApprovalRecord | undefined {
    return this.selectOne(
      `SELECT * FROM pending_approvals WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`,
      [requestId],
      (row) => this.mapPendingApproval(row)
    );
  }

  findPendingApprovalByItem(threadId: string, itemId: string, kind: string): PendingApprovalRecord | undefined {
    return this.selectOne(
      `
        SELECT * FROM pending_approvals
        WHERE thread_id = ? AND item_id = ? AND kind = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [threadId, itemId, kind],
      (row) => this.mapPendingApproval(row)
    );
  }

  listPendingApprovals(): PendingApprovalRecord[] {
    return this.selectMany(
      `SELECT * FROM pending_approvals ORDER BY created_at DESC`,
      [],
      (row) => this.mapPendingApproval(row)
    );
  }

  listActionableApprovals(): PendingApprovalRecord[] {
    return this.selectMany(
      `
        SELECT * FROM pending_approvals
        WHERE status IN ('pending', 'decisionSent') AND restart_disabled_at IS NULL
        ORDER BY created_at DESC
      `,
      [],
      (row) => this.mapPendingApproval(row)
    );
  }

  refreshPendingApprovalRecord(previousToken: string, record: PendingApprovalRecord): void {
    this.database
      .prepare(`
        UPDATE pending_approvals
        SET
          token = @token,
          request_id = @requestId,
          thread_id = @threadId,
          turn_id = @turnId,
          feedback_turn_id = @feedbackTurnId,
          item_id = @itemId,
          kind = @kind,
          sanitized_preview = @sanitizedPreview,
          cwd = @cwd,
          reason = @reason,
          available_decisions = @availableDecisions,
          decision_payloads = @decisionPayloads,
          expires_at = @expiresAt,
          discord_message_id = @discordMessageId,
          status = @status,
          details = @details,
          created_at = @createdAt,
          restart_disabled_at = @restartDisabledAt,
          tool_input = @toolInput
        WHERE token = @previousToken
      `)
      .run({
        previousToken,
        ...record,
        feedbackTurnId: record.feedbackTurnId ?? null,
        availableDecisions: JSON.stringify(record.availableDecisions),
        decisionPayloads: JSON.stringify(record.decisionPayloads),
        restartDisabledAt: record.restartDisabledAt ?? null,
        toolInput: record.toolInput ? JSON.stringify(record.toolInput) : null
      });
  }

  setPendingApprovalToolInputSelection(
    token: string,
    questionId: string,
    answer: string
  ): PendingApprovalRecord | undefined {
    const record = this.findPendingApprovalByToken(token);
    if (!record?.toolInput) {
      return record;
    }
    const toolInput = {
      ...record.toolInput,
      selectedAnswers: {
        ...record.toolInput.selectedAnswers,
        [questionId]: answer
      }
    };
    this.database
      .prepare(`UPDATE pending_approvals SET tool_input = ? WHERE token = ?`)
      .run(JSON.stringify(toolInput), token);
    return {
      ...record,
      toolInput
    };
  }

  setPendingApprovalStatus(token: string, status: PendingApprovalRecord["status"]): void {
    this.database
      .prepare(`
        UPDATE pending_approvals
        SET
          status = @status,
          restart_disabled_at = CASE WHEN @status = 'pending' THEN restart_disabled_at ELSE NULL END
        WHERE token = @token
      `)
      .run({ token, status });
  }

  setPendingApprovalStatusByRequestId(requestId: string, status: PendingApprovalRecord["status"]): void {
    this.database
      .prepare(`
        UPDATE pending_approvals
        SET
          status = @status,
          restart_disabled_at = CASE WHEN @status = 'pending' THEN restart_disabled_at ELSE NULL END
        WHERE request_id = @requestId
      `)
      .run({ requestId, status });
  }

  setPendingApprovalMessageId(token: string, discordMessageId: string): void {
    this.database
      .prepare(`UPDATE pending_approvals SET discord_message_id = ? WHERE token = ?`)
      .run(discordMessageId, token);
  }

  setPendingApprovalRestartDisabled(token: string, restartDisabledAt: string | null): void {
    this.database
      .prepare(`UPDATE pending_approvals SET restart_disabled_at = ? WHERE token = ?`)
      .run(restartDisabledAt, token);
  }

  clearPendingApprovalMessageIdsByThread(threadId: string): void {
    this.database
      .prepare(`UPDATE pending_approvals SET discord_message_id = NULL WHERE thread_id = ?`)
      .run(threadId);
  }

  deletePendingApproval(token: string): void {
    this.database
      .prepare(`DELETE FROM pending_approvals WHERE token = ?`)
      .run(token);
  }

  appendAuditLog(record: AuditLogRecord): void {
    this.database
      .prepare(`
        INSERT INTO audit_log (
          timestamp,
          discord_user_id,
          thread_id,
          turn_id,
          request_id,
          decision,
          sanitized_preview
        ) VALUES (
          @timestamp,
          @discordUserId,
          @threadId,
          @turnId,
          @requestId,
          @decision,
          @sanitizedPreview
        )
      `)
      .run(record);
  }

  deleteAuditLogOlderThan(cutoffIso: string): number {
    const result = this.database
      .prepare(`DELETE FROM audit_log WHERE timestamp < ?`)
      .run(cutoffIso);
    return Number(result.changes ?? 0);
  }

  deleteInactiveApprovalsOlderThan(cutoffIso: string): number {
    const result = this.database
      .prepare(`
        DELETE FROM pending_approvals
        WHERE status IN ('approved', 'rejected', 'expired', 'stale') AND created_at < ?
      `)
      .run(cutoffIso);
    return Number(result.changes ?? 0);
  }

  close(): void {
    this.database.close();
  }

  private selectOne<Row extends Record<string, unknown>, Value>(
    sql: string,
    params: unknown[],
    mapRow: (row: Row) => Value
  ): Value | undefined {
    const row = this.database.prepare(sql).get(...params) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  private selectMany<Row extends Record<string, unknown>, Value>(
    sql: string,
    params: unknown[],
    mapRow: (row: Row) => Value
  ): Value[] {
    return (this.database.prepare(sql).all(...params) as Row[]).map((row) => mapRow(row));
  }

  private readNullableNumber(value: unknown): number | null {
    if (typeof value === "number") {
      return value;
    }
    if (value === null || value === undefined) {
      return null;
    }
    return Number(value);
  }

  private readNumber(value: unknown): number {
    return typeof value === "number" ? value : Number(value);
  }

  private mapProjectBridge(row: Record<string, unknown>): ProjectBridgeRecord {
    return {
      projectKey: String(row.project_key),
      projectName: String(row.project_name),
      discordCategoryId: String(row.discord_category_id),
      createdByBridge: Number(row.created_by_bridge) === 1,
      updatedAt: String(row.updated_at)
    };
  }

  private mapPendingApproval(row: ApprovalRow): PendingApprovalRecord {
    return {
      token: String(row.token),
      requestId: String(row.request_id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      feedbackTurnId: row.feedback_turn_id ? String(row.feedback_turn_id) : null,
      itemId: String(row.item_id),
      kind: String(row.kind) as PendingApprovalRecord["kind"],
      sanitizedPreview: String(row.sanitized_preview),
      cwd: row.cwd ? String(row.cwd) : null,
      reason: row.reason ? String(row.reason) : null,
      availableDecisions: JSON.parse(String(row.available_decisions)) as string[],
      decisionPayloads: row.decision_payloads
        ? (JSON.parse(String(row.decision_payloads)) as Record<string, unknown>)
        : {},
      expiresAt: String(row.expires_at),
      discordMessageId: row.discord_message_id ? String(row.discord_message_id) : null,
      status: String(row.status) as PendingApprovalRecord["status"],
      details: String(row.details),
      createdAt: String(row.created_at),
      restartDisabledAt: row.restart_disabled_at ? String(row.restart_disabled_at) : null,
      toolInput: row.tool_input
        ? (JSON.parse(String(row.tool_input)) as NonNullable<PendingApprovalRecord["toolInput"]>)
        : null
    };
  }

  private mapThreadBridge(row: Record<string, unknown>): ThreadBridgeRecord {
    return {
      codexThreadId: String(row.codex_thread_id),
      parentCodexThreadId: row.parent_codex_thread_id ? String(row.parent_codex_thread_id) : null,
      parentAnchorTurnId: row.parent_anchor_turn_id ? String(row.parent_anchor_turn_id) : null,
      parentAnchorTurnCursor: row.parent_anchor_turn_cursor ? String(row.parent_anchor_turn_cursor) : null,
      projectKey: row.project_key ? String(row.project_key) : "no-workspace",
      projectName: row.project_name ? String(row.project_name) : "No Workspace",
      discordChannelId: String(row.discord_channel_id),
      discordParentChannelId: row.discord_parent_channel_id ? String(row.discord_parent_channel_id) : null,
      statusMessageId: row.status_message_id ? String(row.status_message_id) : null,
      cwd: row.cwd ? String(row.cwd) : null,
      repoName: row.repo_name ? String(row.repo_name) : null,
      lastSeenAt: String(row.last_seen_at),
      attachMode: row.attach_mode === "manual" ? "manual" : "auto",
      threadName: row.thread_name ? String(row.thread_name) : null,
      actorName: row.actor_name ? String(row.actor_name) : null,
      lastStatusType: row.last_status_type ? String(row.last_status_type) : null,
      lastTurnId: row.last_turn_id ? String(row.last_turn_id) : null,
      lastTurnStatus: row.last_turn_status ? String(row.last_turn_status) : null,
      channelKind: row.channel_kind === "subagent" ? "subagent" : "conversation",
      sourceKind: row.source_kind === "cli-session" ? "cli-session" : "app-server",
      latestMirroredTimestampMs: this.readNullableNumber(row.latest_mirrored_timestamp_ms),
      latestMirroredCursor: row.latest_mirrored_cursor ? String(row.latest_mirrored_cursor) : null,
      latestMirroredTurnCursor: row.latest_mirrored_turn_cursor ? String(row.latest_mirrored_turn_cursor) : null,
      latestMirroredSourceFilePath: row.latest_mirrored_source_file_path
        ? String(row.latest_mirrored_source_file_path)
        : null,
      latestMirroredSourceOffset: this.readNullableNumber(row.latest_mirrored_source_offset),
      latestMirroredSourceEventKey: row.latest_mirrored_source_event_key
        ? String(row.latest_mirrored_source_event_key)
        : null
    };
  }

  private mapMirroredItem(row: Record<string, unknown>): MirroredItemRecord {
    const threadId = String(row.thread_id);
    const itemId = String(row.item_id);
    const discordMessageId = String(row.discord_message_id);
    const discordMessageIds = this.listMirroredItemMessageIds(threadId, itemId);
    return {
      threadId,
      itemId,
      turnId: row.turn_id ? String(row.turn_id) : null,
      kind: String(row.kind) as MirroredItemRecord["kind"],
      discordMessageId,
      discordMessageIds: discordMessageIds.length > 0 ? discordMessageIds : [discordMessageId],
      groupKey: row.group_key ? String(row.group_key) : null,
      contentSignature: String(row.content_signature),
      renderedContent: String(row.rendered_content),
      timestampMs: this.readNullableNumber(row.timestamp_ms),
      cursor: row.cursor ? String(row.cursor) : null,
      turnCursor: row.turn_cursor ? String(row.turn_cursor) : null,
      updatedAt: String(row.updated_at)
    };
  }

  private normalizeMirroredItemMessageIds(
    rawMessageIds: string[] | undefined,
    fallbackMessageId: string | null
  ): string[] {
    const candidates = [
      ...(Array.isArray(rawMessageIds) ? rawMessageIds : []),
      ...(fallbackMessageId ? [fallbackMessageId] : [])
    ];
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const trimmed = candidate.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      normalized.push(trimmed);
    }
    return normalized;
  }

  private mapMessageDetail(row: Record<string, unknown>): MessageDetailRecord {
    return {
      token: String(row.token),
      threadId: String(row.thread_id),
      kind: String(row.kind) as MessageDetailRecord["kind"],
      title: String(row.title),
      buttonLabel: String(row.button_label ?? "Show details"),
      detail: String(row.detail),
      discordMessageId: row.discord_message_id ? String(row.discord_message_id) : null,
      expiresAt: String(row.expires_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapProposedPlanActionRecord(row: Record<string, unknown>): ProposedPlanActionRecord {
    const status = String(row.status ?? "");
    return {
      token: String(row.token),
      threadId: String(row.thread_id),
      turnId: row.turn_id ? String(row.turn_id) : null,
      itemId: String(row.item_id),
      planText: String(row.plan_text),
      status:
        status === "pending" ||
        status === "sending" ||
        status === "accepted" ||
        status === "feedbackSent" ||
        status === "failed"
          ? status
          : "failed",
      discordMessageId: row.discord_message_id ? String(row.discord_message_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      expiresAt: String(row.expires_at),
      error: row.error ? String(row.error) : null
    };
  }

  private mapSessionLogCursor(row: Record<string, unknown>): SessionLogCursorRecord {
    return {
      threadId: String(row.thread_id),
      filePath: String(row.file_path),
      byteOffset: this.readNumber(row.byte_offset),
      updatedAt: String(row.updated_at)
    };
  }

  private mapDesktopLogCursor(row: Record<string, unknown>): DesktopLogCursorRecord {
    return {
      filePath: String(row.file_path),
      byteOffset: this.readNumber(row.byte_offset),
      updatedAt: String(row.updated_at)
    };
  }

  private mapRetainedTurn(row: Record<string, unknown>): RetainedTurnRecord {
    const source = String(row.source ?? "");
    return {
      threadId: String(row.thread_id),
      turnKey: String(row.turn_key),
      turnId: row.turn_id ? String(row.turn_id) : null,
      turnCursor: row.turn_cursor ? String(row.turn_cursor) : null,
      anchorItemId: row.anchor_item_id ? String(row.anchor_item_id) : null,
      anchorText: row.anchor_text ? String(row.anchor_text) : null,
      source: source === "session" || source === "codex-read" ? source : "codex-read",
      updatedAt: String(row.updated_at)
    };
  }

  private mapChildThreadAnchor(row: Record<string, unknown>): ChildThreadAnchorRecord {
    const source = String(row.source ?? "");
    return {
      childThreadId: String(row.child_thread_id),
      parentThreadId: String(row.parent_thread_id),
      parentTurnId: row.parent_turn_id ? String(row.parent_turn_id) : null,
      parentTurnCursor: row.parent_turn_cursor ? String(row.parent_turn_cursor) : null,
      source: source === "session" || source === "codex-read" ? source : "codex-read",
      updatedAt: String(row.updated_at)
    };
  }

  private mapCanonicalThreadEvent(row: Record<string, unknown>): CanonicalThreadEventRecord {
    const source = String(row.source ?? "");
    const eventKind = String(row.event_kind ?? "");
    return {
      id: this.readNumber(row.id),
      threadId: String(row.thread_id),
      source:
        source === "session" ||
        source === "desktop-ipc" ||
        source === "app-server" ||
        source === "discord" ||
        source === "codex-read"
          ? source
          : "app-server",
      eventKind:
        eventKind === "content" ||
        eventKind === "childAnchor" ||
        eventKind === "approvalUpsert" ||
        eventKind === "approvalResolved" ||
        eventKind === "status" ||
        eventKind === "ignoredHint" ||
        eventKind === "approvalHold" ||
        eventKind === "approvalRelease" ||
        eventKind === "writeBackQueued" ||
        eventKind === "writeBackSent" ||
        eventKind === "writeBackFailed" ||
        eventKind === "writeBackRetracted"
          ? eventKind
          : "content",
      itemKind: row.item_kind ? String(row.item_kind) : null,
      turnId: row.turn_id ? String(row.turn_id) : null,
      turnCursor: row.turn_cursor ? String(row.turn_cursor) : null,
      itemId: row.item_id ? String(row.item_id) : null,
      requestId: row.request_id ? String(row.request_id) : null,
      summary: row.summary ? String(row.summary) : null,
      detail: row.detail ? String(row.detail) : null,
      createdAt: String(row.created_at)
    };
  }

  private mapWriteBackQueueRecord(row: Record<string, unknown>): WriteBackQueueRecord {
    const status = String(row.status ?? "");
    return {
      id: this.readNumber(row.id),
      threadId: String(row.codex_thread_id),
      discordChannelId: String(row.discord_channel_id),
      actorUserId: String(row.actor_user_id),
      text: String(row.text),
      status:
        status === "pending" ||
        status === "sending" ||
        status === "uncertain" ||
        status === "sent" ||
        status === "failed" ||
        status === "retracted"
          ? status
          : "failed",
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      sentAt: row.sent_at ? String(row.sent_at) : null,
      error: row.error ? String(row.error) : null
    };
  }
}
