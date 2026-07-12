/**
 * Message router: every client mutation lands here, gets validated against
 * the database (never client state), then broadcast as a delta.
 */
import type { ClientMsg } from "@kavga/shared";
import { EngineError } from "../queue/engine.js";
import type { RoomStore } from "../rooms/store.js";
import { fetchOEmbed, parseYoutubeId } from "../media/youtube.js";
import type { Client, Hub } from "./hub.js";

export async function handleClientMsg(
  hub: Hub,
  store: RoomStore,
  client: Client,
  msg: ClientMsg,
): Promise<void> {
  const { roomId } = client;
  const room = store.roomById(roomId);
  if (!room || room.state === "ended") {
    hub.sendError(client, "room_gone", "Oda kapanmış.");
    return;
  }

  try {
    switch (msg.type) {
      case "resync":
        hub.sendSync(client);
        return;

      /* ---------- participant actions ---------- */

      case "add_song": {
        const pid = requireParticipant(client);
        const ytId = parseYoutubeId(msg.url);
        if (!ytId) throw new EngineError("bad_url", "Geçerli bir YouTube linki yapıştır.");
        const meta = await fetchOEmbed(ytId);
        if (!meta) throw new EngineError("oembed_failed", "Video bilgisi alınamadı — link doğru mu?");
        const { tension } = store.engine.addSong(roomId, pid, meta, msg.useArmor);
        hub.broadcast(roomId, { type: "queue_changed", queue: store.engine.rankedQueue(roomId), tension });
        if (msg.useArmor) sendArsenal(hub, store, roomId, pid);
        return;
      }

      case "vote": {
        const pid = requireParticipant(client);
        const { tension } = store.engine.vote(roomId, pid, msg.songId, msg.value);
        hub.broadcast(roomId, { type: "queue_changed", queue: store.engine.rankedQueue(roomId), tension });
        return;
      }

      case "super_vote": {
        const pid = requireParticipant(client);
        const { tension } = store.engine.superVote(roomId, pid, msg.songId);
        hub.broadcast(roomId, { type: "queue_changed", queue: store.engine.rankedQueue(roomId), tension });
        hub.broadcast(roomId, { type: "effect", effect: "super_flash", songId: msg.songId });
        sendArsenal(hub, store, roomId, pid);
        return;
      }

      case "veto": {
        const pid = requireParticipant(client);
        const { tension, victimId } = store.engine.veto(roomId, pid, msg.songId);
        hub.broadcast(roomId, { type: "effect", effect: "veto_shred", songId: msg.songId });
        hub.broadcast(roomId, { type: "queue_changed", queue: store.engine.rankedQueue(roomId), tension });
        sendArsenal(hub, store, roomId, pid);
        sendArsenal(hub, store, roomId, victimId); // revenge token landed
        return;
      }

      case "skip_vote": {
        const pid = requireParticipant(client);
        const playing = store.engine.nowPlaying(roomId);
        if (!playing) throw new EngineError("nothing_playing", "Şu an çalan bir şey yok.");
        const st = store.engine.skipVote(roomId, pid, playing.id);
        hub.broadcast(roomId, {
          type: "skip_state",
          skip: { votes: st.votes, needed: st.needed, voted: store.engine.skipState(roomId, playing.id).voted },
        });
        if (st.passed) {
          hub.broadcast(roomId, { type: "effect", effect: "record_scratch" });
          advance(hub, store, roomId, { kind: "skip", title: playing.title });
        }
        return;
      }

      /* ---------- host actions ---------- */

      case "host:play": {
        requireHost(client);
        const state = store.applyEvent(roomId, "START");
        if (!store.engine.nowPlaying(roomId)) advance(hub, store, roomId);
        hub.broadcast(roomId, { type: "room_state", state, hostConnected: true });
        return;
      }

      case "host:pause": {
        requireHost(client);
        const state = store.applyEvent(roomId, "PAUSE");
        hub.broadcast(roomId, { type: "room_state", state, hostConnected: true });
        return;
      }

      case "host:force_skip": {
        requireHost(client);
        const playing = store.engine.nowPlaying(roomId);
        hub.broadcast(roomId, { type: "effect", effect: "record_scratch" });
        advance(hub, store, roomId, playing ? { kind: "skip", title: playing.title } : undefined);
        return;
      }

      case "host:song_ended": {
        requireHost(client);
        advance(hub, store, roomId);
        return;
      }

      case "host:progress": {
        requireHost(client);
        const playing = store.engine.nowPlaying(roomId);
        store.setPlayback(roomId, {
          songId: playing?.id ?? null,
          positionS: Math.max(0, msg.positionS),
          durationS: msg.durationS > 0 ? msg.durationS : null,
          updatedAt: Date.now(),
          isFallback: false,
        });
        if (playing && msg.durationS > 0 && playing.durationS == null) {
          // oEmbed has no duration; the authoritative player teaches us.
          store.engine.setDuration(playing.id, msg.durationS);
        }
        hub.relayPlayback(roomId);
        return;
      }

      case "host:kick": {
        requireHost(client);
        store.kick(roomId, msg.participantId);
        for (const c of hub.clientsOf(roomId)) {
          if (c.participantId === msg.participantId) c.socket.close(4001, "atıldın");
        }
        const kicked = store.participants(roomId);
        hub.broadcast(roomId, { type: "participants", participants: kicked });
        return;
      }

      case "host:lock_queue": {
        requireHost(client);
        const settings = store.updateSettings(roomId, { queueLocked: msg.locked });
        hub.broadcast(roomId, { type: "settings", settings });
        return;
      }

      case "host:party_mode": {
        requireHost(client);
        const settings = store.updateSettings(roomId, { partyMode: msg.on });
        hub.broadcast(roomId, { type: "settings", settings });
        return;
      }

      case "host:close_room": {
        requireHost(client);
        const state = store.applyEvent(roomId, "END");
        hub.broadcast(roomId, { type: "room_state", state, hostConnected: true });
        hub.closeRoom(roomId);
        return;
      }
    }
  } catch (e) {
    if (e instanceof EngineError) {
      hub.sendError(client, e.code, e.message);
      return;
    }
    throw e;
  }
}

/** Pop the next song (or fallback) and broadcast now-playing. */
export function advance(
  hub: Hub,
  store: RoomStore,
  roomId: string,
  tension?: { kind: "skip"; title: string },
): void {
  const next = store.engine.popNext(roomId);
  store.setPlayback(roomId, {
    songId: next?.song.id ?? null,
    positionS: 0,
    durationS: next?.song.durationS ?? null,
    updatedAt: Date.now(),
    isFallback: next?.isFallback ?? false,
  });
  hub.broadcast(roomId, {
    type: "now_playing",
    song: next?.song ?? null,
    isFallback: next?.isFallback ?? false,
    tension,
  });
  hub.broadcast(roomId, {
    type: "skip_state",
    skip: { votes: 0, needed: 0, voted: [] },
  });
}

function requireParticipant(client: Client): string {
  if (!client.participantId) throw new EngineError("not_participant", "Önce odaya katıl.");
  return client.participantId;
}

function requireHost(client: Client): void {
  if (!client.isHost) throw new EngineError("not_host", "Bunu sadece hoparlör ekranı yapabilir.");
}

function sendArsenal(hub: Hub, store: RoomStore, roomId: string, participantId: string): void {
  const p = store.participant(roomId, participantId);
  if (!p) return;
  hub.broadcast(roomId, {
    type: "arsenal",
    participantId,
    superVotesLeft: p.superVotesLeft,
    vetoesLeft: p.vetoesLeft,
    revengeTokens: p.revengeTokens,
  });
}
