/** The phone controller: join, vote, fight. Budget-friendly — no heavy libs. */
import { useMemo, useState } from "react";
import type { Participant, Song } from "@kavga/shared";
import { useRoom, useSmoothProgress } from "../lib/useRoom";
import { fmtTime } from "../lib/state";

export function Phone({ code }: { code: string }) {
  const [pid, setPid] = useState(() => localStorage.getItem(`kavga:pid:${code}`) ?? "");
  if (!pid) return <JoinForm code={code} onJoined={setPid} />;
  return <Controller code={code} pid={pid} />;
}

/* ---------------- join ---------------- */

function JoinForm({ code, onJoined }: { code: string; onJoined: (pid: string) => void }) {
  const [nick, setNick] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/rooms/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: nick }),
      });
      const data = (await res.json()) as { participant?: Participant; error?: string };
      if (!res.ok || !data.participant) {
        setError(data.error ?? "Katılamadın.");
        return;
      }
      localStorage.setItem(`kavga:pid:${code}`, data.participant.id);
      onJoined(data.participant.id);
    } catch {
      setError("Bağlantı hatası.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6">
      <div className="text-center">
        <div className="figure text-sm tracking-[0.3em] text-mute">ODA {code}</div>
        <h1 className="mt-1 text-3xl font-black">Kavgaya katıl 🥊</h1>
      </div>
      <form onSubmit={join} className="flex w-full max-w-xs flex-col gap-3">
        <input
          value={nick}
          onChange={(e) => setNick(e.target.value)}
          placeholder="Takma adın"
          maxLength={20}
          aria-label="Takma ad"
          className="rounded-2xl border border-line bg-card px-4 py-4 text-center text-xl font-bold placeholder:text-mute/50 focus:border-fight focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || nick.trim().length < 2}
          className="rounded-2xl bg-fight px-6 py-4 text-lg font-bold text-white transition active:scale-95 disabled:opacity-40"
        >
          {busy ? "…" : "İçeri gir"}
        </button>
        {error && <p className="text-center text-sm text-down">{error}</p>}
      </form>
    </main>
  );
}

/* ---------------- controller ---------------- */

