import { fetchWithTimeout } from "./fetchWithTimeout";
import { recordRuntimeEvent } from "./runtimeLog";
import type { MusicProviderName, MusicSearchQuery, MusicSearchResult, Song } from "./types";

const MUSIC_API_BASE_URL =
  process.env.NETEASE_API_BASE_URL ?? process.env.MUSIC_API_BASE_URL ?? "https://music-api.gdstudio.xyz/api.php";
const MUSIC_BITRATE = process.env.MUSIC_BITRATE ?? "320";
const MUSIC_SEARCH_PAGE = "1";
const MUSIC_TIMEOUT_MS = 3500;
const AUDIO_URL_VALIDATE_TIMEOUT_MS = Number(process.env.MUSIC_AUDIO_VALIDATE_TIMEOUT_MS ?? 2500);
const COVER_URL_VALIDATE_TIMEOUT_MS = Number(process.env.MUSIC_COVER_VALIDATE_TIMEOUT_MS ?? 2000);
const VALIDATE_AUDIO_URLS = process.env.MUSIC_VALIDATE_AUDIO_URLS !== "false";
const COVER_FALLBACK_ENABLED = process.env.MUSIC_COVER_FALLBACK_ENABLED !== "false";
const COVER_FALLBACK_PROVIDER = process.env.MUSIC_COVER_FALLBACK_PROVIDER ?? "kuwo";
const COVER_FALLBACK_MIN_SCORE = Number(process.env.MUSIC_COVER_FALLBACK_MIN_SCORE ?? 90);

const providerCapabilities: Record<string, { canSearch: boolean; canPlay: boolean; requiresAuth: boolean }> = {
  netease: { canSearch: true, canPlay: true, requiresAuth: false },
  spotify: { canSearch: true, canPlay: true, requiresAuth: false },
  apple: { canSearch: true, canPlay: true, requiresAuth: false },
  tencent: { canSearch: true, canPlay: true, requiresAuth: false },
};

type MusicApiSearchItem = {
  id?: string | number;
  name?: string;
  artist?: unknown;
  album?: string;
  pic_id?: string | number;
  lyric_id?: string | number;
  source?: string;
};

type MusicApiUrlResult = {
  url?: string;
  br?: string | number;
  size?: string | number;
};


export function getProviderOrder() {
  const raw = process.env.MUSIC_PROVIDER_ORDER ?? "netease,spotify,tencent,apple";
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry === "netease" || entry === "spotify" || entry === "tencent" || entry === "apple");
}

export function getProviderCapabilities(provider: string) {
  return providerCapabilities[provider] ?? { canSearch: true, canPlay: true, requiresAuth: false };
}

export async function searchSongs(query: MusicSearchQuery): Promise<MusicSearchResult> {
  const providers = query.provider ? [query.provider] : getProviderOrder();
  const providerTried: string[] = [];

  for (const provider of providers) {
    providerTried.push(provider);
    const songs = await searchSongsByProvider(provider, query).catch(() => []);

    if (songs.length > 0) {
      return {
        query,
        songs,
        providerTried
      };
    }
  }

  return {
    query,
    songs: [],
    providerTried
  };
}

export async function searchSongsByProvider(provider: MusicProviderName, query: MusicSearchQuery): Promise<Song[]> {

  const capabilities = getProviderCapabilities(provider);
  if (!capabilities.canSearch || !capabilities.canPlay) {
    return [];
  }

  const limit = Math.min(query.limit ?? 10, 8);
  const items = await searchRawItemsByProvider(provider, query.keyword, limit);
  const songs = await Promise.all(items.slice(0, limit).map((item) => toSong(provider, item)));
  return songs.filter((song) => Boolean(song.audioUrl));
}

export function normalizeMusicApiResult(data: unknown): MusicApiSearchItem[] {
  if (Array.isArray(data)) {
    return data as MusicApiSearchItem[];
  }

  if (isRecord(data) && Array.isArray(data.data)) {
    return data.data as MusicApiSearchItem[];
  }

  if (isRecord(data) && Array.isArray(data.result)) {
    return data.result as MusicApiSearchItem[];
  }

  return [];
}

