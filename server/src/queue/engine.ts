/**
 * Queue engine — every mutation of the battlefield lives here.
 *
 * All methods are SYNCHRONOUS (better-sqlite3 + single-threaded Node), which
 * serializes concurrent clients for free: twenty phones voting in the same
 * tick still apply one-at-a-time. The concurrency test proves the math.
 *
 * Nothing here trusts the client: membership, arsenal, armor, limits and the
 * one-vote-per-person rule are all enforced against the database.
 */
import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { Song, TensionEvent } from "@kavga/shared";
import { rankQueue, skipNeeded, skipPasses } from "./rank.js";

export class EngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const err = (code: string, msg: string) => new EngineError(code, msg);

export interface EngineConfig {
  maxQueuedPerPerson: number;
  fallbackPoolSize: number;
}

export const DEFAULT_CONFIG: EngineConfig = { maxQueuedPerPerson: 2, fallbackPoolSize: 20 };

interface SongRow {
  id: string;
  room_id: string;
  youtube_id: string;
  title: string;
  thumbnail_url: string;
  duration_s: number | null;
  added_by: string;
  added_at: number;
  status: string;
  armor: number;
  lowest_score: number;
  nickname: string;
  score: number;
}

export class QueueEngine {
  constructor(
    private readonly db: Database.Database,
    private readonly config: EngineConfig = DEFAULT_CONFIG,
  ) {}

  /* ---------------- guards ---------------- */

  private participant(roomId: string, participantId: string) {
    const row = this.db
      .prepare(
        `SELECT id, nickname, super_votes_left, vetoes_left, revenge_tokens, kicked
         FROM participants WHERE id = ? AND room_id = ?`,
      )
      .get(participantId, roomId) as
      | {
          id: string;
          nickname: string;
          super_votes_left: number;
          vetoes_left: number;
          revenge_tokens: number;
          kicked: number;
        }
      | undefined;
    if (!row || row.kicked) throw err("not_in_room", "Bu odada değilsin.");
    return row;
  }

  private queuedSong(roomId: string, songId: string) {
    const row = this.db
      .prepare(
        `SELECT s.*, p.nickname FROM songs s JOIN participants p ON p.id = s.added_by
         WHERE s.id = ? AND s.room_id = ? AND s.status = 'queued'`,
      )
      .get(songId, roomId) as (SongRow & { nickname: string }) | undefined;
    if (!row) throw err("song_not_queued", "Şarkı kuyrukta değil.");
    return row;
  }

  private roomSettings(roomId: string): { queueLocked: boolean } {
    const row = this.db.prepare(`SELECT settings_json FROM rooms WHERE id = ?`).get(roomId) as
      | { settings_json: string }
      | undefined;
    if (!row) throw err("no_room", "Oda yok.");
    const s = JSON.parse(row.settings_json || "{}");
    return { queueLocked: Boolean(s.queueLocked) };
  }

  /* ---------------- adds ---------------- */

