import { fetchWithTimeout } from "../fetchWithTimeout";
import { buildLastfmQueryVariants, type QueryVariant } from "../musicText/chineseVariants";
import { normalizeForCandidateKey } from "../musicText/normalizeMusicText";
import type { DiscoveryCandidate, DiscoveryPlan, GenerateDiscoveryPlanInput } from "./types";

const LASTFM_API_URL = process.env.LASTFM_API_URL ?? "https://ws.audioscrobbler.com/2.0/";
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_TIMEOUT_MS = 4500;
const MAX_CANDIDATES = 10;
const MAX_TAG_ENRICHMENT_CANDIDATES = 4;

const defaultAvoidKeywords = ["karaoke", "KTV", "instrumental", "cover", "live", "remix", "tribute"];

type LastFmTrack = {
  name?: string;
  mbid?: string;
  artist?: string | { name?: string; mbid?: string };
  match?: string;
};

type LastFmArtist = {
  name?: string;
  match?: string;
};

type LastFmTag = {
  name?: string;
};

export async function generateLastFmDiscoveryPlan(input: GenerateDiscoveryPlanInput): Promise<DiscoveryPlan | null> {
  if (!LASTFM_API_KEY) return null;

  const seed = toSeed(input);
  if (!seed.title && !seed.artist) return null;

  const candidateGroups = await expandSeedByEntity(seed).catch(() => [] as DiscoveryCandidate[][]);

  let candidateSongs = mergeExpandedCandidates(candidateGroups.flat()).slice(0, MAX_CANDIDATES);
  if (candidateSongs.length === 0 && seed.title && seed.artist) {
    candidateSongs = (await getFallbackTagTopTracks(seed.title, seed.artist)).slice(0, MAX_CANDIDATES);
  }
  if (candidateSongs.length === 0) return null;

  const tags = unique(candidateSongs.flatMap((candidate) => candidate.tags ?? [])).slice(0, 8);
  const similarSongQueries = unique([
    seed.title && seed.artist ? `${seed.title} ${seed.artist} similar tracks` : "",
    ...candidateSongs.slice(0, 5).map((candidate) => `${candidate.title} ${candidate.artist}`)
  ]).slice(0, 8);
  const similarArtistQueries = unique([
    seed.artist ? `${seed.artist} similar artists` : "",
    ...candidateSongs.slice(0, 8).map((candidate) => candidate.artist)
  ]).slice(0, 8);

  return {
    seed,
    searchIntent: `Use Last.fm entity graph from ${seed.artist || seed.title}: track.getSimilar, artist.getSimilar, artist.getTopTracks and album.getInfo. Tags are metadata only.`, 
    similarSongQueries,
    similarArtistQueries,
    candidateSongs,
    avoidKeywords: unique([...defaultAvoidKeywords, ...input.tasteProfile.avoidKeywords]),
    reason: "Last.fm is the music-information provider. Chinese titles/artists are queried with simplified, traditional, Hong Kong traditional, Taiwan traditional and artist alias variants; final tracks still require playable-provider verification.",
    source: "lastfm"
  };
}


async function expandSeedByEntity(seed: { title: string; artist: string; album: string }) {
  if (seed.title && seed.artist) {
    const similarTracks = await getSimilarTracks(seed.title, seed.artist);
    if (similarTracks.length > 0) return [similarTracks];

    const fallbackGroups = await Promise.all([
      getArtistTopTracks(seed.artist, "fallback artist top track after empty track.getSimilar"),
      seed.album ? getAlbumTracks(seed.album, seed.artist) : Promise.resolve([])
    ]);
    return fallbackGroups;
  }

  if (seed.album && seed.artist) {
    const albumTracks = await getAlbumTracks(seed.album, seed.artist);
    if (albumTracks.length > 0) return [albumTracks];
    return [await getArtistTopTracks(seed.artist, "fallback artist top track after empty album.getInfo")];
  }

  if (seed.artist) {
    const similarArtistTracks = await getSimilarArtistTopTracks(seed.artist);
    if (similarArtistTracks.length > 0) return [similarArtistTracks];
    return [await getArtistTopTracks(seed.artist, "fallback seed artist top track")];
  }

  return [];
}
export async function getSimilarTracksWithVariants(title: string, artist: string) {
  const variants = await buildLastfmQueryVariants({ title, artist });
  const providerResults: Array<{ variant: QueryVariant; results: DiscoveryCandidate[] }> = [];

  for (const variant of variants.slice(0, 2)) {
    const data = await lastFmRequest("track.getSimilar", {
      track: variant.title,
      artist: variant.artist,
      limit: "8",
      autocorrect: "1"
    }).catch(() => null);
    const tracks = asArray(getNested(data, ["similartracks", "track"])) as LastFmTrack[];
    const results = tracks
      .map((track) => toCandidate(track, "similar track", { title, artist }, [], "lastfm:similar_track", variant, data))
      .filter(Boolean) as DiscoveryCandidate[];
    providerResults.push({ variant, results });
  }

  const mergedResults = await enrichCandidateTags(
    mergeExpandedCandidates(providerResults.flatMap((entry) => entry.results))
  );

  return {
    variants,
    providerResults,
    mergedResults
  };
}

