"use client";

import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent } from "react";
import { computeDjToSongFadePlan, fadeVolume } from "@/lib/player/audioFade";
import { clampVolume, computeEffectiveVolume } from "@/src/lib/player/audioVolume";
import type { FeedbackAction, PlaylistSong, RadioNextResponse, RadioTrack, RecommendationFailure } from "@/lib/types";

type PlayerState =
  | "idle"
  | "preparing"
  | "speaking"
  | "playing"
  | "preparing_next"
  | "transitioning"
  | "paused"
  | "stopped"
  | "error";

type PrepareStatus = "not_ready" | "preparing" | "ready";
type ActiveAudioType = "song" | "speech" | null;
type TransitionReason = "song-ended" | "neutral-next" | "after_skip";
type RecentTrackFeedback = "liked_style" | "changed";
type AppTheme = "dark" | "ivory";
type RequestSongUiStatus = "idle" | "loading" | "success" | "error";

type HourlyChimePackage = {
  ok?: boolean;
  targetHourIso: string;
  targetHourKey: string;
  timeText: string;
  script: string;
  audioUrl?: string;
  cached?: boolean;
};

type LocalServiceStatus = {
  server: {
    ok: boolean;
    checkedAt?: string;
  };
  tts: {
    ok: boolean;
    loaded?: boolean;
    latencyMs?: number;
    speaker?: string;
    error?: string;
  };
};

type PlaylistImportPreview = {
  songs: PlaylistSong[];
  previewSongs: PlaylistSong[];
  summary: {
    fileName: string;
    rowsRead: number;
    acceptedRows: number;
    importedCount: number;
    rejectedCount: number;
    duplicateCount: number;
  };
};
type PlaylistImportMode = "replace" | "merge";

const PLAYBACK_TIMING = {
  prepareNextTrackBeforeEndSec: 120,
  minRemainingSecToStartPrepare: 120,
  fallbackPrepareAtProgress: 0.7
};
const RECENT_UI_LIMIT = 20;
const NEXT_TIMEOUT_MS = 150000;
const FEEDBACK_TIMEOUT_MS = 5000;
const PLAYLIST_IMPORT_TIMEOUT_MS = 15000;
const REQUEST_SONG_TIMEOUT_MS = 60000;
const PREPARE_END_WAIT_MS = 3000;
const PREPARE_RETRY_AFTER_FAILURE_MS = 15000;
const isDev = process.env.NODE_ENV === "development";
const THEME_STORAGE_KEY = "yourradio:theme";

const AUDIO_TRANSITION = {
  songFadeOutSec: 5,
  songManualSkipFadeOutMs: 800,
  nextSongFadeInSec: 5,
  crossfadeBeforeDjEndsSec: 3,
  shortTtsThresholdSec: 4,
  shortTtsSongFadeInSec: 2,
  minFadeInMs: 800
};

const AUDIO_VOLUME = {
  songNormal: 1,
  ttsNormal: 1,
  songDuckUnderTts: 0.25,
  songDuckUnderHourlyChime: 0.18
};

const HOURLY_CHIME = {
  prepareBeforeMs: 5 * 60 * 1000,
  tickMs: 15 * 1000,
  dueWindowMs: 90 * 1000,
  duckFadeMs: 1800,
  restoreFadeMs: 2600
};

const PREBUILT_TTS = {
  variantsPerTimedGroup: 4,
  variantsPerInteractionGroup: 10,
  shortSessionMs: 20 * 60 * 1000
};

type PrebuiltCueAction = "radio_start" | "radio_stop" | "change_track" | "skip_and_downrank";

const prepareStatusText: Record<PrepareStatus, string> = {
  not_ready: "\u672a\u51c6\u5907",
  preparing: "\u6b63\u5728\u51c6\u5907\u4e0b\u4e00\u9996",
  ready: "\u5df2\u51c6\u5907"
};

function debugLog(message: string, detail?: unknown) {
  if (isDev) console.log(message, detail ?? "");
}

function perfLog(name: string, start: number) {
  if (isDev) console.log(`[perf] ${name}: ${Math.round(performance.now() - start)}ms`);
}

