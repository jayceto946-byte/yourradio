import test from "node:test";
import assert from "node:assert/strict";
import { updateExploration } from "../lib/recommender/updateExploration";
import { parseLlmSelectionJson } from "../lib/recommender/llmSelection";

test("completed new songs increase exploration", () => {
  const state = { adaptive: { exploration: 0.35, weights: {} } } as any;
  updateExploration({ state, eventType: "play_end", isNewTrack: true, completionRate: 0.9 });
  assert.ok(state.adaptive.exploration > 0.35);
});

test("skipped new songs decrease exploration", () => {
  const state = { adaptive: { exploration: 0.35, weights: {} } } as any;
  updateExploration({ state, eventType: "skip", isNewTrack: true });
  assert.ok(state.adaptive.exploration < 0.35);
});

test("invalid LLM trackId falls back to top ranked", () => {
  const ranked = [{ score: { trackId: "top" } }] as any;
  const result = parseLlmSelectionJson(JSON.stringify({ trackId: "missing" }), ranked);
  assert.equal(result.selected.score.trackId, "top");
});

test("invalid LLM JSON falls back to top ranked", () => {
  const ranked = [{ score: { trackId: "top" } }] as any;
  const result = parseLlmSelectionJson("not json", ranked);
  assert.equal(result.selected.score.trackId, "top");
});
