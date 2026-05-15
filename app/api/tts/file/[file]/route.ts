import { getTtsCacheDir } from "@/src/lib/tts/ttsCache";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  if (!/^[a-f0-9]{64}\.(wav|mp3)$/i.test(file)) {
    return NextResponse.json({ ok: false, error: "invalid_file" }, { status: 400 });
  }

  const fullPath = path.join(getTtsCacheDir(), file);
  if (!existsSync(fullPath)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const stream = createReadStream(fullPath);
  return new Response(stream as unknown as BodyInit, {
    headers: {
      "Content-Type": file.endsWith(".mp3") ? "audio/mpeg" : "audio/wav",
      "Cache-Control": "public, max-age=31536000, immutable"
    }
  });
}
