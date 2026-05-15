import type { RadioState } from "../types";
import type { RecommenderWeights } from "./weights";

export function updateAdaptiveWeights(input: {
  state: RadioState;
  weights: RecommenderWeights;
  event: "play_end" | "skip" | "like" | "replay" | "dislike";
  completionRate?: number;
}): RecommenderWeights {
  const weights = { ...input.weights };
  const positive = input.event === "like" || input.event === "replay" || (input.event === "play_end" && (input.completionRate ?? 0) >= 0.8);
  const negative = input.event === "skip" || input.event === "dislike" || (input.event === "play_end" && (input.completionRate ?? 1) < 0.25);

  if (positive) {
    weights.lastfmSimilarity = clamp(weights.lastfmSimilarity + 0.03, 2.5, 4.5);
    weights.sourcePathStrength = clamp(weights.sourcePathStrength + 0.02, 1.0, 2.5);
    weights.explorationBonus = clamp(weights.explorationBonus + 0.01, 0.4, 1.4);
  }

  if (negative) {
    weights.recentlySkippedPenalty = clamp(weights.recentlySkippedPenalty + 0.06, 4.0, 8.0);
    weights.sourcePathStrength = clamp(weights.sourcePathStrength - 0.02, 1.0, 2.5);
    weights.explorationBonus = clamp(weights.explorationBonus - 0.02, 0.4, 1.4);
  }

  void input.state;
  return weights;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