function stateLabel(state: PlayerState) {
  const labels: Record<PlayerState, string> = {
    idle: "\u5f85\u673a",
    preparing: "\u51c6\u5907\u4e2d",
    speaking: "DJ \u4e32\u573a",
    playing: "\u64ad\u653e\u4e2d",
    preparing_next: "\u64ad\u653e\u4e2d / \u9884\u5907\u4e0b\u4e00\u9996",
    transitioning: "\u5207\u6b4c\u4e2d",
    paused: "\u5df2\u6682\u505c",
    stopped: "\u5df2\u505c\u6b62",
    error: "\u51fa\u9519"
  };

  return labels[state];
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "00:00";
  const minutes = Math.floor(value / 60);
  const seconds = String(Math.floor(value % 60)).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function isRecommendationFailure(value: unknown): value is RecommendationFailure {
  return Boolean(value && typeof value === "object" && "ok" in value && (value as RecommendationFailure).ok === false);
}

export default function Home() {
  const [playerState, setPlayerState] = useState<PlayerState>("idle");
  const [currentItem, setCurrentItem] = useState<RadioNextResponse | null>(null);
  const [speakingForItem, setSpeakingForItem] = useState<RadioNextResponse | null>(null);
  const [nextPreparedItem, setNextPreparedItem] = useState<RadioNextResponse | null>(null);
  const [prepareStatus, setPrepareStatus] = useState<PrepareStatus>("not_ready");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const [recentTracks, setRecentTracks] = useState<RadioTrack[]>([]);
  const [recentTrackFeedback, setRecentTrackFeedback] = useState<Record<string, RecentTrackFeedback>>({});
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const [feedbackStatus, setFeedbackStatus] = useState("");
  const [feedbackPending, setFeedbackPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [masterVolume, setMasterVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [localServiceStatus, setLocalServiceStatus] = useState<LocalServiceStatus | null>(null);
  const [theme, setTheme] = useState<AppTheme>("dark");
  const [playlistImportMode, setPlaylistImportMode] = useState<PlaylistImportMode>("replace");
  const [playlistImportPreview, setPlaylistImportPreview] = useState<PlaylistImportPreview | null>(null);
  const [playlistImportPending, setPlaylistImportPending] = useState(false);
  const [playlistImportStatus, setPlaylistImportStatus] = useState("");
  const [requestSongText, setRequestSongText] = useState("");
  const [requestSongPending, setRequestSongPending] = useState(false);
  const [requestSongStatus, setRequestSongStatus] = useState<RequestSongUiStatus>("idle");
  const [isRequestSongOpen, setIsRequestSongOpen] = useState(false);
  const [isToolMenuOpen, setIsToolMenuOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "running" | "success" | "error">("idle");

  const songAudioRef = useRef<HTMLAudioElement | null>(null);
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);
  const effectAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentRef = useRef<RadioNextResponse | null>(null);
  const speakingForRef = useRef<RadioNextResponse | null>(null);
  const nextPreparedRef = useRef<RadioNextResponse | null>(null);
  const activeAudioTypeRef = useRef<ActiveAudioType>(null);
  const pausedAudioTypeRef = useRef<ActiveAudioType>(null);
  const isPreparingNextRef = useRef(false);
  const hasPreparedForCurrentTrackRef = useRef(false);
  const nextPrepareRetryAtRef = useRef(0);
  const previousTtsOnlineRef = useRef<boolean | null>(null);
  const transitionLockRef = useRef(false);
  const isRadioActiveRef = useRef(false);
  const playerStateRef = useRef<PlayerState>("idle");
  const transitionIdRef = useRef(0);
  const prepareIdRef = useRef(0);
  const speechResolveRef = useRef<(() => void) | null>(null);
  const songFadeAbortRef = useRef<AbortController | null>(null);
  const songFadeInAbortRef = useRef<AbortController | null>(null);
  const songAudioContextRef = useRef<AudioContext | null>(null);
  const songMediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const songGainNodeRef = useRef<GainNode | null>(null);
  const songWebAudioFadeTimerRef = useRef<number | null>(null);
  const audioFallbackAttemptsRef = useRef(new Set<string>());
  const songFadeOutStartedRef = useRef(false);
  const fadeTrackIdRef = useRef<string | null>(null);
  const nextSongStartedRef = useRef(false);
  const masterVolumeRef = useRef(1);
  const isMutedRef = useRef(false);
  const songLocalVolumeRef = useRef(AUDIO_VOLUME.songNormal);
  const ttsLocalVolumeRef = useRef(AUDIO_VOLUME.ttsNormal);
  const hourlyChimePreparedRef = useRef<HourlyChimePackage | null>(null);
  const hourlyChimePreparingRef = useRef(new Set<string>());
  const hourlyChimePlayedRef = useRef(new Set<string>());
  const hourlyChimePlayingRef = useRef(false);
  const hourlyChimeDuckAbortRef = useRef<AbortController | null>(null);
  const radioSessionStartedAtRef = useRef<number | null>(null);
  const markNextPlayedAsChangedRef = useRef(false);
  const themeEffectInitializedRef = useRef(false);
  const playlistFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === "ivory" || storedTheme === "dark") {
      setTheme(storedTheme);
      document.documentElement.dataset.theme = storedTheme;
    } else {
      document.documentElement.dataset.theme = "dark";
    }
  }, []);

  useEffect(() => {
    if (!themeEffectInitializedRef.current) {
      themeEffectInitializedRef.current = true;
      return;
    }
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!feedbackStatus) return;
    const feedbackDismissTimer = window.setTimeout(() => setFeedbackStatus(""), 5000);
    return () => window.clearTimeout(feedbackDismissTimer);
  }, [feedbackStatus]);

  useEffect(() => {
    if (requestSongStatus === "idle" || requestSongStatus === "loading") return;
    const requestSongDismissTimer = window.setTimeout(() => setRequestSongStatus("idle"), 3000);
    return () => window.clearTimeout(requestSongDismissTimer);
  }, [requestSongStatus]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const refresh = async () => {
      try {
        const response = await fetch("/api/system/status", { cache: "no-store" });
        const data = await response.json();
        if (!cancelled) {
          setLocalServiceStatus(data);
          handleTtsStatusRefresh(Boolean(data?.tts?.ok));
        }
      } catch {
        if (!cancelled) {
          setLocalServiceStatus({
            server: { ok: false },
            tts: { ok: false, error: "status_check_failed" }
          });
          handleTtsStatusRefresh(false);
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 5000);
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const handleVisibilityOrFocus = () => {
      if (document.hidden) {
        stabilizeSongAudioForBackground();
        return;
      }
      debugLog("[audio] visibility restored, resyncing volume");
      resyncAudioElementsVolume();
      resumeSongIfBrowserPausedIt();
    };
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    window.addEventListener("focus", handleVisibilityOrFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      window.removeEventListener("focus", handleVisibilityOrFocus);
    };
  }, []);


  useEffect(() => {
    const tick = () => {
      if (!isRadioActiveRef.current) return;
      maybePrepareHourlyChime();
      void maybePlayHourlyChime();
    };
    tick();
    const timer = window.setInterval(tick, HOURLY_CHIME.tickMs);
    return () => window.clearInterval(timer);
  }, []);

  function setState(nextState: PlayerState) {
    debugLog(`[state] ${nextState}`);
    playerStateRef.current = nextState;
    setPlayerState(nextState);
  }

  function toggleTheme() {
    setTheme((current) => current === "ivory" ? "dark" : "ivory");
  }

  async function startRadio() {
    const startedAt = performance.now();
    if (playerStateRef.current !== "idle" && playerStateRef.current !== "stopped" && playerStateRef.current !== "error") return;

    isRadioActiveRef.current = true;
    radioSessionStartedAtRef.current = Date.now();
    setError(null);
    setFeedbackStatus("");
    setState("preparing");

    try {
      const transitionId = nextTransitionId();
      const startCue = playPrebuiltCue("radio_start");
      const item = await fetchNextItem();
      await startCue;
      await playRadioItem({ ...item, ttsSkipped: true }, transitionId);
    } catch (cause) {
      handleError(cause, "\u542f\u52a8\u5931\u8d25\uff1a");
    } finally {
      perfLog("startRadio", startedAt);
    }
  }

  async function playRadioItem(item: RadioNextResponse, transitionId: number) {
    if (!isLatestTransition(transitionId)) {
      debugLog("[transition] ignored stale request", transitionId);
      return;
    }

    stopSongAudio();
    clearSongProgress();
    currentRef.current = null;
    setCurrentItem(null);
    speakingForRef.current = item;
    setSpeakingForItem(item);
    clearPreparedNext();
    hasPreparedForCurrentTrackRef.current = false;
    nextPrepareRetryAtRef.current = 0;
    setPrepareStatus("not_ready");
    setError(null);

    nextSongStartedRef.current = false;
    cancelSongFades();
    if (item.ttsSkipped) {
      debugLog("[audio] opening tts skipped");
    } else {
      setState("speaking");
      await playSpeech(item.djLine, transitionId, item.track.audioUrl, item.ttsUrl ?? undefined);
    }

    if (!isRadioActiveRef.current || !isLatestTransition(transitionId)) {
      debugLog("[transition] ignored stale request", transitionId);
      return;
    }

    stopSpeechAudio();
    speakingForRef.current = null;
    setSpeakingForItem(null);
    currentRef.current = item;
    setCurrentItem(item);
    pushRecentTrack(item.track);
    if (markNextPlayedAsChangedRef.current) {
      markRecentTrackFeedback(item.track, "changed");
      markNextPlayedAsChangedRef.current = false;
    }
    setState("playing");
    activeAudioTypeRef.current = "song";
    if (!nextSongStartedRef.current) {
      await playSong(item.track.audioUrl, transitionId, { fadeIn: true });
    }
    triggerImmediateNextPreparation("song_started");
    setFeedbackPending(false);
  }

  function handleTtsStatusRefresh(isOnline: boolean) {
    const wasOnline = previousTtsOnlineRef.current;
    previousTtsOnlineRef.current = isOnline;
    if (!isOnline || wasOnline === true) return;
    nextPrepareRetryAtRef.current = 0;
    void logClientRuntimeEvent("tts.status", "info", { reason: "tts_recovered_trigger_prepare" });
    if (activeAudioTypeRef.current === "song" && currentRef.current && !nextPreparedRef.current) {
      hasPreparedForCurrentTrackRef.current = false;
      void prepareNext();
    }
  }

  function triggerImmediateNextPreparation(reason: "song_started" | "song_audio_playing") {
    if (
      hasPreparedForCurrentTrackRef.current ||
      isPreparingNextRef.current ||
      !isRadioActiveRef.current ||
      transitionLockRef.current ||
      activeAudioTypeRef.current !== "song" ||
      !currentRef.current
    ) return;
    void logClientRuntimeEvent("prepareNext.immediate", "started", { reason, track: `${currentRef.current.track.title} - ${currentRef.current.track.artist}` });
    window.setTimeout(() => {
      if (
        hasPreparedForCurrentTrackRef.current ||
        isPreparingNextRef.current ||
        !isRadioActiveRef.current ||
        transitionLockRef.current ||
        activeAudioTypeRef.current !== "song" ||
        !currentRef.current
      ) return;
      void prepareNext();
    }, 0);
  }

  async function prepareNext() {
    if (isPreparingNextRef.current || hasPreparedForCurrentTrackRef.current || !isRadioActiveRef.current || transitionLockRef.current) return;
    if (nextPrepareRetryAtRef.current && Date.now() < nextPrepareRetryAtRef.current) return;

    const prepareId = ++prepareIdRef.current;
    const startedAt = performance.now();
    isPreparingNextRef.current = true;
    hasPreparedForCurrentTrackRef.current = true;
    setPrepareStatus("preparing");
    if (playerStateRef.current === "playing") setState("preparing_next");
    debugLog("[prepareNext] started", prepareId);

    try {
      const item = await fetchNextItem("prepare");
      if (prepareId !== prepareIdRef.current || transitionLockRef.current) {
        debugLog("[prepareNext] ignored stale result", prepareId);
        return;
      }
      nextPrepareRetryAtRef.current = 0;
      nextPreparedRef.current = item;
      setNextPreparedItem(item);
      setPrepareStatus("ready");
      debugLog("[prepareNext] ready", item.track.title);
    } catch (cause) {
      debugLog("[prepareNext] failed", cause);
      clearPreparedNext();
      hasPreparedForCurrentTrackRef.current = false;
      nextPrepareRetryAtRef.current = Date.now() + PREPARE_RETRY_AFTER_FAILURE_MS;
      setPrepareStatus("not_ready");
      void logClientRuntimeEvent("prepareNext.retry", "info", { retryAfterMs: PREPARE_RETRY_AFTER_FAILURE_MS, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      isPreparingNextRef.current = false;
      if (activeAudioTypeRef.current === "song" && songAudioRef.current && !songAudioRef.current.paused) setState("playing");
      perfLog("prepareNext", startedAt);
    }
  }

  async function handleSongEnded() {
    debugLog("[transition] song-ended");
    await transitionToPreparedOrFetchNext("song-ended");
  }

  async function transitionToPreparedOrFetchNext(reason: TransitionReason) {
    if (transitionLockRef.current) return;

    const startedAt = performance.now();
    const transitionId = nextTransitionId();
    transitionLockRef.current = true;
    isRadioActiveRef.current = true;
    prepareIdRef.current += 1;
    setState("transitioning");
    debugLog(`[transition] ${reason}`, transitionId);

    try {
      if (reason !== "song-ended") await fadeOutSongForManualTransition();
      stopAllAudio();
      const prepared = reason === "after_skip" ? null : nextPreparedRef.current ?? await waitForPreparedNext(PREPARE_END_WAIT_MS);
      clearPreparedNext();
      const next = prepared ?? (await fetchNextItem(undefined, reason === "after_skip" ? "after_skip" : undefined));
      await playRadioItem(next, transitionId);
    } catch (cause) {
      handleError(cause, "\u5207\u6362\u5931\u8d25\uff1a");
    } finally {
      if (isLatestTransition(transitionId)) transitionLockRef.current = false;
      perfLog(`transition:${reason}`, startedAt);
    }
  }


  async function waitForPreparedNext(timeoutMs: number) {
    if (!isPreparingNextRef.current) return nextPreparedRef.current;
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      if (nextPreparedRef.current) return nextPreparedRef.current;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return nextPreparedRef.current;
  }

  function maybePrepareHourlyChime(now = new Date()) {
    const target = getNextTopOfHour(now);
    const msToTarget = target.getTime() - now.getTime();
    if (msToTarget <= 0 || msToTarget > HOURLY_CHIME.prepareBeforeMs) return;
    const key = getHourlyChimeKey(target);
    if (hourlyChimePreparedRef.current?.targetHourKey === key || hourlyChimePreparingRef.current.has(key)) return;
    hourlyChimePreparingRef.current.add(key);
    void logClientRuntimeEvent("hourlyChime.prepare", "started", { targetHour: target.toISOString(), msToTarget });
    void fetchWithTimeout(`/api/hourly-chime/prepare?targetHour=${encodeURIComponent(target.toISOString())}`, { cache: "no-store" }, 130000)
      .then((response) => response.json())
      .then((payload: HourlyChimePackage) => {
        if (!payload?.audioUrl) throw new Error("hourly_chime_no_audio");
        hourlyChimePreparedRef.current = payload;
        void logClientRuntimeEvent("hourlyChime.prepare", "success", { targetHourKey: key, audioUrl: payload.audioUrl, cached: payload.cached });
      })
      .catch((cause) => {
        void logClientRuntimeEvent("hourlyChime.prepare", "error", { targetHourKey: key, error: cause instanceof Error ? cause.message : String(cause) });
      })
      .finally(() => {
        hourlyChimePreparingRef.current.delete(key);
      });
  }

  async function maybePlayHourlyChime(now = new Date()) {
    const top = getCurrentTopOfHour(now);
    const elapsed = now.getTime() - top.getTime();
    if (elapsed < 0 || elapsed > HOURLY_CHIME.dueWindowMs) return;
    const key = getHourlyChimeKey(top);
    if (hourlyChimePlayedRef.current.has(key) || hourlyChimePlayingRef.current) return;
    const prepared = hourlyChimePreparedRef.current;
    if (!prepared || prepared.targetHourKey !== key || !prepared.audioUrl) return;
    hourlyChimePlayedRef.current.add(key);
    await playHourlyChime(prepared);
  }

  async function playHourlyChime(chime: HourlyChimePackage) {
    const songAudio = songAudioRef.current;
    const speechAudio = speechAudioRef.current;
    if (!songAudio || !speechAudio || activeAudioTypeRef.current !== "song" || songAudio.paused || !songAudio.src) {
      void logClientRuntimeEvent("hourlyChime.play", "info", { targetHourKey: chime.targetHourKey, reason: "not_playing_song" });
      return;
    }
    if (songFadeOutStartedRef.current || songFadeAbortRef.current || songFadeInAbortRef.current) {
      void logClientRuntimeEvent("hourlyChime.play", "info", { targetHourKey: chime.targetHourKey, reason: "song_fade_active" });
      return;
    }

    hourlyChimePlayingRef.current = true;
    const previousLocalVolume = songLocalVolumeRef.current || AUDIO_VOLUME.songNormal;
    const duckVolume = Math.min(previousLocalVolume, AUDIO_VOLUME.songDuckUnderHourlyChime);
    const startedAt = performance.now();
    void logClientRuntimeEvent("hourlyChime.play", "started", { targetHourKey: chime.targetHourKey, timeText: chime.timeText });

    try {
      hourlyChimeDuckAbortRef.current?.abort();
      const duckController = new AbortController();
      hourlyChimeDuckAbortRef.current = duckController;
      await fadeVolume({
        audio: songAudio,
        from: songLocalVolumeRef.current,
        to: duckVolume,
        durationMs: HOURLY_CHIME.duckFadeMs,
        signal: duckController.signal,
        onFrame: (volume) => {
          songLocalVolumeRef.current = volume;
          applySongVolume();
        },
        onComplete: () => {
          songLocalVolumeRef.current = duckVolume;
          applySongVolume();
        },
        onAbort: () => applySongVolume()
      });

      ttsLocalVolumeRef.current = AUDIO_VOLUME.ttsNormal;
      applyTtsVolume();
      speechAudio.src = chime.audioUrl ?? "";
      speechAudio.load();
      await playAudioElement(speechAudio);
      await new Promise<void>((resolve) => {
        const finish = () => {
          speechAudio.onended = null;
          speechAudio.onerror = null;
          resolve();
        };
        speechAudio.onended = finish;
        speechAudio.onerror = finish;
      });
      void logClientRuntimeEvent("hourlyChime.play", "success", { targetHourKey: chime.targetHourKey, durationMs: Math.round(performance.now() - startedAt) });
    } catch (cause) {
      void logClientRuntimeEvent("hourlyChime.play", "error", { targetHourKey: chime.targetHourKey, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      speechAudio.pause();
      speechAudio.removeAttribute("src");
      speechAudio.load();
      const restoreController = new AbortController();
      hourlyChimeDuckAbortRef.current = restoreController;
      await fadeVolume({
        audio: songAudio,
        from: songLocalVolumeRef.current,
        to: previousLocalVolume,
        durationMs: HOURLY_CHIME.restoreFadeMs,
        signal: restoreController.signal,
        onFrame: (volume) => {
          songLocalVolumeRef.current = volume;
          applySongVolume();
        },
        onComplete: () => {
          songLocalVolumeRef.current = previousLocalVolume;
          applySongVolume();
        },
        onAbort: () => applySongVolume()
      }).catch(() => undefined);
      if (hourlyChimeDuckAbortRef.current === restoreController) hourlyChimeDuckAbortRef.current = null;
      hourlyChimePlayingRef.current = false;
    }
  }

  function getNextTopOfHour(now: Date) {
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);
    return next;
  }

  function getCurrentTopOfHour(now: Date) {
    const top = new Date(now);
    top.setMinutes(0, 0, 0);
    return top;
  }

  function getHourlyChimeKey(value: Date) {
    return value.toISOString().slice(0, 13).replace(/[-:T]/g, "");
  }

  function handleSongTimeUpdate() {
    const audio = songAudioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;

    if (!isSeeking) {
      setCurrentTime(audio.currentTime);
      setSeekValue(audio.currentTime);
    }

    setDuration(audio.duration);
    maybePrepareFromTime(audio.currentTime, audio.duration);
    maybeFadeOutSongFromTime(audio.currentTime, audio.duration);
  }

  async function pauseOrResumeRadio() {
    if (playerStateRef.current === "paused") {
      const pausedType = pausedAudioTypeRef.current;
      isRadioActiveRef.current = true;

      if (pausedType === "speech") {
        if (speechAudioRef.current?.src) {
          activeAudioTypeRef.current = "speech";
          setState("speaking");
          await speechAudioRef.current.play().catch((cause) => handleError(cause, "TTS resume failed."));
        }
        return;
      }

      if (pausedType === "song" && songAudioRef.current?.src) {
        activeAudioTypeRef.current = "song";
        setState("playing");
        await songAudioRef.current.play().catch((cause) => handleError(cause, "\u7ee7\u7eed\u64ad\u653e\u5931\u8d25\uff1a"));
      }
      return;
    }

    if (activeAudioTypeRef.current === "speech") {
      speechAudioRef.current?.pause();
      pausedAudioTypeRef.current = "speech";
      setState("paused");
      return;
    }

    if (activeAudioTypeRef.current === "song") {
      songAudioRef.current?.pause();
      pausedAudioTypeRef.current = "song";
      setState("paused");
    }
  }

  function neutralNext() {
    const startedAt = performance.now();
    if (transitionLockRef.current || feedbackPending) return;
    const changed = currentRef.current?.track ?? speakingForRef.current?.track;
    if (changed) markRecentTrackFeedback(changed, "changed");
    markNextPlayedAsChangedRef.current = true;
    setFeedbackPending(true);
    setFeedbackStatus("\u6b63\u5728\u6362\u4e00\u9996\uff0c\u672c\u6b21\u4e0d\u8ba1\u5165\u8d1f\u53cd\u9988\u3002\u540e\u53f0\u63a8\u8350\u751f\u6210\u4e2d\uff0c\u9875\u9762\u4e0d\u4f1a\u7b49\u5f85\u8bf7\u6c42\u5b8c\u6210\u3002");
    perfLog("right-control:neutral-next-click", startedAt);
    debugLog("[transition] neutral-next");
    void runNeutralNextInBackground();
  }

  async function runNeutralNextInBackground() {
    try {
      await transitionToPreparedOrFetchNext("neutral-next");
    } catch (cause) {
      handleError(cause, "\u6362\u6b4c\u5931\u8d25\uff1a");
      setFeedbackPending(false);
    }
  }

  function skipAndReduce() {
    const startedAt = performance.now();
    if (transitionLockRef.current || feedbackPending) return;
    const skipped = currentRef.current?.track ?? speakingForRef.current?.track;
    markNextPlayedAsChangedRef.current = true;
    setFeedbackPending(true);
    setFeedbackStatus("\u5df2\u964d\u4f4e\u5f53\u524d\u6b4c\u66f2/\u6b4c\u624b\u7684\u63a8\u8350\u6743\u91cd\uff0c\u6b63\u5728\u540e\u53f0\u5207\u6362\u4e0b\u4e00\u9996\u3002");
    perfLog("right-control:skip-click", startedAt);
    debugLog("[transition] skip");
    void runSkipInBackground(skipped);
  }

  async function runSkipInBackground(skipped?: RadioTrack) {
    try {
      void sendFeedback("skip").catch(() => setFeedbackStatus("\u53cd\u9988\u63d0\u4ea4\u5931\u8d25\uff0c\u4f46\u4f1a\u7ee7\u7eed\u5207\u6b4c\u3002"));
      if (skipped) removeRecentTrack(skipped);
      await transitionToPreparedOrFetchNext("after_skip");
    } catch (cause) {
      handleError(cause, "\u8df3\u8fc7\u5931\u8d25\uff1a");
      setFeedbackPending(false);
    }
  }

  function likeCurrentStyle() {
    const startedAt = performance.now();
    if (feedbackPending) return;
    const liked = currentRef.current?.track ?? speakingForRef.current?.track;
    if (liked) markRecentTrackFeedback(liked, "liked_style");
    setFeedbackPending(true);
    setFeedbackStatus("\u5df2\u8bb0\u5f55\uff0c\u4f1a\u5f71\u54cd\u540e\u7eed\u63a8\u8350\uff1b\u5f53\u524d\u6b63\u5728\u51c6\u5907\u7684\u4e0b\u4e00\u9996\u4e0d\u4f1a\u88ab\u6253\u65ad\u3002");
    perfLog("right-control:like-click", startedAt);
    void runLikeInBackground();
  }

  async function runLikeInBackground() {
    try {
      await sendFeedback("like_style");
    } catch {
      setFeedbackStatus("\u53cd\u9988\u63d0\u4ea4\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002");
    } finally {
      setFeedbackPending(false);
    }
  }

  async function stopRadio() {
    const sessionDurationMs = radioSessionStartedAtRef.current ? Date.now() - radioSessionStartedAtRef.current : undefined;
    void saveWarmupBeforeStop();
    isRadioActiveRef.current = false;
    radioSessionStartedAtRef.current = null;
    transitionIdRef.current += 1;
    prepareIdRef.current += 1;
    transitionLockRef.current = false;
    stopAllAudio();
    clearPreparedNext();
    currentRef.current = null;
    speakingForRef.current = null;
    setCurrentItem(null);
    setSpeakingForItem(null);
    setPrepareStatus("not_ready");
    clearSongProgress();
    setFeedbackPending(false);
    setState("stopped");
    await playPrebuiltCue("radio_stop", { sessionDurationMs });
    await shutdownLocalServices();
  }


  async function saveWarmupBeforeStop() {
    try {
      await fetch("/api/player/stop", { method: "POST", keepalive: true });
    } catch (cause) {
      debugLog("[warmup] save on stop failed", cause);
    }
  }


  async function shutdownLocalServices() {
    try {
      await fetch("/api/system/shutdown", { method: "POST", keepalive: true });
    } catch (cause) {
      debugLog("[system] shutdown request failed", cause);
    } finally {
      window.setTimeout(() => {
        window.close();
        window.setTimeout(() => {
          try { window.location.href = "about:blank"; } catch {}
        }, 500);
      }, 700);
    }
  }

  function stopSongAudio() {
    const audio = songAudioRef.current;
    debugLog("[audio] stop song");
    if (!audio) return;
    cancelSongFades();
    resetSongWebAudioGain();
    audio.pause();
    audio.currentTime = 0;
    songLocalVolumeRef.current = AUDIO_VOLUME.songNormal;
    applySongVolume();
    audio.removeAttribute("src");
    audio.load();
    songFadeOutStartedRef.current = false;
    fadeTrackIdRef.current = null;
    if (activeAudioTypeRef.current === "song") activeAudioTypeRef.current = null;
  }

  function stopSpeechAudio() {
    const audio = speechAudioRef.current;
    debugLog("[audio] stop speech");
    speechResolveRef.current?.();
    speechResolveRef.current = null;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    ttsLocalVolumeRef.current = AUDIO_VOLUME.ttsNormal;
    applyTtsVolume();
    audio.removeAttribute("src");
    audio.load();
    if (activeAudioTypeRef.current === "speech") activeAudioTypeRef.current = null;
  }

  function stopEffectAudio() {
    const audio = effectAudioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute("src");
    audio.load();
  }

  function stopAllAudio() {
    stopSongAudio();
    stopSpeechAudio();
    pausedAudioTypeRef.current = null;
  }

  function clearSongProgress() {
    setCurrentTime(0);
    setSeekValue(0);
    setDuration(0);
    setIsSeeking(false);
  }

  function clearPreparedNext() {
    nextPreparedRef.current = null;
    setNextPreparedItem(null);
  }

  async function playPrebuiltCue(action: PrebuiltCueAction, options: { sessionDurationMs?: number } = {}) {
    const audio = effectAudioRef.current;
    if (!audio) return;
    const file = choosePrebuiltCueFile(action, options);
    const url = `/api/prebuilt-tts/file/${encodeURIComponent(file)}`;
    try {
      audio.pause();
      audio.currentTime = 0;
      audio.src = url;
      audio.load();
      audio.volume = computeEffectiveVolume({ masterVolume: masterVolumeRef.current, localVolume: AUDIO_VOLUME.ttsNormal, isMuted: isMutedRef.current });
      void logClientRuntimeEvent("prebuiltTts.play", "started", { action, file });
      await playAudioElement(audio);
      await new Promise<void>((resolve) => {
        const finish = () => {
          audio.onended = null;
          audio.onerror = null;
          resolve();
        };
        audio.onended = finish;
        audio.onerror = finish;
      });
      void logClientRuntimeEvent("prebuiltTts.play", "success", { action, file });
    } catch (cause) {
      void logClientRuntimeEvent("prebuiltTts.play", "error", { action, file, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }

  function choosePrebuiltCueFile(action: PrebuiltCueAction, options: { sessionDurationMs?: number } = {}) {
    const category = choosePrebuiltCueCategory(action, options);
    const variantCount = action === "change_track" || action === "skip_and_downrank" ? PREBUILT_TTS.variantsPerInteractionGroup : PREBUILT_TTS.variantsPerTimedGroup;
    const variant = Math.floor(Math.random() * variantCount) + 1;
    return `${action}.${category}.${String(variant).padStart(2, "0")}.wav`;
  }

  function choosePrebuiltCueCategory(action: PrebuiltCueAction, options: { sessionDurationMs?: number } = {}) {
    if (action === "change_track" || action === "skip_and_downrank") return "default";
    if (action === "radio_stop" && typeof options.sessionDurationMs === "number" && options.sessionDurationMs < PREBUILT_TTS.shortSessionMs) return "short_session_end";
    const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false }).format(new Date()));
    if (action === "radio_start") {
      if (hour >= 5 && hour < 9) return "just_woke";
      if (hour >= 9 && hour < 12) return "work_study";
      if (hour >= 12 && hour < 14) return "break_meal_idle";
      if (hour >= 14 && hour < 18) return "afternoon_late";
      if (hour >= 18 && hour < 23) return "evening_return";
      return "late_night_rest";
    }
    if (hour >= 9 && hour < 12) return "work_study_end";
    if (hour >= 12 && hour < 14) return "break_end";
    if (hour >= 14 && hour < 18) return "afternoon_late_end";
    if (hour >= 18 && hour < 23) return "evening_end";
    return "late_night_rest_end";
  }

  async function fetchNextItem(mode?: "prepare", scene?: "after_skip" | "after_like") {
    const startedAt = performance.now();
    const params = new URLSearchParams();
    if (mode) params.set("mode", mode);
    if (scene) params.set("scene", scene);
    const previousTrack = currentRef.current?.track;
    if (previousTrack) {
      params.set("previousTitle", previousTrack.title);
      params.set("previousArtist", previousTrack.artist);
      if (previousTrack.album) params.set("previousAlbum", previousTrack.album);
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";

    try {
      const timeoutMs = mode === "prepare" ? 125000 : NEXT_TIMEOUT_MS;
      const response = await fetchWithTimeout(`/api/next${suffix}`, { cache: "no-store" }, timeoutMs);
      const data = await response.json().catch(() => null);

      if (!response.ok || isRecommendationFailure(data)) {
        const failure = isRecommendationFailure(data) ? data : null;
        throw new Error(failure?.message ?? "\u65e0\u6cd5\u83b7\u53d6\u4e0b\u4e00\u9996\u3002\u8bf7\u68c0\u67e5 Last.fm \u548c\u97f3\u4e50 API \u914d\u7f6e\u3002");
      }

      return data as RadioNextResponse;
    } finally {
      perfLog(`/api/next${suffix}`, startedAt);
    }
  }

  async function sendFeedback(action: FeedbackAction) {
    const item = currentRef.current ?? speakingForRef.current;
    if (!item) return;

    const startedAt = performance.now();
    try {
      const response = await fetchWithTimeout("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, item })
      }, FEEDBACK_TIMEOUT_MS);

      if (!response.ok) throw new Error("鍙嶉鎻愪氦澶辫触");
    } finally {
      perfLog(`/api/feedback:${action}`, startedAt);
    }
  }

  async function handlePlaylistFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setPlaylistImportPending(true);
    setPlaylistImportStatus("");
    setPlaylistImportPreview(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetchWithTimeout("/api/playlist/import", { method: "POST", body: formData }, PLAYLIST_IMPORT_TIMEOUT_MS);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "\u6b4c\u5355\u89e3\u6790\u5931\u8d25");
      setPlaylistImportPreview(data as PlaylistImportPreview);
      setPlaylistImportStatus("\u5df2\u89e3\u6790\uff0c\u8bf7\u786e\u8ba4\u540e\u5199\u5165\u57fa\u7840\u6b4c\u5355\u3002");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "\u6b4c\u5355\u89e3\u6790\u5931\u8d25";
      setPlaylistImportStatus(message);
    } finally {
      setPlaylistImportPending(false);
    }
  }

  async function confirmPlaylistImport() {
    if (!playlistImportPreview || playlistImportPending) return;
    setPlaylistImportPending(true);
    try {
      const response = await fetchWithTimeout("/api/playlist/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: playlistImportMode, songs: playlistImportPreview.songs })
      }, PLAYLIST_IMPORT_TIMEOUT_MS);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "\u6b4c\u5355\u5199\u5165\u5931\u8d25");
      const status = playlistImportMode === "merge"
        ? `\u5df2\u5408\u5e76 ${data.addedCount} \u9996\uff0c\u57fa\u7840\u6b4c\u5355\u73b0\u6709 ${data.writtenCount} \u9996\u3002`
        : `\u5df2\u5199\u5165 ${data.writtenCount} \u9996\u57fa\u7840\u6b4c\u5355\u3002`;
      setPlaylistImportStatus(status);
      setPlaylistImportPreview(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "\u6b4c\u5355\u5199\u5165\u5931\u8d25";
      setPlaylistImportStatus(message);
    } finally {
      setPlaylistImportPending(false);
    }
  }

  async function submitSongRequest(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = requestSongText.trim();
    if (!text || requestSongPending) return;
    setRequestSongPending(true);
    setRequestSongStatus("loading");
    try {
      const response = await fetchWithTimeout("/api/request-song", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      }, REQUEST_SONG_TIMEOUT_MS);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message ?? "request_song_failed");
      setRequestSongText("");
      setRequestSongStatus("success");
      setPrepareStatus((current) => current === "ready" ? current : "preparing");
    } catch (cause) {
      setRequestSongStatus("error");
    } finally {
      setRequestSongPending(false);
    }
  }
  async function requestLocalUpdate() {
    if (updateStatus === "running") return;
    setUpdateStatus("running");
    try {
      const response = await fetch("/api/system/update", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error ?? "update_failed");
      setUpdateStatus("success");
    } catch {
      setUpdateStatus("error");
    }
  }

  function playSpeech(text: string, transitionId: number, nextAudioUrl?: string, ttsUrl?: string) {
    return new Promise<void>((resolve) => {
      if (!isLatestTransition(transitionId)) {
        resolve();
        return;
      }

      stopSongAudio();
      activeAudioTypeRef.current = "speech";
      pausedAudioTypeRef.current = null;
      speechResolveRef.current = resolve;

      if (ttsUrl && speechAudioRef.current) {
        void playSpeechAudioElement(ttsUrl, transitionId, nextAudioUrl).then(resolve);
        return;
      }
      speechResolveRef.current = null;
      activeAudioTypeRef.current = null;
      resolve();
      return;
    });
  }


  function playSpeechAudioElement(ttsUrl: string, transitionId: number, nextAudioUrl?: string) {
    return new Promise<void>((resolve) => {
      const audio = speechAudioRef.current;
      if (!audio || !isLatestTransition(transitionId)) {
        resolve();
        return;
      }
      activeAudioTypeRef.current = "speech";
      ttsLocalVolumeRef.current = AUDIO_VOLUME.ttsNormal;
      applyTtsVolume();
      audio.src = ttsUrl;
      audio.load();
      let fadeInTimer: number | null = null;
      let startedSong = false;
      const clear = () => {
        if (fadeInTimer) window.clearTimeout(fadeInTimer);
        audio.onloadedmetadata = null;
        audio.onended = null;
        audio.onerror = null;
      };
      audio.onloadedmetadata = () => {
        const fadePlan = computeDjToSongFadePlan({
          ttsDurationSec: Number.isFinite(audio.duration) ? audio.duration : 0,
          crossfadeBeforeDjEndsSec: AUDIO_TRANSITION.crossfadeBeforeDjEndsSec,
          normalFadeInSec: AUDIO_TRANSITION.nextSongFadeInSec,
          shortTtsThresholdSec: AUDIO_TRANSITION.shortTtsThresholdSec,
          shortTtsSongFadeInSec: AUDIO_TRANSITION.shortTtsSongFadeInSec,
          minFadeInMs: AUDIO_TRANSITION.minFadeInMs
        });
        if (nextAudioUrl) {
          fadeInTimer = window.setTimeout(() => {
            if (!isLatestTransition(transitionId) || nextSongStartedRef.current || startedSong) return;
            startedSong = true;
            debugLog("[audio] qwen tts near end, starting song fade in", fadePlan.mode);
            void startNextSongFadeIn(nextAudioUrl, transitionId, fadePlan.fadeInDurationMs);
          }, Math.max(0, fadePlan.startSongAtTtsTimeSec * 1000));
        }
      };
      audio.onended = () => {
        clear();
        finishSpeech(resolve);
      };
      audio.onerror = () => {
        clear();
        finishSpeech(resolve);
      };
      audio.play().catch(() => {
        clear();
        finishSpeech(resolve);
      });
    });
  }

  function finishSpeech(resolve: () => void) {
    speechResolveRef.current = null;
    if (activeAudioTypeRef.current === "speech") activeAudioTypeRef.current = null;
    resolve();
  }

  async function playSong(audioUrl: string, transitionId: number, options: { fadeIn?: boolean; keepSpeechActive?: boolean; fadeInDurationMs?: number } = {}) {
    if (!songAudioRef.current || !audioUrl || !isLatestTransition(transitionId)) return;
    try {
      await playSongUrl(audioUrl, transitionId, options);
    } catch (cause) {
      debugLog("[audio] song source failed", cause);
      void logClientRuntimeEvent("audio.playSong", "error", {
        error: cause instanceof Error ? cause.message : String(cause),
        track: `${currentRef.current?.track.title ?? speakingForRef.current?.track.title ?? ""} - ${currentRef.current?.track.artist ?? speakingForRef.current?.track.artist ?? ""}`,
        audioUrl: safeUrlForLog(audioUrl)
      });
      const fallback = await resolveAlternateSongAudio(audioUrl);
      if (!fallback || !isLatestTransition(transitionId)) {
        await recoverFromUnplayableSongSource(transitionId);
        return;
      }
      await playSongUrl(fallback.track.audioUrl, transitionId, options);
    }
  }

  async function playSongUrl(audioUrl: string, transitionId: number, options: { fadeIn?: boolean; keepSpeechActive?: boolean; fadeInDurationMs?: number } = {}) {
    if (!songAudioRef.current || !audioUrl || !isLatestTransition(transitionId)) return;
    if (!options.keepSpeechActive) {
      stopSpeechAudio();
      activeAudioTypeRef.current = "song";
    }
    pausedAudioTypeRef.current = null;
    const audio = songAudioRef.current;
    cancelSongFades();
    songFadeOutStartedRef.current = false;
    fadeTrackIdRef.current = currentRef.current?.track.id ?? speakingForRef.current?.track.id ?? null;
    const fadeInDurationMs = options.fadeInDurationMs ?? AUDIO_TRANSITION.nextSongFadeInSec * 1000;
    const shouldUseFrameFadeIn = Boolean(options.fadeIn && !document.hidden);
    const webAudioFadeStarted = Boolean(options.fadeIn && document.hidden && await startSongWebAudioFadeIn(fadeInDurationMs));
    if (options.fadeIn && document.hidden && webAudioFadeStarted) {
      debugLog("[audio] page hidden, using Web Audio song fade in");
      void logClientRuntimeEvent("audio.fadeIn", "info", { reason: "hidden_page_web_audio", track: currentRef.current?.track.title ?? speakingForRef.current?.track.title ?? null });
    }
    if (!webAudioFadeStarted) resetSongWebAudioGain();
    songLocalVolumeRef.current = shouldUseFrameFadeIn ? 0 : AUDIO_VOLUME.songNormal;
    applySongVolume();
    audio.src = audioUrl;
    audio.load();
    await playAudioElement(audio);
    applySongVolume();
    triggerImmediateNextPreparation("song_audio_playing");
    if (shouldUseFrameFadeIn) {
      const controller = new AbortController();
      songFadeInAbortRef.current = controller;
      debugLog("[audio] song fade in started");
      await fadeVolume({
        audio,
        from: songLocalVolumeRef.current,
        to: AUDIO_VOLUME.songNormal,
        durationMs: fadeInDurationMs,
        signal: controller.signal,
        onFrame: (volume) => {
          songLocalVolumeRef.current = volume;
          applySongVolume();
        },
        onComplete: () => {
          songLocalVolumeRef.current = AUDIO_VOLUME.songNormal;
          applySongVolume();
        },
        onAbort: () => {
          debugLog("[audio] fade aborted", "song fade in");
          applySongVolume();
        }
      });
      if (songFadeInAbortRef.current === controller) songFadeInAbortRef.current = null;
      debugLog("[audio] song fade in complete");
    }
  }

  async function startSongWebAudioFadeIn(durationMs: number, fromGain = 0.0001) {
    const audio = songAudioRef.current;
    if (!audio || typeof window === "undefined") return false;
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return false;

    try {
      const context = songAudioContextRef.current ?? new AudioContextCtor();
      songAudioContextRef.current = context;
      if (context.state === "suspended") await context.resume();
      if (!songGainNodeRef.current || !songMediaSourceRef.current) {
        const source = context.createMediaElementSource(audio);
        const gain = context.createGain();
        source.connect(gain);
        gain.connect(context.destination);
        songMediaSourceRef.current = source;
        songGainNodeRef.current = gain;
      }

      const gain = songGainNodeRef.current;
      const now = context.currentTime;
      const durationSec = Math.max(AUDIO_TRANSITION.minFadeInMs, durationMs) / 1000;
      if (songWebAudioFadeTimerRef.current) window.clearTimeout(songWebAudioFadeTimerRef.current);
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(Math.max(0.0001, Math.min(1, fromGain)), now);
      gain.gain.exponentialRampToValueAtTime(1, now + durationSec);
      songWebAudioFadeTimerRef.current = window.setTimeout(() => {
        resetSongWebAudioGain();
        debugLog("[audio] Web Audio song fade in complete");
      }, durationSec * 1000 + 100);
      return true;
    } catch (cause) {
      debugLog("[audio] Web Audio fade in unavailable", cause);
      void logClientRuntimeEvent("audio.fadeIn", "error", { reason: "web_audio_unavailable", error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    }
  }

  function resetSongWebAudioGain() {
    const gain = songGainNodeRef.current;
    const context = songAudioContextRef.current;
    if (songWebAudioFadeTimerRef.current) {
      window.clearTimeout(songWebAudioFadeTimerRef.current);
      songWebAudioFadeTimerRef.current = null;
    }
    if (!gain || !context) return;
    const now = context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(1, now);
  }

  function playAudioElement(audio: HTMLAudioElement) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        audio.removeEventListener("canplay", onPlayable);
        audio.removeEventListener("playing", onPlaying);
        audio.removeEventListener("error", onError);
      };
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const rejectOnce = (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      };
      const onPlayable = () => resolveOnce();
      const onPlaying = () => resolveOnce();
      const onError = () => {
        const hasStarted = audio.currentTime > 0.5 || (!audio.paused && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
        if (hasStarted) {
          debugLog("[audio] ignored late media error after playback started", audio.error?.message);
          resolveOnce();
          return;
        }
        rejectOnce(new Error(audio.error?.message || "audio_source_error"));
      };
      audio.addEventListener("canplay", onPlayable, { once: true });
      audio.addEventListener("playing", onPlaying, { once: true });
      audio.addEventListener("error", onError, { once: true });
      audio.play().then(() => {
        resolveOnce();
      }).catch((cause) => {
        rejectOnce(cause);
      });
    });
  }

  async function resolveAlternateSongAudio(failedAudioUrl: string) {
    const item = currentRef.current ?? speakingForRef.current;
    if (!item) return null;
    const key = `${item.track.id}:${failedAudioUrl}`;
    if (audioFallbackAttemptsRef.current.has(key)) return null;
    audioFallbackAttemptsRef.current.add(key);

    const excludeProviders = [item.selectedProvider, providerFromAudioUrl(failedAudioUrl)].filter(Boolean);
    const response = await fetchWithTimeout("/api/audio/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: item.track.title,
        artist: item.track.artist,
        album: item.track.album,
        failedAudioUrl,
        excludeProviders
      })
    }, 20000);
    const data = await response.json().catch(() => null) as null | { ok?: boolean; selectedProvider?: string; track?: RadioTrack };
    if (!response.ok || !data?.ok || !data.track?.audioUrl) {
      void logClientRuntimeEvent("audio.resolveFallback.client", "error", {
        track: `${item.track.title} - ${item.track.artist}`,
        failedAudioUrl: safeUrlForLog(failedAudioUrl),
        message: "no_client_alternate"
      });
      return null;
    }

    item.track = { ...item.track, ...data.track, title: item.track.title, artist: item.track.artist, album: item.track.album };
    item.selectedProvider = data.selectedProvider ?? item.selectedProvider;
    if (currentRef.current?.track.id === item.track.id) setCurrentItem({ ...item });
    if (speakingForRef.current?.track.id === item.track.id) setSpeakingForItem({ ...item });
    if (nextPreparedRef.current?.track.id === item.track.id) setNextPreparedItem({ ...item });
    debugLog("[audio] switched song source", data.selectedProvider);
    return item;
  }


  async function recoverFromUnplayableSongSource(transitionId: number) {
    if (!isLatestTransition(transitionId) || !isRadioActiveRef.current) return;
    debugLog("[audio] current song unplayable, fetching replacement");
    void logClientRuntimeEvent("audio.recoverUnplayable", "started", {
      track: `${currentRef.current?.track.title ?? speakingForRef.current?.track.title ?? ""} - ${currentRef.current?.track.artist ?? speakingForRef.current?.track.artist ?? ""}`
    });
    stopSongAudio();
    clearSongProgress();
    clearPreparedNext();
    const replacement = await fetchNextItem(undefined, "after_skip");
    if (!isLatestTransition(transitionId)) return;
    await playRadioItem(replacement, transitionId);
  }
  function providerFromAudioUrl(value: string) {
    const lowered = value.toLowerCase();
    if (lowered.includes("netease")) return "netease";
    if (lowered.includes("spotify")) return "spotify";
    if (lowered.includes("tencent") || lowered.includes("qq.com")) return "tencent";
    if (lowered.includes("apple")) return "apple";
    return "";
  }
  function safeUrlForLog(value: string) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname.slice(0, 80)}`;
    } catch {
      return value.slice(0, 120);
    }
  }

  async function logClientRuntimeEvent(step: string, status: "started" | "success" | "error" | "info", context?: Record<string, unknown>) {
    try {
      await fetch("/api/debug/runtime-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step, status, context })
      });
    } catch {
      // Best effort only. Playback should never wait for diagnostics.
    }
  }

  function handleSeekStart() {
    if (!isSongSeekEnabled) return;
    setIsSeeking(true);
  }

  function handleSeekChange(value: string) {
    if (!isSongSeekEnabled) return;
    setSeekValue(Number(value));
  }

  function commitSeek() {
    if (!songAudioRef.current || !isSongSeekEnabled || !Number.isFinite(duration) || duration <= 0) {
      setIsSeeking(false);
      return;
    }

    songAudioRef.current.currentTime = seekValue;
    setCurrentTime(seekValue);
    setIsSeeking(false);
    maybePrepareFromTime(seekValue, duration);
  }

  function maybePrepareFromTime(time: number, total: number) {
    if (!Number.isFinite(total) || total <= 0) return;
    const remaining = total - time;
    const shouldPrepareByRemaining = remaining <= PLAYBACK_TIMING.prepareNextTrackBeforeEndSec;
    const shouldPrepareShortTrack = total < 150 && time / total >= 0.5;
    const shouldPrepareByProgress = time / total >= PLAYBACK_TIMING.fallbackPrepareAtProgress && remaining <= PLAYBACK_TIMING.minRemainingSecToStartPrepare;
    if (shouldPrepareByRemaining || shouldPrepareShortTrack || shouldPrepareByProgress) void prepareNext();
  }

  function maybeFadeOutSongFromTime(time: number, total: number) {
    if (activeAudioTypeRef.current !== "song" || !songAudioRef.current || !Number.isFinite(total) || total <= 0) return;
    const trackId = currentRef.current?.track.id;
    if (!trackId) return;
    if (fadeTrackIdRef.current !== trackId) {
      songFadeOutStartedRef.current = false;
      fadeTrackIdRef.current = trackId;
    }

    const remaining = total - time;
    if (remaining <= AUDIO_TRANSITION.songFadeOutSec && !songFadeOutStartedRef.current) {
      void startSongFadeOut(Math.max(300, remaining * 1000));
    }
  }

  async function startSongFadeOut(durationMs: number) {
    const audio = songAudioRef.current;
    if (!audio || songFadeOutStartedRef.current) return;
    songFadeOutStartedRef.current = true;
    songFadeAbortRef.current?.abort();
    const controller = new AbortController();
    songFadeAbortRef.current = controller;
    debugLog("[audio] song fade out started");
    await fadeVolume({
      audio,
      from: songLocalVolumeRef.current,
      to: 0,
      durationMs,
      signal: controller.signal,
      onFrame: (volume) => {
        songLocalVolumeRef.current = volume;
        applySongVolume();
      },
      onComplete: () => {
        songLocalVolumeRef.current = 0;
        applySongVolume();
      },
      onAbort: () => {
        debugLog("[audio] fade aborted", "song fade out");
        applySongVolume();
      }
    });
    if (songFadeAbortRef.current === controller) songFadeAbortRef.current = null;
    debugLog("[audio] song fade out complete");
  }

  async function fadeOutSongForManualTransition() {
    const audio = songAudioRef.current;
    if (activeAudioTypeRef.current !== "song" || !audio || audio.paused || !audio.src) return;
    songFadeAbortRef.current?.abort();
    const controller = new AbortController();
    songFadeAbortRef.current = controller;
    debugLog("[audio] song fade out started");
    await fadeVolume({
      audio,
      from: songLocalVolumeRef.current,
      to: 0,
      durationMs: AUDIO_TRANSITION.songManualSkipFadeOutMs,
      signal: controller.signal,
      onFrame: (volume) => {
        songLocalVolumeRef.current = volume;
        applySongVolume();
      },
      onComplete: () => {
        songLocalVolumeRef.current = 0;
        applySongVolume();
      },
      onAbort: () => {
        debugLog("[audio] fade aborted", "manual skip");
        applySongVolume();
      }
    });
    if (songFadeAbortRef.current === controller) songFadeAbortRef.current = null;
    debugLog("[audio] song fade out complete");
  }

  async function startNextSongFadeIn(audioUrl: string, transitionId: number, fadeInDurationMs: number) {
    if (nextSongStartedRef.current || !isLatestTransition(transitionId)) return;
    nextSongStartedRef.current = true;
    try {
      await playSong(audioUrl, transitionId, { fadeIn: true, keepSpeechActive: true, fadeInDurationMs });
    } catch (cause) {
      nextSongStartedRef.current = false;
      debugLog("[audio] song fade in failed", cause);
    }
  }

  function cancelSongFades() {
    songFadeAbortRef.current?.abort();
    songFadeInAbortRef.current?.abort();
    songFadeAbortRef.current = null;
    songFadeInAbortRef.current = null;
  }

  function handleVolumeChange(value: string) {
    const next = clampVolume(Number(value));
    masterVolumeRef.current = next;
    setMasterVolume(next);
    debugLog("[audio] volume changed", next);
    resyncAudioElementsVolume(next, isMutedRef.current);
  }

  function toggleMute() {
    const next = !isMutedRef.current;
    isMutedRef.current = next;
    setIsMuted(next);
    resyncAudioElementsVolume(masterVolumeRef.current, next);
  }

  function resyncAudioElementsVolume(master = masterVolumeRef.current, muted = isMutedRef.current) {
    applySongVolume(master, muted);
    applyTtsVolume(master, muted);
  }

  function stabilizeSongAudioForBackground() {
    const audio = songAudioRef.current;
    if (!audio || !audio.src || playerStateRef.current === "paused") return;
    if (songFadeInAbortRef.current && songLocalVolumeRef.current < AUDIO_VOLUME.songNormal) {
      const currentFadeProgress = Math.max(0.0001, Math.min(1, songLocalVolumeRef.current / AUDIO_VOLUME.songNormal));
      const remainingFadeMs = Math.max(AUDIO_TRANSITION.minFadeInMs, AUDIO_TRANSITION.nextSongFadeInSec * 1000 * (1 - currentFadeProgress));
      debugLog("[audio] page hidden during song fade in, handing off to Web Audio", currentFadeProgress);
      songFadeInAbortRef.current.abort();
      songFadeInAbortRef.current = null;
      songLocalVolumeRef.current = AUDIO_VOLUME.songNormal;
      applySongVolume();
      void startSongWebAudioFadeIn(remainingFadeMs, currentFadeProgress);
      void logClientRuntimeEvent("audio.fadeIn", "info", { reason: "visibility_hidden_web_audio_handoff", track: currentRef.current?.track.title ?? speakingForRef.current?.track.title ?? null });
      return;
    }
    if (activeAudioTypeRef.current === "song" && !audio.paused && songLocalVolumeRef.current <= 0 && !isMutedRef.current) {
      debugLog("[audio] hidden page song volume was zero, restoring normal volume");
      songLocalVolumeRef.current = AUDIO_VOLUME.songNormal;
      applySongVolume();
      void logClientRuntimeEvent("audio.volume", "info", { reason: "hidden_page_restore_zero_song_volume", track: currentRef.current?.track.title ?? null });
    }
  }

  function resumeSongIfBrowserPausedIt() {
    const audio = songAudioRef.current;
    if (!audio || activeAudioTypeRef.current !== "song" || playerStateRef.current === "paused" || !audio.src) return;
    if (!audio.paused) return;
    void logClientRuntimeEvent("audio.resume", "info", { reason: "visibility_restore", track: currentRef.current?.track.title ?? null });
    void audio.play().catch((cause) => debugLog("[audio] resume after visibility restore failed", cause));
  }

  function applySongVolume(master = masterVolumeRef.current, muted = isMutedRef.current) {
    if (!songAudioRef.current) return;
    const volume = computeEffectiveVolume({ masterVolume: master, localVolume: songLocalVolumeRef.current, isMuted: muted });
    songAudioRef.current.volume = volume;
    debugLog("[audio] song effective volume", volume);
  }

  function applyTtsVolume(master = masterVolumeRef.current, muted = isMutedRef.current) {
    if (!speechAudioRef.current) return;
    const volume = computeEffectiveVolume({ masterVolume: master, localVolume: ttsLocalVolumeRef.current, isMuted: muted });
    speechAudioRef.current.volume = volume;
    debugLog("[audio] tts effective volume", volume);
  }

  function estimateSpeechDurationMs(text: string) {
    const chineseCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const otherCount = Math.max(0, text.length - chineseCount);
    return Math.max(2500, Math.min(14000, chineseCount * 220 + otherCount * 90));
  }

  function getRecentTrackKey(track: RadioTrack) {
    return `${track.id}::${track.title}::${track.artist}`.toLowerCase();
  }

  function pushRecentTrack(track: RadioTrack) {
    setRecentTracks((tracks) => [track, ...tracks.filter((item) => getRecentTrackKey(item) !== getRecentTrackKey(track))].slice(0, RECENT_UI_LIMIT));
  }

  function markRecentTrackFeedback(track: RadioTrack, feedback: RecentTrackFeedback) {
    const key = getRecentTrackKey(track);
    setRecentTrackFeedback((current) => ({ ...current, [key]: feedback }));
  }

  function removeRecentTrack(track: RadioTrack) {
    const key = getRecentTrackKey(track);
    setRecentTracks((tracks) => tracks.filter((item) => getRecentTrackKey(item) !== key));
    setRecentTrackFeedback((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function handleError(cause: unknown, prefix = "") {
    const rawMessage = cause instanceof Error ? cause.message : "鏈煡閿欒";
    const message = rawMessage.includes("aborted") || rawMessage.includes("AbortError") ? "\u8bf7\u6c42\u8d85\u65f6\u6216\u88ab\u53d6\u6d88\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002" : rawMessage;
    setError(`${prefix}${message}`.trim());
    setState("error");
  }

  function nextTransitionId() {
    transitionIdRef.current += 1;
    return transitionIdRef.current;
  }

  function isLatestTransition(id: number) {
    return id === transitionIdRef.current;
  }


  async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  const displayItem = playerState === "speaking" ? speakingForItem : currentItem;
  const displayTrack = displayItem?.track;
  const isPaused = playerState === "paused";
  const canControl = (currentItem !== null || speakingForItem !== null) && playerState !== "idle" && playerState !== "stopped";
  const feedbackDisabled = !canControl || feedbackPending || transitionLockRef.current;
  const isSongSeekEnabled = (playerState === "playing" || playerState === "preparing_next" || (playerState === "paused" && pausedAudioTypeRef.current === "song")) && Boolean(songAudioRef.current?.src) && duration > 0;
  const progressValue = isSongSeekEnabled ? (isSeeking ? seekValue : currentTime) : 0;
  const sourceSeedText = displayItem ? [displayItem.sourceSeed.title, displayItem.sourceSeed.artist].filter(Boolean).join(" - ") : "-";
  const artworkUrl = displayTrack?.coverUrl ?? "";
  const artworkKey = displayTrack ? `${displayTrack.id}-${displayTrack.coverUrl ?? ""}` : "placeholder-cover";
  const backgroundStyle = artworkUrl
    ? ({ "--album-art-url": `url("${artworkUrl.replace(/"/g, '\\"')}")` } as CSSProperties)
    : undefined;
  const canToggleRecentTracks = recentTracks.length > 4;
  const visibleRecentTracks = isHistoryExpanded ? recentTracks : recentTracks.slice(0, 4);

  const serverOnline = localServiceStatus?.server.ok ?? true;
  const ttsOnline = localServiceStatus?.tts.ok ?? false;
  const logoSrc = theme === "ivory" ? "/api/assets/logo?theme=ivory&v=white-20260514" : "/api/assets/logo?v=svg-20260514";
  const searchIconSrc = theme === "ivory" ? "/api/assets/icon/search?v=20260520" : "/api/assets/icon/search-white?v=20260520";

  return (
    <main className="shell your-radio-page" data-theme={theme} style={backgroundStyle}>
      <div className="app-background" aria-hidden="true">
        {artworkUrl ? <div className="album-bg-blur" /> : null}
        <div className="album-bg-gradient" />
        <div className="album-bg-noise" />
      </div>
      <div className="app">
        <header className="topbar">
          <div>
            <h1 className="title"><img className="brand-logo" src={logoSrc} alt="YourRadio" /></h1>
          </div>
          <div className="top-status-cluster" aria-label="Local service status">
            <form className="request-song-form" data-open={isRequestSongOpen} onSubmit={(event) => void submitSongRequest(event)}>
              {isRequestSongOpen ? (
                <div className="request-song-row">
                  <input
                    id="request-song-input"
                    className="request-song-input"
                    value={requestSongText}
                    disabled={requestSongPending}
                    onChange={(event) => setRequestSongText(event.target.value)}
                    placeholder={"\u6bd4\u5982\u8bf4\"Maroon5-this love\""}
                    aria-label={"\u641c\u7d22\u5e76\u52a0\u5165\u60f3\u542c\u7684\u6b4c"}
                    autoFocus
                  />
                  <button className="request-song-icon-button" type="submit" data-status={requestSongStatus} disabled={requestSongPending || !requestSongText.trim()} aria-label={requestSongPending ? "\u67e5\u627e\u4e2d" : "\u52a0\u5165\u961f\u5217"}>
                    {requestSongStatus === "loading" ? (
                      <span className="request-song-spinner" aria-hidden="true" />
                    ) : requestSongStatus === "success" ? (
                      <span className="request-song-check" aria-hidden="true" />
                    ) : (
                      <img className="request-song-icon" src={searchIconSrc} alt="" aria-hidden="true" />
                    )}
                  </button>
                </div>
              ) : (
                <button className="request-song-collapsed" type="button" onClick={() => setIsRequestSongOpen(true)} aria-label={"\u6253\u5f00\u70b9\u6b4c\u641c\u7d22"}>
                  <img className="request-song-icon" src={searchIconSrc} alt="" aria-hidden="true" />
                  <span>{"\u60f3\u542c\u4ec0\u4e48\uff1f"}</span>
                </button>
              )}
            </form>
            <button className="theme-toggle-button" type="button" onClick={toggleTheme} aria-label={"\u5207\u6362\u64ad\u653e\u5668\u989c\u8272"} data-theme-value={theme}>
              <span className="theme-switch-option" data-active={theme === "dark"}>{"\u6df1\u8272"}</span>
              <span className="theme-switch-option" data-active={theme === "ivory"}>{"\u7c73\u8272"}</span>
            </button>
            <div className="status">{stateLabel(playerState)}</div>
          </div>
        </header>

        <section className="studio">
          <article className="panel main-panel">
            <div className="player-card">
              <div className="player-service-lights" aria-label="Local service status">
                <div className="service-pill service-light-only" data-online={serverOnline} title={serverOnline ? "Server online" : "Server offline"} aria-label={serverOnline ? "Server online" : "Server offline"}>
                  <span className="service-dot" />
                </div>
                <div className="service-pill service-light-only" data-online={ttsOnline} title={ttsOnline ? "TTS online" : localServiceStatus?.tts.error ?? "TTS offline"} aria-label={ttsOnline ? "TTS online" : "TTS offline"}>
                  <span className="service-dot" />
                </div>
              </div>
              <div className="cover-wrap fade-in" key={artworkKey}>
                {displayTrack?.coverUrl ? <img src={displayTrack.coverUrl} alt="" className="cover" /> : <div className="cover placeholder-cover" aria-hidden="true" />}
              </div>
              <div className="player-info">
                <p className="label">{playerState === "speaking" ? "\u6b63\u5728\u64ad\u653e DJ \u6587\u6848" : "\u5f53\u524d\u6b4c\u66f2"}</p>
                <h2 className="song-title">{displayTrack?.title ?? "\u8fd8\u6ca1\u6709\u5f00\u59cb\u64ad\u653e"}</h2>
                <div className="song-meta">
                  <span>{displayTrack?.artist ?? "\u7b49\u5f85\u7535\u53f0\u542f\u52a8"}</span>
                  {displayTrack ? <span>{displayTrack.album || "\u672a\u77e5\u4e13\u8f91"}</span> : null}
                </div>
                <input
                  className="seek-range"
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.1}
                  value={progressValue}
                  disabled={!isSongSeekEnabled}
                  onMouseDown={handleSeekStart}
                  onTouchStart={handleSeekStart}
                  onChange={(event) => handleSeekChange(event.target.value)}
                  onMouseUp={commitSeek}
                  onTouchEnd={commitSeek}
                />
                <div className="time-row"><span>{formatTime(progressValue)}</span><span>{formatTime(isSongSeekEnabled ? duration : 0)}</span></div>
                <div className="playback-tools-row">
                  <div className="inline-controls">
                    <button className="button mini" disabled={!canControl} onClick={() => void pauseOrResumeRadio()}>
                      {isPaused ? "\u7ee7\u7eed" : "\u6682\u505c"}
                    </button>
                    <button className="button mini" onClick={toggleMute}>{isMuted ? "\u53d6\u6d88\u9759\u97f3" : "\u9759\u97f3"}</button>
                  </div>
                  <label className="volume-control">
                    <span>{"\u97f3\u91cf"}</span>
                    <input type="range" min={0} max={1} step={0.01} value={masterVolume} onChange={(event) => handleVolumeChange(event.target.value)} />
                  </label>
                </div>
              </div>
            </div>

            <div className="script">{displayItem?.djLine ?? "\u70b9\u51fb\u5f00\u59cb\u7535\u53f0\u540e\uff0c\u8fd9\u91cc\u4f1a\u663e\u793a AI \u4e3b\u64ad\u4e32\u573a\u6587\u6848\u3002"}</div>

            <audio ref={songAudioRef} className="hidden-audio" onTimeUpdate={handleSongTimeUpdate} onLoadedMetadata={handleSongTimeUpdate} onEnded={() => void handleSongEnded()} />
            <audio ref={speechAudioRef} className="hidden-audio" />
            <audio ref={effectAudioRef} className="hidden-audio" />


            {error ? <div className="error">{error}</div> : null}
            <div className="controls-below">
              <div className="actions">
                <button className="button primary" disabled={playerState !== "idle" && playerState !== "stopped" && playerState !== "error"} onClick={startRadio}>{"\u5f00\u59cb\u7535\u53f0"}</button>
                <button className="button" disabled={!canControl} onClick={() => void pauseOrResumeRadio()}>{isPaused ? "\u7ee7\u7eed\u7535\u53f0" : "\u6682\u505c\u7535\u53f0"}</button>
                <button className="button" disabled={feedbackDisabled} onClick={() => void neutralNext()}>{"\u6362\u4e00\u9996\uff08\u4e0d\u964d\u6743\uff09"}</button>
                <button className="button danger" disabled={feedbackDisabled} onClick={() => void skipAndReduce()}>{"\u8df3\u8fc7\u5e76\u51cf\u5c11\u63a8\u8350"}</button>
                <button className="button" disabled={feedbackDisabled} onClick={() => void likeCurrentStyle()}>{"\u559c\u6b22\u8fd9\u79cd\u98ce\u683c"}</button>
                <button className="button primary" disabled={!canControl} onClick={() => void stopRadio()}>{"\u505c\u6b62\u7535\u53f0"}</button>
              </div>

              {feedbackStatus ? <p className="feedback">{feedbackStatus}</p> : null}
            </div>
          </article>
        </section>

        <section className="panel history-panel">
          <div className="history-panel-header">
            <p className="label">{"\u6700\u8fd1\u64ad\u653e"}</p>
            {canToggleRecentTracks ? (
              <button className="history-toggle" type="button" onClick={() => setIsHistoryExpanded((current) => !current)}>
                {isHistoryExpanded ? "\u6536\u8d77" : `\u5c55\u5f00 ${recentTracks.length - 4}`}
              </button>
            ) : null}
          </div>
          {recentTracks.length === 0 ? <p className="muted">{"\u8fd8\u6ca1\u6709\u6700\u8fd1\u64ad\u653e\u8bb0\u5f55\u3002"}</p> : (
            <ol className="history-list" data-expanded={isHistoryExpanded}>
              {visibleRecentTracks.map((track) => {
                const marker = recentTrackFeedback[getRecentTrackKey(track)];
                return (
                  <li key={getRecentTrackKey(track)}>
                    <span>{track.title}</span>
                    <small>{track.artist} / {track.album}</small>
                    {marker === "liked_style" ? <img className="history-mark" src="/api/assets/icon/heart?v=new-heart-20260514" alt="" aria-hidden="true" /> : null}
                    {marker === "changed" ? <img className="history-mark" src="/api/assets/icon/ellipsis?v=top-20260514" alt="" aria-hidden="true" /> : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="panel playlist-import-panel">
          <div className="playlist-import-header">
            <p className="label">{"\u5bfc\u5165\u57fa\u7840\u6b4c\u5355"}</p>
            <span className="muted">CSV / XLSX</span>
          </div>
          <p className="muted playlist-import-help">{"\u81f3\u5c11\u9700\u8981\u6b4c\u540d\u548c\u6b4c\u624b\uff0c\u53ef\u8bc6\u522b title / \u6b4c\u66f2\u540d / \u6b4c\u540d \u4e0e artist / \u827a\u672f\u5bb6 / \u6b4c\u624b \u7b49\u8868\u5934\u3002"}</p>
          <div className="playlist-import-toolbar">
            <input
              ref={playlistFileInputRef}
              className="playlist-file-input"
              type="file"
              accept=".csv,.xlsx"
              disabled={playlistImportPending}
              onChange={(event) => void handlePlaylistFileChange(event)}
            />
            <button
              className="button playlist-file-button"
              type="button"
              disabled={playlistImportPending}
              onClick={() => playlistFileInputRef.current?.click()}
            >
              {playlistImportPending ? "\u5904\u7406\u4e2d" : "\u9009\u62e9\u6b4c\u5355\u6587\u4ef6"}
            </button>
            <div className="playlist-import-mode" role="radiogroup" aria-label="\u5bfc\u5165\u65b9\u5f0f">
              <label><input type="radio" checked={playlistImportMode === "replace"} onChange={() => setPlaylistImportMode("replace")} />{"\u8986\u76d6"}</label>
              <label><input type="radio" checked={playlistImportMode === "merge"} onChange={() => setPlaylistImportMode("merge")} />{"\u5408\u5e76"}</label>
            </div>
          </div>
          {playlistImportPreview ? (
            <div className="playlist-import-preview">
              <p>{`\u8bfb\u53d6 ${playlistImportPreview.summary.rowsRead} \u884c\uff0c\u53ef\u5bfc\u5165 ${playlistImportPreview.summary.importedCount} \u9996\uff0c\u8df3\u8fc7 ${playlistImportPreview.summary.rejectedCount} \u884c\uff0c\u53bb\u91cd ${playlistImportPreview.summary.duplicateCount} \u9996\u3002`}</p>
              <ol>
                {playlistImportPreview.previewSongs.map((song) => <li key={`${song.title}::${song.artist}`}>{song.title} / {song.artist}</li>)}
              </ol>
              <button className="button primary" disabled={playlistImportPending} onClick={() => void confirmPlaylistImport()}>{"\u786e\u8ba4\u5199\u5165"}</button>
            </div>
          ) : null}
          {playlistImportStatus ? <p className="feedback playlist-import-status">{playlistImportStatus}</p> : null}
        </section>
      </div>
      <div className="corner-tools" data-open={isToolMenuOpen}>
        {isToolMenuOpen ? (
          <div className="corner-tools-menu">
            <a className="corner-tool-item" href="https://github.com/jayceto946-byte" target="_blank" rel="noreferrer">GitHub 主页</a>
            <button className="corner-tool-item" type="button" onClick={() => void requestLocalUpdate()} disabled={updateStatus === "running"}>
              {updateStatus === "running" ? "更新中" : updateStatus === "success" ? "已开始更新" : updateStatus === "error" ? "更新失败" : "一键更新"}
            </button>
          </div>
        ) : null}
        <button className="corner-tool-button" type="button" onClick={() => setIsToolMenuOpen((current) => !current)} aria-label="打开工具菜单">
          <span aria-hidden="true">•••</span>
        </button>
      </div>
    </main>
  );
}











