function Controller({ code, pid }: { code: string; pid: string }) {
  const { view, connected, send, lastError } = useRoom(code, { pid });
  const snap = view.snap;
  const [sheetOpen, setSheetOpen] = useState(false);

  const me = useMemo(() => snap?.participants.find((p) => p.id === pid), [snap, pid]);
  const smoothPos = useSmoothProgress(
    snap?.playback.positionS ?? 0,
    snap?.playback.updatedAt ?? Date.now(),
    snap?.state === "playing",
  );

  if (!snap) return <main className="grid min-h-dvh place-items-center text-mute">Bağlanıyor…</main>;

  if (snap.state === "ended")
    return (
      <main className="grid min-h-dvh place-items-center px-6 text-center">
        <div>
          <div className="text-4xl">🏁</div>
          <h1 className="mt-2 text-2xl font-black">Parti bitti!</h1>
          <p className="mt-1 text-mute">Kavga güzeldi. Bir dahakine!</p>
        </div>
      </main>
    );

  const np = snap.nowPlaying;
  const iVotedSkip = snap.skip.voted.includes(pid);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-3 px-3 pb-28 pt-3">
      {/* status bar */}
      <header className="flex items-center gap-2 text-xs text-mute">
        <span className="figure font-black tracking-widest text-ink">{code}</span>
        <span className={`size-2 rounded-full ${connected ? "bg-up" : "bg-down"}`} />
        {me && (
          <span className="ml-auto flex items-center gap-1.5">
            <span style={{ color: me.color }}>{me.emoji}</span> {me.nickname}
          </span>
        )}
      </header>

      {!snap.hostConnected && (
        <div className="rounded-2xl border border-down/40 bg-down/10 p-3 text-center font-bold text-down">
          📵 Hoparlör koptu — dönmesini bekliyoruz…
        </div>
      )}

      {/* now playing + skip */}
      {np ? (
        <section className="rounded-2xl border border-line bg-card p-3">
          <div className="flex items-center gap-3">
            <img src={np.thumbnailUrl} alt="" className="h-12 w-20 rounded-lg object-cover" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold">{np.title}</div>
              <div className="text-xs text-mute">
                {snap.playback.isFallback ? "🔁 eski listeden" : np.addedByNickname}
                {snap.state === "paused" && " · ⏸ duraklatıldı"}
              </div>
            </div>
          </div>
          <div className="figure mt-2 flex items-center gap-2 text-[10px] text-mute">
            {fmtTime(Math.min(smoothPos, snap.playback.durationS ?? smoothPos))}
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-card-2">
              <div
                className="h-full bg-fight transition-[width] duration-1000 ease-linear"
                style={{
                  width: snap.playback.durationS
                    ? `${Math.min(100, (smoothPos / snap.playback.durationS) * 100)}%`
                    : "0%",
                }}
              />
            </div>
            {fmtTime(snap.playback.durationS)}
          </div>
          <button
            onClick={() => send({ type: "skip_vote" })}
            disabled={iVotedSkip}
            className={`mt-2 w-full rounded-xl py-2.5 text-sm font-bold transition active:scale-95 ${
              iVotedSkip ? "bg-card-2 text-mute" : "bg-fight/15 text-fight"
            }`}
          >
            {iVotedSkip ? "Oyun verildi" : "⏭ Bunu geç"} · {snap.skip.votes}/{snap.skip.needed || "?"}
          </button>
        </section>
      ) : (
        <section className="rounded-2xl border border-dashed border-line p-4 text-center text-sm text-mute">
          {snap.state === "lobby" ? "Hoparlör başlatınca müzik burada akacak." : "Sırada bir şey yok — ekle!"}
        </section>
      )}

      {/* arsenal */}
      {me && (
        <section className="flex items-center justify-around rounded-2xl border border-line bg-card px-2 py-2 text-center text-xs">
          <Arsenal label="Süper oy" icon="⚡" n={me.superVotesLeft} />
          <Arsenal label="Veto" icon="💀" n={me.vetoesLeft} />
          <Arsenal label="Rövanş" icon="🛡️" n={me.revengeTokens} />
        </section>
      )}

      {/* queue */}
      <section className="flex-1 space-y-2">
        {snap.queue.map((s, i) => (
          <PhoneSongCard key={s.id} song={s} rank={i + 1} me={me} pid={pid} send={send} />
        ))}
        {snap.queue.length === 0 && (
          <p className="py-8 text-center text-sm text-mute">Kuyruk bomboş. İlk hamleyi sen yap 👇</p>
        )}
      </section>

      {lastError && Date.now() - lastError.at < 4000 && (
        <div className="fixed inset-x-3 top-3 z-50 rounded-xl bg-down px-4 py-3 text-center text-sm font-bold text-white">
          {lastError.message}
        </div>
      )}

      {/* add song */}
      <button
        onClick={() => setSheetOpen(true)}
        disabled={snap.settings.queueLocked}
        className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-full bg-fight px-8 py-4 text-lg font-black text-white shadow-xl shadow-fight/40 transition active:scale-95 disabled:opacity-40"
      >
        {snap.settings.queueLocked ? "🔒 Kuyruk kilitli" : "＋ Şarkı ekle"}
      </button>
      {sheetOpen && <AddSheet me={me} send={send} onClose={() => setSheetOpen(false)} />}
    </main>
  );
}

function Arsenal({ label, icon, n }: { label: string; icon: string; n: number }) {
  return (
    <div className={n > 0 ? "" : "opacity-35"}>
      <div className="text-xl">{icon}</div>
      <div className="font-bold">{n}</div>
      <div className="text-mute">{label}</div>
    </div>
  );
}

