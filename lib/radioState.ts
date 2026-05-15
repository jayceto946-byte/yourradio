import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FeedbackAction, RadioNextResponse, RadioState } from "./types";
import { updateTasteProfileFromFeedback } from "./recommender/updateTasteProfileFromFeedback";
import { DEFAULT_SOURCE_PATH_TRUST } from "./taste";

const STATE_PATH = path.join(process.cwd(), "data", "radio-state.json");
const RECENT_LIMIT = 50;
const LIST_LIMIT = 120;

const defaultState: RadioState = {
  recentTracks: [],
  skippedTracks: [],
  likedTracks: [],
  artistWeights: {},
  keywordWeights: {},
  tagWeights: {},
  albumWeights: {},
  sourcePathWeights: {},
  sourcePathTrust: DEFAULT_SOURCE_PATH_TRUST,
  styleSeedCandidates: [],
  tasteProfileDirty: false,
  lastFeedbackEvents: [],
  shortTerm: { artistWeights: {}, tagWeights: {}, skippedArtists: {}, skippedTags: {} },
  adaptive: { exploration: 0.35, weights: {} },
  recentDjLines: [],
  searchStrategyHistory: [],
  playHistory: []
};

export async function loadRadioState(): Promise<RadioState> {
  try {
    const content = await readFile(STATE_PATH, "utf8");
    const data = JSON.parse(stripBom(content)) as Partial<RadioState>;

    return {
      recentTracks: Array.isArray(data.recentTracks) ? data.recentTracks.slice(0, RECENT_LIMIT) : [],
      skippedTracks: Array.isArray(data.skippedTracks) ? data.skippedTracks : [],
      likedTracks: Array.isArray(data.likedTracks) ? data.likedTracks : [],
      recentDjLines: Array.isArray(data.recentDjLines) ? data.recentDjLines.slice(0, 10) : [],
      searchStrategyHistory: Array.isArray(data.searchStrategyHistory) ? data.searchStrategyHistory.slice(0, 10) : [],
      artistWeights: isRecord(data.artistWeights) ? toNumberMap(data.artistWeights) : {},
      keywordWeights: isRecord(data.keywordWeights) ? toNumberMap(data.keywordWeights) : {},
      tagWeights: isRecord(data.tagWeights) ? toNumberMap(data.tagWeights) : {},
      albumWeights: isRecord(data.albumWeights) ? toNumberMap(data.albumWeights) : {},
      sourcePathWeights: isRecord(data.sourcePathWeights) ? toNumberMap(data.sourcePathWeights) : {},
      sourcePathTrust: isRecord(data.sourcePathTrust) ? { ...DEFAULT_SOURCE_PATH_TRUST, ...toNumberMap(data.sourcePathTrust) } : DEFAULT_SOURCE_PATH_TRUST,
      styleSeedCandidates: Array.isArray(data.styleSeedCandidates) ? data.styleSeedCandidates.slice(0, 80) as RadioState["styleSeedCandidates"] : [],
      tasteProfileDirty: Boolean(data.tasteProfileDirty),
      lastFeedbackEvents: Array.isArray(data.lastFeedbackEvents) ? data.lastFeedbackEvents.slice(0, 30) as RadioState["lastFeedbackEvents"] : [],
      shortTerm: isRecord(data.shortTerm) ? normalizeShortTerm(data.shortTerm) : { artistWeights: {}, tagWeights: {}, skippedArtists: {}, skippedTags: {} },
      adaptive: isRecord(data.adaptive) ? normalizeAdaptive(data.adaptive) : { exploration: 0.35, weights: {} },
      playHistory: Array.isArray(data.playHistory) ? data.playHistory.slice(-LIST_LIMIT) as RadioState["playHistory"] : []
    };
  } catch {
    return defaultState;
  }
}

