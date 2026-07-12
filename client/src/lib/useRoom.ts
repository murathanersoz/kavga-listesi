import { useEffect, useReducer, useRef, useState } from "react";
import type { ClientMsg } from "@kavga/shared";
import { RoomSocket } from "./ws";
import { initialView, reduce, type RoomView } from "./state";
import { fanfare, scratch, shred, tick } from "./sounds";

export function useRoom(
  code: string,
  auth: { pid?: string; hostKey?: string },
  enabled = true,
): {
  view: RoomView;
  connected: boolean;
  send: (msg: ClientMsg) => void;
  lastError: { code: string; message: string; at: number } | null;
} {
  const [view, dispatch] = useReducer(reduce, initialView);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<{ code: string; message: string; at: number } | null>(null);
  const socketRef = useRef<RoomSocket | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const socket = new RoomSocket(code, auth, {
      onSnapshot: (snap) => dispatch({ type: "snapshot", snap }),
      onDelta: (delta) => {
        dispatch({ type: "delta", delta });
        if (delta.type === "effect") {
          if (delta.effect === "super_flash") fanfare();
          if (delta.effect === "veto_shred") shred();
          if (delta.effect === "record_scratch") scratch();
        }
        if (delta.type === "queue_changed" && delta.tension?.kind === "vote") tick();
      },
      onError: (c, m) => setLastError({ code: c, message: m, at: Date.now() }),
      onStatus: setConnected,
    });
    socketRef.current = socket;
    socket.connect();
    return () => socket.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, auth.pid, auth.hostKey, enabled]);

  return {
    view,
    connected,
    send: (msg) => socketRef.current?.send(msg),
    lastError,
  };
}

/** Smooth local progress between 5s server ticks. */
export function useSmoothProgress(positionS: number, updatedAt: number, playing: boolean): number {
  const [, force] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [playing]);
  if (!playing) return positionS;
  return positionS + (Date.now() - updatedAt) / 1000;
}
