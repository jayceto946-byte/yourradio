import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import type { PlaylistSong } from "./types";

export const PLAYLIST_PATH = path.join(process.cwd(), "user", "playlists.json");
export const PLAYLIST_FIELD_ALIASES = {
  title: ["title", "\u6b4c\u66f2\u540d", "\u6b4c\u540d", "name", "track name"],
  artist: ["artist", "\u827a\u672f\u5bb6", "\u6b4c\u624b", "ar", "artist name"],
  album: ["album", "\u4e13\u8f91", "al"],
  duration: ["duration", "\u65f6\u957f", "dt"]
} as const;

const SUPPORTED_EXTENSIONS = new Set([".csv", ".xlsx"]);

export type PlaylistImportRejectedRow = {
  rowNumber: number;
  reason: "missing_title" | "missing_artist";
};

export type PlaylistImportSummary = {
  fileName: string;
  rowsRead: number;
  acceptedRows: number;
  importedCount: number;
  rejectedCount: number;
  duplicateCount: number;
};

export type PlaylistImportPreview = {
  songs: PlaylistSong[];
  rejectedRows: PlaylistImportRejectedRow[];
  summary: PlaylistImportSummary;
};

export function parsePlaylistBuffer(input: { buffer: Buffer; fileName: string }): PlaylistImportPreview {
  const extension = path.extname(input.fileName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error("Only .csv and .xlsx playlist files are supported.");
  }

  const workbook = XLSX.read(input.buffer, { type: "buffer", raw: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("The playlist file does not contain a worksheet.");
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheetName], {
    defval: "",
    raw: false
  });
  const rejectedRows: PlaylistImportRejectedRow[] = [];
  const accepted: PlaylistSong[] = [];

  rows.forEach((row, index) => {
    const song = normalizePlaylistSong(row);
    if (!song.title) {
      rejectedRows.push({ rowNumber: index + 2, reason: "missing_title" });
      return;
    }
    if (!song.artist) {
      rejectedRows.push({ rowNumber: index + 2, reason: "missing_artist" });
      return;
    }
    accepted.push(song);
  });

  const songs = dedupePlaylistSongs(accepted);
  return {
    songs,
    rejectedRows,
    summary: {
      fileName: input.fileName,
      rowsRead: rows.length,
      acceptedRows: accepted.length,
      importedCount: songs.length,
      rejectedCount: rejectedRows.length,
      duplicateCount: accepted.length - songs.length
    }
  };
}

export function normalizePlaylistSong(value: unknown): PlaylistSong {
  if (!isRecord(value)) return emptySong();

  return {
    title: readAliasedText(value, PLAYLIST_FIELD_ALIASES.title),
    artist: readAliasedText(value, PLAYLIST_FIELD_ALIASES.artist),
    album: readAliasedText(value, PLAYLIST_FIELD_ALIASES.album),
    duration: readAliasedText(value, PLAYLIST_FIELD_ALIASES.duration)
  };
}

export function hasMinimumPlaylistFields(song: PlaylistSong) {
  return Boolean(song.title && song.artist);
}

export function hasSearchablePlaylistText(song: PlaylistSong) {
  return Boolean(song.title || song.artist || song.album);
}

export function dedupePlaylistSongs(songs: PlaylistSong[]) {
  const byKey = new Map<string, PlaylistSong>();
  for (const song of songs) {
    const normalized = normalizePlaylistSong(song);
    if (!hasMinimumPlaylistFields(normalized)) continue;
    const key = getPlaylistSongKey(normalized);
    if (!byKey.has(key)) byKey.set(key, normalized);
  }
  return Array.from(byKey.values());
}

export function mergePlaylistSongs(existing: PlaylistSong[], imported: PlaylistSong[]) {
  return dedupePlaylistSongs([...existing, ...imported]);
}

export async function saveImportedPlaylist(songs: PlaylistSong[]) {
  const normalized = dedupePlaylistSongs(songs);
  await mkdir(path.dirname(PLAYLIST_PATH), { recursive: true });
  await writeFile(PLAYLIST_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function getPlaylistSongKey(song: Pick<PlaylistSong, "title" | "artist">) {
  return `${normalizeKey(song.title)}::${normalizeKey(song.artist)}`;
}

function readAliasedText(value: Record<string, unknown>, aliases: readonly string[]) {
  const normalizedEntries = new Map(Object.entries(value).map(([key, entry]) => [normalizeFieldName(key), entry]));
  for (const alias of aliases) {
    const text = toText(normalizedEntries.get(normalizeFieldName(alias)));
    if (text) return text;
  }
  return "";
}

function normalizeFieldName(value: string) {
  return value.trim().toLowerCase();
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function emptySong(): PlaylistSong {
  return { title: "", artist: "", album: "", duration: "" };
}

function toText(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