async function getSimilarTracks(title: string, artist: string): Promise<DiscoveryCandidate[]> {
  return (await getSimilarTracksWithVariants(title, artist)).mergedResults;
}

export async function getArtistTopTracks(artist: string, reason: string): Promise<DiscoveryCandidate[]> {
  const variants = await buildLastfmQueryVariants({ title: "_artist_", artist });
  const all: DiscoveryCandidate[] = [];
  for (const variant of variants.slice(0, 2)) {
    const data = await lastFmRequest("artist.getTopTracks", { artist: variant.artist, limit: "4", autocorrect: "1" }).catch(() => null);
    const tracks = asArray(getNested(data, ["toptracks", "track"])) as LastFmTrack[];
    const sourcePath = reason.includes("similar artist") ? "lastfm:similar_artist:top_track" : "lastfm:artist_top_track";
    all.push(...tracks.map((track) => toCandidate(track, reason, { artist }, [], sourcePath, variant, data)).filter(Boolean) as DiscoveryCandidate[]);
  }
  return enrichCandidateTags(mergeExpandedCandidates(all));
}

export async function getSimilarArtistTopTracks(artist: string): Promise<DiscoveryCandidate[]> {
  const variants = await buildLastfmQueryVariants({ title: "_artist_", artist });
  const similarArtists: Array<{ name: string; match: number; variant: QueryVariant }> = [];
  for (const variant of variants.slice(0, 2)) {
    const data = await lastFmRequest("artist.getSimilar", { artist: variant.artist, limit: "4", autocorrect: "1" }).catch(() => null);
    const artists = asArray(getNested(data, ["similarartists", "artist"])) as LastFmArtist[];
    similarArtists.push(...artists.map((item) => ({ name: clean(item.name), match: Number(item.match ?? 0) * variant.weight, variant })).filter((item) => item.name));
  }
  const topTrackGroups = await Promise.all(
    similarArtists
      .sort((a, b) => b.match - a.match)
      .slice(0, 2)
      .map((item) => getArtistTopTracks(item.name, `top track from Last.fm similar artist of ${artist}`))
  );
  return enrichCandidateTags(mergeExpandedCandidates(topTrackGroups.flat()));
}

export async function getAlbumTracks(album: string, artist: string): Promise<DiscoveryCandidate[]> {
  const variants = await buildLastfmQueryVariants({ title: album, artist });
  const all: DiscoveryCandidate[] = [];
  for (const variant of variants.slice(0, 2)) {
    const data = await lastFmRequest("album.getInfo", { album: variant.title, artist: variant.artist, autocorrect: "1" }).catch(() => null);
    const tracks = asArray(getNested(data, ["album", "tracks", "track"])) as LastFmTrack[];
    all.push(...tracks.map((track) => toCandidate({ ...track, artist: track.artist ?? artist }, "album track from Last.fm album.getInfo", { artist, album }, [], "lastfm:album_track", variant, data)).filter(Boolean) as DiscoveryCandidate[]);
  }
  return enrichCandidateTags(mergeExpandedCandidates(all));
}

async function getFallbackTagTopTracks(title: string, artist: string) {
  const tags = await getTrackTags(title, artist);
  return getTagTopTracks(tags.slice(0, 3), { title, artist });
}

async function getTrackTags(title: string, artist: string) {
  const variants = await buildLastfmQueryVariants({ title, artist });
  const tags: string[] = [];
  for (const variant of variants.slice(0, 1)) {
    const data = await lastFmRequest("track.getTopTags", { track: variant.title, artist: variant.artist, autocorrect: "1" }).catch(() => null);
    const variantTags = asArray(getNested(data, ["toptags", "tag"])) as LastFmTag[];
    tags.push(...variantTags.map((tag) => clean(tag.name)).filter(Boolean));
  }
  return unique(tags);
}

async function getTagTopTracks(tags: string[], seed: DiscoveryCandidate["seed"]): Promise<DiscoveryCandidate[]> {
  const groups = await Promise.all(
    unique(tags).slice(0, 2).map(async (tag) => {
      const data = await lastFmRequest("tag.getTopTracks", { tag, limit: "4", autocorrect: "1" }).catch(() => null);
      const tracks = asArray(getNested(data, ["tracks", "track"])) as LastFmTrack[];
      const variant: QueryVariant = { title: tag, artist: tag, variantType: "normalized", weight: 1 };
      return tracks
        .map((track) => toCandidate(track, `top track for Last.fm tag ${tag}`, seed, [tag], "fallback:lastfm:tag_top_track", variant, data))
        .filter(Boolean) as DiscoveryCandidate[];
    })
  );
  return mergeExpandedCandidates(groups.flat());
}


