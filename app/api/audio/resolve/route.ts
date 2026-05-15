import { getProviderOrder, searchSongsByProvider } from "@/lib/music";
import { recordRuntimeEvent } from "@/lib/runtimeLog";
import type { Song } from "@/lib/types";
import { NextResponse } from "next/server";

const SEARCH_LIMIT = 5;

export async function POST(request: Request) {
  const startedAt = performance.now();
  let body: { title?: string; artist?: string; album?: string; excludeProviders?: string[]; failedAudioUrl?: string } = {};
  try {
    body = await request.json();
    const title = String(body.title ?? "").trim();
    const artist = String(body.artist ?? "").trim();
    const album = String(body.album ?? "").trim();
    const excludeProviders = new Set((body.excludeProviders ?? []).map((item) => String(item).toLowerCase()).filter(Boolean));

    if (!title || !artist) {
      return NextResponse.json({ ok: false, message: "title and artist are required" }, { status: 400 });
    }

    const providerOrder = prioritizeFallbackProviders(getProviderOrder(), excludeProviders);
    const queries = unique([`${title} ${artist}`, `${artist} ${title}`, title]);
    const tried: string[] = [];
    const candidates: Array<{ song: Song; provider: string; score: number }> = [];

    for (const provider of providerOrder) {
      tried.push(provider);
      for (const keyword of queries) {
        const songs = await searchSongsByProvider(provider, { keyword, limit: SEARCH_LIMIT }).catch(() => []);
        for (const song of songs) {
          if (!song.audioUrl || song.audioUrl === body.failedAudioUrl) continue;
          const score = scoreAudioFallback(song, { title, artist, album });
          if (score >= 35) candidates.push({ song, provider, score });
        }
        if (candidates.some((entry) => entry.provider === provider && entry.score >= 75)) break;
      }
      if (candidates.some((entry) => entry.provider === provider && entry.score >= 75)) break;
    }

    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates[0];
    if (!selected) {
      void recordRuntimeEvent({ step: "audio.resolveFallback", status: "error", durationMs: Math.round(performance.now() - startedAt), error: "no_playable_alternate", context: { title, artist, tried } });
      return NextResponse.json({ ok: false, message: "No playable alternate source found", providerTried: tried, candidates: candidates.slice(0, 5).map((entry) => ({ title: entry.song.title, artist: entry.song.artist, provider: entry.provider, score: entry.score })) });
    }

    void recordRuntimeEvent({ step: "audio.resolveFallback", status: "success", durationMs: Math.round(performance.now() - startedAt), context: { title, artist, selectedProvider: selected.provider, score: selected.score, tried } });
    return NextResponse.json({
      ok: true,
      providerTried: tried,
      selectedProvider: selected.provider,
      track: {
        id: selected.song.id,
        title: selected.song.title,
        artist: selected.song.artist,
        album: selected.song.album,
        durationSec: selected.song.durationSeconds,
        coverUrl: selected.song.coverUrl ?? "",
        audioUrl: selected.song.audioUrl
      }
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "resolve audio failed";
    void recordRuntimeEvent({ step: "audio.resolveFallback", status: "error", durationMs: Math.round(performance.now() - startedAt), error: message, context: body });
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

function prioritizeFallbackProviders(providers: string[], excludeProviders: Set<string>) {
  const preferred = ["spotify", "tencent", "apple", "netease"];
  return unique([...providers, ...preferred]).filter((provider) => !excludeProviders.has(provider));
}

function scoreAudioFallback(song: Song, target: { title: string; artist: string; album?: string }) {
  let score = 0;
  const title = normalize(song.title);
  const targetTitle = normalize(target.title);
  const artist = normalize(song.artist);
  const targetArtist = normalize(target.artist);
  if (title === targetTitle) score += 55;
  else if (title.includes(targetTitle) || targetTitle.includes(title)) score += 38;
  if (artist === targetArtist) score += 35;
  else if (artist.includes(targetArtist) || targetArtist.includes(artist)) score += 22;
  if (target.album && normalize(song.album) === normalize(target.album)) score += 8;
  if (isBadVersion(song)) score -= 45;
  return score;
}

function isBadVersion(song: Song) {
  return /karaoke|ktv|伴奏|instrumental|tribute|cover|翻唱|remix|slowed|sped up|nightcore|\blive\b|现场|演唱会|concert/i.test(`${song.title} ${song.album} ${song.artist}`);
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

