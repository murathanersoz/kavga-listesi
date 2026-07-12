/** Synthesized party sounds — zero audio files, zero bytes of assets. */
let ctx: AudioContext | null = null;
let muted = false;

export function setMuted(m: boolean): void {
  muted = m;
}

function ac(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Subtle vote tick. */
export function tick(): void {
  const a = ac();
  if (!a || muted) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = "triangle";
  o.frequency.value = 880;
  g.gain.setValueAtTime(0.08, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.08);
  o.connect(g).connect(a.destination);
  o.start();
  o.stop(a.currentTime + 0.09);
}

/** Veto: paper-shred noise burst. */
export function shred(): void {
  const a = ac();
  if (!a || muted) return;
  const len = a.sampleRate * 0.5;
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = a.createBufferSource();
  src.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(2400, a.currentTime);
  filter.frequency.exponentialRampToValueAtTime(300, a.currentTime + 0.45);
  const g = a.createGain();
  g.gain.value = 0.25;
  src.connect(filter).connect(g).connect(a.destination);
  src.start();
}

/** Skip: record scratch — descending filtered noise wobble. */
export function scratch(): void {
  const a = ac();
  if (!a || muted) return;
  const o = a.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(700, a.currentTime);
  o.frequency.exponentialRampToValueAtTime(60, a.currentTime + 0.35);
  const g = a.createGain();
  g.gain.setValueAtTime(0.18, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.4);
  const lfo = a.createOscillator();
  lfo.frequency.value = 24;
  const lfoGain = a.createGain();
  lfoGain.gain.value = 200;
  lfo.connect(lfoGain).connect(o.frequency);
  o.connect(g).connect(a.destination);
  lfo.start();
  o.start();
  o.stop(a.currentTime + 0.45);
  lfo.stop(a.currentTime + 0.45);
}

/** Super vote: rising golden arpeggio. */
export function fanfare(): void {
  const a = ac();
  if (!a || muted) return;
  [523, 659, 784, 1047].forEach((f, i) => {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = "square";
    o.frequency.value = f;
    const t = a.currentTime + i * 0.09;
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + 0.3);
  });
}