function PhoneSongCard({
  song: s,
  rank,
  me,
  pid,
  send,
}: {
  song: Song;
  rank: number;
  me: Participant | undefined;
  pid: string;
  send: (m: never) => void;
}) {
  const sendMsg = send as (m: unknown) => void;
  const mine = s.addedBy === pid;
  const my = s.myVote ?? 0;

  return (
    <div className={`rounded-2xl border border-line bg-card p-2.5 ${rank === 1 ? "ring-1 ring-glory/50" : ""}`}>
      <div className="flex items-center gap-2.5">
        <span className={`figure w-5 text-center font-black ${rank === 1 ? "text-glory" : "text-mute"}`}>{rank}</span>
        <img src={s.thumbnailUrl} alt="" className="h-10 w-[68px] rounded-md object-cover" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {s.armor && "🛡️ "}
            {s.title}
          </div>
          <div className="truncate text-[11px] text-mute">
            {mine ? "senin şarkın" : s.addedByNickname} ·{" "}
            <span className={`figure font-bold ${s.score > 0 ? "text-up" : s.score < 0 ? "text-down" : ""}`}>
              {s.score > 0 ? `+${s.score}` : s.score}
            </span>
          </div>
        </div>
      </div>
      <div className="mt-2 flex gap-1.5">
        <VoteBtn
          active={my === 1}
          onClick={() => sendMsg({ type: "vote", songId: s.id, value: my === 1 ? 0 : 1 })}
          className="flex-1 bg-up/15 text-up"
        >
          ▲
        </VoteBtn>
        <VoteBtn
          active={my === -1}
          onClick={() => sendMsg({ type: "vote", songId: s.id, value: my === -1 ? 0 : -1 })}
          className="flex-1 bg-down/15 text-down"
        >
          ▼
        </VoteBtn>
        <VoteBtn
          disabled={!me || me.superVotesLeft === 0 || my === 3}
          active={my === 3}
          onClick={() => sendMsg({ type: "super_vote", songId: s.id })}
          className="w-14 bg-glory/15 text-glory"
          title="Süper oy (+3, geri alınamaz)"
        >
          ⚡
        </VoteBtn>
        {!mine && (
          <VoteBtn
            disabled={!me || me.vetoesLeft === 0 || s.armor}
            onClick={() => {
              if (confirm(`"${s.title}" vetolansın mı? Tek vetonu harcayacaksın!`))
                sendMsg({ type: "veto", songId: s.id });
            }}
            className="w-14 bg-fight/15 text-fight"
            title={s.armor ? "Zırhlı — veto işlemez" : "Veto (tek hakkın!)"}
          >
            💀
          </VoteBtn>
        )}
      </div>
    </div>
  );
}

function VoteBtn({
  children,
  onClick,
  className,
  disabled,
  active,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  className: string;
  disabled?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={`rounded-xl py-2.5 text-lg font-black transition active:scale-90 disabled:opacity-30 ${className} ${
        active ? "ring-2 ring-current" : ""
      }`}
    >
      {children}
    </button>
  );
}

/* ---------------- add sheet ---------------- */

function AddSheet({
  me,
  send,
  onClose,
}: {
  me: Participant | undefined;
  send: (m: never) => void;
  onClose: () => void;
}) {
  const sendMsg = send as (m: unknown) => void;
  const [url, setUrl] = useState("");
  const [useArmor, setUseArmor] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    sendMsg({ type: "add_song", url: url.trim(), useArmor });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60" onClick={onClose}>
      <div
        className="w-full rounded-t-3xl border-t border-line bg-card p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" />
        <h2 className="text-lg font-black">Şarkı ekle 🎵</h2>
        <p className="mt-1 text-xs text-mute">YouTube linkini yapıştır — başlık ve kapak otomatik gelir.</p>
        <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://youtu.be/…"
            inputMode="url"
            autoFocus
            aria-label="YouTube linki"
            className="rounded-2xl border border-line bg-card-2 px-4 py-3.5 text-sm placeholder:text-mute/50 focus:border-fight focus:outline-none"
          />
          {me && me.revengeTokens > 0 && (
            <label className="flex items-center gap-2 rounded-xl bg-glory/10 px-3 py-2.5 text-sm">
              <input type="checkbox" checked={useArmor} onChange={(e) => setUseArmor(e.target.checked)} />
              🛡️ Rövanş hakkını kullan — bu şarkı <b>vetolanamaz</b>
            </label>
          )}
          <button
            type="submit"
            disabled={!url.trim()}
            className="rounded-2xl bg-fight py-3.5 font-black text-white transition active:scale-95 disabled:opacity-40"
          >
            Sıraya at
          </button>
        </form>
      </div>
    </div>
  );
}
