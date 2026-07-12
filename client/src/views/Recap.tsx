/** End-of-party recap + shareable canvas card. */
import { useEffect, useRef, useState } from "react";
import type { Recap } from "@kavga/shared";

export function RecapView({ code }: { code: string }) {
  const [recap, setRecap] = useState<Recap | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(`/api/rooms/${code}/recap`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setRecap)
      .catch(() => setError(true));
  }, [code]);

  if (error) return <Centered>Özet yüklenemedi.</Centered>;
  if (!recap) return <Centered>Kavga raporu hazırlanıyor…</Centered>;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center gap-4 px-4 py-8">
      <div className="text-5xl">🏁</div>
      <h1 className="text-3xl font-black">Parti bitti!</h1>
      <p className="figure -mt-2 text-sm tracking-[0.3em] text-mute">ODA {recap.roomCode}</p>

      <div className="grid w-full grid-cols-2 gap-2.5">
        <Stat big={String(recap.totalSongsPlayed)} label="şarkı çaldı" />
        <Stat big={String(recap.totalVotes)} label="oy kullanıldı" />
        {recap.topAdder && (
          <Stat big={recap.topAdder.nickname} label={`${recap.topAdder.count} şarkıyla gecenin DJ'i 🏆`} gold />
        )}
        {recap.mostVetoed ? (
          <Stat
            big={recap.mostVetoed.nickname}
            label={`${recap.mostVetoed.count} veto yedi — kavganın kaybedeni 💀`}
            fight
          />
        ) : (
          <Stat big={String(recap.totalVetoes)} label="veto atıldı" />
        )}
        {recap.biggestComeback && (
          <div className="col-span-2 rounded-2xl border border-line bg-card p-4 text-center">
            <div className="text-xs font-bold tracking-widest text-up">EN BÜYÜK GERİ DÖNÜŞ 📈</div>
            <div className="mt-1 truncate font-bold">“{recap.biggestComeback.title}”</div>
            <div className="text-xs text-mute">
              {recap.biggestComeback.lowestScore} puandan sahneye — ekleyen {recap.biggestComeback.addedBy}
            </div>
          </div>
        )}
      </div>

      <ShareCard recap={recap} />
      <a href="/" className="mt-2 text-sm text-mute underline">
        Yeni kavga başlat
      </a>
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="grid min-h-dvh place-items-center text-mute">{children}</main>;
}

function Stat({ big, label, gold, fight }: { big: string; label: string; gold?: boolean; fight?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4 text-center">
      <div className={`figure truncate text-2xl font-black ${gold ? "text-glory" : fight ? "text-fight" : ""}`}>
        {big}
      </div>
      <div className="mt-0.5 text-xs text-mute">{label}</div>
    </div>
  );
}

/** Canvas-rendered 1080×1350 share image. */
function ShareCard({ recap }: { recap: Recap }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = (): HTMLCanvasElement => {
    const c = canvasRef.current!;
    c.width = 1080;
    c.height = 1350;
    const x = c.getContext("2d")!;
    // bg
    const grad = x.createLinearGradient(0, 0, 0, 1350);
    grad.addColorStop(0, "#1c1917");
    grad.addColorStop(1, "#0c0a09");
    x.fillStyle = grad;
    x.fillRect(0, 0, 1080, 1350);
    x.textAlign = "center";

    x.font = "900 92px system-ui";
    x.fillStyle = "#fafaf9";
    x.fillText("Kavga Listesi 🥊", 540, 170);
    x.font = "700 40px system-ui";
    x.fillStyle = "#a8a29e";
    x.fillText(`ODA ${recap.roomCode} · KAVGA RAPORU`, 540, 240);

    const line = (y: number, icon: string, big: string, small: string, color = "#fafaf9") => {
      x.font = "900 64px system-ui";
      x.fillStyle = color;
      x.fillText(`${icon} ${big}`, 540, y);
      x.font = "500 36px system-ui";
      x.fillStyle = "#a8a29e";
      x.fillText(small, 540, y + 52);
    };

    line(420, "🎵", String(recap.totalSongsPlayed), "şarkı çaldı");
    line(580, "🗳️", String(recap.totalVotes), "oy kullanıldı");
    if (recap.topAdder) line(740, "🏆", recap.topAdder.nickname, `gecenin DJ'i (${recap.topAdder.count} şarkı)`, "#fbbf24");
    if (recap.mostVetoed)
      line(900, "💀", recap.mostVetoed.nickname, `kavganın kaybedeni (${recap.mostVetoed.count} veto)`, "#f43f5e");
    if (recap.biggestComeback) {
      const t = recap.biggestComeback.title.length > 26
        ? recap.biggestComeback.title.slice(0, 26) + "…"
        : recap.biggestComeback.title;
      line(1060, "📈", `“${t}”`, `en büyük geri dönüş (${recap.biggestComeback.lowestScore} puandan)`, "#4ade80");
    }

    x.font = "500 32px system-ui";
    x.fillStyle = "#57534e";
    x.fillText("kavga listesi — parti kuyruğu savaş alanıdır", 540, 1290);
    return c;
  };

  const download = () => {
    const c = draw();
    const a = document.createElement("a");
    a.download = `kavga-${recap.roomCode}.png`;
    a.href = c.toDataURL("image/png");
    a.click();
  };

  return (
    <>
      <canvas ref={canvasRef} className="hidden" aria-hidden />
      <button
        onClick={download}
        className="rounded-2xl bg-glory px-6 py-3.5 font-black text-black transition active:scale-95"
      >
        📸 Raporu indir & paylaş
      </button>
    </>
  );
}
