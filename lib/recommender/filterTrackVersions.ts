export type TrackVersionFilterResult = {
  allowed: boolean;
  penalty: number;
  reasons: string[];
};

const VERSION_PATTERNS: Array<{ reason: string; pattern: RegExp; hard: boolean }> = [
  { reason: "remix", pattern: /(^|[^a-z0-9])remix([^a-z0-9]|$)/i, hard: true },
  { reason: "cover", pattern: /(^|[^a-z0-9])cover([^a-z0-9]|$)/i, hard: true },
  { reason: "dj", pattern: /(^|[^a-z0-9])dj([^a-z0-9]|$)|DJ版/i, hard: true },
  { reason: "bootleg", pattern: /(^|[^a-z0-9])bootleg([^a-z0-9]|$)/i, hard: true },
  { reason: "karaoke", pattern: /(^|[^a-z0-9])karaoke([^a-z0-9]|$)|\bktv\b/i, hard: true },
  { reason: "instrumental", pattern: /(^|[^a-z0-9])instrumental([^a-z0-9]|$)|伴奏|纯音乐版|純音樂版/i, hard: true },
  { reason: "live", pattern: /(^|[^a-z0-9])live([^a-z0-9]|$)|现场|現場|演唱会|演唱會/i, hard: true },
  { reason: "radio edit", pattern: /radio\s+edit/i, hard: false },
  { reason: "sped up", pattern: /sped\s+up|加速/i, hard: false },
  { reason: "slowed", pattern: /slowed|降速/i, hard: false },
  { reason: "nightcore", pattern: /nightcore/i, hard: false },
  { reason: "rework", pattern: /(^|[^a-z0-9])rework([^a-z0-9]|$)/i, hard: false },
  { reason: "edit", pattern: /(^|[^a-z0-9])edit([^a-z0-9]|$)/i, hard: false },
  { reason: "version", pattern: /(^|[^a-z0-9])version([^a-z0-9]|$)/i, hard: false },
  { reason: "翻唱", pattern: /翻唱|改编|重制|混音/i, hard: true }
];

export function filterTrackVersion(input: {
  title: string;
  artist?: string;
  album?: string;
  userAllowsAlternateVersions?: boolean;
}): TrackVersionFilterResult {
  if (input.userAllowsAlternateVersions) return { allowed: true, penalty: 0, reasons: [] };

  const text = `${input.title} ${input.album ?? ""}`;
  const matches = VERSION_PATTERNS.filter((entry) => entry.pattern.test(text));
  if (matches.length === 0) return { allowed: true, penalty: 0, reasons: [] };

  const hasHard = matches.some((entry) => entry.hard);
  return {
    allowed: !hasHard,
    penalty: hasHard ? 1 : 0.55,
    reasons: matches.map((entry) => entry.reason)
  };
}
