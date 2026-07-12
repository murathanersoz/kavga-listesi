/** End-to-end smoke over real HTTP+WS: room → join → host → add → vote → veto. */
import WebSocket from "ws";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const WSBASE = BASE.replace("http", "ws");

const jfetch = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(body)}`);
  return body;
};

function connect(params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSBASE}/ws?${new URLSearchParams(params)}`);
    const client = { ws, snap: null, deltas: [], errors: [], seqs: [] };
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "sync") {
        client.snap = msg.snapshot;
        resolve(client);
      }
      if (msg.type === "delta") {
        client.deltas.push(msg.event);
        if (msg.event.type !== "playback") client.seqs.push(msg.seq);
      }
      if (msg.type === "error") client.errors.push(msg);
    });
    ws.on("error", reject);
  });
}

const send = (c, msg) => c.ws.send(JSON.stringify(msg));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
};

// 1. create room + join two phones
const room = await jfetch("/api/rooms", { method: "POST", body: "{}" });
assert(/^[A-Z]{4}$/.test(room.code), `oda kuruldu: ${room.code}`);
const ece = (await jfetch(`/api/rooms/${room.code}/join`, { method: "POST", body: JSON.stringify({ nickname: "Ece" }) })).participant;
const baran = (await jfetch(`/api/rooms/${room.code}/join`, { method: "POST", body: JSON.stringify({ nickname: "Baran" }) })).participant;

// 2. connect host + phones
const host = await connect({ code: room.code, hostKey: room.hostKey });
const phoneE = await connect({ code: room.code, pid: ece.id });
const phoneB = await connect({ code: room.code, pid: baran.id });
assert(host.snap.hostConnected, "host bağlı, snapshot geldi");

// 3. add a real song via oEmbed (needs internet)
send(phoneE, { type: "add_song", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
await wait(2500);
const added = phoneB.deltas.find((d) => d.type === "queue_changed");
assert(added && added.queue.length === 1, `oEmbed ile şarkı eklendi: "${added?.queue[0]?.title}"`);

// 4. vote + super vote, arsenal broadcast
const songId = added.queue[0].id;
send(phoneB, { type: "vote", songId, value: 1 });
send(phoneB, { type: "super_vote", songId });
await wait(500);
const lastQueue = [...host.deltas].reverse().find((d) => d.type === "queue_changed");
assert(lastQueue.queue[0].score === 3, "süper oy normal oyu değiştirdi, skor tam 3");
assert(host.deltas.some((d) => d.type === "effect" && d.effect === "super_flash"), "altın flaş efekti yayınlandı");

// 5. host starts the party → now_playing
send(host, { type: "host:play" });
await wait(400);
assert(phoneE.deltas.some((d) => d.type === "now_playing" && d.song?.id === songId), "parti başladı, şarkı çalıyor");

// 6. veto flow on a second song + revenge token
send(phoneB, { type: "add_song", url: "https://youtu.be/dQw4w9WgXcQ" });
await wait(2000);
const q2 = [...phoneE.deltas].reverse().find((d) => d.type === "queue_changed");
send(phoneE, { type: "veto", songId: q2.queue[0].id });
await wait(400);
assert(host.deltas.some((d) => d.type === "effect" && d.effect === "veto_shred"), "veto parçalama efekti");
const arsenal = [...phoneB.deltas].reverse().find((d) => d.type === "arsenal" && d.participantId === baran.id);
assert(arsenal?.revengeTokens === 1, "kurban rövanş jetonu aldı");

// 7. seq integrity: strictly increasing, no gaps on any client
for (const [name, c] of [["host", host], ["phoneE", phoneE], ["phoneB", phoneB]]) {
  const ok = c.seqs.every((s, i) => i === 0 || s === c.seqs[i - 1] + 1);
  assert(ok, `${name} seq zinciri boşluksuz (${c.seqs.length} delta)`);
  assert(c.errors.filter((e) => e.code === "internal").length === 0, `${name} iç hata yok`);
}

// 8. host disconnect → phones see paused + hostConnected=false
host.ws.close();
await wait(400);
const roomState = [...phoneE.deltas].reverse().find((d) => d.type === "room_state");
assert(roomState.state === "paused" && roomState.hostConnected === false, "hoparlör koptu → parti duraklatıldı");

console.log("\n🥊 SMOKE GREEN — kavga hazır.");
process.exit(0);