async function enrichCandidateTags(candidates: DiscoveryCandidate[]): Promise<DiscoveryCandidate[]> {
  const targets = candidates.slice(0, MAX_TAG_ENRICHMENT_CANDIDATES);
  const enrichedTags = await Promise.all(
    targets.map((candidate) => getTrackTags(candidate.title, candidate.artist).catch(() => [] as string[]))
  );
  const tagByKey = new Map(targets.map((candidate, index) => [candidateKey(candidate), enrichedTags[index]]));
  return candidates.map((candidate) => {
    const tags = tagByKey.get(candidateKey(candidate));
    if (!tags?.length) return candidate;
    return { ...candidate, tags: unique([...(candidate.tags ?? []), ...tags]) };
  });
}
async function lastFmRequest(method: string, params: Record<string, string>) {
  const url = new URL(LASTFM_API_URL);
  url.searchParams.set("method", method);
  url.searchParams.set("api_key", LASTFM_API_KEY ?? "");
  url.searchParams.set("format", "json");
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetchWithTimeout(url, { cache: "no-store" }, LASTFM_TIMEOUT_MS);
  if (!response.ok) throw new Error(`lastfm_${method}_${response.status}`);
  return response.json();
}

function toCandidate(track: LastFmTrack, reason: string, seed: DiscoveryCandidate["seed"], tags: string[] = [], sourcePath = "lastfm:similar_track", queryVariant?: QueryVariant, raw?: unknown): DiscoveryCandidate | null {
  const title = clean(track.name);
  const artist = clean(typeof track.artist === "string" ? track.artist : track.artist?.name);
  if (!title || !artist) return null;

  const match = Number(track.match ?? 0) || 0.3;
  const variantWeight = queryVariant?.weight ?? 1;
  return {
    title,
    artist,
    source: "lastfm",
    confidence: match * variantWeight >= 0.6 ? "high" : "medium",
    reason,
    seed,
    tags,
    sourcePaths: buildSourcePaths(sourcePath, seed, artist),
    seedWeights: [0.7 * variantWeight],
    similarityScores: [match],
    queryVariantWeights: [variantWeight],
    queryVariantTypes: queryVariant ? [queryVariant.variantType] : [],
    queryVariants: queryVariant ? [queryVariant] : [],
    raw
  } as DiscoveryCandidate & { raw?: unknown };
}


function buildSourcePaths(sourcePath: string, seed: DiscoveryCandidate["seed"], candidateArtist: string) {
  const paths = [sourcePath];
  const normalizedSeedArtist = normalizeForCandidateKey(seed?.artist ?? "");
  const normalizedCandidateArtist = normalizeForCandidateKey(candidateArtist);

  if (sourcePath === "lastfm:similar_track") {
    paths.push(normalizedSeedArtist && normalizedSeedArtist !== normalizedCandidateArtist ? "similar_track_different_artist" : "similar_track_same_artist");
  }
  if (sourcePath === "lastfm:similar_artist:top_track") paths.push("similar_artist_representative");
  if (sourcePath === "lastfm:artist_top_track") paths.push("same_artist_top_tracks");
  if (sourcePath === "lastfm:album_track") paths.push("same_album_other_tracks");
  return unique(paths);
}
function toSeed(input: GenerateDiscoveryPlanInput) {
  const seed = input.sourceSeed ?? input.seedTrack;
  return {
    title: seed?.title ?? "",
    artist: seed?.artist ?? "",
    album: seed?.album ?? ""
  };
}

function getNested(value: unknown, path: string[]) {
  return path.reduce<unknown>((current, key) => {
    if (typeof current === "object" && current !== null && key in current) return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

function asArray(value: unknown) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function mergeExpandedCandidates(candidates: DiscoveryCandidate[]) {
  const byKey = new Map<string, DiscoveryCandidate>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...candidate });
      continue;
    }
    byKey.set(key, {
      ...existing,
      sourcePaths: unique([...(existing.sourcePaths ?? []), ...(candidate.sourcePaths ?? [])]),
      seedWeights: [...(existing.seedWeights ?? []), ...(candidate.seedWeights ?? [])],
      similarityScores: [...(existing.similarityScores ?? []), ...(candidate.similarityScores ?? [])],
      queryVariantWeights: [...(existing.queryVariantWeights ?? []), ...(candidate.queryVariantWeights ?? [])],
      queryVariantTypes: unique([...(existing.queryVariantTypes ?? []), ...(candidate.queryVariantTypes ?? [])]),
      queryVariants: [...(existing.queryVariants ?? []), ...(candidate.queryVariants ?? [])],
      tags: unique([...(existing.tags ?? []), ...(candidate.tags ?? [])]),
      confidence: existing.confidence === "high" || candidate.confidence === "high" ? "high" : "medium"
    });
  }
  return [...byKey.values()].sort((a, b) => effectiveSimilarity(b) - effectiveSimilarity(a));
}

function effectiveSimilarity(candidate: DiscoveryCandidate) {
  const weights = candidate.queryVariantWeights ?? [];
  return Math.max(...(candidate.similarityScores ?? [0]).map((score, index) => score * (weights[index] ?? 1)), 0);
}

function candidateKey(candidate: DiscoveryCandidate) {
  return `${normalizeForCandidateKey(candidate.title)}::${normalizeForCandidateKey(candidate.artist)}`;
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}





