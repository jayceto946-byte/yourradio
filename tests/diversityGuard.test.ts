import test from "node:test";
import assert from "node:assert/strict";
import { applyDiversityGuard, type DiversityGuardOutput } from "../lib/recommender/diversityGuard";
import type { RankedCandidate } from "../lib/recommender/rankCandidates";
import type { RadioState } from "../lib/types";

function state(playHistory: RadioState["playHistory"]): RadioState {
  return {
    recentTracks: [],
    skippedTracks: [],
    likedTracks: [],
    artistWeights: {},
    keywordWeights: {},
    tagWeights: {},
    sourcePathTrust: {},
    recentDjLines: [],
    searchStrategyHistory: [],
    playHistory
  };
}

function history(title: string, artist: string, index: number): RadioState["playHistory"][number] {
  return {
    id: String(index),
    title,
    artist,
    album: "Album",
    searchQuery: "",
    sourceSeed: { title: "", artist: "", album: "" },
    playedAt: new Date(Date.now() - index * 60_000).toISOString()
  };
}

function ranked(id: string, title: string, artist: string, total: number): RankedCandidate {
  return {
    candidate: {
      playableTrack: { id, source: "test", title, artist, playUrl: "url" },
      infoTrack: { title, artist, sourceProvider: "test" },
      sourcePaths: ["lastfm:similar_track"],
      providerNames: ["test"],
      seedWeights: [0.8],
      similarityScores: [0.8],
      matchConfidence: 0.95,
      seedRefs: [{ type: "track", title: "Seed", artist: "Seed Artist", source: "base_library", weight: 1 }]
    },
    score: {
      trackId: id,
      total,
      sourcePaths: ["lastfm:similar_track"],
      providerNames: ["test"],
      features: {} as RankedCandidate["score"]["features"],
      weighted: {} as RankedCandidate["score"]["weighted"],
      explanation: "base"
    }
  };
}

function findPenalty(output: DiversityGuardOutput, type: string) {
  return output.penaltiesApplied.find((entry) => entry.penaltyType === type);
}

test("diversity guard strongly downranks artists from the last five plays", () => {
  const output = applyDiversityGuard({
    radioState: state([
      history("Recent A", "Artist A", 1),
      history("Recent B", "Artist B", 2),
      history("Recent C", "Artist C", 3)
    ]),
    candidates: [
      ranked("same", "Same Artist Candidate", "Artist A", 9),
      ranked("fresh", "Fresh Artist Candidate", "Artist Z", 7)
    ]
  });

  assert.equal(output.candidates[0].score.trackId, "fresh");
  assert.ok(findPenalty(output, "sameArtistHardRecentPenalty"));
});

test("diversity guard penalizes artists already represented in the future queue", () => {
  const output = applyDiversityGuard({
    radioState: state([]),
    currentQueue: [{ status: "track_ready", item: { track: { title: "Queued", artist: "Artist A" } } }],
    candidates: [ranked("same", "Same Artist Candidate", "Artist A", 9)]
  });

  assert.ok(findPenalty(output, "sameArtistInQueuePenalty"));
  assert.ok(output.candidates[0].score.total < 9);
});
