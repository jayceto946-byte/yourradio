import test from "node:test";
import assert from "node:assert/strict";
import { rankCandidates, type PlayableCandidate } from "../lib/recommender/rankCandidates";
import { buildTasteProfile } from "../lib/taste";
import type { RadioState } from "../lib/types";

function state(overrides: Partial<RadioState> = {}): RadioState {
  return {
    recentTracks: [],
    skippedTracks: [],
    likedTracks: [],
    artistWeights: {},
    keywordWeights: {},
    tagWeights: { "dream pop": 1 },
    sourcePathTrust: { "lastfm:similar_track": 1, "fallback:lastfm:tag_top_track": 0.65 },
    recentDjLines: [],
    searchStrategyHistory: [],
    playHistory: [],
    ...overrides
  };
}

function candidate(overrides: Partial<PlayableCandidate> = {}): PlayableCandidate {
  return {
    playableTrack: { id: "1", source: "netease", title: "A", artist: "Artist", playUrl: "url" },
    infoTrack: { title: "A", artist: "Artist", tags: ["dream pop"], sourceProvider: "lastfm" },
    sourcePaths: ["lastfm:similar_track"],
    providerNames: ["netease"],
    seedWeights: [0.5],
    similarityScores: [0.5],
    matchConfidence: 0.95,
    ...overrides
  };
}

test("lastfmSimilarity increases total score", () => {
  const profile = buildTasteProfile([]);
  const scores = rankCandidates({ candidates: [candidate({ playableTrack: { id: "low", source: "netease", title: "L", artist: "A" }, similarityScores: [0.2] }), candidate({ playableTrack: { id: "high", source: "netease", title: "H", artist: "A" }, similarityScores: [0.9] })], tasteProfile: profile, radioState: state() });
  assert.equal(scores[0].score.trackId, "high");
});

test("seedWeight increases total score", () => {
  const profile = buildTasteProfile([]);
  const scores = rankCandidates({ candidates: [candidate({ playableTrack: { id: "low", source: "netease", title: "L", artist: "A" }, seedWeights: [0.1] }), candidate({ playableTrack: { id: "high", source: "netease", title: "H", artist: "A" }, seedWeights: [1] })], tasteProfile: profile, radioState: state() });
  assert.equal(scores[0].score.trackId, "high");
});

test("matchConfidence below 0.75 is filtered", () => {
  const scores = rankCandidates({ candidates: [candidate({ matchConfidence: 0.7 })], tasteProfile: buildTasteProfile([]), radioState: state() });
  assert.equal(scores.length, 0);
});

test("similar track path beats tag top track when otherwise equal", () => {
  const profile = buildTasteProfile([]);
  const scores = rankCandidates({ candidates: [candidate({ playableTrack: { id: "tag", source: "netease", title: "T", artist: "A" }, sourcePaths: ["fallback:lastfm:tag_top_track"] }), candidate({ playableTrack: { id: "similar", source: "netease", title: "S", artist: "A" }, sourcePaths: ["lastfm:similar_track"] })], tasteProfile: profile, radioState: state() });
  assert.equal(scores[0].score.trackId, "similar");
});

test("recent play creates penalty", () => {
  const recent = new Date().toISOString();
  const scores = rankCandidates({ candidates: [candidate()], tasteProfile: buildTasteProfile([]), radioState: state({ playHistory: [{ id: "1", title: "A", artist: "Artist", album: "", searchQuery: "", sourceSeed: { title: "", artist: "", album: "" }, playedAt: recent }] }) });
  assert.ok(scores[0].score.features.recentlyPlayedPenalty > 0.5);
});
