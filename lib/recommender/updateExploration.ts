import type { RadioState } from "../types";
import { RECENCY_WINDOWS } from "./recencyWindows";

export function updateExploration(input: {
  state: RadioState;
  eventType: "play_end" | "skip" | "replay" | "like" | "dislike" | "request_more_new";
  isNewTrack?: boolean;
  isKnownArtist?: boolean;
  completionRate?: number;
}) {
  input.state.adaptive ??= { exploration: 0.35, weights: {} };
  let exploration = input.state.adaptive.exploration ?? 0.35;

  if (input.eventType === "request_more_new") {
    exploration += 0.12;
  }

  if (input.eventType === "play_end" && input.isNewTrack && (input.completionRate ?? 0) >= RECENCY_WINDOWS.strongCompletionRate) {
    exploration += 0.05;
  }

  if (input.eventType === "skip" && input.isNewTrack) {
    exploration -= 0.08;
  }

  if (input.eventType === "play_end" && !input.isNewTrack && input.isKnownArtist && (input.completionRate ?? 0) >= RECENCY_WINDOWS.strongCompletionRate) {
    exploration -= 0.02;
  }

  input.state.adaptive.exploration = clamp(exploration, 0.1, 0.7);
  return input.state;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
