import { invalidateWarmupPackage, loadWarmupPackage, refillRollingQueue, saveWarmupPackageFromQueue } from "@/src/lib/player/rollingQueue/rollingQueueStore";
import { NextResponse } from "next/server";

export async function GET() {
  const pkg = await loadWarmupPackage();
  return NextResponse.json({
    exists: Boolean(pkg),
    valid: Boolean(pkg?.valid),
    track: pkg?.item ? `${pkg.item.track.title} - ${pkg.item.track.artist}` : null,
    hasScript: Boolean(pkg?.item?.djLine),
    hasTts: Boolean(pkg?.item?.ttsUrl),
    expiresAt: pkg?.expiresAt,
    invalidReason: pkg?.invalidReason,
    package: pkg
  });
}

export async function POST() {
  await refillRollingQueue({ allowTts: true, force: true });
  const pkg = await saveWarmupPackageFromQueue("debug_save_warmup");
  if (!pkg) return NextResponse.json({ ok: false, error: "no_script_ready_item" }, { status: 409 });
  return NextResponse.json({ ok: true, package: pkg });
}

export async function DELETE() {
  const pkg = await invalidateWarmupPackage("deleted_by_debug_api");
  return NextResponse.json({ ok: true, package: pkg });
}
