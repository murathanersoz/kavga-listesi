/**
 * The speaker screen: authoritative YouTube player + the living queue.
 * Phones are remotes; this screen is the party.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Song } from "@kavga/shared";
import { useRoom } from "../lib/useRoom";
import { fmtTime } from "../lib/state";
import { setMuted } from "../lib/sounds";
import { navigate } from "../App";

declare global {
  interface Window {
    YT?: typeof YT;
    onYouTubeIframeAPIReady?: () => void;
  }
}
declare namespace YT {
  class Player {
    constructor(el: string | HTMLElement, opts: unknown);
    loadVideoById(id: string): void;
    playVideo(): void;
    pauseVideo(): void;
    getCurrentTime(): number;
    getDuration(): number;
    destroy(): void;
  }
}

function useHostAuth(): { code: string; hostKey: string } | null {
  const params = new URLSearchParams(location.search);
  const code = (params.get("code") ?? localStorage.getItem("kavga:lastHostRoom") ?? "").toUpperCase();
  const hostKey = code ? localStorage.getItem(`kavga:hostKey:${code}`) : null;
  if (!code || !hostKey) return null;
  return { code, hostKey };
}

export function Host() {
  const auth = useHostAuth();
  if (!auth) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4">
        <p className="text-mute">Bu tarayıcıda oda anahtarı yok.</p>
        <button onClick={() => navigate("/")} className="rounded-xl bg-fight px-5 py-3 font-bold">
          Yeni parti başlat
        </button>
      </main>
    );
  }
  return <HostScreen code={auth.code} hostKey={auth.hostKey} />;
}

function HostScreen({ code, hostKey }: { code: string; hostKey: string }) {
  const { view, connected, send } = useRoom(code, { hostKey });
  const snap = view.snap;
  const playerRef = useRef<YT.Player | null>(null);
  const playerReady = useRef(false);
  const [mute, setMute] = useState(false);
  const currentVideo = useRef<string | null>(null);

  /* ---- YouTube IFrame API (playback stays on THIS visible screen) ---- */
  useEffect(() => {
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => {
      playerRef.current = new window.YT!.Player("yt-player", {
        width: "100%",
        height: "100%",
        playerVars: { playsinline: 1, rel: 0 },
        events: {
          onReady: () => {
            playerReady.current = true;
          },
          onStateChange: (e: { data: number }) => {
            if (e.data === 0) send({ type: "host:song_ended" }); // ENDED
          },
        },
      });
    };
    return () => playerRef.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- follow room state: load/play/pause ---- */
  const nowPlaying = snap?.nowPlaying ?? null;
  const roomState = snap?.state ?? "lobby";

  useEffect(() => {
    const p = playerRef.current;
    if (!p || !playerReady.current) return;
    if (nowPlaying && currentVideo.current !== nowPlaying.youtubeId) {
      currentVideo.current = nowPlaying.youtubeId;
      p.loadVideoById(nowPlaying.youtubeId);
    }
    if (roomState === "playing") p.playVideo();
    else p.pauseVideo();
  }, [nowPlaying?.youtubeId, roomState, nowPlaying]);

  /* ---- authoritative progress relay every 5s ---- */
  useEffect(() => {
    const id = setInterval(() => {
      const p = playerRef.current;
      if (!p || !playerReady.current || roomState !== "playing") return;
      try {
        send({ type: "host:progress", positionS: p.getCurrentTime(), durationS: p.getDuration() });
      } catch {
        /* player not ready */
      }
    }, 5000);
    return () => clearInterval(id);
  }, [roomState, send]);

  /* ---- effects ---- */
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (view.effect?.kind === "super_flash") setFlash(view.effect.at);
  }, [view.effect]);

  const joinUrl = useMemo(() => `${location.origin}/p/${code}`, [code]);

  if (!snap) {
    return <main className="grid min-h-dvh place-items-center text-mute">Bağlanıyor…</main>;
  }

  return (
    <main className="flex h-dvh flex-col gap-4 p-4 lg:flex-row">
      {flash > 0 && <div key={flash} className="gold-flash" />}

      {/* left: player + now playing */}
      <section className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-line bg-black">
          <div id="yt-player" className="absolute inset-0" />
          {roomState === "lobby" && (
            <LobbyOverlay code={code} joinUrl={joinUrl} participantCount={snap.participants.length} />
          )}
          {!connected && (
            <div className="absolute inset-0 grid place-items-center bg-bg/80 text-xl font-bold">
              Sunucuya yeniden bağlanılıyor…
            </div>
          )}
        </div>

        {nowPlaying && (
          <div className="flex items-center gap-4 rounded-2xl border border-line bg-card p-4">
            <img src={nowPlaying.thumbnailUrl} alt="" className="h-16 w-28 rounded-lg object-cover" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-bold">{nowPlaying.title}</div>
              <div className="text-sm text-mute">
                {snap.playback.isFallback ? "🔁 Liste bitti, dövüşün! (eski listeden)" : `Ekleyen: ${nowPlaying.addedByNickname}`}
              </div>
            </div>
            {snap.skip.votes > 0 && (
              <div className="figure rounded-full bg-fight/20 px-3 py-1 text-sm font-bold text-fight">
                SKIP {snap.skip.votes}/{snap.skip.needed}
              </div>
            )}
            <div className="figure text-sm text-mute">
              {fmtTime(snap.playback.positionS)} / {fmtTime(snap.playback.durationS)}
            </div>
          </div>
        )}

        {/* host controls */}
        <div className="flex flex-wrap items-center gap-2">
          {roomState !== "playing" ? (
            <Btn onClick={() => send({ type: "host:play" })} primary>
              ▶ {roomState === "lobby" ? "Partiyi başlat" : "Devam"}
            </Btn>
          ) : (
            <Btn onClick={() => send({ type: "host:pause" })}>⏸ Duraklat</Btn>
          )}
          <Btn onClick={() => send({ type: "host:force_skip" })}>⏭ Atla</Btn>
          <Btn onClick={() => send({ type: "host:lock_queue", locked: !snap.settings.queueLocked })}>
            {snap.settings.queueLocked ? "🔓 Kuyruğu aç" : "🔒 Kuyruğu kilitle"}
          </Btn>
          <Btn
            onClick={() => {
              setMute(!mute);
              setMuted(!mute);
            }}
          >
            {mute ? "🔇 Efektler kapalı" : "🔊 Efektler açık"}
          </Btn>
          <span className="figure ml-auto rounded-xl border border-line bg-card px-4 py-2 text-xl font-black tracking-[0.25em]">
            {code}
          </span>
          <Btn
            onClick={() => {
              if (confirm("Parti bitsin mi?")) send({ type: "host:close_room" });
            }}
            danger
          >
            ⏹ Bitir
          </Btn>
        </div>
      </section>

      {/* right: living queue + tension feed */}
      <aside className="flex min-h-0 w-full flex-col gap-3 lg:w-96">
        <h2 className="flex items-baseline justify-between font-bold text-mute">
          <span>SIRADAKİLER</span>
          <span className="figure text-xs">{snap.queue.length} şarkı · {snap.participants.length} kişi</span>
        </h2>
        <HostQueue queue={snap.queue} shredId={view.effect?.kind === "veto_shred" ? view.effect.songId : undefined} />
        <div className="h-28 shrink-0 overflow-hidden rounded-2xl border border-line bg-card p-3">
          <div className="mb-1 text-[10px] font-bold tracking-widest text-mute">GERİLİM HATTI</div>
          {view.ticker.slice(-3).map((l) => (
            <div key={l.id} className="ticker-item truncate text-sm leading-6 text-ink-2">
              {l.text}
            </div>
          ))}
        </div>
      </aside>
    </main>
  );
}

