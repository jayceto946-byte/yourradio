import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FeedbackAction, RadioNextResponse, RadioState } from "./types";

export const LIKED_SONGS_PATH = path.join(process.cwd(), "user", "liked-songs.json");

const LIKED_SONGS_LIMIT = 500;

export type LikedSongEntry = {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  likedAt: string;
  feedbackAction: Extract<FeedbackAction, "like" | "like_style">;
};

export async function recordLikedSong(input: {
  item: RadioNextResponse;
  action: Extract<FeedbackAction, "like" | "like_style">;
  state: RadioState;
}) {
  const existing = await loadLikedSongs();
  const backfilled = backfillLikedSongsFromState(input.state);
  const current = toLikedSongEntry(input.item, input.action);
  const merged = dedupeLikedSongs([current, ...existing, ...backfilled]).slice(0, LIKED_SONGS_LIMIT);

  await mkdir(path.dirname(LIKED_SONGS_PATH), { recursive: true });
  await writeFile(LIKED_SONGS_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

export async function loadLikedSongs(): Promise<LikedSongEntry[]> {
  try {
    const content = await readFile(LIKED_SONGS_PATH, "utf8");
    const data = JSON.parse(stripBom(content)) as unknown;
    if (!Array.isArray(data)) return [];
    return data.map(normalizeLikedSongEntry).filter(Boolean) as LikedSongEntry[];
  } catch {
    return [];
  }
}

function backfillLikedSongsFromState(state: RadioState) {
  const likedKeys = new Set(state.likedTracks);
  return [...state.playHistory]
    .reverse()
    .filter((entry) => likedKeys.has(getTrackKey(entry.id, entry.title, entry.artist)))
    .map((entry) => ({
      trackId: entry.id,
      title: entry.title,
      artist: entry.artist,
      album: entry.album,
      durationSeconds: 0,
      likedAt: entry.playedAt,
      feedbackAction: "like_style" as const
    }));
}

function toLikedSongEntry(item: RadioNextResponse, action: Extract<FeedbackAction, "like" | "like_style">): LikedSongEntry {
  return {
    trackId: item.track.id,
    title: item.track.title,
    artist: item.track.artist,
    album: item.track.album,
    durationSeconds: item.track.durationSec,
    likedAt: new Date().toISOString(),
    feedbackAction: action
  };
}

function dedupeLikedSongs(entries: LikedSongEntry[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = getTrackKey(entry.trackId, entry.title, entry.artist);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeLikedSongEntry(value: unknown): LikedSongEntry | undefined {
  if (!isRecord(value)) return undefined;
  const trackId = toText(value.trackId);
  const title = toText(value.title);
  const artist = toText(value.artist);
  if (!trackId || !title || !artist) return undefined;

  return {
    trackId,
    title,
    artist,
    album: toText(value.album),
    durationSeconds: typeof value.durationSeconds === "number" ? value.durationSeconds : 0,
    likedAt: toText(value.likedAt) || new Date(0).toISOString(),
    feedbackAction: value.feedbackAction === "like" ? "like" : "like_style"
  };
}

function getTrackKey(id: string, title: string, artist: string) {
  return [id, title, artist].map((part) => part.trim().toLowerCase()).join("::");
}

function stripBom(content: string) {
  return content.replace(/^\uFEFF/, "");
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
