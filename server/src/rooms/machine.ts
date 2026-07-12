/**
 * Room lifecycle state machine — pure, no I/O.
 *
 *   lobby ──START──▶ playing ◀──START── paused
 *                      │  ▲                ▲
 *                   PAUSE │                │ HOST_DISCONNECT (from playing)
 *                      ▼  └────────────────┘
 *   any ──END──▶ ended (terminal)
 *
 * Host reconnect does NOT auto-resume: the host presses play — a party
 * speaker suddenly blasting music on reconnect is a bug, not a feature.
 */
import type { RoomState } from "@kavga/shared";

export type RoomEvent =
  | "START"
  | "PAUSE"
  | "END"
  | "HOST_DISCONNECT"
  | "HOST_RECONNECT";

export class InvalidTransition extends Error {
  constructor(
    public readonly from: RoomState,
    public readonly event: RoomEvent,
  ) {
    super(`invalid transition: ${from} + ${event}`);
  }
}

const TABLE: Record<RoomState, Partial<Record<RoomEvent, RoomState>>> = {
  lobby: {
    START: "playing",
    END: "ended",
    HOST_DISCONNECT: "lobby", // nothing to pause yet
    HOST_RECONNECT: "lobby",
  },
  playing: {
    PAUSE: "paused",
    END: "ended",
    HOST_DISCONNECT: "paused", // speaker gone → hold the party
    HOST_RECONNECT: "playing", // no-op safety
    START: "playing", // idempotent play
  },
  paused: {
    START: "playing",
    PAUSE: "paused", // idempotent
    END: "ended",
    HOST_DISCONNECT: "paused",
    HOST_RECONNECT: "paused", // deliberate: host must press play
  },
  ended: {
    END: "ended", // idempotent; everything else is invalid
  },
};

export function transition(from: RoomState, event: RoomEvent): RoomState {
  const to = TABLE[from][event];
  if (to === undefined) throw new InvalidTransition(from, event);
  return to;
}

export const isTerminal = (s: RoomState): boolean => s === "ended";
