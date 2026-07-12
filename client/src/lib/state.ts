/** Snapshot + delta reducer shared by host and phone views. */
import type { Delta, RoomSnapshot, TensionEvent } from "@kavga/shared";

export interface TickerLine {
  id: number;
  text: string;
}

export interface RoomView {
  snap: RoomSnapshot | null;
  ticker: TickerLine[];
  effect: { kind: "super_flash" | "veto_shred" | "record_scratch"; songId?: string; at: number } | null;
}

export const initialView: RoomView = { snap: null, ticker: [], effect: null };

let tickerId = 0;

export function tensionText(t: TensionEvent): string {
  switch (t.kind) {
    case "add":
      return `${t.who} “${t.title}” ekledi 🎵`;
    case "vote":
      return t.value === 1 ? `${t.who}, “${t.title}” şarkısını yükseltti 👍` : `${t.who}, “${t.title}” şarkısını gömdü 👎`;
    case "super":
      return `${t.who} SÜPER OYUNU kullandı ⚡ “${t.title}”`;
    case "veto":
      return `${t.who}, ${t.victim} kişisinin şarkısını vetoladı 💀`;
    case "armor":
      return `${t.who} rövanşını aldı — “${t.title}” artık ZIRHLI 🛡️`;
    case "skip":
      return `“${t.title}” oy birliğiyle kesildi ⏭️`;
    case "join":
      return `${t.who} kavgaya katıldı 👋`;
    case "kick":
      return `${t.who} partiden atıldı 🚪`;
  }
}

export type Action = { type: "snapshot"; snap: RoomSnapshot } | { type: "delta"; delta: Delta };

export function reduce(view: RoomView, action: Action): RoomView {
  if (action.type === "snapshot") return { ...view, snap: action.snap };
  const { delta } = action;
  const snap = view.snap;
  if (!snap) return view;

  const pushTension = (t?: TensionEvent): TickerLine[] =>
    t ? [...view.ticker.slice(-7), { id: ++tickerId, text: tensionText(t) }] : view.ticker;

  switch (delta.type) {
    case "queue_changed":
      return { ...view, snap: { ...snap, queue: delta.queue }, ticker: pushTension(delta.tension) };
    case "now_playing":
      return {
        ...view,
        snap: {
          ...snap,
          nowPlaying: delta.song,
          queue: snap.queue.filter((s) => s.id !== delta.song?.id),
          skip: { votes: 0, needed: snap.skip.needed, voted: [] },
        },
        ticker: pushTension(delta.tension),
      };
    case "playback":
      return { ...view, snap: { ...snap, playback: delta.playback } };
    case "participants":
      return { ...view, snap: { ...snap, participants: delta.participants } };
    case "skip_state":
      return { ...view, snap: { ...snap, skip: delta.skip } };
    case "room_state":
      return { ...view, snap: { ...snap, state: delta.state, hostConnected: delta.hostConnected } };
    case "settings":
      return { ...view, snap: { ...snap, settings: delta.settings } };
    case "arsenal": {
      const participants = snap.participants.map((p) =>
        p.id === delta.participantId
          ? { ...p, superVotesLeft: delta.superVotesLeft, vetoesLeft: delta.vetoesLeft, revengeTokens: delta.revengeTokens }
          : p,
      );
      return { ...view, snap: { ...snap, participants } };
    }
    case "effect":
      return { ...view, effect: { kind: delta.effect, songId: delta.songId, at: Date.now() } };
    default:
      return view;
  }
}

export function fmtTime(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "—:——";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}
