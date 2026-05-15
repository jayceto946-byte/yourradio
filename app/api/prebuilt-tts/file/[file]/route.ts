import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

const PREBUILT_AUDIO_DIR = path.join(process.cwd(), "data", "prebuilt-tts", "audio");
const FILE_PATTERN = /^(radio_start|radio_stop|change_track|skip_and_downrank)\.[a-z_]+\.\d{2}\.wav$/;

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  if (!FILE_PATTERN.test(file)) {
    return NextResponse.json({ ok: false, error: "invalid_file" }, { status: 400 });
  }

  const fullPath = path.join(PREBUILT_AUDIO_DIR, file);
  if (!fullPath.startsWith(PREBUILT_AUDIO_DIR) || !existsSync(fullPath)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const stream = createReadStream(fullPath);
  return new Response(stream as unknown as BodyInit, {
    headers: {
      "Content-Type": "audio/wav",
      "Cache-Control": "public, max-age=31536000, immutable"
    }
  });
}
