/**
 * RoomStore: room lifecycle + snapshots + the per-room monotonic sequence.
 * Every broadcastable change calls nextSeq(), which also appends to the
 * event log (recap + gap detection share one source of truth).
 */
import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { Participant, Playback, RoomSettings, RoomSnapshot, RoomState } from "@kavga/shared";
import { QueueEngine } from "../queue/engine.js";
import { newQrToken, newRoomCode } from "./codes.js";
import { transition, type RoomEvent } from "./machine.js";
import { assignAvatar, cleanNickname } from "../util/sanitize.js";

const DEFAULT_SETTINGS: RoomSettings = {
  maxQueuedPerPerson: 2,
  queueLocked: false,
  partyMode: false,
  muted: false,
};

export interface RoomRow {
  id: string;
  code: string;
  qr_token: string;
  state: RoomState;
  host_connected: number;
  settings_json: string;
  seq: number;
}

export class RoomStore {
  readonly engine: QueueEngine;
  /** In-memory presence (sockets are per-process). */
  private connected = new Map<string, Set<string>>(); // roomId -> participantIds
  private playback = new Map<string, Playback>();

  constructor(private readonly db: Database.Database) {
    this.engine = new QueueEngine(db);
  }

  createRoom(): { id: string; code: string; qrToken: string; hostKey: string } {
    const id = nanoid(10);
    const code = this.uniqueCode();
    const qrToken = newQrToken();
    const hostKey = nanoid(24);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO rooms (id, code, qr_token, settings_json, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, code, qrToken, JSON.stringify({ ...DEFAULT_SETTINGS, hostKey }), now, now);
    return { id, code, qrToken, hostKey };
  }

  private uniqueCode(): string {
    for (let i = 0; i < 50; i++) {
      const code = newRoomCode();
      const clash = this.db
        .prepare(`SELECT 1 FROM rooms WHERE code = ? AND state != 'ended'`)
        .get(code);
      if (!clash) return code;
    }
    throw new Error("could not allocate a room code");
  }

  roomByCode(code: string): RoomRow | undefined {
    return this.db
      .prepare(`SELECT * FROM rooms WHERE code = ? AND state != 'ended'`)
      .get(code.toUpperCase()) as RoomRow | undefined;
  }

