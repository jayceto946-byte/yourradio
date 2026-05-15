import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const theme = url.searchParams.get("theme");
  const fileName = theme === "ivory" ? "logo_white.svg" : "logo.svg";
  const logoPath = path.join(process.cwd(), "data", fileName);
  if (!existsSync(logoPath)) {
    return NextResponse.json({ ok: false, error: "logo_not_found" }, { status: 404 });
  }

  const stream = createReadStream(logoPath);
  return new Response(stream as unknown as BodyInit, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-cache, must-revalidate"
    }
  });
}
