/**
 * SQLite schema. better-sqlite3 is synchronous — combined with Node's single
 * thread this gives us free serialization of all queue mutations (the
 * concurrency test proves it).
 */
import Database from "better-sqlite3";

export function openDb(path = process.env.KAVGA_DB ?? "kavga.db"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      qr_token TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'lobby' CHECK (state IN ('lobby','playing','paused','ended')),
      host_connected INTEGER NOT NULL DEFAULT 0,
      settings_json TEXT NOT NULL DEFAULT '{}',
      seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      nickname TEXT NOT NULL,
      emoji TEXT NOT NULL,
      color TEXT NOT NULL,
      super_votes_left INTEGER NOT NULL DEFAULT 1,
      vetoes_left INTEGER NOT NULL DEFAULT 1,
      revenge_tokens INTEGER NOT NULL DEFAULT 0,
      kicked INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      UNIQUE (room_id, nickname)
    );
    CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);

    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      youtube_id TEXT NOT NULL,
      title TEXT NOT NULL,
      thumbnail_url TEXT NOT NULL DEFAULT '',
      duration_s INTEGER,
      added_by TEXT NOT NULL REFERENCES participants(id),
      added_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','playing','played','vetoed')),
      armor INTEGER NOT NULL DEFAULT 0,
      played_at INTEGER,
      lowest_score INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_songs_room_status ON songs(room_id, status);

    CREATE TABLE IF NOT EXISTS votes (
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      value INTEGER NOT NULL CHECK (value IN (-1, 1, 3)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (song_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS skip_votes (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      song_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      PRIMARY KEY (room_id, song_id, participant_id)
    );

    -- Append-only event log: powers deltas (seq), the tension feed, and the recap.
    CREATE TABLE IF NOT EXISTS events (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, seq)
    );
  `);
  return db;
}
