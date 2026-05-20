export type KnowledgeConfidence = "high" | "medium" | "low" | "none";

export type KnowledgeSource =
  | "lastfm"
  | "local_metadata"
  | "lyrics"
  | "manual"
  | "local_generated"
  | "user_feedback";

export type ArtistCard = {
  type: "artist";
  artist: string;
  normalizedArtist: string;
  aliases?: string[];
  tags?: string[];
  similarArtists?: string[];
  shortBio?: string;
  moodWords?: string[];
  knownFor?: string[];
  lastfmListeners?: number;
  lastfmPlaycount?: number;
  source: KnowledgeSource;
  confidence: KnowledgeConfidence;
  createdAt: string;
  updatedAt: string;
};

export type AlbumCard = {
  type: "album";
  artist: string;
  normalizedArtist: string;
  album: string;
  normalizedAlbum: string;
  year?: string;
  tags?: string[];
  trackList?: string[];
  summary?: string;
  moodWords?: string[];
  djAngles?: string[];
  source: KnowledgeSource;
  confidence: KnowledgeConfidence;
  createdAt: string;
  updatedAt: string;
};

export type TrackCard = {
  type: "track";
  title: string;
  normalizedTitle: string;
  artist: string;
  normalizedArtist: string;
  album?: string;
  normalizedAlbum?: string;
  tags?: string[];
  similarTracks?: Array<{ title: string; artist: string; match?: number }>;
  summary?: string;
  lyricTheme?: string;
  moodWords?: string[];
  djAngles?: string[];
  source: KnowledgeSource;
  confidence: KnowledgeConfidence;
  createdAt: string;
  updatedAt: string;
};

export type DjScriptMode =
  | "mood_note"
  | "artist_context"
  | "album_context"
  | "queue_reason"
  | "soft_transition"
  | "direct_play"
  | "fallback"
  | "user_request";

export type LikedTrackContextItem = {
  title: string;
  artist: string;
  album?: string;
  likedAt?: string;
  feedbackAction?: "like" | "like_style";
};

export type LikedTrackContext = {
  sameArtist?: LikedTrackContextItem[];
  sameAlbum?: LikedTrackContextItem[];
  summary?: string;
};

export type DjScriptMemory = {
  id: string;
  trackTitle: string;
  normalizedTitle: string;
  artist: string;
  normalizedArtist: string;
  album?: string;
  normalizedAlbum?: string;
  script: string;
  mode: DjScriptMode;
  userFeedback?: "good" | "neutral" | "bad";
  createdAt: string;
  updatedAt: string;
};

export type TrackContextPack = {
  track: {
    title: string;
    artist: string;
    album?: string;
    year?: string;
  };
  recommendation: {
    seedTrack?: string;
    seedArtist?: string;
    sourcePath?: string;
    reason?: string;
    tags?: string[];
    similarTo?: Array<{ title: string; artist: string }>;
    likedContext?: LikedTrackContext;
  };
  knowledge: {
    trackCard?: TrackCard;
    albumCard?: AlbumCard;
    artistCard?: ArtistCard;
    scriptMemory?: DjScriptMemory;
  };
  listeningContext: {
    previousTrack?: { title: string; artist: string };
    position: "opening" | "normal" | "requested" | "fallback" | "ending";
    userAction?: "none" | "user_request" | "like_style" | "skip_downrank";
  };
  confidence: KnowledgeConfidence;
};