async function searchRawItemsByProvider(provider: string, keyword: string, limit: number): Promise<MusicApiSearchItem[]> {
  const url = buildApiUrl({
    types: "search",
    source: provider,
    name: keyword,
    count: String(limit),
    pages: MUSIC_SEARCH_PAGE
  });
  const response = await fetchWithTimeout(url, { cache: "no-store" }, MUSIC_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Music provider ${provider} returned ${response.status}`);
  }
  return normalizeMusicApiResult(await response.json());
}

function buildApiUrl(params: Record<string, string>) {
  const url = new URL(MUSIC_API_BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

async function toSong(provider: string, item: MusicApiSearchItem): Promise<Song> {
  const id = String(item.id ?? "");
  const source = item.source ?? provider;
  const title = item.name ?? "Unknown Title";
  const artist = formatArtist(item.artist);
  const album = item.album ?? "Unknown Album";
  const [audioUrl, directCoverUrl] = await Promise.all([
    getSongUrl(source, id),
    item.pic_id ? getCoverUrl(source, String(item.pic_id)) : Promise.resolve(undefined)
  ]);
  const coverUrl = directCoverUrl || await getFallbackCoverUrl({ title, artist, album });

  return {
    id,
    title,
    artist,
    album,
    durationSeconds: 0,
    audioUrl,
    platform: source,
    coverUrl,
    lyricId: item.lyric_id ? String(item.lyric_id) : undefined
  };
}

async function getFallbackCoverUrl(target: { title: string; artist: string; album: string }): Promise<string | undefined> {
  if (!COVER_FALLBACK_ENABLED || !COVER_FALLBACK_PROVIDER) return undefined;

  try {
    const queries = unique([`${target.title} ${target.artist}`, target.title]);
    let best: { item: MusicApiSearchItem; score: number } | null = null;

    for (const keyword of queries) {
      const items = await searchRawItemsByProvider(COVER_FALLBACK_PROVIDER, keyword, 5).catch(() => []);
      for (const item of items) {
        if (!item.pic_id) continue;
        const score = scoreCoverFallbackCandidate(item, target);
        if (!best || score > best.score) best = { item, score };
      }
      if (best && best.score >= COVER_FALLBACK_MIN_SCORE) break;
    }

    if (!best || best.score < COVER_FALLBACK_MIN_SCORE || !best.item.pic_id) return undefined;
    const coverUrl = await getCoverUrl(best.item.source ?? COVER_FALLBACK_PROVIDER, String(best.item.pic_id));
    if (!coverUrl || !(await validateCoverImageUrl(coverUrl))) return undefined;

    void recordRuntimeEvent({
      step: "music.coverFallback",
      status: "success",
      context: {
        provider: COVER_FALLBACK_PROVIDER,
        title: target.title,
        artist: target.artist,
        matchedTitle: best.item.name ?? "",
        matchedArtist: formatArtist(best.item.artist),
        score: best.score
      }
    });
    return coverUrl;
  } catch (cause) {
    void recordRuntimeEvent({
      step: "music.coverFallback",
      status: "error",
      error: cause instanceof Error ? cause.message : "cover_fallback_failed",
      context: { provider: COVER_FALLBACK_PROVIDER, title: target.title, artist: target.artist }
    });
    return undefined;
  }
}

export function scoreCoverFallbackCandidate(item: MusicApiSearchItem, target: { title: string; artist: string; album: string }) {
  if (!item.pic_id) return 0;
  const title = normalizeCoverMatch(item.name ?? "");
  const targetTitle = normalizeCoverMatch(target.title);
  const artist = normalizeCoverMatch(formatArtist(item.artist));
  const targetArtist = normalizeCoverMatch(target.artist);
  const album = normalizeCoverMatch(item.album ?? "");
  const targetAlbum = normalizeCoverMatch(target.album);
  let score = 0;
  if (title === targetTitle) score += 70;
  else if (title.includes(targetTitle) || targetTitle.includes(title)) score += 35;
  if (artist === targetArtist) score += 35;
  else if (artist.includes(targetArtist) || targetArtist.includes(artist)) score += 18;
  if (targetAlbum && album === targetAlbum) score += 10;
  return score;
}

async function validateCoverImageUrl(coverUrl: string) {
  if (!/^https?:\/\//i.test(coverUrl)) return false;
  try {
    const response = await fetchWithTimeout(coverUrl, {
      method: "GET",
      headers: { Range: "bytes=0-1" },
      redirect: "follow",
      cache: "no-store"
    }, COVER_URL_VALIDATE_TIMEOUT_MS);
    return (response.ok || response.status === 206) && (response.headers.get("content-type") ?? "").toLowerCase().startsWith("image/");
  } catch {
    return false;
  }
}

async function getSongUrl(source: string, id: string): Promise<string> {
  if (!id) {
    return "";
  }

  const url = buildApiUrl({
    types: "url",
    source,
    id,
    br: MUSIC_BITRATE
  });
  const response = await fetchWithTimeout(url, { cache: "no-store" }, MUSIC_TIMEOUT_MS);

  if (!response.ok) {
    return "";
  }

  const data = (await response.json()) as MusicApiUrlResult;
  const audioUrl = typeof data.url === "string" ? data.url.trim() : "";
  if (!audioUrl) return "";

  const playable = await validatePlayableAudioUrl(audioUrl, { source, id });
  return playable ? audioUrl : "";
}

export async function validatePlayableAudioUrl(audioUrl: string, context: { source?: string; id?: string; title?: string; artist?: string } = {}) {
  if (!VALIDATE_AUDIO_URLS) return true;
  if (!/^https?:\/\//i.test(audioUrl)) return false;

  try {
    const head = await fetchWithTimeout(audioUrl, {
      method: "HEAD",
      redirect: "follow",
      cache: "no-store"
    }, AUDIO_URL_VALIDATE_TIMEOUT_MS);
    if (isPlayableAudioResponse(head)) return true;
    if (isClearlyBadAudioResponse(head)) {
      void recordRuntimeEvent({
        step: "music.audioUrl.validate",
        status: "error",
        error: `bad_head_${head.status}`,
        context: { ...context, contentType: head.headers.get("content-type") ?? "" }
      });
      return false;
    }
  } catch {
    // Some music hosts reject HEAD. Fall through to a tiny range GET.
  }

  try {
    const ranged = await fetchWithTimeout(audioUrl, {
      method: "GET",
      headers: { Range: "bytes=0-1" },
      redirect: "follow",
      cache: "no-store"
    }, AUDIO_URL_VALIDATE_TIMEOUT_MS);
    const ok = isPlayableAudioResponse(ranged);
    if (!ok) {
      void recordRuntimeEvent({
        step: "music.audioUrl.validate",
        status: "error",
        error: `bad_range_${ranged.status}`,
        context: { ...context, contentType: ranged.headers.get("content-type") ?? "" }
      });
    }
    return ok;
  } catch (cause) {
    void recordRuntimeEvent({
      step: "music.audioUrl.validate",
      status: "error",
      error: cause instanceof Error ? cause.message : "audio_url_validate_failed",
      context
    });
    return false;
  }
}

function isPlayableAudioResponse(response: Response) {
  if (!(response.ok || response.status === 206)) return false;
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType) return true;
  if (contentType.startsWith("audio/")) return true;
  if (contentType.includes("application/octet-stream")) return true;
  if (contentType.includes("video/mp4")) return true;
  return false;
}

function isClearlyBadAudioResponse(response: Response) {
  if (response.status === 404 || response.status === 403 || response.status === 451) return true;
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  return contentType.includes("text/html") || contentType.includes("application/json") || contentType.includes("text/plain");
}
async function getCoverUrl(source: string, id: string): Promise<string | undefined> {
  const url = buildApiUrl({
    types: "pic",
    source,
    id,
    size: "300"
  });
  const response = await fetchWithTimeout(url, { cache: "no-store" }, MUSIC_TIMEOUT_MS);

  if (!response.ok) {
    return undefined;
  }

  const data = (await response.json()) as { url?: string };
  return data.url;
}

function formatArtist(artist: unknown): string {
  if (Array.isArray(artist)) {
    return artist
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (isRecord(item) && typeof item.name === "string") {
          return item.name;
        }

        return "";
      })
      .filter(Boolean)
      .join(" / ");
  }

  if (typeof artist === "string") {
    return artist;
  }

  return "Unknown Artist";
}

function normalizeCoverMatch(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}






