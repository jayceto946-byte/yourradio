export type DjScriptMode =
  | "standalone_intro"
  | "mood_note"
  | "song_fact"
  | "soft_transition"
  | "direct_play"
  | "personal_taste_note";

export const DJ_SCRIPT_MODE_WEIGHTS: Record<DjScriptMode, number> = {
  standalone_intro: 0.3,
  mood_note: 0.25,
  song_fact: 0.2,
  soft_transition: 0.15,
  direct_play: 0.07,
  personal_taste_note: 0.03
};

export function selectDjScriptMode(input: {
  factsCount: number;
  hasHighConfidenceFact: boolean;
  recentScriptModes: DjScriptMode[];
  previousTrackAvailable: boolean;
  isChineseTrackLikelyLowCoverage: boolean;
}): DjScriptMode {
  const recentTransitions = input.recentScriptModes.slice(0, 5).filter((mode) => mode === "soft_transition").length;
  const blocked = new Set<DjScriptMode>();
  if (!input.previousTrackAvailable || recentTransitions >= 2) blocked.add("soft_transition");
  if (!input.hasHighConfidenceFact) blocked.add("song_fact");

  if (input.isChineseTrackLikelyLowCoverage && input.factsCount === 0) {
    return weightedPick([
      ["mood_note", 0.45],
      ["direct_play", 0.25],
      ["standalone_intro", 0.3]
    ]);
  }

  const entries = Object.entries(DJ_SCRIPT_MODE_WEIGHTS)
    .filter(([mode]) => !blocked.has(mode as DjScriptMode)) as Array<[DjScriptMode, number]>;
  return weightedPick(entries.length ? entries : [["mood_note", 1]]);
}

function weightedPick(entries: Array<[DjScriptMode, number]>) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = Math.random() * total;
  for (const [mode, weight] of entries) {
    cursor -= weight;
    if (cursor <= 0) return mode;
  }
  return entries[0][0];
}
