import { buildTrackContextPack } from "@/src/lib/knowledge/buildTrackContextPack";
import { selectDjScriptMode } from "@/src/lib/knowledge/knowledgeCardGenerator";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const title = url.searchParams.get("title") ?? "";
  const artist = url.searchParams.get("artist") ?? "";
  const album = url.searchParams.get("album") ?? undefined;
  if (!title || !artist) return NextResponse.json({ ok: false, message: "title and artist are required" }, { status: 400 });

  const contextPack = await buildTrackContextPack({ track: { title, artist, album }, listeningContext: { position: "normal", userAction: "none" } });
  return NextResponse.json({
    ok: true,
    track: contextPack.track,
    knowledge: {
      hasTrackCard: Boolean(contextPack.knowledge.trackCard),
      hasAlbumCard: Boolean(contextPack.knowledge.albumCard),
      hasArtistCard: Boolean(contextPack.knowledge.artistCard),
      hasScriptMemory: Boolean(contextPack.knowledge.scriptMemory)
    },
    confidence: contextPack.confidence,
    selectedMode: selectDjScriptMode(contextPack),
    contextPack
  });
}