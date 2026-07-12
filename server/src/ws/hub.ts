/**
 * WebSocket hub: per-room channels, monotonic delta broadcast, presence.
 *
 * Every broadcast increments the room's seq (persisted with the event log).
 * Clients track the last seq they saw; a gap means missed deltas → they send
 * {type:"resync"} and get the full snapshot. Server state is the only truth.
 */
import type { WebSocket } from "ws";
import type { Delta, ServerMsg } from "@kavga/shared";
import type { RoomStore } from "../rooms/store.js";

export interface Client {
  socket: Pick<WebSocket, "send" | "readyState" | "close">;
  roomId: string;
  participantId: string | null; // null for the host screen
  isHost: boolean;
  alive: boolean;
}

const OPEN = 1;

export class Hub {
  private rooms = new Map<string, Set<Client>>();

  constructor(private readonly store: RoomStore) {}

  attach(client: Client): void {
    let set = this.rooms.get(client.roomId);
    if (!set) this.rooms.set(client.roomId, (set = new Set()));
    set.add(client);

    if (client.isHost) {
      const state = this.store.setHostConnected(client.roomId, true);
      this.broadcast(client.roomId, { type: "room_state", state, hostConnected: true });
    } else if (client.participantId) {
      this.store.markConnected(client.roomId, client.participantId, true);
      this.broadcast(client.roomId, {
        type: "participants",
        participants: this.store.participants(client.roomId),
      });
    }
  }

  detach(client: Client): void {
    const set = this.rooms.get(client.roomId);
    set?.delete(client);
    if (set && set.size === 0) this.rooms.delete(client.roomId);

    const room = this.store.roomById(client.roomId);
    if (!room || room.state === "ended") return;

    if (client.isHost && !this.hasHost(client.roomId)) {
      // Speaker gone → the machine pauses the party ("hoparlör koptu").
      const state = this.store.setHostConnected(client.roomId, false);
      this.broadcast(client.roomId, { type: "room_state", state, hostConnected: false });
    } else if (client.participantId && !this.isParticipantConnected(client.roomId, client.participantId)) {
      this.store.markConnected(client.roomId, client.participantId, false);
      this.broadcast(client.roomId, {
        type: "participants",
        participants: this.store.participants(client.roomId),
      });
    }
  }

  private hasHost(roomId: string): boolean {
    for (const c of this.rooms.get(roomId) ?? []) if (c.isHost) return true;
    return false;
  }

  private isParticipantConnected(roomId: string, participantId: string): boolean {
    for (const c of this.rooms.get(roomId) ?? []) if (c.participantId === participantId) return true;
    return false;
  }

  clientsOf(roomId: string): Set<Client> {
    return this.rooms.get(roomId) ?? new Set();
  }

  /** Assigns the next seq, logs the event, fans the delta out to the room. */
  broadcast(roomId: string, event: Delta): number {
    const seq = this.store.nextSeq(roomId, event.type, event);
    const msg: ServerMsg = { type: "delta", seq, event };
    const json = JSON.stringify(msg);
    for (const c of this.clientsOf(roomId)) {
      if (c.socket.readyState === OPEN) c.socket.send(json);
    }
    return seq;
  }

  /** Playback ticks are ephemeral: relayed without consuming a seq (they are
   *  not state clients could "miss" — the next tick supersedes them). */
  relayPlayback(roomId: string): void {
    const msg: ServerMsg = {
      type: "delta",
      seq: this.store.currentSeq(roomId),
      event: { type: "playback", playback: this.store.getPlayback(roomId) },
    };
    const json = JSON.stringify(msg);
    for (const c of this.clientsOf(roomId)) {
      if (c.socket.readyState === OPEN) c.socket.send(json);
    }
  }

  sendSync(client: Client): void {
    const snapshot = this.store.snapshot(client.roomId, client.participantId ?? undefined);
    const msg: ServerMsg = { type: "sync", snapshot };
    if (client.socket.readyState === OPEN) client.socket.send(JSON.stringify(msg));
  }

  sendError(client: Client, code: string, message: string): void {
    const msg: ServerMsg = { type: "error", code, message };
    if (client.socket.readyState === OPEN) client.socket.send(JSON.stringify(msg));
  }

  closeRoom(roomId: string): void {
    for (const c of this.clientsOf(roomId)) c.socket.close(4000, "oda kapandı");
    this.rooms.delete(roomId);
  }
}
