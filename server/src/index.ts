/** Kavga Listesi server: Fastify HTTP + ws upgrade + cleanup job. */
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer, type WebSocket } from "ws";
import QRCode from "qrcode";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ClientMsg } from "@kavga/shared";
import { openDb } from "./db.js";
import { RoomStore } from "./rooms/store.js";
import { isValidCode } from "./rooms/codes.js";
import { Hub, type Client } from "./ws/hub.js";
import { handleClientMsg } from "./ws/handlers.js";
import { searchYoutube } from "./media/youtube.js";
import { sanitizeText } from "./util/sanitize.js";

const PORT = Number(process.env.PORT ?? 3001);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const YT_KEY = process.env.YOUTUBE_API_KEY ?? "";

const db = openDb();
const store = new RoomStore(db);
const hub = new Hub(store);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

/* ---------------- static client (production build) ---------------- */
const clientDist = path.resolve(import.meta.dirname, "../../client/dist");
if (existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
      reply.code(404).send({ error: "yok" });
      return;
    }
    reply.sendFile("index.html"); // SPA fallback
  });
}

/* ---------------- http api ---------------- */

app.post("/api/rooms", async () => {
  const room = store.createRoom();
  return {
    code: room.code,
    hostKey: room.hostKey,
    joinUrl: `${PUBLIC_URL}/p/${room.code}?t=${room.qrToken}`,
  };
});

app.get<{ Params: { code: string } }>("/api/rooms/:code", async (req, reply) => {
  const room = store.roomByCode(req.params.code);
  if (!room) return reply.code(404).send({ error: "Oda bulunamadı." });
  return { code: room.code, state: room.state };
});

app.post<{ Params: { code: string }; Body: { nickname?: string } }>(
  "/api/rooms/:code/join",
  async (req, reply) => {
    const room = store.roomByCode(req.params.code);
    if (!room) return reply.code(404).send({ error: "Oda bulunamadı." });
    const res = store.join(room.id, String(req.body?.nickname ?? ""));
    if (!res.ok) return reply.code(400).send({ error: res.reason });
    return { participant: res.participant, code: room.code };
  },
);

app.get<{ Params: { code: string } }>("/api/rooms/:code/qr.svg", async (req, reply) => {
  const room = store.roomByCode(req.params.code);
  if (!room) return reply.code(404).send({ error: "Oda bulunamadı." });
  const url = `${PUBLIC_URL}/p/${room.code}?t=${room.qr_token}`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 480 });
  reply.header("Content-Type", "image/svg+xml").header("Cache-Control", "max-age=3600");
  return svg;
});

app.get("/api/config", async () => ({ searchEnabled: Boolean(YT_KEY) }));

app.get<{ Querystring: { q?: string } }>("/api/search", async (req, reply) => {
  if (!YT_KEY) return reply.code(503).send({ error: "Arama kapalı — link yapıştırma modunu kullan." });
  const q = sanitizeText(String(req.query.q ?? ""), 80);
  if (q.length < 2) return { results: [] };
  return { results: await searchYoutube(q, YT_KEY) };
});

/* ---------------- websocket upgrade ---------------- */

const wss = new WebSocketServer({ noServer: true });

interface Live extends Client {
  socket: WebSocket;
}

wss.on("connection", (socket: WebSocket, client: Live) => {
  hub.attach(client);
  hub.sendSync(client);

  socket.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    void handleClientMsg(hub, store, client, msg).catch((err) => {
      app.log.error({ err }, "ws handler crashed");
      hub.sendError(client, "internal", "Bir şeyler ters gitti.");
    });
  });
  socket.on("pong", () => (client.alive = true));
  socket.on("close", () => hub.detach(client));
});

// Heartbeat: drop dead sockets so presence stays honest.
setInterval(() => {
  for (const ws of wss.clients) {
    const c = (ws as WebSocket & { kavga?: Live }).kavga;
    if (!c) continue;
    if (!c.alive) {
      ws.terminate();
      continue;
    }
    c.alive = false;
    ws.ping();
  }
}, 15_000).unref();

app.server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", PUBLIC_URL);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const code = url.searchParams.get("code") ?? "";
  const room = isValidCode(code) ? store.roomByCode(code) : undefined;
  if (!room) {
    socket.destroy();
    return;
  }

  const hostKey = url.searchParams.get("hostKey");
  const pid = url.searchParams.get("pid");
  let client: Live | null = null;

  if (hostKey && hostKey === store.hostKeyOf(room)) {
    client = { socket: null as never, roomId: room.id, participantId: null, isHost: true, alive: true };
  } else if (pid && store.participant(room.id, pid)) {
    client = { socket: null as never, roomId: room.id, participantId: pid, isHost: false, alive: true };
  }
  if (!client) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    client.socket = ws;
    (ws as WebSocket & { kavga?: Live }).kavga = client;
    wss.emit("connection", ws, client);
  });
});

/* ---------------- cleanup job: rooms idle >24h ---------------- */
setInterval(() => {
  for (const roomId of store.sweepIdle()) {
    app.log.info({ roomId }, "idle room ended");
    hub.closeRoom(roomId);
  }
}, 60 * 60 * 1000).unref();

await app.listen({ port: PORT, host: "0.0.0.0" });
app.log.info(`Kavga Listesi hazır → ${PUBLIC_URL}`);
