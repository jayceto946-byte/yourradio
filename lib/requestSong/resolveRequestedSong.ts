import { getProviderOrder, searchSongsByProvider } from "../music";
import { filterTrackVersion } from "../recommender/filterTrackVersions";
import type { MusicProviderName, Song } from "../types";
import { buildSongRequestKeywords, normalizeRequestKeyword, parseSongRequestText, type ParsedSongRequest } from "./parseSongRequest";

export type RequestedSongCandidate = {
  song: Song;
  provider: string;
  keyword: string;
  score: number;
  rejectedReasons: string[];
};

export type ResolveRequestedSongResult = {
  parsed: ParsedSongRequest;
  selected: RequestedSongCandidate;
  candidates: RequestedSongCandidate[];
  providerTried: string[];
  keywords: string[];
};

const SEARCH_LIMIT = 6;
const MIN_SCORE = 54;

export async function resolveRequestedSong(text: string): Promise<ResolveRequestedSongResult> {
  const parsed = parseSongRequestText(text);
  if (!parsed) throw new Error("empty_request");

  const keywords = buildSongRequestKeywords(parsed);
  const providerTried: string[] = [];
  const candidates: RequestedSongCandidate[] = [];

  for (const provider of getProviderOrder()) {
    providerTried.push(provider);
    for (const keyword of keywords) {
      const songs = await searchSongsByProvider(provider as MusicProviderName, { keyword, limit: SEARCH_LIMIT }).catch(() => []);
      for (let index = 0; index < songs.length; index += 1) {
        const scored = scoreRequestedSongCandidate(songs[index], parsed, provider, keyword, index);
        if (scored.score >= MIN_SCORE) candidates.push(scored);
      }
      if (candidates.some((candidate) => candidate.provider === provider && candidate.score >= 86)) break;
    }
    if (candidates.some((candidate) => candidate.provider === provider && candidate.score >= 86)) break;
  }

  const deduped = dedupeCandidates(candidates).sort((a, b) => b.score - a.score);
  const selected = deduped.find((candidate) => !candidate.rejectedReasons.includes("bad_version")) ?? deduped[0];
  if (!selected) throw new Error("no_playable_requested_song");

  return { parsed, selected, candidates: deduped.slice(0, 12), providerTried, keywords };
}

export function scoreRequestedSongCandidate(song: Song, parsed: ParsedSongRequest, provider: string, keyword: string, searchIndex = 0): RequestedSongCandidate {
  const rejectedReasons: string[] = [];
  const query = parsed.normalizedKeyword;
  const queryTokens = query.split(" ").filter(Boolean);
  const title = normalizeRequestKeyword(song.title);
  const artist = normalizeRequestKeyword(song.artist);
  const album = normalizeRequestKeyword(song.album);
  const joined = `${title} ${artist}`.trim();
  const reverse = `${artist} ${title}`.trim();
  const full = `${title} ${artist} ${album}`.trim();

  let score = 30 - searchIndex * 2;
  if (joined === query || reverse === query) score += 58;
  else if (queryTokens.length && queryTokens.every((token) => full.includes(token))) score += 42;
  else if (title && query.includes(title) && artist && query.includes(artist)) score += 46;
  else if (title && query.includes(title)) score += 22;

  if (artist && query.includes(artist)) score += 22;
  if (provider === "netease") score += 2;
  if (!song.audioUrl) {
    score -= 100;
    rejectedReasons.push("not_playable");
  }

  const version = filterTrackVersion({ title: song.title, artist: song.artist, album: song.album });
  if (!version.allowed) {
    score -= 70;
    rejectedReasons.push("bad_version", ...version.reasons);
  } else if (version.penalty > 0) {
    score -= Math.round(version.penalty * 30);
    rejectedReasons.push(...version.reasons);
  }

  return { song, provider, keyword, score: Math.round(score), rejectedReasons };
}

function dedupeCandidates(candidates: RequestedSongCandidate[]) {
  const byKey = new Map<string, RequestedSongCandidate>();
  for (const candidate of candidates) {
    const key = `${normalizeRequestKeyword(candidate.song.title)}::${normalizeRequestKeyword(candidate.song.artist)}`;
    const existing = byKey.get(key);
    if (!existing || candidate.score > existing.score) byKey.set(key, candidate);
  }
  return [...byKey.values()];
}
