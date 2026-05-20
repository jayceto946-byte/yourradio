import type { SongFact } from "../dj/songFacts";
import type { AlbumCard, ArtistCard, DjScriptMode, KnowledgeConfidence, KnowledgeSource, TrackCard, TrackContextPack } from "./knowledgeTypes";
import { normalizeKnowledgeKey } from "./normalizeKnowledgeKey";
import { upsertAlbumCard, upsertArtistCard, upsertTrackCard } from "./knowledgeStore";

export async function updateKnowledgeCardsFromFacts(input: {
  title: string;
  artist: string;
  album?: string;
  tags?: string[];
  facts: SongFact[];
  source?: KnowledgeSource;
}) {
  const now = new Date().toISOString();
  const source = input.source ?? inferSource(input.facts);
  const tags = unique([...(input.tags ?? []), ...extractTags(input.facts)]).slice(0, 8);
  const summary = pickSummary(input.facts);
  const confidence = inferConfidence(input.facts, summary, tags);

  if (summary || tags.length || input.album) {
    const trackCard: TrackCard = {
      type: "track",
      title: input.title,
      normalizedTitle: normalizeKnowledgeKey(input.title),
      artist: input.artist,
      normalizedArtist: normalizeKnowledgeKey(input.artist),
      album: input.album,
      normalizedAlbum: normalizeKnowledgeKey(input.album),
      tags,
      summary,
      moodWords: tags.slice(0, 4),
      djAngles: buildDjAngles(summary, tags),
      source,
      confidence,
      createdAt: now,
      updatedAt: now
    };
    await upsertTrackCard(trackCard);
  }

  if (input.album && (summary || tags.length)) {
    const albumCard: AlbumCard = {
      type: "album",
      artist: input.artist,
      normalizedArtist: normalizeKnowledgeKey(input.artist),
      album: input.album,
      normalizedAlbum: normalizeKnowledgeKey(input.album),
      tags,
      summary: pickAlbumSummary(input.facts) ?? summary,
      moodWords: tags.slice(0, 4),
      djAngles: buildDjAngles(summary, tags),
      source,
      confidence,
      createdAt: now,
      updatedAt: now
    };
    await upsertAlbumCard(albumCard);
  }

  if (tags.length) {
    const artistCard: ArtistCard = {
      type: "artist",
      artist: input.artist,
      normalizedArtist: normalizeKnowledgeKey(input.artist),
      tags,
      moodWords: tags.slice(0, 4),
      knownFor: tags.slice(0, 3),
      source,
      confidence: confidence === "high" ? "medium" : confidence,
      createdAt: now,
      updatedAt: now
    };
    await upsertArtistCard(artistCard);
  }
}

export function selectDjScriptMode(context: TrackContextPack): DjScriptMode {
  if (context.listeningContext.position === "requested") return "user_request";
  if (context.confidence === "high" && context.knowledge.albumCard) return "album_context";
  if (context.confidence === "high" && context.knowledge.artistCard) return "artist_context";
  if (context.recommendation.sourcePath || context.recommendation.reason) return "queue_reason";
  if (context.confidence === "low") return "mood_note";
  if (context.confidence === "none") return "direct_play";
  return "mood_note";
}

function inferSource(facts: SongFact[]): KnowledgeSource {
  if (facts.some((fact) => fact.sourceName?.toLowerCase().includes("last.fm"))) return "lastfm";
  if (facts.some((fact) => fact.sourceName?.toLowerCase().includes("local"))) return "local_metadata";
  return "local_generated";
}

function inferConfidence(facts: SongFact[], summary: string | undefined, tags: string[]): KnowledgeConfidence {
  const max = Math.max(...facts.map((fact) => fact.confidence), 0);
  if (summary && max >= 0.72) return "high";
  if (summary || tags.length >= 2 || max >= 0.66) return "medium";
  if (facts.length || tags.length) return "low";
  return "none";
}

function pickSummary(facts: SongFact[]) {
  return facts.find((fact) => fact.type === "background" && fact.confidence >= 0.68)?.text
    ?? facts.find((fact) => fact.type === "soundtrack" && fact.confidence >= 0.62)?.text
    ?? undefined;
}

function pickAlbumSummary(facts: SongFact[]) {
  return facts.find((fact) => fact.type === "album" && fact.confidence >= 0.68)?.text;
}

function extractTags(facts: SongFact[]) {
  return facts
    .filter((fact) => fact.type === "metadata" && /标签包括/.test(fact.text))
    .flatMap((fact) => fact.text.replace(/^.*标签包括\s*/, "").replace(/。$/, "").split(/[、,，]/g))
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function buildDjAngles(summary: string | undefined, tags: string[]) {
  const angles: string[] = [];
  if (summary) angles.push("可以轻轻带出一条可靠背景，但不要讲成百科。");
  if (tags.length) angles.push(`可以围绕 ${tags.slice(0, 3).join("、")} 的听感做短串场。`);
  return angles;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}