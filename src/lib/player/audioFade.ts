export type FadeVolumeInput = {
  audio: HTMLAudioElement;
  from: number;
  to: number;
  durationMs: number;
  signal?: AbortSignal;
  onFrame?: (volume: number) => void;
  onComplete?: () => void;
  onAbort?: () => void;
};

function clampVolume(value: number) {
  return Math.max(0, Math.min(1, value));
}

function setFrameVolume(audio: HTMLAudioElement, value: number, onFrame?: (volume: number) => void) {
  const volume = clampVolume(value);
  if (onFrame) {
    onFrame(volume);
    return;
  }
  audio.volume = volume;
}

export function fadeVolume({ audio, from, to, durationMs, signal, onFrame, onComplete, onAbort }: FadeVolumeInput): Promise<void> {
  const startVolume = clampVolume(from);
  const endVolume = clampVolume(to);
  const duration = Math.max(0, durationMs);

  setFrameVolume(audio, startVolume, onFrame);

  if (duration === 0 || signal?.aborted) {
    if (!signal?.aborted) setFrameVolume(audio, endVolume, onFrame);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const startedAt = performance.now();
    let frameId = 0;

    const finish = (aborted: boolean) => {
      if (frameId) cancelAnimationFrame(frameId);
      if (!aborted) {
        setFrameVolume(audio, endVolume, onFrame);
        onComplete?.();
      } else {
        onAbort?.();
      }
      resolve();
    };

    const handleAbort = () => finish(true);
    signal?.addEventListener("abort", handleAbort, { once: true });

    const step = (now: number) => {
      if (signal?.aborted) {
        signal?.removeEventListener("abort", handleAbort);
        finish(true);
        return;
      }

      const progress = Math.min(1, (now - startedAt) / duration);
      setFrameVolume(audio, startVolume + (endVolume - startVolume) * progress, onFrame);

      if (progress >= 1) {
        signal?.removeEventListener("abort", handleAbort);
        finish(false);
        return;
      }

      frameId = requestAnimationFrame(step);
    };

    frameId = requestAnimationFrame(step);
  });
}


export type DjToSongFadePlan = {
  startSongAtTtsTimeSec: number;
  fadeInDurationMs: number;
  mode: "overlap" | "short_tts" | "after_tts";
};

export function computeDjToSongFadePlan(input: {
  ttsDurationSec: number;
  crossfadeBeforeDjEndsSec: number;
  normalFadeInSec: number;
  shortTtsThresholdSec: number;
  shortTtsSongFadeInSec: number;
  minFadeInMs: number;
}): DjToSongFadePlan {
  if (!Number.isFinite(input.ttsDurationSec) || input.ttsDurationSec <= 0) {
    return {
      startSongAtTtsTimeSec: 0,
      fadeInDurationMs: Math.max(input.minFadeInMs, input.shortTtsSongFadeInSec * 1000),
      mode: "after_tts"
    };
  }

  if (input.ttsDurationSec <= input.shortTtsThresholdSec) {
    return {
      startSongAtTtsTimeSec: Math.max(0, input.ttsDurationSec - 0.5),
      fadeInDurationMs: Math.max(input.minFadeInMs, input.shortTtsSongFadeInSec * 1000),
      mode: "short_tts"
    };
  }

  return {
    startSongAtTtsTimeSec: Math.max(0, input.ttsDurationSec - input.crossfadeBeforeDjEndsSec),
    fadeInDurationMs: Math.max(input.minFadeInMs, input.normalFadeInSec * 1000),
    mode: "overlap"
  };
}





