import { readFile } from "node:fs/promises";
import path from "node:path";
import * as OpenCC from "opencc-js";
import { containsChinese, normalizeMusicText } from "./normalizeMusicText";

export type QueryVariant = {
  title: string;
  artist: string;
  variantType:
    | "original"
    | "simplified"
    | "traditional"
    | "traditional_hk"
    | "traditional_tw"
    | "artist_alias"
    | "normalized";
  weight: number;
};

const ALIAS_PATH = path.join(process.cwd(), "data", "artist_aliases.json");
const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });
const toTraditional = OpenCC.Converter({ from: "cn", to: "t" });
const toTraditionalHongKong = OpenCC.Converter({ from: "cn", to: "hk" });
const toTraditionalTaiwan = OpenCC.Converter({ from: "cn", to: "tw" });

export async function buildLastfmQueryVariants(input: {
  title: string;
  artist: string;
  artistAliases?: string[];
}): Promise<QueryVariant[]> {
  const aliases = unique([...(input.artistAliases ?? []), ...(await getArtistAliases(input.artist))]);
  const variants: QueryVariant[] = [];
  const original = {
    title: normalizeMusicText(input.title),
    artist: normalizeMusicText(input.artist)
  };

  pushVariant(variants, { ...original, variantType: "original", weight: 1.0 });
  pushVariant(variants, {
    title: normalizeMusicText(original.title),
    artist: normalizeMusicText(original.artist),
    variantType: "normalized",
    weight: 0.95
  });

  if (containsChinese(`${original.title}${original.artist}`)) {
    pushChineseVariants(variants, original.title, original.artist, 1);
  }

  for (const alias of aliases) {
    const normalizedAlias = normalizeMusicText(alias);
    pushVariant(variants, {
      title: original.title,
      artist: normalizedAlias,
      variantType: "artist_alias",
      weight: 0.85
    });

    if (containsChinese(`${original.title}${normalizedAlias}`)) {
      pushChineseVariants(variants, original.title, normalizedAlias, 0.85);
    }
  }

  return Array.from(dedupeVariants(variants).values()).sort((a, b) => b.weight - a.weight);
}

export async function getArtistAliases(artist: string) {
  try {
    const raw = await readFile(ALIAS_PATH, "utf8");
    const data = JSON.parse(raw) as Record<string, string[]>;
    const normalized = normalizeMusicText(artist);
    const simplified = toSimplified(normalized);
    const traditional = toTraditional(normalized);
    const direct = data[normalized] ?? data[simplified] ?? data[traditional] ?? [];
    const reverse = Object.entries(data)
      .filter(([key, aliases]) => key === normalized || aliases.includes(normalized) || aliases.includes(simplified) || aliases.includes(traditional))
      .flatMap(([key, aliases]) => [key, ...aliases]);
    return unique([...direct, ...reverse]).filter((alias) => normalizeMusicText(alias) !== normalized);
  } catch {
    return [];
  }
}

function pushChineseVariants(variants: QueryVariant[], title: string, artist: string, weightMultiplier: number) {
  pushVariant(variants, {
    title: toSimplified(title),
    artist: toSimplified(artist),
    variantType: "simplified",
    weight: 0.9 * weightMultiplier
  });
  pushVariant(variants, {
    title: toTraditional(title),
    artist: toTraditional(artist),
    variantType: "traditional",
    weight: 0.95 * weightMultiplier
  });
  pushVariant(variants, {
    title: toTraditionalHongKong(title),
    artist: toTraditionalHongKong(artist),
    variantType: "traditional_hk",
    weight: 1.0 * weightMultiplier
  });
  pushVariant(variants, {
    title: toTraditionalTaiwan(title),
    artist: toTraditionalTaiwan(artist),
    variantType: "traditional_tw",
    weight: 0.9 * weightMultiplier
  });
}

function pushVariant(variants: QueryVariant[], variant: QueryVariant) {
  if (!variant.title || !variant.artist) return;
  variants.push({
    ...variant,
    title: normalizeMusicText(variant.title),
    artist: normalizeMusicText(variant.artist),
    weight: clamp(variant.weight, 0.1, 1.2)
  });
}

function dedupeVariants(variants: QueryVariant[]) {
  const byKey = new Map<string, QueryVariant>();
  for (const variant of variants) {
    const key = `${variant.title}::${variant.artist}`;
    const existing = byKey.get(key);
    if (!existing || variant.weight > existing.weight) {
      byKey.set(key, variant);
    }
  }
  return byKey;
}

function unique(values: string[]) {
  return Array.from(new Set(values.map(normalizeMusicText).filter(Boolean)));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
