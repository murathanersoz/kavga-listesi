import { useState } from "react";
import { navigate } from "../App";

export function Landing() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const createRoom = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      const data = (await res.json()) as { code: string; hostKey: string };
      localStorage.setItem(`kavga:hostKey:${data.code}`, data.hostKey);
      localStorage.setItem("kavga:lastHostRoom", data.code);
      navigate(`/host?code=${data.code}`);
    } catch {
      setError("Oda açılamadı — sunucu çalışıyor mu?");
    } finally {
      setBusy(false);
    }
  };

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length === 4) navigate(`/p/${c}`);
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-10 px-6 text-center">
      <div>
        <h1 className="text-5xl font-black tracking-tight">
          Kavga <span className="text-fight">Listesi</span> 🥊
        </h1>
        <p className="mt-3 max-w-sm text-mute">
          Herkes telefonundan şarkı ekler, oylar, vetolar. Sıradaki şarkı için dövüşün.
        </p>
      </div>

      <div className="flex w-full max-w-sm flex-col gap-6">
        <button
          onClick={createRoom}
          disabled={busy}
          className="rounded-2xl bg-fight px-6 py-4 text-lg font-bold text-white shadow-lg shadow-fight/30 transition active:scale-95 disabled:opacity-50"
        >
          {busy ? "Açılıyor…" : "🔊 Parti Başlat (hoparlör ekranı)"}
        </button>

        <div className="flex items-center gap-3 text-mute">
          <span className="h-px flex-1 bg-line" /> ya da <span className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={join} className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))}
            placeholder="ODA KODU"
            aria-label="Oda kodu"
            className="figure min-w-0 flex-1 rounded-2xl border border-line bg-card px-4 py-4 text-center text-2xl font-black tracking-[0.3em] uppercase placeholder:text-mute/50 focus:border-fight focus:outline-none"
          />
          <button
            type="submit"
            disabled={code.length !== 4}
            className="rounded-2xl bg-card-2 px-6 font-bold transition active:scale-95 disabled:opacity-40"
          >
            Katıl
          </button>
        </form>
        {error && <p className="text-sm text-down">{error}</p>}
      </div>

      <p className="text-xs text-mute/70">
        Müzik sadece hoparlör ekranında çalar — telefonlar kumandadır.
      </p>
    </main>
  );
}
