export type AudioVolumeState = {
  masterVolume: number;
  songVolume: number;
  ttsVolume: number;
  isMuted: boolean;
  activeFade?: {
    id: string;
    audioType: "song" | "tts";
    kind: "fade_in" | "fade_out";
    targetVolume: number;
  };
};

export function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function computeEffectiveVolume(input: {
  masterVolume: number;
  localVolume: number;
  isMuted: boolean;
}): number {
  if (input.isMuted) return 0;
  return clampVolume(input.masterVolume * input.localVolume);
}
