import type { PlaylistSong, StyleSeedCandidate } from "./types";
import type { RecommenderWeights } from "./recommender/weights";

export type TasteProfile = {
  favoriteArtists: string[];
  favoriteGenres: string[];
  favoriteLanguages: string[];
  favoriteMoods: string[];
  favoriteEras: string[];
  favoriteEnergyLevels: string[];
  avoidKeywords: string[];
  artistWeights: Record<string, number>;
  tagWeights: Record<string, number>;
  albumWeights: Record<string, number>;
  sourcePathTrust: Record<string, number>;
  styleSeedCandidates: StyleSeedCandidate[];
  shortTerm: {
    artistWeights: Record<string, number>;
    tagWeights: Record<string, number>;
    skippedArtists: Record<string, number>;
    skippedTags: Record<string, number>;
  };
  adaptive: {
    exploration: number;
    weights: Partial<RecommenderWeights>;
  };
};

export const DEFAULT_SOURCE_PATH_TRUST: Record<string, number> = {
  "lastfm:similar_track": 1.0,
  "similar_track_different_artist": 1.05,
  "similar_track_same_artist": 0.82,
  "lastfm:similar_artist:top_track": 0.85,
  "similar_artist_representative": 0.78,
  "fallback:lastfm:tag_top_track": 0.35,
  "lastfm:artist_top_track": 0.55,
  "same_artist_top_tracks": 0.35,
  "lastfm:album_track": 0.5,
  "same_album_other_tracks": 0.3,
  "fallback:custom_search": 0.2
};

const defaultProfile: TasteProfile = {
  favoriteArtists: [],
  favoriteGenres: ["R&B", "hip hop", "soul", "indie pop", "city pop", "华语流行"],
  favoriteLanguages: ["华语", "英语", "粤语", "日语"],
  favoriteMoods: ["夜晚", "放松", "克制", "城市感"],
  favoriteEras: ["2000s", "2010s", "2020s"],
  favoriteEnergyLevels: ["中慢速", "低能量", "groove", "慢歌"],
  avoidKeywords: ["live", "现场", "演唱会", "karaoke", "KTV", "伴奏", "instrumental", "cover", "翻唱", "remix", "DJ版"],
  artistWeights: {},
  tagWeights: {},
  albumWeights: {},
  sourcePathTrust: DEFAULT_SOURCE_PATH_TRUST,
  styleSeedCandidates: [],
  shortTerm: {
    artistWeights: {},
    tagWeights: {},
    skippedArtists: {},
    skippedTags: {}
  },
  adaptive: {
    exploration: 0.35,
    weights: {}
  }
};

const genreRules: Array<[RegExp, string]> = [
  [/drake|kendrick|future|travis|metro|asap|tyler|frank ocean/i, "hip hop"],
  [/bruno mars|sza|the weeknd|usher|r&b/i, "R&B"],
  [/city|灞变笅|绔瑰唴|鏉忛噷|mariya/i, "city pop"],
  [/indie|lana|phoebe|clairo|boygenius/i, "indie pop"],
  [/周杰伦|林俊杰|孙燕姿|五月天|陈奕迅|王菲|陶喆/i, "华语流行"]
];

export function buildTasteProfile(playlist: PlaylistSong[]): TasteProfile {
  const artists = countTop(playlist.map((song) => song.artist), 16);
  const albums = countTop(playlist.map((song) => song.album), 16);
  const albumText = playlist.map((song) => song.album).join(" ");
  const text = `${artists.join(" ")} ${albumText} ${playlist.map((song) => song.title).join(" ")}`;
  const genres = unique([...inferGenres(text), ...defaultProfile.favoriteGenres]).slice(0, 10);
  const languages = unique([...inferLanguages(text), ...defaultProfile.favoriteLanguages]).slice(0, 6);

  return {
    ...defaultProfile,
    favoriteArtists: artists,
    favoriteGenres: genres,
    favoriteLanguages: languages,
    artistWeights: Object.fromEntries(artists.map((artist, index) => [normalizeKey(artist), Math.max(0.15, 1 - index * 0.05)])),
    tagWeights: Object.fromEntries(genres.map((tag, index) => [normalizeKey(tag), Math.max(0.15, 0.8 - index * 0.04)])),
    albumWeights: Object.fromEntries(albums.map((album, index) => [normalizeKey(album), Math.max(0.1, 0.65 - index * 0.03)])),
    sourcePathTrust: { ...DEFAULT_SOURCE_PATH_TRUST },
    styleSeedCandidates: [],
    shortTerm: { ...defaultProfile.shortTerm, artistWeights: {}, tagWeights: {}, skippedArtists: {}, skippedTags: {} },
    adaptive: { exploration: 0.35, weights: {} }
  };
}

function inferGenres(text: string) {
  return genreRules.filter(([pattern]) => pattern.test(text)).map(([, genre]) => genre);
}

function inferLanguages(text: string) {
  const languages: string[] = [];
  if (/[\u4e00-\u9fff]/.test(text)) languages.push("华语");
  if (/drake|kendrick|future|sza|travis|metro|nokia|luther/i.test(text)) languages.push("英语");
  if (/陈奕迅|王菲|港|粤/i.test(text)) languages.push("粤语");
  if (/city pop|j-pop|日语|山下|竹内/i.test(text)) languages.push("日语");
  return languages;
}

function countTop(values: string[], limit: number) {
  const counts = new Map<string, number>();
  values.flatMap((value) => splitArtists(value)).forEach((value) => {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value]) => value);
}

function splitArtists(value: string) {
  return value.split(/,|&|、|和|feat\.|ft\./i).map((item) => item.trim()).filter(Boolean);
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}


