import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { EngineError, QueueEngine } from "./engine.js";
import { rankQueue, skipNeeded, skipPasses } from "./rank.js";
import { nanoid } from "nanoid";
import type Database from "better-sqlite3";

let db: Database.Database;
let engine: QueueEngine;
const ROOM = "room-1";

function addParticipant(nick: string): string {
  const id = nanoid(8);
  db.prepare(
    `INSERT INTO participants (id, room_id, nickname, emoji, color, joined_at, last_seen_at)
     VALUES (?, ?, ?, '🦊', '#f00', ?, ?)`,
  ).run(id, ROOM, nick, Date.now(), Date.now());
  return id;
}

function addSong(by: string, title = "Şarkı", useArmor = false) {
  return engine.addSong(
    ROOM,
    by,
    { youtubeId: "dQw4w9WgXcQ", title, thumbnailUrl: "", durationS: null },
    useArmor,
  ).song;
}

beforeEach(() => {
  db = openDb(":memory:");
  engine = new QueueEngine(db);
  db.prepare(
    `INSERT INTO rooms (id, code, qr_token, created_at, last_activity_at) VALUES (?, 'ABCD', ?, ?, ?)`,
  ).run(ROOM, nanoid(), Date.now(), Date.now());
});

/* ---------------- ranking ---------------- */