  addSong(
    roomId: string,
    participantId: string,
    input: { youtubeId: string; title: string; thumbnailUrl: string; durationS: number | null },
    useArmor = false,
  ): { song: Song; tension: TensionEvent } {
    return this.db.transaction(() => {
      const p = this.participant(roomId, participantId);
      if (this.roomSettings(roomId).queueLocked) throw err("queue_locked", "Kuyruk kilitli.");

      const queuedByMe = (
        this.db
          .prepare(
            `SELECT count(*) AS n FROM songs WHERE room_id = ? AND added_by = ? AND status = 'queued'`,
          )
          .get(roomId, participantId) as { n: number }
      ).n;
      if (queuedByMe >= this.config.maxQueuedPerPerson)
        throw err("too_many_queued", `Aynı anda en fazla ${this.config.maxQueuedPerPerson} şarkın sırada olabilir.`);

      let armor = 0;
      if (useArmor) {
        if (p.revenge_tokens <= 0) throw err("no_revenge_token", "Rövanş hakkın yok.");
        this.db
          .prepare(`UPDATE participants SET revenge_tokens = revenge_tokens - 1 WHERE id = ?`)
          .run(participantId);
        armor = 1;
      }

      const id = nanoid(12);
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO songs (id, room_id, youtube_id, title, thumbnail_url, duration_s, added_by, added_at, status, armor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(id, roomId, input.youtubeId, input.title, input.thumbnailUrl, input.durationS, participantId, now, armor);

      const tension: TensionEvent = armor
        ? { kind: "armor", who: p.nickname, title: input.title }
        : { kind: "add", who: p.nickname, title: input.title };
      return { song: this.songById(roomId, id), tension };
    })();
  }

  /* ---------------- votes ---------------- */

  /** value: 1 up, -1 down, 0 remove my vote. One vote per person, changeable. */
  vote(roomId: string, participantId: string, songId: string, value: -1 | 0 | 1): { tension?: TensionEvent } {
    return this.db.transaction(() => {
      const p = this.participant(roomId, participantId);
      const song = this.queuedSong(roomId, songId);

      const existing = this.db
        .prepare(`SELECT value FROM votes WHERE song_id = ? AND participant_id = ?`)
        .get(songId, participantId) as { value: number } | undefined;

      if (existing?.value === 3)
        throw err("super_locked", "Süper oy geri alınamaz."); // drama is permanent

      if (value === 0) {
        this.db.prepare(`DELETE FROM votes WHERE song_id = ? AND participant_id = ?`).run(songId, participantId);
        this.trackLowestScore(songId);
        return {};
      }
      this.db
        .prepare(
          `INSERT INTO votes (song_id, participant_id, value, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (song_id, participant_id) DO UPDATE SET value = excluded.value`,
        )
        .run(songId, participantId, value, Date.now());
      this.trackLowestScore(songId);
      return { tension: { kind: "vote" as const, who: p.nickname, title: song.title, value } };
    })();
  }

  superVote(roomId: string, participantId: string, songId: string): { tension: TensionEvent } {
    return this.db.transaction(() => {
      const p = this.participant(roomId, participantId);
      if (p.super_votes_left <= 0) throw err("no_super", "Süper oyunu zaten kullandın.");
      const song = this.queuedSong(roomId, songId);

      // Super vote REPLACES any prior vote on this song by this person.
      this.db
        .prepare(
          `INSERT INTO votes (song_id, participant_id, value, created_at) VALUES (?, ?, 3, ?)
           ON CONFLICT (song_id, participant_id) DO UPDATE SET value = 3`,
        )
        .run(songId, participantId, Date.now());
      this.db
        .prepare(`UPDATE participants SET super_votes_left = super_votes_left - 1 WHERE id = ?`)
        .run(participantId);
      this.trackLowestScore(songId);
      return { tension: { kind: "super" as const, who: p.nickname, title: song.title } };
    })();
  }

  /* ---------------- veto ---------------- */

  veto(roomId: string, participantId: string, songId: string): { tension: TensionEvent; victimId: string } {
    return this.db.transaction(() => {
      const p = this.participant(roomId, participantId);
      if (p.vetoes_left <= 0) throw err("no_veto", "Vetonu zaten kullandın.");
      const song = this.queuedSong(roomId, songId);
      if (song.added_by === participantId) throw err("self_veto", "Kendi şarkını vetolayamazsın, sil yeter.");
      if (song.armor) throw err("armored", "Bu şarkı zırhlı — veto işlemez. (Veton yanmadı.)");

      this.db.prepare(`UPDATE songs SET status = 'vetoed' WHERE id = ?`).run(songId);
      this.db.prepare(`UPDATE participants SET vetoes_left = vetoes_left - 1 WHERE id = ?`).run(participantId);
      // Revenge: the victim's NEXT song can carry permanent armor.
      this.db
        .prepare(`UPDATE participants SET revenge_tokens = revenge_tokens + 1 WHERE id = ?`)
        .run(song.added_by);

      return {
        victimId: song.added_by,
        tension: { kind: "veto" as const, who: p.nickname, victim: song.nickname, title: song.title },
      };
    })();
  }

  /* ---------------- skip ---------------- */

  skipVote(
    roomId: string,
    participantId: string,
    currentSongId: string,
  ): { votes: number; needed: number; passed: boolean } {
    return this.db.transaction(() => {
      this.participant(roomId, participantId);
      this.db
        .prepare(
          `INSERT INTO skip_votes (room_id, song_id, participant_id) VALUES (?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(roomId, currentSongId, participantId);
      return this.skipState(roomId, currentSongId);
    })();
  }

  /** Threshold is evaluated against CURRENT active participants — joins and
   *  leaves mid-vote genuinely move the goalposts (tested). */
  skipState(roomId: string, currentSongId: string): { votes: number; needed: number; passed: boolean; voted: string[] } {
    const voted = (
      this.db
        .prepare(
          `SELECT sv.participant_id FROM skip_votes sv
           JOIN participants p ON p.id = sv.participant_id AND p.kicked = 0
           WHERE sv.room_id = ? AND sv.song_id = ?`,
        )
        .all(roomId, currentSongId) as { participant_id: string }[]
    ).map((r) => r.participant_id);
    const active = this.activeParticipantCount(roomId);
    return { votes: voted.length, needed: skipNeeded(active), passed: skipPasses(voted.length, active), voted };
  }

  activeParticipantCount(roomId: string): number {
    return (
      this.db
        .prepare(`SELECT count(*) AS n FROM participants WHERE room_id = ? AND kicked = 0`)
        .get(roomId) as { n: number }
    ).n;
  }

  clearSkipVotes(roomId: string): void {
    this.db.prepare(`DELETE FROM skip_votes WHERE room_id = ?`).run(roomId);
  }

  /* ---------------- playback progression ---------------- */

  /** Pop the top of the queue into 'playing'. Falls back to the last-played
   *  pool when the queue is empty. Returns null only when NOTHING exists. */
  popNext(roomId: string): { song: Song; isFallback: boolean } | null {
    return this.db.transaction(() => {
      this.db
        .prepare(`UPDATE songs SET status = 'played', played_at = ? WHERE room_id = ? AND status = 'playing'`)
        .run(Date.now(), roomId);
      this.clearSkipVotes(roomId);

      const queue = this.rankedQueue(roomId);
      const top = queue[0];
      if (top) {
        this.db.prepare(`UPDATE songs SET status = 'playing' WHERE id = ?`).run(top.id);
        return { song: this.songById(roomId, top.id), isFallback: false };
      }

      // "liste bitti, dövüşün!" — recycle the recent battlefield.
      const pool = this.db
        .prepare(
          `SELECT id FROM songs WHERE room_id = ? AND status = 'played'
           ORDER BY played_at DESC LIMIT ?`,
        )
        .all(roomId, this.config.fallbackPoolSize) as { id: string }[];
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (!pick) return null;
      this.db.prepare(`UPDATE songs SET status = 'playing' WHERE id = ?`).run(pick.id);
      return { song: this.songById(roomId, pick.id), isFallback: true };
    })();
  }

  nowPlaying(roomId: string): Song | null {
    const row = this.db
      .prepare(
        `SELECT s.*, p.nickname, COALESCE((SELECT sum(value) FROM votes v WHERE v.song_id = s.id), 0) AS score
         FROM songs s JOIN participants p ON p.id = s.added_by
         WHERE s.room_id = ? AND s.status = 'playing'`,
      )
      .get(roomId) as SongRow | undefined;
    return row ? this.toSong(row) : null;
  }

  /* ---------------- reads ---------------- */

  rankedQueue(roomId: string, forParticipant?: string): Song[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, p.nickname,
                COALESCE((SELECT sum(value) FROM votes v WHERE v.song_id = s.id), 0) AS score
         FROM songs s JOIN participants p ON p.id = s.added_by
         WHERE s.room_id = ? AND s.status = 'queued'`,
      )
      .all(roomId) as SongRow[];
    const ranked = rankQueue(rows.map((r) => this.toSong(r)));
    if (forParticipant) {
      const mine = this.db
        .prepare(
          `SELECT v.song_id, v.value FROM votes v JOIN songs s ON s.id = v.song_id
           WHERE s.room_id = ? AND v.participant_id = ?`,
        )
        .all(roomId, forParticipant) as { song_id: string; value: -1 | 1 | 3 }[];
      const map = new Map(mine.map((m) => [m.song_id, m.value]));
      for (const s of ranked) s.myVote = map.get(s.id) ?? 0;
    }
    return ranked;
  }

  songById(roomId: string, songId: string): Song {
    const row = this.db
      .prepare(
        `SELECT s.*, p.nickname,
                COALESCE((SELECT sum(value) FROM votes v WHERE v.song_id = s.id), 0) AS score
         FROM songs s JOIN participants p ON p.id = s.added_by
         WHERE s.id = ? AND s.room_id = ?`,
      )
      .get(songId, roomId) as SongRow | undefined;
    if (!row) throw err("no_song", "Şarkı yok.");
    return this.toSong(row);
  }

  private toSong(r: SongRow): Song {
    return {
      id: r.id,
      youtubeId: r.youtube_id,
      title: r.title,
      thumbnailUrl: r.thumbnail_url,
      durationS: r.duration_s,
      addedBy: r.added_by,
      addedByNickname: r.nickname,
      addedAt: r.added_at,
      status: r.status as Song["status"],
      armor: Boolean(r.armor),
      score: r.score,
    };
  }

  /** The authoritative host player reports duration once it knows it. */
  setDuration(songId: string, durationS: number): void {
    this.db
      .prepare(`UPDATE songs SET duration_s = ? WHERE id = ? AND duration_s IS NULL`)
      .run(Math.round(durationS), songId);
  }

  /** Comeback tracking for the recap: remember each song's lowest score. */
  private trackLowestScore(songId: string): void {
    this.db
      .prepare(
        `UPDATE songs SET lowest_score = min(
           lowest_score,
           COALESCE((SELECT sum(value) FROM votes v WHERE v.song_id = songs.id), 0)
         ) WHERE id = ?`,
      )
      .run(songId);
  }
}
