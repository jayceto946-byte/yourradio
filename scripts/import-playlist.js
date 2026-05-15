const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");

const FIELD_ALIASES = {
  title: ["title", "\u6b4c\u66f2\u540d", "\u6b4c\u540d", "name", "track name"],
  artist: ["artist", "\u827a\u672f\u5bb6", "\u6b4c\u624b", "ar", "artist name"],
  album: ["album", "\u4e13\u8f91", "al"],
  duration: ["duration", "\u65f6\u957f", "dt"]
};
const SUPPORTED_EXTENSIONS = new Set([".csv", ".xlsx"]);
const projectRoot = path.resolve(__dirname, "..");
const defaultOutputPath = path.join(projectRoot, "user", "playlists.json");

const args = process.argv.slice(2);
const inputPath = args.find((arg) => !arg.startsWith("--"));
const outputFlagIndex = args.indexOf("--output");
const requestedOutputPath = outputFlagIndex >= 0 ? args[outputFlagIndex + 1] : undefined;
const mode = args.includes("--merge") ? "merge" : "replace";
if (!inputPath) {
  console.error("Usage: node scripts/import-playlist.js <playlist.csv|playlist.xlsx> [--merge] [--output <path>]");
  process.exit(1);
}

const extension = path.extname(inputPath).toLowerCase();
if (!SUPPORTED_EXTENSIONS.has(extension)) {
  console.error("Only .csv and .xlsx files are supported.");
  process.exit(1);
}

const outputPath = requestedOutputPath ? path.resolve(requestedOutputPath) : defaultOutputPath;
const workbook = XLSX.readFile(inputPath, { raw: false });
const firstSheet = workbook.SheetNames[0];
if (!firstSheet) {
  console.error("The playlist file does not contain a worksheet.");
  process.exit(1);
}

const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: "", raw: false });
const accepted = [];
let rejectedCount = 0;
for (const row of rows) {
  const song = normalizeSong(row);
  if (!song.title || !song.artist) {
    rejectedCount += 1;
    continue;
  }
  accepted.push(song);
}
const imported = dedupe(accepted);
const existing = mode === "merge" ? loadExisting() : [];
const songs = mode === "merge" ? dedupe([...existing, ...imported]) : imported;
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(songs, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  mode,
  inputPath: path.resolve(inputPath),
  outputPath,
  rowsRead: rows.length,
  acceptedRows: accepted.length,
  rejectedCount,
  duplicateCount: accepted.length - imported.length,
  importedCount: imported.length,
  previousCount: existing.length,
  writtenCount: songs.length
}, null, 2));

function loadExisting() {
  try {
    const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8").replace(/^\uFEFF/, ""));
    return Array.isArray(parsed) ? parsed.map(normalizeSong).filter((song) => song.title && song.artist) : [];
  } catch {
    return [];
  }
}

function normalizeSong(row) {
  const normalized = new Map(Object.entries(row || {}).map(([key, value]) => [key.trim().toLowerCase(), value]));
  return {
    title: readAlias(normalized, FIELD_ALIASES.title),
    artist: readAlias(normalized, FIELD_ALIASES.artist),
    album: readAlias(normalized, FIELD_ALIASES.album),
    duration: readAlias(normalized, FIELD_ALIASES.duration)
  };
}

function readAlias(map, aliases) {
  for (const alias of aliases) {
    const value = map.get(alias.trim().toLowerCase());
    const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
    if (text) return text;
  }
  return "";
}

function dedupe(songs) {
  const byKey = new Map();
  for (const song of songs) {
    const key = `${song.title.trim().toLowerCase().replace(/\s+/g, " ")}::${song.artist.trim().toLowerCase().replace(/\s+/g, " ")}`;
    if (!byKey.has(key)) byKey.set(key, song);
  }
  return Array.from(byKey.values());
}