  roomById(id: string): RoomRow | undefined {
    return this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id) as RoomRow | undefined;
  }

  hostKeyOf(room: RoomRow): string {
    return JSON.parse(room.settings_json).hostKey ?? "";
  }

  settingsOf(room: RoomRow): RoomSettings {
    const raw = JSON.parse(room.settings_json);
    return {
      maxQueuedPerPerson: raw.maxQueuedPerPerson ?? 2,
      queueLocked: Boolean(raw.queueLocked),
      partyMode: Boolean(raw.partyMode),
      muted: Boolean(raw.muted),
    };
  }

  updateSettings(roomId: string, patch: Partial<RoomSettings>): RoomSettings {
    const room = this.roomById(roomId)!;
    const merged = { ...JSON.parse(room.settings_json), ...patch };
    this.db.prepare(`UPDATE rooms SET settings_json = ? WHERE id = ?`).run(JSON.stringify(merged), roomId);
    return this.settingsOf({ ...room, settings_json: JSON.stringify(merged) });
  }

  /* ---------------- membership ---------------- */

  join(roomId: string, rawNickname: string): { ok: true; participant: Participant } | { ok: false; reason: string } {
    const cleaned = cleanNickname(rawNickname);
    if (!cleaned.ok) return cleaned;
    const count = (
      this.db.prepare(`SELECT count(*) AS n FROM participants WHERE room_id = ?`).get(roomId) as { n: number }
    ).n;
    const { emoji, color } = assignAvatar(count);
    const id = nanoid(12);
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO participants (id, room_id, nickname, emoji, color, joined_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, roomId, cleaned.nickname, emoji, color, now, now);
    } catch {
      return { ok: false, reason: "Bu takma ad odada zaten var." };
    }
    this.touch(roomId);
    return { ok: true, participant: this.participant(roomId, id)! };
  }

  participant(roomId: string, participantId: string): Participant | undefined {
    const r = this.db
      .prepare(
        `SELECT id, nickname, emoji, color, super_votes_left, vetoes_left, revenge_tokens, kicked
         FROM participants WHERE id = ? AND room_id = ?`,
      )
      .get(participantId, roomId) as
      | {
          id: string;
          nickname: string;
          emoji: string;
          color: string;
          super_votes_left: number;
          vetoes_left: number;
          revenge_tokens: number;
          kicked: number;
        }
      | undefined;
    if (!r || r.kicked) return undefined;
    return {
      id: r.id,
      nickname: r.nickname,
      emoji: r.emoji,
      color: r.color,
      superVotesLeft: r.super_votes_left,
      vetoesLeft: r.vetoes_left,
      revengeTokens: r.revenge_tokens,
      connected: this.connected.get(roomId)?.has(r.id) ?? false,
    };
  }

  participants(roomId: string): Participant[] {
    const rows = this.db
      .prepare(`SELECT id FROM participants WHERE room_id = ? AND kicked = 0 ORDER BY joined_at`)
      .all(roomId) as { id: string }[];
    return rows.map((r) => this.participant(roomId, r.id)!).filter(Boolean);
  }

  kick(roomId: string, participantId: string): void {
    this.db
      .prepare(`UPDATE participants SET kicked = 1 WHERE id = ? AND room_id = ?`)
      .run(participantId, roomId);
  }

  /* ---------------- presence ---------------- */

  markConnected(roomId: string, participantId: string, on: boolean): void {
    let set = this.connected.get(roomId);
    if (!set) this.connected.set(roomId, (set = new Set()));
    if (on) set.add(participantId);
    else set.delete(participantId);
    this.db
      .prepare(`UPDATE participants SET last_seen_at = ? WHERE id = ?`)
      .run(Date.now(), participantId);
    this.touch(roomId);
  }

  setHostConnected(roomId: string, on: boolean): RoomState {
    const room = this.roomById(roomId)!;
    const next = transition(room.state, on ? "HOST_RECONNECT" : "HOST_DISCONNECT");
    this.db
      .prepare(`UPDATE rooms SET host_connected = ?, state = ?, last_activity_at = ? WHERE id = ?`)
      .run(on ? 1 : 0, next, Date.now(), roomId);
    return next;
  }

  /* ---------------- state machine ---------------- */

  applyEvent(roomId: string, event: RoomEvent): RoomState {
    const room = this.roomById(roomId)!;
    const next = transition(room.state, event);
    this.db
      .prepare(`UPDATE rooms SET state = ?, last_activity_at = ? WHERE id = ?`)
      .run(next, Date.now(), roomId);
    return next;
  }

  touch(roomId: string): void {
    this.db.prepare(`UPDATE rooms SET last_activity_at = ? WHERE id = ?`).run(Date.now(), roomId);
  }

  /* ---------------- sequence + event log ---------------- */

  nextSeq(roomId: string, type: string, payload: unknown = {}): number {
    const seq = this.db.transaction(() => {
      this.db.prepare(`UPDATE rooms SET seq = seq + 1 WHERE id = ?`).run(roomId);
      const { seq } = this.db.prepare(`SELECT seq FROM rooms WHERE id = ?`).get(roomId) as { seq: number };
      this.db
        .prepare(`INSERT INTO events (room_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(roomId, seq, type, JSON.stringify(payload), Date.now());
      return seq;
    })();
    return seq;
  }

  currentSeq(roomId: string): number {
    return (this.db.prepare(`SELECT seq FROM rooms WHERE id = ?`).get(roomId) as { seq: number }).seq;
  }

  /* ---------------- playback relay ---------------- */

  setPlayback(roomId: string, pb: Playback): void {
    this.playback.set(roomId, pb);
  }

  getPlayback(roomId: string): Playback {
    return (
      this.playback.get(roomId) ?? {
        songId: null,
        positionS: 0,
        durationS: null,
        updatedAt: Date.now(),
        isFallback: false,
      }
    );
  }

  /* ---------------- snapshot (full re-sync payload) ---------------- */

  snapshot(roomId: string, forParticipant?: string): RoomSnapshot {
    const room = this.roomById(roomId)!;
    const nowPlaying = this.engine.nowPlaying(roomId);
    const skip = nowPlaying
      ? this.engine.skipState(roomId, nowPlaying.id)
      : { votes: 0, needed: 0, passed: false, voted: [] };
    return {
      seq: room.seq,
      code: room.code,
      state: room.state,
      settings: this.settingsOf(room),
      participants: this.participants(roomId),
      queue: this.engine.rankedQueue(roomId, forParticipant),
      nowPlaying,
      playback: this.getPlayback(roomId),
      skip: { votes: skip.votes, needed: skip.needed, voted: skip.voted },
      hostConnected: Boolean(room.host_connected),
    };
  }

  /* ---------------- cleanup ---------------- */

  /** End rooms idle for longer than maxIdleMs; returns ended room ids. */
  sweepIdle(maxIdleMs = 24 * 60 * 60 * 1000): string[] {
    const cutoff = Date.now() - maxIdleMs;
    const stale = this.db
      .prepare(`SELECT id FROM rooms WHERE state != 'ended' AND last_activity_at < ?`)
      .all(cutoff) as { id: string }[];
    for (const { id } of stale) {
      this.db.prepare(`UPDATE rooms SET state = 'ended' WHERE id = ?`).run(id);
    }
    return stale.map((s) => s.id);
  }
}
