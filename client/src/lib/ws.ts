/**
 * Room socket: gap-detecting delta stream with auto-reconnect.
 * If a delta's seq isn't exactly lastSeq+1 we missed something → resync.
 */
import type { ClientMsg, Delta, RoomSnapshot, ServerMsg } from "@kavga/shared";

export interface SocketCallbacks {
  onSnapshot: (s: RoomSnapshot) => void;
  onDelta: (e: Delta) => void;
  onError: (code: string, message: string) => void;
  onStatus: (connected: boolean) => void;
}

export class RoomSocket {
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private backoff = 500;
  private closed = false;

  constructor(
    private readonly code: string,
    private readonly auth: { pid?: string; hostKey?: string },
    private readonly cb: SocketCallbacks,
  ) {}

  connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ code: this.code });
    if (this.auth.pid) params.set("pid", this.auth.pid);
    if (this.auth.hostKey) params.set("hostKey", this.auth.hostKey);
    const ws = new WebSocket(`${proto}//${location.host}/ws?${params}`);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.cb.onStatus(true);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerMsg;
      switch (msg.type) {
        case "sync":
        case "joined": {
          const snap = msg.type === "sync" ? msg.snapshot : msg.snapshot;
          this.lastSeq = snap.seq;
          this.cb.onSnapshot(snap);
          break;
        }
        case "delta": {
          if (msg.event.type === "playback") {
            // Ephemeral — no seq contract.
            this.cb.onDelta(msg.event);
            break;
          }
          if (msg.seq <= this.lastSeq) break; // stale duplicate
          if (msg.seq !== this.lastSeq + 1) {
            this.send({ type: "resync" }); // gap → full authoritative state
            break;
          }
          this.lastSeq = msg.seq;
          this.cb.onDelta(msg.event);
          break;
        }
        case "error":
          this.cb.onError(msg.code, msg.message);
          break;
      }
    };
    ws.onclose = () => {
      this.cb.onStatus(false);
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
    ws.onerror = () => ws.close();
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
