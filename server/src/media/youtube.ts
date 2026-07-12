/** YouTube helpers: URL parsing + keyless oEmbed metadata (+ optional search). */
import { sanitizeText } from "../util/sanitize.js";

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function parseYoutubeId(input: string): string | null {
  const raw = input.trim();
  if (ID_RE.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    return ID_RE.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "music.youtube.com") {
    const v = url.searchParams.get("v");
    if (v && ID_RE.test(v)) return v;
    const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
    if (m?.[1]) return m[1];
  }
  return null;
}

export interface SongMeta {
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationS: number | null; // oEmbed has no duration; host reports it on play
}

/** Keyless metadata via the public oEmbed endpoint. */
export async function fetchOEmbed(youtubeId: string): Promise<SongMeta | null> {
  const target = `https://www.youtube.com/watch?v=${youtubeId}`;
  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`,
    { signal: AbortSignal.timeout(6000) },
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json()) as { title?: string; thumbnail_url?: string };
  if (!data.title) return null;
  return {
    youtubeId,
    title: sanitizeText(data.title, 120),
    thumbnailUrl: data.thumbnail_url ?? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
    durationS: null,
  };
}

/** Optional search — only when YOUTUBE_API_KEY is configured. */
export async function searchYoutube(query: string, apiKey: string): Promise<SongMeta[]> {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("videoEmbeddable", "true");
  url.searchParams.set("maxResults", "8");
  url.searchParams.set("q", query);
  url.searchParams.set("key", apiKey);
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) }).catch(() => null);
  if (!res || !res.ok) return [];
  const data = (await res.json()) as {
    items?: { id?: { videoId?: string }; snippet?: { title?: string; thumbnails?: { medium?: { url?: string } } } }[];
  };
  return (data.items ?? [])
    .filter((i) => i.id?.videoId && i.snippet?.title)
    .map((i) => ({
      youtubeId: i.id!.videoId!,
      title: sanitizeText(i.snippet!.title!, 120),
      thumbnailUrl: i.snippet!.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${i.id!.videoId}/hqdefault.jpg`,
      durationS: null,
    }));
}
