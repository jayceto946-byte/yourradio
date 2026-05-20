import { fetchWithTimeout } from "../../../lib/fetchWithTimeout";
import { buildLastfmQueryVariants } from "../../../lib/musicText/chineseVariants";
import type { SongFact } from "../dj/songFacts";

const LASTFM_API_URL = process.env.LASTFM_API_URL ?? "https://ws.audioscrobbler.com/2.0/";
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const DEFAULT_TIMEOUT_MS = 1600;

type LastfmTrackInfoInput = {
  rawTitle: string;
  speechTitle: string;
  rawArtist: string;
  displayArtist: string;
  timeoutMs?: number;
};

type LastfmTrackInfoOutput = {
  ok: boolean;
  facts: SongFact[];
  usedVariants: string[];
  latencyMs: number;
  listeners?: number;
  playcount?: number;
  error?: string;
};

type LastfmTrackInfoResponse = {
  track?: {
    name?: string;
    url?: string;
    listeners?: string;
    playcount?: string;
    artist?: { name?: string; url?: string };
    album?: { title?: string; url?: string };
    wiki?: { summary?: string; content?: string; published?: string };
    toptags?: { tag?: Array<{ name?: string }> | { name?: string } };
  };
};

export async function getLastfmTrackInfoFacts(input: LastfmTrackInfoInput): Promise<LastfmTrackInfoOutput> {
  const startedAt = performance.now();
  if (!LASTFM_API_KEY) {
    return { ok: false, facts: [], usedVariants: [], latencyMs: 0, error: "missing_lastfm_api_key" };
  }

  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const usedVariants: string[] = [];

  try {
    const queryInputs = [
      { title: input.speechTitle, artist: input.displayArtist },
      { title: input.rawTitle, artist: input.rawArtist }
    ];

    for (const query of queryInputs) {
      const variants = await buildLastfmQueryVariants(query);
      for (const variant of variants.slice(0, 2)) {
        const label = `${variant.title} - ${variant.artist}`;
        if (usedVariants.includes(label)) continue;
        usedVariants.push(label);

        const data = await requestTrackInfo(variant.title, variant.artist, controller.signal, timeoutMs).catch(() => null);
        const track = data?.track;
        if (!track) continue;

        const facts = normalizeLastfmTrackInfoToFacts(track);
        if (facts.length) {
          return {
            ok: true,
            facts,
            usedVariants,
            listeners: toNumber(track.listeners),
            playcount: toNumber(track.playcount),
            latencyMs: Math.round(performance.now() - startedAt)
          };
        }
      }
    }

    return { ok: true, facts: [], usedVariants, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (cause) {
    const error = cause instanceof Error && cause.name === "AbortError" ? "timeout" : cause instanceof Error ? cause.message : "lastfm_track_info_error";
    return { ok: false, facts: [], usedVariants, latencyMs: Math.round(performance.now() - startedAt), error };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestTrackInfo(track: string, artist: string, signal: AbortSignal, timeoutMs: number) {
  const url = new URL(LASTFM_API_URL);
  url.searchParams.set("method", "track.getInfo");
  url.searchParams.set("api_key", LASTFM_API_KEY ?? "");
  url.searchParams.set("format", "json");
  url.searchParams.set("track", track);
  url.searchParams.set("artist", artist);
  url.searchParams.set("autocorrect", "1");

  const response = await fetchWithTimeout(url, { cache: "no-store", signal }, timeoutMs);
  if (!response.ok) throw new Error(`lastfm_track_getInfo_${response.status}`);
  return await response.json() as LastfmTrackInfoResponse;
}

function normalizeLastfmTrackInfoToFacts(track: NonNullable<LastfmTrackInfoResponse["track"]>) {
  const facts: SongFact[] = [];
  const sourceName = "Last.fm track.getInfo";
  const sourceUrl = track.url;

  const album = cleanText(track.album?.title ?? "");
  if (album) {
    facts.push({ type: "album", text: limitFactText(`\u8d44\u6599\u8bb0\u5f55\u7684\u4e13\u8f91\u4fe1\u606f\u662f\u300a${album}\u300b\u3002`), sourceName, sourceUrl: track.album?.url ?? sourceUrl, confidence: 0.76 });
  }

  const wikiSummary = cleanLastfmWiki(track.wiki?.summary ?? "") || cleanLastfmWiki(track.wiki?.content ?? "");
  if (wikiSummary) {
    facts.push({ type: "background", text: limitFactText(wikiSummary), sourceName, sourceUrl, confidence: 0.74 });
  }

  const tags = asArray(track.toptags?.tag)
    .map((tag) => cleanText(tag.name ?? ""))
    .filter(Boolean)
    .filter((tag) => !/^seen live$/i.test(tag))
    .slice(0, 3);
  if (tags.length) {
    facts.push({ type: "metadata", text: limitFactText(`Last.fm 标签包括 ${tags.join("、")}。`), sourceName, sourceUrl, confidence: 0.66 });
  }

  return facts;
}

function cleanLastfmWiki(value: string) {
  return cleanText(value)
    .replace(/Read more on Last\.fm\.?/ig, "")
    .replace(/User-contributed text is available under.*$/ig, "")
    .replace(/<a\b[^>]*>.*?<\/a>/ig, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: string) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function limitFactText(value: string) {
  const text = value.replace(/。+$/g, "").trim();
  if (text.length <= 70) return `${text}。`;
  return `${text.slice(0, 68).replace(/[，,；;：:\s]+$/g, "")}。`;
}

function asArray<T>(value: T[] | T | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toNumber(value?: string) {
  const number = Number(value ?? "");
  return Number.isFinite(number) ? number : undefined;
}
export { getSimilarTracksWithVariants } from "../../../lib/discovery/lastfmProvider";
export { buildLastfmQueryVariants } from "../../../lib/musicText/chineseVariants";
export type { QueryVariant } from "../../../lib/musicText/chineseVariants";
