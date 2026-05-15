import { readFile } from "node:fs/promises";
import type { PlaylistSong, RadioState } from "./types";
import { hasSearchablePlaylistText, normalizePlaylistSong, PLAYLIST_PATH } from "./playlistImport";

export async function loadImportedPlaylist(): Promise<PlaylistSong[]> {
  try {
    const content = await readFile(PLAYLIST_PATH, "utf8");
    const data = JSON.parse(stripBom(content)) as unknown;
    if (!Array.isArray(data)) return [];
    return data.map(normalizePlaylistSong).filter(hasSearchablePlaylistText);
  } catch {
    return [];
  }
}

export function pickPlaylistSeed(playlist: PlaylistSong[], state: RadioState) {
  if (playlist.length === 0) return undefined;
  return weightedPick(playlist, (song) => getSeedWeight(song, state));
}

export function buildSeedSearchQuery(seed: PlaylistSong) {
  return [seed.title, seed.artist].filter(Boolean).join(" ").trim();
}

function getSeedWeight(seed: PlaylistSong, state: RadioState) {
  const artistWeight = state.artistWeights[seed.artist.toLowerCase()] ?? 0;
  const titleWeight = state.keywordWeights[seed.title.toLowerCase()] ?? 0;
  const albumWeight = state.keywordWeights[seed.album.toLowerCase()] ?? 0;
  return Math.max(0.2, 8 + artistWeight * 1.5 + titleWeight + albumWeight * 0.5 + Math.random() * 3);
}

function weightedPick<T>(items: T[], weightFor: (item: T) => number) {
  const weighted = items.map((item) => ({ item, weight: Math.max(0.01, weightFor(item)) }));
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let marker = Math.random() * total;

  for (const entry of weighted) {
    marker -= entry.weight;
    if (marker <= 0) return entry.item;
  }
  return weighted[weighted.length - 1]?.item;
}

function stripBom(content: string) {
  return content.replace(/^\uFEFF/, "");
}
