/** Kavga Listesi — shared types (server is the source of truth). */

export type RoomState = "lobby" | "playing" | "paused" | "ended";

export interface RoomSettings {
  maxQueuedPerPerson: number; // default 2
  queueLocked: boolean;
  partyMode: boolean;
  muted: boolean;
}

export interface Participant {
  id: string;
  nickname: string;
  emoji: string;
  color: string;
  superVotesLeft: number;
  vetoesLeft: number;
  revengeTokens: number;
  connected: boolean;
  isHost?: boolean;
}

export type SongStatus = "queued" | "playing" | "played" | "vetoed";

export interface Song {
  id: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationS: number | null; // oEmbed has no duration; host reports it on play
  addedBy: string; // participant id
  addedByNickname: string;
  addedAt: number;
  status: SongStatus;
  armor: boolean;
  score: number;
  myVote?: -1 | 1 | 3 | 0;
  isFallback?: boolean;
}

export interface Playback {
  songId: string | null;
  positionS: number;
  durationS: number | null;
  updatedAt: number;
  isFallback: boolean;
}

export interface SkipState {
  votes: number;
  needed: number;
  voted: string[]; // participant ids
}

/** Full room snapshot sent on (re)sync. */
export interface RoomSnapshot {
  seq: number;
  code: string;
  state: RoomState;
  settings: RoomSettings;
  participants: Participant[];
  queue: Song[]; // ranked
  nowPlaying: Song | null;
  playback: Playback;
  skip: SkipState;
  hostConnected: boolean;
}

/* ---------- websocket protocol ---------- */

export type ClientMsg =
  | { type: "resync" }
  | { type: "add_song"; url: string; useArmor?: boolean }
  | { type: "vote"; songId: string; value: -1 | 0 | 1 }
  | { type: "super_vote"; songId: string }
  | { type: "veto"; songId: string }
  | { type: "skip_vote" }
  | { type: "host:play" }
  | { type: "host:pause" }
  | { type: "host:force_skip" }
  | { type: "host:song_ended" }
  | { type: "host:progress"; positionS: number; durationS: number }
  | { type: "host:kick"; participantId: string }
  | { type: "host:lock_queue"; locked: boolean }
  | { type: "host:party_mode"; on: boolean }
  | { type: "host:close_room" };

export type TensionEvent =
  | { kind: "add"; who: string; title: string }
  | { kind: "vote"; who: string; title: string; value: 1 | -1 }
  | { kind: "super"; who: string; title: string }
  | { kind: "veto"; who: string; victim: string; title: string }
  | { kind: "armor"; who: string; title: string }
  | { kind: "skip"; title: string }
  | { kind: "join"; who: string }
  | { kind: "kick"; who: string };

export type ServerMsg =
  | { type: "sync"; snapshot: RoomSnapshot }
  | { type: "delta"; seq: number; event: Delta }
  | { type: "error"; code: string; message: string }
  | { type: "joined"; participantId: string; snapshot: RoomSnapshot };

export type Delta =
  | { type: "queue_changed"; queue: Song[]; tension?: TensionEvent }
  | { type: "now_playing"; song: Song | null; isFallback: boolean; tension?: TensionEvent }
  | { type: "playback"; playback: Playback }
  | { type: "participants"; participants: Participant[]; tension?: TensionEvent }
  | { type: "skip_state"; skip: SkipState }
  | { type: "room_state"; state: RoomState; hostConnected: boolean }
  | { type: "settings"; settings: RoomSettings }
  | { type: "arsenal"; participantId: string; superVotesLeft: number; vetoesLeft: number; revengeTokens: number }
  | { type: "effect"; effect: "super_flash" | "veto_shred" | "record_scratch"; songId?: string };

/* ---------- recap ---------- */

export interface Recap {
  roomCode: string;
  totalSongsPlayed: number;
  totalVotes: number;
  totalVetoes: number;
  topAdder: { nickname: string; count: number } | null;
  mostVetoed: { nickname: string; count: number } | null;
  biggestComeback: { title: string; lowestScore: number; addedBy: string } | null;
}