export async function saveRadioState(state: RadioState) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function recordPlay(item: RadioNextResponse) {
  const state = await loadRadioState();
  const key = getTrackKey(item.track.id, item.track.title, item.track.artist);
  state.recentTracks = unique([key, ...state.recentTracks]).slice(0, RECENT_LIMIT);
  state.searchStrategyHistory = unique([item.searchStrategy ?? "tasteExpansion", ...(state.searchStrategyHistory ?? [])]).slice(0, 10) as RadioState["searchStrategyHistory"];
  state.playHistory = [
    ...state.playHistory,
    {
      id: item.track.id,
      title: item.track.title,
      artist: item.track.artist,
      album: item.track.album,
      searchQuery: item.searchQuery,
      sourceSeed: item.sourceSeed,
      playedAt: new Date().toISOString(),
      tags: item.tasteKeywordsUsed ?? [],
      sourcePaths: item.rankerSourcePaths ?? []
    }
  ].slice(-LIST_LIMIT);
  await saveRadioState(state);
}

export async function recordFeedback(action: FeedbackAction, item: RadioNextResponse) {
  const state = await loadRadioState();
  const key = getTrackKey(item.track.id, item.track.title, item.track.artist);

  if (action === "skip") {
    state.skippedTracks = unique([key, ...state.skippedTracks]).slice(0, LIST_LIMIT);
    state.recentTracks = state.recentTracks.filter((trackKey) => trackKey !== key);
    adjustWeight(state.keywordWeights, item.searchQuery, -1.2, 3);
    adjustWeight(state.keywordWeights, item.sourceSeed.title, -0.6, 3);
    updateTasteProfileFromFeedback({ state, item, event: "skip", skippedBeforeMs: 30000 });
  }

  if (action === "like" || action === "like_style") {
    state.likedTracks = unique([key, ...state.likedTracks]).slice(0, LIST_LIMIT);
    adjustWeight(state.keywordWeights, item.searchQuery, 0.8, 3);
    adjustWeight(state.keywordWeights, item.sourceSeed.title, 0.45, 3);
    updateTasteProfileFromFeedback({ state, item, event: action });
  }

  state.lastFeedbackEvents = [{ action, trackId: item.track.id, title: item.track.title, artist: item.track.artist, createdAt: new Date().toISOString() }, ...(state.lastFeedbackEvents ?? [])].slice(0, 30);
  await saveRadioState(state);
  return state;
}


export async function recordDjLine(line: string) {
  const state = await loadRadioState();
  const text = line.trim();
  if (!text) {
    return state;
  }

  state.recentDjLines = unique([text, ...(state.recentDjLines ?? [])]).slice(0, 10);
  await saveRadioState(state);
  return state;
}
export function getTrackKey(id: string, title: string, artist: string) {
  return [id, title, artist].map((part) => part.trim().toLowerCase()).join("::");
}

function adjustWeight(map: Record<string, number>, rawKey: string, delta: number, cap: number) {
  const key = rawKey.trim().toLowerCase();
  if (!key) {
    return;
  }

  map[key] = Math.max(-cap, Math.min(cap, (map[key] ?? 0) + delta));
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function toNumberMap(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, typeof entry === "number" ? entry : 0])
  );
}

function stripBom(content: string) {
  return content.replace(/^\uFEFF/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


function normalizeShortTerm(value: Record<string, unknown>) {
  return {
    artistWeights: isRecord(value.artistWeights) ? toNumberMap(value.artistWeights) : {},
    tagWeights: isRecord(value.tagWeights) ? toNumberMap(value.tagWeights) : {},
    skippedArtists: isRecord(value.skippedArtists) ? toNumberMap(value.skippedArtists) : {},
    skippedTags: isRecord(value.skippedTags) ? toNumberMap(value.skippedTags) : {}
  };
}

function normalizeAdaptive(value: Record<string, unknown>) {
  return {
    exploration: typeof value.exploration === "number" ? Math.max(0.1, Math.min(0.7, value.exploration)) : 0.35,
    weights: isRecord(value.weights) ? toNumberMap(value.weights) : {}
  };
}


