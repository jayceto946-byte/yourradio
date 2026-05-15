export function buildSongResearchQueries(input: {
  rawTitle: string;
  speechTitle: string;
  rawArtist: string;
  displayArtist: string;
  album?: string;
  isSoundtrack?: boolean;
  featuredArtists?: string[];
}): string[] {
  const title = input.speechTitle || input.rawTitle;
  const artist = input.displayArtist || input.rawArtist;
  const queries = [
    `${artist} ${title} 发行 专辑 背景`,
    `${artist} ${title} review`,
    input.album ? `${artist} ${input.album} 专辑 发行 背景` : "",
    input.isSoundtrack ? `${title} ${artist} original soundtrack background` : "",
    input.isSoundtrack && input.album ? `${title} ${input.album} soundtrack background` : ""
  ];

  return unique(queries.map(cleanQuery).filter((query) => query.length >= 6)).slice(0, 3);
}

export function buildWikiResearchQueries(input: {
  rawTitle: string;
  speechTitle: string;
  rawArtist: string;
  displayArtist: string;
  album?: string;
  isSoundtrackLike?: boolean;
  featuredArtists?: string[];
}): string[] {
  const title = input.speechTitle || input.rawTitle;
  const artist = input.displayArtist || input.rawArtist;
  const queries = [
    `${artist} ${title}`,
    `${input.rawArtist} ${input.rawTitle}`,
    `${title} ${artist} 歌曲`,
    input.album ? `${artist} ${input.album}` : "",
    input.album ? `${input.rawArtist} ${input.album}` : "",
    input.isSoundtrackLike ? `${title} ${artist} soundtrack` : "",
    input.isSoundtrackLike ? `${title} ${artist} 原声带` : "",
    input.isSoundtrackLike && input.album ? `${title} ${input.album} soundtrack` : ""
  ];

  return unique(queries.map(cleanQuery).filter((query) => query.length >= 3)).slice(0, 6);
}

function cleanQuery(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values: string[]) {
  return [...new Set(values)];
}