describe("ranking", () => {
  it("orders by score desc, then oldest-first, deterministically", () => {
    const ranked = rankQueue([
      { id: "b", addedAt: 200, score: 5 },
      { id: "a", addedAt: 100, score: 5 },
      { id: "c", addedAt: 50, score: 9 },
      { id: "d", addedAt: 300, score: -2 },
    ]);
    expect(ranked.map((s) => s.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("live queue reflects votes, super-votes weigh +3", () => {
    const [ece, baran, deniz] = [addParticipant("Ece"), addParticipant("Baran"), addParticipant("Deniz")];
    const s1 = addSong(ece, "Birinci");
    const s2 = addSong(baran, "İkinci");

    engine.vote(ROOM, deniz, s1.id, 1); // s1: +1
    engine.superVote(ROOM, baran, s2.id); // s2: +3 → over s1 despite being newer
    const q = engine.rankedQueue(ROOM);
    expect(q.map((s) => s.title)).toEqual(["İkinci", "Birinci"]);
    expect(q[0]!.score).toBe(3);
  });
});

/* ---------------- votes ---------------- */

describe("votes", () => {
  it("one vote per person — changeable, removable", () => {
    const [a, b] = [addParticipant("A"), addParticipant("B")];
    const s = addSong(a);
    engine.vote(ROOM, b, s.id, 1);
    engine.vote(ROOM, b, s.id, 1); // idempotent, not cumulative
    expect(engine.songById(ROOM, s.id).score).toBe(1);
    engine.vote(ROOM, b, s.id, -1); // flip
    expect(engine.songById(ROOM, s.id).score).toBe(-1);
    engine.vote(ROOM, b, s.id, 0); // withdraw
    expect(engine.songById(ROOM, s.id).score).toBe(0);
  });

  it("super vote consumes the single charge and cannot be reused or undone", () => {
    const [a, b] = [addParticipant("A"), addParticipant("B")];
    const s1 = addSong(a, "Bir");
    const s2 = addSong(a, "İki");

    engine.superVote(ROOM, b, s1.id);
    expect(() => engine.superVote(ROOM, b, s2.id)).toThrowError(/Süper oyunu zaten/);
    expect(() => engine.vote(ROOM, b, s1.id, 0)).toThrowError(/geri alınamaz/);
    expect(engine.songById(ROOM, s1.id).score).toBe(3);
  });

  it("super vote replaces a prior normal vote instead of stacking", () => {
    const [a, b] = [addParticipant("A"), addParticipant("B")];
    const s = addSong(a);
    engine.vote(ROOM, b, s.id, -1);
    engine.superVote(ROOM, b, s.id);
    expect(engine.songById(ROOM, s.id).score).toBe(3); // not 2, not 4
  });

  it("outsiders and kicked participants cannot vote", () => {
    const a = addParticipant("A");
    const s = addSong(a);
    expect(() => engine.vote(ROOM, "ghost", s.id, 1)).toThrowError(EngineError);
    const kicked = addParticipant("Kicked");
    db.prepare(`UPDATE participants SET kicked = 1 WHERE id = ?`).run(kicked);
    expect(() => engine.vote(ROOM, kicked, s.id, 1)).toThrowError(/odada değilsin/);
  });
});

/* ---------------- veto, armor, revenge ---------------- */

describe("veto & revenge", () => {
  it("veto kills the song, burns the charge, grants the victim a revenge token", () => {
    const [ece, baran] = [addParticipant("Ece"), addParticipant("Baran")];
    const s = addSong(baran, "Baran'ın şarkısı");

    const res = engine.veto(ROOM, ece, s.id);
    expect(res.tension).toMatchObject({ kind: "veto", who: "Ece", victim: "Baran" });
    expect(engine.rankedQueue(ROOM)).toHaveLength(0);

    const victim = db.prepare(`SELECT revenge_tokens FROM participants WHERE id = ?`).get(baran) as {
      revenge_tokens: number;
    };
    expect(victim.revenge_tokens).toBe(1);

    // Arsenal is spent: a second veto is impossible.
    const another = addSong(baran, "Yenisi");
    expect(() => engine.veto(ROOM, ece, another.id)).toThrowError(/zaten kullandın/);
  });

  it("revenge token buys permanent armor; armor blocks veto WITHOUT burning it", () => {
    const [ece, baran] = [addParticipant("Ece"), addParticipant("Baran")];
    const s = addSong(baran, "Kurban");
    engine.veto(ROOM, ece, s.id); // baran earns revenge

    const armored = addSong(baran, "Zırhlı dönüş", true);
    expect(armored.armor).toBe(true);

    const kaan = addParticipant("Kaan");
    expect(() => engine.veto(ROOM, kaan, armored.id)).toThrowError(/zırhlı/i);
    // Kaan's veto must NOT be consumed by the failed attempt.
    const kaanRow = db.prepare(`SELECT vetoes_left FROM participants WHERE id = ?`).get(kaan) as {
      vetoes_left: number;
    };
    expect(kaanRow.vetoes_left).toBe(1);
  });

  it("armor cannot be faked without a token; self-veto is blocked", () => {
    const a = addParticipant("A");
    expect(() => addSong(a, "Sahte zırh", true)).toThrowError(/Rövanş hakkın yok/);
    const s = addSong(a);
    expect(() => engine.veto(ROOM, a, s.id)).toThrowError(/Kendi şarkını/);
  });
});

/* ---------------- add limits ---------------- */

describe("add limits", () => {
  it("max 2 queued per person; slot frees when a song leaves the queue", () => {
    const a = addParticipant("A");
    addSong(a, "1");
    const s2 = addSong(a, "2");
    expect(() => addSong(a, "3")).toThrowError(/en fazla 2/);

    const b = addParticipant("B");
    engine.veto(ROOM, b, s2.id); // one slot frees
    expect(() => addSong(a, "3")).not.toThrow();
  });

  it("locked queue rejects adds", () => {
    const a = addParticipant("A");
    db.prepare(`UPDATE rooms SET settings_json = '{"queueLocked":true}' WHERE id = ?`).run(ROOM);
    expect(() => addSong(a)).toThrowError(/kilitli/);
  });
});

/* ---------------- skip threshold ---------------- */

describe("skip threshold", () => {
  it("needs MORE than half; joins and leaves move the goalposts mid-vote", () => {
    expect(skipPasses(1, 2)).toBe(false);
    expect(skipPasses(2, 3)).toBe(true);
    expect(skipNeeded(4)).toBe(3);

    const a = addParticipant("A");
    const song = addSong(a);
    db.prepare(`UPDATE songs SET status = 'playing' WHERE id = ?`).run(song.id);

    const b = addParticipant("B");
    addParticipant("C"); // 3 active
    let st = engine.skipVote(ROOM, a, song.id);
    expect(st.passed).toBe(false); // 1/3

    // A fourth person joins mid-vote: threshold rises to 3.
    const d = addParticipant("D");
    st = engine.skipVote(ROOM, b, song.id);
    expect(st).toMatchObject({ votes: 2, needed: 3, passed: false });

    // One voter gets kicked: their skip vote stops counting AND the pool shrinks.
    db.prepare(`UPDATE participants SET kicked = 1 WHERE id = ?`).run(b);
    st = engine.skipState(ROOM, song.id);
    expect(st).toMatchObject({ votes: 1, needed: 2, passed: false }); // 1 of 3 active

    engine.skipVote(ROOM, d, song.id);
    st = engine.skipState(ROOM, song.id);
    expect(st.passed).toBe(true); // 2 of 3
  });

  it("skip voting is idempotent per person", () => {
    const a = addParticipant("A");
    addParticipant("B");
    addParticipant("C");
    const s = addSong(a);
    engine.skipVote(ROOM, a, s.id);
    const st = engine.skipVote(ROOM, a, s.id);
    expect(st.votes).toBe(1);
  });
});

/* ---------------- playback progression ---------------- */

describe("popNext & fallback", () => {
  it("pops the ranked top and marks the previous song played", () => {
    const [a, b] = [addParticipant("A"), addParticipant("B")];
    const low = addSong(a, "Düşük");
    const high = addSong(a, "Yüksek");
    engine.vote(ROOM, b, high.id, 1);

    const first = engine.popNext(ROOM);
    expect(first?.song.title).toBe("Yüksek");
    expect(first?.isFallback).toBe(false);

    const second = engine.popNext(ROOM);
    expect(second?.song.title).toBe("Düşük");
    const prev = db.prepare(`SELECT status FROM songs WHERE id = ?`).get(high.id) as { status: string };
    expect(prev.status).toBe("played");
    expect(low.id).toBe(second?.song.id);
  });

  it("empty queue falls back to the played pool (liste bitti, dövüşün!)", () => {
    const a = addParticipant("A");
    const s = addSong(a, "Tek şarkı");
    engine.popNext(ROOM); // plays it
    const fb = engine.popNext(ROOM); // queue empty → fallback
    expect(fb).not.toBeNull();
    expect(fb!.isFallback).toBe(true);
    expect(fb!.song.id).toBe(s.id);
  });

  it("returns null only when the room never played anything", () => {
    expect(engine.popNext(ROOM)).toBeNull();
  });
});

/* ---------------- THE concurrency test ---------------- */

describe("concurrency", () => {
  it("20 simultaneous clients voting the same song produce an exactly correct score", async () => {
    const adder = addParticipant("Sahibi");
    const song = addSong(adder, "Kavga çıkaran şarkı");
    const clients = Array.from({ length: 20 }, (_, i) => addParticipant(`K${i}`));

    // All twenty fire "simultaneously" (same tick, interleaved microtasks).
    await Promise.all(
      clients.map(
        (id) =>
          new Promise<void>((resolve) => {
            setImmediate(() => {
              engine.vote(ROOM, id, song.id, 1);
              resolve();
            });
          }),
      ),
    );

    expect(engine.songById(ROOM, song.id).score).toBe(20);

    // Second wave: half flip to -1, three withdraw — still exact.
    await Promise.all([
      ...clients.slice(0, 10).map(
        (id) =>
          new Promise<void>((r) =>
            setImmediate(() => {
              engine.vote(ROOM, id, song.id, -1);
              r();
            }),
          ),
      ),
      ...clients.slice(10, 13).map(
        (id) =>
          new Promise<void>((r) =>
            setImmediate(() => {
              engine.vote(ROOM, id, song.id, 0);
              r();
            }),
          ),
      ),
    ]);
    // 7 × (+1) + 10 × (−1) = −3
    expect(engine.songById(ROOM, song.id).score).toBe(-3);
  });

  it("concurrent super-vote attempts by one person consume exactly one charge", async () => {
    const a = addParticipant("A");
    const s1 = addSong(a, "Bir");
    const s2 = addSong(a, "İki");
    const b = addParticipant("B");

    const results = await Promise.allSettled([
      new Promise<void>((res, rej) =>
        setImmediate(() => {
          try {
            engine.superVote(ROOM, b, s1.id);
            res();
          } catch (e) {
            rej(e);
          }
        }),
      ),
      new Promise<void>((res, rej) =>
        setImmediate(() => {
          try {
            engine.superVote(ROOM, b, s2.id);
            res();
          } catch (e) {
            rej(e);
          }
        }),
      ),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1); // exactly one succeeded
    const total =
      engine.songById(ROOM, s1.id).score + engine.songById(ROOM, s2.id).score;
    expect(total).toBe(3); // one +3, never six
  });
});
