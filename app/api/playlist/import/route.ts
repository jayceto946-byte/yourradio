import { loadImportedPlaylist } from "@/lib/playlist";
import {
  dedupePlaylistSongs,
  hasMinimumPlaylistFields,
  mergePlaylistSongs,
  normalizePlaylistSong,
  parsePlaylistBuffer,
  saveImportedPlaylist
} from "@/lib/playlistImport";
import type { PlaylistSong } from "@/lib/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
type CommitMode = "replace" | "merge";

type CommitBody = {
  mode?: CommitMode;
  songs?: unknown[];
};

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return commitImportedPlaylist(request);
    }
    return previewImportedPlaylist(request);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Playlist import failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

async function previewImportedPlaylist(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "Missing playlist file." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: "Playlist file exceeds the 5 MB limit." }, { status: 413 });
  }

  const preview = parsePlaylistBuffer({
    buffer: Buffer.from(await file.arrayBuffer()),
    fileName: file.name
  });
  return NextResponse.json({
    ok: true,
    ...preview,
    previewSongs: preview.songs.slice(0, 10)
  });
}

async function commitImportedPlaylist(request: Request) {
  const body = (await request.json()) as CommitBody;
  const mode: CommitMode = body.mode === "merge" ? "merge" : "replace";
  const imported = dedupePlaylistSongs((body.songs ?? []).map(normalizePlaylistSong).filter(hasMinimumPlaylistFields));
  if (imported.length === 0) {
    return NextResponse.json({ ok: false, error: "No valid songs were provided." }, { status: 400 });
  }

  const existing = mode === "merge" ? await loadImportedPlaylist() : [];
  const songs = mode === "merge" ? mergePlaylistSongs(existing, imported) : imported;
  await saveImportedPlaylist(songs);

  return NextResponse.json({
    ok: true,
    mode,
    importedCount: imported.length,
    previousCount: existing.length,
    writtenCount: songs.length,
    addedCount: mode === "merge" ? Math.max(0, songs.length - existing.length) : songs.length
  });
}
