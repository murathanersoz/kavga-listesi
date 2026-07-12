/**
 * Demo seed: opens a room with 5 fake participants and a fighting queue —
 * instant demo without phones. Prints the host URL + join URL.
 *   pnpm --filter @kavga/server seed
 */
import { openDb } from "./db.js";
import { RoomStore } from "./rooms/store.js";

const db = openDb();
const store = new RoomStore(db);

const room = store.createRoom();
const nicks = ["Ece", "Baran", "Deniz", "Kaan", "Zeynep"];
const pids: string[] = [];
for (const n of nicks) {
  const r = store.join(room.id, n);
  if (r.ok) pids.push(r.participant.id);
}

// A believable party playlist (real videos, static metadata — no network).
const SONGS: [string, string][] = [
  ["dQw4w9WgXcQ", "Rick Astley - Never Gonna Give You Up"],
  ["kJQP7kiw5Fk", "Luis Fonsi - Despacito ft. Daddy Yankee"],
  ["9bZkp7q19f0", "PSY - GANGNAM STYLE"],
  ["JGwWNGJdvx8", "Ed Sheeran - Shape of You"],
  ["RgKAFK5djSk", "Wiz Khalifa - See You Again ft. Charlie Puth"],
  ["OPf0YbXqDm0", "Mark Ronson - Uptown Funk ft. Bruno Mars"],
];

const songIds: string[] = [];
SONGS.forEach(([id, title], i) => {
  const adder = pids[i % pids.length]!;
  const { song } = store.engine.addSong(room.id, adder, {
    youtubeId: id,
    title,
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    durationS: null,
  });
  songIds.push(song.id);
});

// Some opening shots so the queue has drama from second one.
store.engine.vote(room.id, pids[1]!, songIds[0]!, -1);
store.engine.vote(room.id, pids[2]!, songIds[0]!, -1);
store.engine.vote(room.id, pids[0]!, songIds[1]!, 1);
store.engine.vote(room.id, pids[3]!, songIds[1]!, 1);
store.engine.superVote(room.id, pids[4]!, songIds[2]!);
store.engine.vote(room.id, pids[0]!, songIds[3]!, 1);
store.engine.veto(room.id, pids[1]!, songIds[4]!); // Baran opens the war on Zeynep's song

const base = process.env.PUBLIC_URL ?? "http://localhost:3001";
console.log("\n🥊 Demo oda hazır!");
console.log(`   Oda kodu : ${room.code}`);
console.log(`   Hoparlör : ${base}/host?code=${room.code}`);
console.log(`     (tarayıcı konsolunda: localStorage.setItem('kavga:hostKey:${room.code}','${room.hostKey}'))`);
console.log(`   Telefon  : ${base}/p/${room.code}`);
console.log(`   5 savaşçı içeride, 5 şarkı sırada, 1 veto atıldı bile.\n`);
