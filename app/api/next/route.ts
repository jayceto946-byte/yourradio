import { RecommendationFailureError } from "@/lib/queue";
import { recordDjLine, recordPlay } from "@/lib/radioState";
import { recordRuntimeEvent } from "@/lib/runtimeLog";
import type { RadioNextResponse } from "@/lib/types";
import {
  buildImmediateRadioItem,
  consumeBestRollingQueueItem,
  consumeWarmupPackage,
  ensureRadioItemPlayable,
  refillRollingQueue
} from "@/src/lib/player/rollingQueue/rollingQueueStore";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const startedAt = performance.now();
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  const previousTrack = parsePreviousTrack(url);
  const explicitScene = url.searchParams.get("scene");
  const scene = explicitScene === "after_skip" || explicitScene === "after_like"
    ? explicitScene
    : mode === "prepare" || previousTrack
      ? "normal"
      : "opening";

  void recordRuntimeEvent({ step: "api.next", status: "started", context: { mode, scene, previousTrack: previousTrack ? `${previousTrack.title} - ${previousTrack.artist}` : null } });

  try {
    let item: RadioNextResponse | null = null;
    let source: "warmup" | "rolling_queue" | "immediate" = "immediate";

    if (scene === "opening" && mode !== "prepare" && !previousTrack) {
      item = await consumeWarmupPackage();
      if (item) source = "warmup";
      if (!item) {
        item = await buildImmediateRadioItem({ scene: "opening", withTts: false, skipTts: true });
        source = "immediate";
      }
      if (!await ensureRadioItemPlayable(item, `api.next:${source}`)) {
        item = await buildImmediateRadioItem({ scene: "opening", withTts: false, skipTts: true });
        source = "immediate";
        await ensureRadioItemPlayable(item, "api.next:opening_replacement");
      }
      await recordReturnedPlayback(item);
      void refillRollingQueue({ allowTts: true }).catch((cause) => console.error("[rollingQueue] refill failed", cause));
      logSuccess({ startedAt, mode, scene, source, item });
      return NextResponse.json(item);
    }

    if (mode === "prepare") {
      item = await consumeBestRollingQueueItem({ requireScript: true });
      if (item) source = "rolling_queue";
      void refillRollingQueue({ allowTts: true }).catch((cause) => console.error("[rollingQueue] refill failed", cause));
      if (!item) {
        void recordRuntimeEvent({ step: "api.next", status: "info", durationMs: Math.round(performance.now() - startedAt), context: { mode, scene, source: "not_ready" } });
        return NextResponse.json({ ok: false, code: "NOT_READY", message: "Next track script is still preparing." }, { status: 202 });
      }
    } else {
      item = await consumeBestRollingQueueItem();
      if (item) source = "rolling_queue";
    }

    if (!item) {
      item = await buildImmediateRadioItem({ scene, withTts: false, skipTts: false, previousTrack });
      source = "immediate";
    }

    if (!await ensureRadioItemPlayable(item, `api.next:${source}`)) {
      item = await buildImmediateRadioItem({ scene: "after_skip", withTts: false, skipTts: false, previousTrack });
      source = "immediate";
      await ensureRadioItemPlayable(item, "api.next:replacement");
    }

    if (mode !== "prepare") await recordReturnedPlayback(item);
    void refillRollingQueue({ allowTts: true }).catch((cause) => console.error("[rollingQueue] refill failed", cause));
    logSuccess({ startedAt, mode, scene, source, item });
    return NextResponse.json(item);
  } catch (cause) {
    void recordRuntimeEvent({ step: "api.next", status: "error", durationMs: Math.round(performance.now() - startedAt), error: cause instanceof Error ? cause.message : String(cause), context: { mode, scene } });
    if (cause instanceof RecommendationFailureError) {
      return NextResponse.json(cause.failure, { status: 503 });
    }
    const message = cause instanceof Error ? cause.message : "Cannot get next radio item";
    return NextResponse.json({ ok: false, code: "PROVIDER_ERROR", message }, { status: 500 });
  } finally {
    if (process.env.NODE_ENV === "development") console.log(`[perf] /api/next total: ${Math.round(performance.now() - startedAt)}ms`);
  }
}

function logSuccess(input: { startedAt: number; mode: string | null; scene: string; source: string; item: RadioNextResponse }) {
  void recordRuntimeEvent({
    step: "api.next",
    status: "success",
    durationMs: Math.round(performance.now() - input.startedAt),
    context: {
      mode: input.mode,
      scene: input.scene,
      source: input.source,
      track: `${input.item.track.title} - ${input.item.track.artist}`,
      hasTts: Boolean(input.item.ttsUrl),
      ttsSkipped: input.item.ttsSkipped
    }
  });
}

function parsePreviousTrack(url: URL) {
  const title = url.searchParams.get("previousTitle")?.trim() ?? "";
  const artist = url.searchParams.get("previousArtist")?.trim() ?? "";
  const album = url.searchParams.get("previousAlbum")?.trim() ?? "";
  if (!title || !artist) return undefined;
  return { title, artist, album };
}

async function recordReturnedPlayback(item: RadioNextResponse) {
  await recordPlay(item);
  await recordDjLine(item.djLine);
}