function Btn({
  children,
  onClick,
  primary,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl px-4 py-2 font-bold transition active:scale-95 ${
        primary ? "bg-up text-black" : danger ? "bg-fight/20 text-fight" : "bg-card-2 text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** FLIP: songs slide to their new rank when votes land. */
function HostQueue({ queue, shredId }: { queue: Song[]; shredId?: string }) {
  const positions = useRef(new Map<string, number>());
  const refs = useRef(new Map<string, HTMLLIElement>());

  useEffect(() => {
    for (const [id, el] of refs.current) {
      const prev = positions.current.get(id);
      const next = el.getBoundingClientRect().top;
      if (prev !== undefined && prev !== next) {
        el.style.transition = "none";
        el.style.transform = `translateY(${prev - next}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "";
          el.style.transform = "";
        });
      }
      positions.current.set(id, next);
    }
  });

  return (
    <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
      {queue.length === 0 && (
        <li className="rounded-2xl border border-dashed border-line p-6 text-center text-mute">
          Kuyruk boş — telefonlardan şarkı ekleyin!
        </li>
      )}
      {queue.map((s, i) => (
        <li
          key={s.id}
          ref={(el) => {
            if (el) refs.current.set(s.id, el);
            else refs.current.delete(s.id);
          }}
          className={`queue-item flex items-center gap-3 rounded-2xl border border-line bg-card p-2.5 ${
            shredId === s.id ? "shredding" : ""
          } ${i === 0 ? "ring-1 ring-glory/60" : ""}`}
        >
          <span className={`figure w-6 text-center text-lg font-black ${i === 0 ? "text-glory" : "text-mute"}`}>
            {i + 1}
          </span>
          <img src={s.thumbnailUrl} alt="" className="h-11 w-[74px] rounded-md object-cover" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">
              {s.armor && <span title="Zırhlı — veto işlemez">🛡️ </span>}
              {s.title}
            </div>
            <div className="truncate text-xs text-mute">{s.addedByNickname}</div>
          </div>
          <span
            className={`figure rounded-lg px-2 py-1 text-sm font-black ${
              s.score > 0 ? "bg-up/15 text-up" : s.score < 0 ? "bg-down/15 text-down" : "bg-card-2 text-mute"
            }`}
          >
            {s.score > 0 ? `+${s.score}` : s.score}
          </span>
        </li>
      ))}
    </ol>
  );
}

function LobbyOverlay({ code, joinUrl, participantCount }: { code: string; joinUrl: string; participantCount: number }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-bg/95 p-6 text-center">
      <h1 className="text-3xl font-black">
        Kavga <span className="text-fight">Listesi</span> 🥊
      </h1>
      <img src={`/api/rooms/${code}/qr.svg`} alt={`Katılım karekodu — ${joinUrl}`} className="w-56 rounded-2xl bg-white p-3" />
      <div>
        <div className="text-sm text-mute">telefonla okut ya da şu adrese gir:</div>
        <div className="mt-1 text-lg font-bold">{location.host}</div>
        <div className="figure mt-2 text-5xl font-black tracking-[0.3em] text-glory">{code}</div>
      </div>
      <div className="text-mute">
        {participantCount === 0 ? "İlk savaşçı bekleniyor…" : `${participantCount} savaşçı hazır`}
      </div>
    </div>
  );
}
