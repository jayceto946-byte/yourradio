"use client";

import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
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
const PREPARE_END_WAIT_MS = 3000;
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
  not_ready: "未准备",
  preparing: "正在准备下一首",
  ready: "已准备"
};

function debugLog(message: string, detail?: unknown) {
  if (isDev) console.log(message, detail ?? "");
}

function perfLog(name: string, start: number) {
  if (isDev) console.log(`[perf] ${name}: ${Math.round(performance.now() - start)}ms`);
}

function stateLabel(state: PlayerState) {
  const labels: Record<PlayerState, string> = {
    idle: "待机",
    preparing: "准备中",
    speaking: "DJ 串场",
    playing: "播放中",
    preparing_next: "播放中 / 预备下一首",
    transitioning: "切歌中",
    paused: "已暂停",
    stopped: "已停止",
    error: "出错"
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
  const transitionLockRef = useRef(false);
  const isRadioActiveRef = useRef(false);
  const playerStateRef = useRef<PlayerState>("idle");
  const transitionIdRef = useRef(0);
  const prepareIdRef = useRef(0);
  const speechResolveRef = useRef<(() => void) | null>(null);
  const songFadeAbortRef = useRef<AbortController | null>(null);
  const songFadeInAbortRef = useRef<AbortController | null>(null);
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
    let cancelled = false;
    let timer: number | undefined;

    const refresh = async () => {
      try {
        const response = await fetch("/api/system/status", { cache: "no-store" });
        const data = await response.json();
        if (!cancelled) setLocalServiceStatus(data);
      } catch {
        if (!cancelled) {
          setLocalServiceStatus({
            server: { ok: false },
            tts: { ok: false, error: "status_check_failed" }
          });
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
      handleError(cause, "启动失败：");
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
      nextPreparedRef.current = item;
      setNextPreparedItem(item);
      setPrepareStatus("ready");
      debugLog("[prepareNext] ready", item.track.title);
    } catch (cause) {
      debugLog("[prepareNext] failed", cause);
      clearPreparedNext();
      setPrepareStatus("not_ready");
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
      handleError(cause, "切换失败：");
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
        await songAudioRef.current.play().catch((cause) => handleError(cause, "继续播放失败："));
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
    setFeedbackStatus("正在换一首，本次不计入负反馈。后台推荐生成中，页面不会等待请求完成。");
    perfLog("right-control:neutral-next-click", startedAt);
    debugLog("[transition] neutral-next");
    void runNeutralNextInBackground();
  }

  async function runNeutralNextInBackground() {
    try {
      await transitionToPreparedOrFetchNext("neutral-next");
    } catch (cause) {
      handleError(cause, "换歌失败：");
      setFeedbackPending(false);
    }
  }

  function skipAndReduce() {
    const startedAt = performance.now();
    if (transitionLockRef.current || feedbackPending) return;
    const skipped = currentRef.current?.track ?? speakingForRef.current?.track;
    markNextPlayedAsChangedRef.current = true;
    setFeedbackPending(true);
    setFeedbackStatus("已降低当前歌曲/歌手的推荐权重，正在后台切换下一首。");
    perfLog("right-control:skip-click", startedAt);
    debugLog("[transition] skip");
    void runSkipInBackground(skipped);
  }

  async function runSkipInBackground(skipped?: RadioTrack) {
    try {
      void sendFeedback("skip").catch(() => setFeedbackStatus("反馈提交失败，但会继续切歌。"));
      if (skipped) removeRecentTrack(skipped);
      await transitionToPreparedOrFetchNext("after_skip");
    } catch (cause) {
      handleError(cause, "跳过失败：");
      setFeedbackPending(false);
    }
  }

  function likeCurrentStyle() {
    const startedAt = performance.now();
    if (feedbackPending) return;
    const liked = currentRef.current?.track ?? speakingForRef.current?.track;
    if (liked) markRecentTrackFeedback(liked, "liked_style");
    setFeedbackPending(true);
    setFeedbackStatus("已记录，会影响后续推荐；当前正在准备的下一首不会被打断。");
    perfLog("right-control:like-click", startedAt);
    void runLikeInBackground();
  }

  async function runLikeInBackground() {
    try {
      await sendFeedback("like_style");
    } catch {
      setFeedbackStatus("反馈提交失败，请稍后再试。");
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
        throw new Error(failure?.message ?? "无法获取下一首。请检查 Last.fm 和音乐 API 配置。");
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

      if (!response.ok) throw new Error("反馈提交失败");
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
    songLocalVolumeRef.current = options.fadeIn ? 0 : AUDIO_VOLUME.songNormal;
    applySongVolume();
    audio.src = audioUrl;
    audio.load();
    await playAudioElement(audio);
    triggerImmediateNextPreparation("song_audio_playing");
    if (options.fadeIn) {
      const controller = new AbortController();
      songFadeInAbortRef.current = controller;
      debugLog("[audio] song fade in started");
      await fadeVolume({
        audio,
        from: songLocalVolumeRef.current,
        to: AUDIO_VOLUME.songNormal,
        durationMs: options.fadeInDurationMs ?? AUDIO_TRANSITION.nextSongFadeInSec * 1000,
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
    if (!audio || activeAudioTypeRef.current !== "song") return;
    if (songFadeInAbortRef.current && songLocalVolumeRef.current < AUDIO_VOLUME.songNormal) {
      debugLog("[audio] page hidden during song fade in, completing fade immediately");
      songLocalVolumeRef.current = AUDIO_VOLUME.songNormal;
      applySongVolume();
      songFadeInAbortRef.current.abort();
      songFadeInAbortRef.current = null;
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
    const rawMessage = cause instanceof Error ? cause.message : "未知错误";
    const message = rawMessage.includes("aborted") || rawMessage.includes("AbortError") ? "请求超时或被取消，请稍后重试。" : rawMessage;
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
            <div className="service-pill" data-online={serverOnline}>
              <span className="service-dot" />
              <span>Server</span>
            </div>
            <div className="service-pill" data-online={ttsOnline} title={localServiceStatus?.tts.error ?? ""}>
              <span className="service-dot" />
              <span>TTS</span>
            </div>
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

            <div className="script">{displayItem?.djLine ?? "点击开始电台后，这里会显示 AI 主播串场文案。"}</div>

            <audio ref={songAudioRef} className="hidden-audio" onTimeUpdate={handleSongTimeUpdate} onLoadedMetadata={handleSongTimeUpdate} onEnded={() => void handleSongEnded()} />
            <audio ref={speechAudioRef} className="hidden-audio" />
            <audio ref={effectAudioRef} className="hidden-audio" />


            {error ? <div className="error">{error}</div> : null}
            <div className="controls-below">
              <div className="actions">
                <button className="button primary" disabled={playerState !== "idle" && playerState !== "stopped" && playerState !== "error"} onClick={startRadio}>开始电台</button>
                <button className="button" disabled={!canControl} onClick={() => void pauseOrResumeRadio()}>{isPaused ? "继续电台" : "暂停电台"}</button>
                <button className="button" disabled={feedbackDisabled} onClick={() => void neutralNext()}>换一首（不降权）</button>
                <button className="button danger" disabled={feedbackDisabled} onClick={() => void skipAndReduce()}>跳过并减少推荐</button>
                <button className="button" disabled={feedbackDisabled} onClick={() => void likeCurrentStyle()}>喜欢这种风格</button>
                <button className="button primary" disabled={!canControl} onClick={() => void stopRadio()}>停止电台</button>
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
    </main>
  );
}








































