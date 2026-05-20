import type { KnowledgeConfidence, TrackContextPack } from "./knowledgeTypes";
import { getAlbumCard, getArtistCard, getScriptMemory, getTrackCard } from "./knowledgeStore";

export async function buildTrackContextPack(input: {
  track: { title: string; artist: string; album?: string; year?: string };
  recommendation?: {
    seedTrack?: string;
    seedArtist?: string;
    sourcePath?: string;
    reason?: string;
    tags?: string[];
    similarTo?: Array<{ title: string; artist: string }>;
    likedContext?: TrackContextPack["recommendation"]["likedContext"];
  };
  listeningContext?: TrackContextPack["listeningContext"];
}): Promise<TrackContextPack> {
  const [trackCard, albumCard, artistCard, scriptMemory] = await Promise.all([
    getTrackCard(input.track.title, input.track.artist),
    getAlbumCard(input.track.artist, input.track.album),
    getArtistCard(input.track.artist),
    getScriptMemory(input.track.title, input.track.artist, input.track.album)
  ]);

  return {
    track: input.track,
    recommendation: input.recommendation ?? {},
    knowledge: {
      trackCard: trackCard ?? undefined,
      albumCard: albumCard ?? undefined,
      artistCard: artistCard ?? undefined,
      scriptMemory: scriptMemory ?? undefined
    },
    listeningContext: input.listeningContext ?? { position: "normal", userAction: "none" },
    confidence: computeConfidence({ trackCard, albumCard, artistCard, scriptMemory })
  };
}

function computeConfidence(input: {
  trackCard: Awaited<ReturnType<typeof getTrackCard>>;
  albumCard: Awaited<ReturnType<typeof getAlbumCard>>;
  artistCard: Awaited<ReturnType<typeof getArtistCard>>;
  scriptMemory: Awaited<ReturnType<typeof getScriptMemory>>;
}): KnowledgeConfidence {
  if (input.trackCard && hasUsefulTrackContext(input.trackCard) && input.trackCard.confidence !== "low" && input.trackCard.confidence !== "none") return "high";
  if (input.albumCard && hasUsefulAlbumContext(input.albumCard) && input.albumCard.confidence !== "low" && input.albumCard.confidence !== "none") return "high";
  if (input.scriptMemory?.userFeedback === "good") return "high";
  if (input.trackCard || input.albumCard) return "medium";
  if (input.artistCard && input.artistCard.confidence !== "none") return "medium";
  if (input.scriptMemory && input.scriptMemory.userFeedback !== "bad") return "low";
  return "none";
}

function hasUsefulTrackContext(card: NonNullable<Awaited<ReturnType<typeof getTrackCard>>>) {
  return Boolean(card.summary || card.lyricTheme || card.moodWords?.length || card.djAngles?.length || card.tags?.length);
}

function hasUsefulAlbumContext(card: NonNullable<Awaited<ReturnType<typeof getAlbumCard>>>) {
  return Boolean(card.summary || card.moodWords?.length || card.djAngles?.length || card.tags?.length);
}