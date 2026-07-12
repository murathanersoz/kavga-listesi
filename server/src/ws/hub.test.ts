import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { RoomStore } from "../rooms/store.js";
import { Hub, type Client } from "./hub.js";
import { handleClientMsg } from "./handlers.js";
import type { ServerMsg } from "@kavga/shared";
import type Database from "better-sqlite3";

let db: Database.Database;
let store: RoomStore;
let hub: Hub;
let roomId: string;

function fakeClient(participantId: string | null, isHost = false): Client & { inbox: ServerMsg[] } {
  const inbox: ServerMsg[] = [];
  return {
    socket: {
      readyState: 1,
      send: vi.fn((data: string) => inbox.push(JSON.parse(data))),
      close: vi.fn(),
    } as never,
    roomId,
    participantId,
    isHost,
    alive: true,
    inbox,
  };
}

function join(nick: string): string {
  const res = store.join(roomId, nick);
  if (!res.ok) throw new Error(res.reason);
  return res.participant.id;
}

function addSongDirect(by: string, title = "Şarkı"): string {
  return store.engine.addSong(roomId, by, {
    youtubeId: "dQw4w9WgXcQ",
    title,
    thumbnailUrl: "",
    durationS: null,
  }).song.id;
}

beforeEach(() => {
  db = openDb(":memory:");
  store = new RoomStore(db);
  hub = new Hub(store);
  roomId = store.createRoom().id;
});

