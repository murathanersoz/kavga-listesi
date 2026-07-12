/** End-of-party recap, computed from the immutable tables. */
import type Database from "better-sqlite3";
import type { Recap } from "@kavga/shared";

export function computeRecap(db: Database.Database, roomId: string, code: string): Recap {
  const one = <T>(sql: string, ...args: unknown[]): T | undefined =>
    db.prepare(sql).get(...args) as T | undefined;

  const totalSongsPlayed =
    one<{ n: number }>(
      `SELECT count(*) AS n FROM songs WHERE room_id = ? AND status IN ('played','playing')`,
      roomId,
    )?.n ?? 0;

  const totalVotes =
    one<{ n: number }>(
      `SELECT count(*) AS n FROM votes v JOIN songs s ON s.id = v.song_id WHERE s.room_id = ?`,
      roomId,
    )?.n ?? 0;

  const totalVetoes =
    one<{ n: number }>(
      `SELECT count(*) AS n FROM songs WHERE room_id = ? AND status = 'vetoed'`,
      roomId,
    )?.n ?? 0;

  const topAdder = one<{ nickname: string; n: number }>(
    `SELECT p.nickname, count(*) AS n FROM songs s JOIN participants p ON p.id = s.added_by
     WHERE s.room_id = ? AND s.status IN ('played','playing')
     GROUP BY s.added_by ORDER BY n DESC, p.nickname LIMIT 1`,
    roomId,
  );

  const mostVetoed = one<{ nickname: string; n: number }>(
    `SELECT p.nickname, count(*) AS n FROM songs s JOIN participants p ON p.id = s.added_by
     WHERE s.room_id = ? AND s.status = 'vetoed'
     GROUP BY s.added_by ORDER BY n DESC, p.nickname LIMIT 1`,
    roomId,
  );

  // Biggest comeback: a song that was buried (lowest score < 0) but still got played.
  const comeback = one<{ title: string; lowest_score: number; nickname: string }>(
    `SELECT s.title, s.lowest_score, p.nickname FROM songs s
     JOIN participants p ON p.id = s.added_by
     WHERE s.room_id = ? AND s.status IN ('played','playing') AND s.lowest_score < 0
     ORDER BY s.lowest_score ASC LIMIT 1`,
    roomId,
  );

  return {
    roomCode: code,
    totalSongsPlayed,
    totalVotes,
    totalVetoes,
    topAdder: topAdder ? { nickname: topAdder.nickname, count: topAdder.n } : null,
    mostVetoed: mostVetoed ? { nickname: mostVetoed.nickname, count: mostVetoed.n } : null,
    biggestComeback: comeback
      ? { title: comeback.title, lowestScore: comeback.lowest_score, addedBy: comeback.nickname }
      : null,
  };
}
