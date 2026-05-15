import test from "node:test";
import assert from "node:assert/strict";
import { computeEffectiveLastfmSimilarity } from "../lib/recommender/rankCandidates";

test("queryVariantWeight adjusts effective Last.fm similarity", () => {
  const candidate = {
    similarityScores: [0.7, 0.8],
    queryVariantWeights: [0.8, 1.0],
    sourcePaths: ["lastfm:similar_track"]
  } as any;
  assert.equal(computeEffectiveLastfmSimilarity(candidate), 0.8);
});

test("queryVariantWeight does not overwrite raw similarity", () => {
  const candidate = {
    similarityScores: [0.9],
    queryVariantWeights: [0.5],
    sourcePaths: ["lastfm:similar_track"]
  } as any;
  assert.equal(candidate.similarityScores[0], 0.9);
  assert.equal(computeEffectiveLastfmSimilarity(candidate), 0.45);
});