describe("sequence numbers & re-sync", () => {
  it("every broadcast carries a strictly increasing seq, persisted with the event log", () => {
    const ece = join("Ece");
    const client = fakeClient(ece);
    hub.attach(client); // broadcasts a participants delta (seq 1)

    const song = addSongDirect(ece);
    hub.broadcast(roomId, { type: "queue_changed", queue: store.engine.rankedQueue(roomId) });
    hub.broadcast(roomId, { type: "queue_changed", queue: store.engine.rankedQueue(roomId) });

    const seqs = client.inbox.filter((m) => m.type === "delta").map((m) => (m as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    expect(store.currentSeq(roomId)).toBe(seqs[seqs.length - 1]);

    const logged = db
      .prepare(`SELECT seq FROM events WHERE room_id = ? ORDER BY seq`)
      .all(roomId) as { seq: number }[];
    expect(logged.map((l) => l.seq)).toEqual(seqs);
    void song;
  });

  it("a client that detects a gap resyncs to the full authoritative snapshot", async () => {
    const ece = join("Ece");
    const late = fakeClient(ece);
    // late client missed everything: adds + votes happened before attach
    const s = addSongDirect(ece, "Kaçırdığım şarkı");
    hub.broadcast(roomId, { type: "queue_changed", queue: store.engine.rankedQueue(roomId) });

    hub.attach(late);
    late.inbox.length = 0; // simulate: client sees a delta with seq N but lastSeen=0 → gap → resync
    await handleClientMsg(hub, store, late, { type: "resync" });

    const sync = late.inbox.find((m) => m.type === "sync") as Extract<ServerMsg, { type: "sync" }>;
    expect(sync).toBeDefined();
    expect(sync.snapshot.seq).toBe(store.currentSeq(roomId));
    expect(sync.snapshot.queue.map((q) => q.id)).toContain(s);
    expect(sync.snapshot.code).toHaveLength(4);
  });

  it("playback relays do NOT consume seq (ephemeral ticks)", () => {
    const ece = join("Ece");
    const c = fakeClient(ece);
    hub.attach(c);
    const before = store.currentSeq(roomId);
    hub.relayPlayback(roomId);
    hub.relayPlayback(roomId);
    expect(store.currentSeq(roomId)).toBe(before);
  });
});

describe("presence & host lifecycle", () => {
  it("host disconnect pauses a playing room and phones learn 'hoparlör koptu'", async () => {
    const ece = join("Ece");
    const phone = fakeClient(ece);
    const host = fakeClient(null, true);
    hub.attach(host);
    hub.attach(phone);

    addSongDirect(ece);
    await handleClientMsg(hub, store, host, { type: "host:play" });
    expect(store.roomById(roomId)!.state).toBe("playing");

    hub.detach(host);
    expect(store.roomById(roomId)!.state).toBe("paused");
    const last = phone.inbox.filter((m) => m.type === "delta").at(-1) as {
      event: { type: string; hostConnected?: boolean; state?: string };
    };
    expect(last.event).toMatchObject({ type: "room_state", state: "paused", hostConnected: false });

    // Host returns: room stays paused (no auto-blast), hostConnected true again.
    hub.attach(host);
    expect(store.roomById(roomId)!.state).toBe("paused");
    expect(store.roomById(roomId)!.host_connected).toBe(1);
  });

  it("participant connect/disconnect updates presence for everyone", () => {
    const ece = join("Ece");
    const baran = join("Baran");
    const phoneE = fakeClient(ece);
    const phoneB = fakeClient(baran);
    hub.attach(phoneE);
    hub.attach(phoneB);

    let parts = store.participants(roomId);
    expect(parts.find((p) => p.nickname === "Baran")?.connected).toBe(true);

    hub.detach(phoneB);
    parts = store.participants(roomId);
    expect(parts.find((p) => p.nickname === "Baran")?.connected).toBe(false);
    expect(parts.find((p) => p.nickname === "Ece")?.connected).toBe(true);
  });
});

describe("game flow over the wire", () => {
  it("vote → queue_changed delta with tension; invalid actions return errors not crashes", async () => {
    const ece = join("Ece");
    const baran = join("Baran");
    const phoneB = fakeClient(baran);
    hub.attach(phoneB);
    const songId = addSongDirect(ece, "Ece'nin şarkısı");

    await handleClientMsg(hub, store, phoneB, { type: "vote", songId, value: 1 });
    const delta = phoneB.inbox.filter((m) => m.type === "delta").at(-1) as {
      event: { type: string; queue?: { score: number }[]; tension?: { kind: string } };
    };
    expect(delta.event.type).toBe("queue_changed");
    expect(delta.event.queue?.[0]?.score).toBe(1);
    expect(delta.event.tension).toMatchObject({ kind: "vote", value: 1 });

    // Voting on a ghost song: clean error envelope.
    await handleClientMsg(hub, store, phoneB, { type: "vote", songId: "ghost", value: 1 });
    const err = phoneB.inbox.at(-1) as Extract<ServerMsg, { type: "error" }>;
    expect(err.type).toBe("error");
    expect(err.code).toBe("song_not_queued");
  });

  it("participants cannot run host commands", async () => {
    const ece = join("Ece");
    const phone = fakeClient(ece);
    hub.attach(phone);
    await handleClientMsg(hub, store, phone, { type: "host:force_skip" });
    const err = phone.inbox.at(-1) as Extract<ServerMsg, { type: "error" }>;
    expect(err).toMatchObject({ type: "error", code: "not_host" });
  });

  it("skip passing advances the song and resets skip state", async () => {
    const [a, b, c] = [join("Ali"), join("Bora"), join("Cem")];
    const [pa, pb] = [fakeClient(a), fakeClient(b)];
    const host = fakeClient(null, true);
    hub.attach(host);
    hub.attach(pa);
    hub.attach(pb);

    addSongDirect(a, "Çalan");
    addSongDirect(b, "Sıradaki");
    await handleClientMsg(hub, store, host, { type: "host:play" });
    const first = store.engine.nowPlaying(roomId)!;

    await handleClientMsg(hub, store, pa, { type: "skip_vote" }); // 1/3 — not yet
    expect(store.engine.nowPlaying(roomId)!.id).toBe(first.id);
    await handleClientMsg(hub, store, pb, { type: "skip_vote" }); // 2/3 — passes

    const now = store.engine.nowPlaying(roomId)!;
    expect(now.id).not.toBe(first.id);
    const effects = pa.inbox
      .filter((m) => m.type === "delta")
      .map((m) => (m as { event: { type: string; effect?: string } }).event)
      .filter((e) => e.type === "effect");
    expect(effects.some((e) => e.effect === "record_scratch")).toBe(true);
    expect(store.snapshot(roomId).skip.votes).toBe(0);
    void c;
  });
});
