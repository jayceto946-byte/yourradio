import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AlbumCard, ArtistCard, DjScriptMemory, KnowledgeConfidence, TrackCard } from "./knowledgeTypes";
import { normalizeKnowledgeKey } from "./normalizeKnowledgeKey";

const KNOWLEDGE_DIR = path.join(process.cwd(), "data", "knowledge");
const ARTISTS_PATH = path.join(KNOWLEDGE_DIR, "artists.json");
const ALBUMS_PATH = path.join(KNOWLEDGE_DIR, "albums.json");
const TRACKS_PATH = path.join(KNOWLEDGE_DIR, "tracks.json");
const SCRIPTS_PATH = path.join(KNOWLEDGE_DIR, "dj-scripts.json");

type Collection<T> = Record<string, T>;

export async function getArtistCard(artist: string) {
  const cards = await readCollection<ArtistCard>(ARTISTS_PATH);
  return cards[artistKey(artist)] ?? null;
}

export async function getAlbumCard(artist: string, album?: string) {
  if (!album) return null;
  const cards = await readCollection<AlbumCard>(ALBUMS_PATH);
  return cards[albumKey(artist, album)] ?? null;
}

export async function getTrackCard(title: string, artist: string) {
  const cards = await readCollection<TrackCard>(TRACKS_PATH);
  return cards[trackKey(title, artist)] ?? null;
}

export async function getScriptMemory(title: string, artist: string, album?: string) {
  const cards = await readCollection<DjScriptMemory>(SCRIPTS_PATH);
  const normalizedTitle = normalizeKnowledgeKey(title);
  const normalizedArtist = normalizeKnowledgeKey(artist);
  const normalizedAlbum = normalizeKnowledgeKey(album);
  const exact = cards[scriptKey(title, artist, album)];
  if (exact && exact.userFeedback !== "bad") return exact;
  return Object.values(cards)
    .filter((item) => item.userFeedback !== "bad")
    .filter((item) => item.normalizedTitle === normalizedTitle && item.normalizedArtist === normalizedArtist)
    .filter((item) => !normalizedAlbum || !item.normalizedAlbum || item.normalizedAlbum === normalizedAlbum)
    .sort((a, b) => confidenceRank(scriptConfidence(b)) - confidenceRank(scriptConfidence(a)) || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export async function upsertArtistCard(card: ArtistCard) {
  const cards = await readCollection<ArtistCard>(ARTISTS_PATH);
  const key = artistKey(card.artist);
  cards[key] = mergeCard(cards[key], card);
  await writeCollection(ARTISTS_PATH, cards);
}

export async function upsertAlbumCard(card: AlbumCard) {
  const cards = await readCollection<AlbumCard>(ALBUMS_PATH);
  const key = albumKey(card.artist, card.album);
  cards[key] = mergeCard(cards[key], card);
  await writeCollection(ALBUMS_PATH, cards);
}

export async function upsertTrackCard(card: TrackCard) {
  const cards = await readCollection<TrackCard>(TRACKS_PATH);
  const key = trackKey(card.title, card.artist);
  cards[key] = mergeCard(cards[key], card);
  await writeCollection(TRACKS_PATH, cards);
}

export async function saveDjScriptMemory(memory: Omit<DjScriptMemory, "id" | "normalizedTitle" | "normalizedArtist" | "normalizedAlbum" | "createdAt" | "updatedAt"> & { userFeedback?: "good" | "neutral" | "bad" }) {
  const cards = await readCollection<DjScriptMemory>(SCRIPTS_PATH);
  const now = new Date().toISOString();
  const key = scriptKey(memory.trackTitle, memory.artist, memory.album);
  const existing = cards[key];
  cards[key] = {
    id: key,
    trackTitle: memory.trackTitle,
    normalizedTitle: normalizeKnowledgeKey(memory.trackTitle),
    artist: memory.artist,
    normalizedArtist: normalizeKnowledgeKey(memory.artist),
    album: memory.album,
    normalizedAlbum: normalizeKnowledgeKey(memory.album),
    script: memory.script,
    mode: memory.mode,
    userFeedback: memory.userFeedback ?? existing?.userFeedback ?? "neutral",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await writeCollection(SCRIPTS_PATH, cards);
}

export function trackKey(title: string, artist: string) {
  return `${normalizeKnowledgeKey(artist)}::${normalizeKnowledgeKey(title)}`;
}

export function albumKey(artist: string, album: string) {
  return `${normalizeKnowledgeKey(artist)}::${normalizeKnowledgeKey(album)}`;
}

export function artistKey(artist: string) {
  return normalizeKnowledgeKey(artist);
}

async function readCollection<T>(filePath: string): Promise<Collection<T>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Collection<T> : {};
  } catch {
    return {};
  }
}

async function writeCollection<T>(filePath: string, value: Collection<T>) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mergeCard<T extends { updatedAt: string; createdAt: string; confidence: KnowledgeConfidence }>(existing: T | undefined, next: T): T {
  if (!existing) return next;
  const keepExisting = confidenceRank(existing.confidence) > confidenceRank(next.confidence);
  return {
    ...existing,
    ...next,
    confidence: keepExisting ? existing.confidence : next.confidence,
    createdAt: existing.createdAt,
    updatedAt: next.updatedAt
  };
}

function scriptKey(title: string, artist: string, album?: string) {
  return `${trackKey(title, artist)}::${normalizeKnowledgeKey(album)}`;
}

function scriptConfidence(memory: DjScriptMemory): KnowledgeConfidence {
  if (memory.userFeedback === "good") return "high";
  if (memory.userFeedback === "bad") return "none";
  return "medium";
}

function confidenceRank(confidence: KnowledgeConfidence) {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  if (confidence === "low") return 1;
  return 0;
}