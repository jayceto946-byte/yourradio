import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { RankedCandidate } from "./recommender/rankCandidates";
import type { RecommendationSeed, SeedUsageEvent } from "./recommender/selectSeeds";
import type { TasteProfile } from "./taste";

const DB_PATH = path.join(process.cwd(), "data", "radio.sqlite");

export type DbStatus = {
  ready: boolean;
  path: string;
};

let db: Database.Database | null = null;

export function getDbStatus(): DbStatus {
  return {
    ready: true,
    path: DB_PATH
  };
}

export function initDb(): DbStatus {
  getDb();
  return getDbStatus();
}

export function saveRecommendationCandidates(runId: string, ranked: RankedCandidate[]) {
  const database = getDb();
  const insert = database.prepare(`
    INSERT INTO recommendation_candidates (
      run_id,
      playable_track_id,
      info_title,
      info_artist,
      info_album,
      source_providers_json,
      source_paths_json,
      raw_similarity_scores_json,
      seed_weights_json,
      match_confidence,
      score,
      score_features_json,
      weighted_score_json,
      explanation,
      raw_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  const tx = database.transaction((items: RankedCandidate[]) => {
    for (const item of items) {
      insert.run(
        runId,
        item.candidate.playableTrack.id,
        item.candidate.infoTrack.title,
        item.candidate.infoTrack.artist,
        item.candidate.infoTrack.album ?? null,
        JSON.stringify(item.candidate.providerNames),
        JSON.stringify(item.candidate.sourcePaths),
        JSON.stringify(item.candidate.similarityScores),
        JSON.stringify(item.candidate.seedWeights),
        item.candidate.matchConfidence,
        item.score.total,
        JSON.stringify(item.score.features),
        JSON.stringify(item.score.weighted),
        item.score.explanation,
        JSON.stringify(item.candidate),
        now
      );
    }
  });
  tx(ranked);
}


export function saveSeedUsageEvents(runId: string, seeds: RecommendationSeed[]) {
  const database = getDb();
  const insert = database.prepare(`
    INSERT INTO seed_usage_events (
      run_id,
      seed_type,
      seed_title,
      seed_artist,
      seed_album,
      seed_mbid,
      source,
      weight,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  const tx = database.transaction((items: RecommendationSeed[]) => {
    for (const seed of items) {
      insert.run(
        runId,
        seed.type,
        seed.type === "track" ? seed.title : null,
        seed.artist,
        seed.type === "album" ? seed.album : seed.type === "track" ? seed.album ?? null : null,
        seed.mbid ?? null,
        seed.source,
        seed.weight,
        now
      );
    }
  });
  tx(seeds);
}

export function listRecentSeedUsageEvents(limit = 20): SeedUsageEvent[] {
  const database = getDb();
  return database.prepare(`
    SELECT run_id, seed_type, seed_title, seed_artist, seed_album, seed_mbid, source, weight, created_at
    FROM seed_usage_events
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as SeedUsageEvent[];
}

export type SongResearchCacheEntry = {
  cache_key: string;
  raw_title: string;
  speech_title: string;
  raw_artist: string;
  display_artist: string;
  album?: string | null;
  facts_json: string;
  provider_names_json: string;
  searched: number;
  wiki_searched: number;
  errors_json?: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export function getSongResearchCache(cacheKey: string): SongResearchCacheEntry | null {
  const database = getDb();
  const row = database.prepare(`
    SELECT * FROM song_research_cache
    WHERE cache_key = ? AND expires_at > ?
  `).get(cacheKey, new Date().toISOString()) as SongResearchCacheEntry | undefined;
  return row ?? null;
}

export function listSongResearchCache(limit = 50): SongResearchCacheEntry[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM song_research_cache
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as SongResearchCacheEntry[];
}

export function saveSongResearchCache(input: {
  cacheKey: string;
  rawTitle: string;
  speechTitle: string;
  rawArtist: string;
  displayArtist: string;
  album?: string;
  facts: unknown[];
  providerNames: string[];
  searched: boolean;
  wikiSearched?: boolean;
  errors: string[];
  expiresAt: string;
}) {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO song_research_cache (
      cache_key, raw_title, speech_title, raw_artist, display_artist, album,
      facts_json, provider_names_json, searched, wiki_searched, errors_json, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      speech_title = excluded.speech_title,
      display_artist = excluded.display_artist,
      album = excluded.album,
      facts_json = excluded.facts_json,
      provider_names_json = excluded.provider_names_json,
      searched = excluded.searched,
      wiki_searched = excluded.wiki_searched,
      errors_json = excluded.errors_json,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(
    input.cacheKey,
    input.rawTitle,
    input.speechTitle,
    input.rawArtist,
    input.displayArtist,
    input.album ?? null,
    JSON.stringify(input.facts),
    JSON.stringify(input.providerNames),
    input.searched ? 1 : 0,
    input.wikiSearched ? 1 : 0,
    JSON.stringify(input.errors),
    input.expiresAt,
    now,
    now
  );
}
export function saveTasteProfile(profile: TasteProfile) {
  const database = getDb();
  database.prepare("INSERT INTO taste_profiles (profile_json, created_at) VALUES (?, ?)").run(JSON.stringify(profile), new Date().toISOString());
}

function getDb() {
  if (db) return db;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS recommendation_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      playable_track_id TEXT,
      info_title TEXT NOT NULL,
      info_artist TEXT NOT NULL,
      info_album TEXT,
      source_providers_json TEXT NOT NULL,
      source_paths_json TEXT NOT NULL,
      raw_similarity_scores_json TEXT,
      seed_weights_json TEXT,
      match_confidence REAL,
      score REAL,
      score_features_json TEXT,
      weighted_score_json TEXT,
      explanation TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS taste_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seed_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      seed_type TEXT NOT NULL,
      seed_title TEXT,
      seed_artist TEXT,
      seed_album TEXT,
      seed_mbid TEXT,
      source TEXT NOT NULL,
      weight REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS song_research_cache (
      cache_key TEXT PRIMARY KEY,
      raw_title TEXT NOT NULL,
      speech_title TEXT NOT NULL,
      raw_artist TEXT NOT NULL,
      display_artist TEXT NOT NULL,
      album TEXT,
      facts_json TEXT NOT NULL,
      provider_names_json TEXT NOT NULL,
      searched INTEGER NOT NULL,
      wiki_searched INTEGER NOT NULL DEFAULT 0,
      errors_json TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, "song_research_cache", "wiki_searched", "INTEGER NOT NULL DEFAULT 0");
  return db;
}

function ensureColumn(database: Database.Database, table: string, column: string, definition: string) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

