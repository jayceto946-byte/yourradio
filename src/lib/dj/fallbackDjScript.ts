import { FALLBACK_DJ_SCRIPTS } from "./fallbackDjScripts";
import type { DjScriptMode } from "./selectDjScriptMode";

export function buildFallbackDjScript(input: {
  speechTitle: string;
  displayArtist: string;
  mode: DjScriptMode;
  timeOfDay: string;
  hasFacts: boolean;
}) {
  const templates: Record<DjScriptMode, string[]> = {
    standalone_intro: [
      `${input.displayArtist} \u7684\u300a${input.speechTitle}\u300b\u3002\u4e0d\u591a\u94fa\u57ab\uff0c\u8ba9\u58f0\u97f3\u81ea\u5df1\u6162\u6162\u5c55\u5f00\u3002`,
      `\u8fd9\u91cc\u653e\u4e00\u9996 ${input.displayArtist} \u7684\u300a${input.speechTitle}\u300b\u3002\u5148\u628a\u89e3\u91ca\u653e\u8f7b\u3002`
    ],
    mood_note: [
      `\u8fd9\u9996\u7684\u60c5\u7eea\u8d34\u8fd1${input.timeOfDay}\u91cc\u5b89\u9759\u4e0b\u6765\u7684\u90a3\u4e00\u6bb5\uff0c\u58f0\u97f3\u4e0d\u62a2\u3002`,
      "\u628a\u97f3\u91cf\u7559\u5728\u8212\u670d\u7684\u4f4d\u7f6e\u3002\u63a5\u4e0b\u6765\u8fd9\u6bb5\u66f4\u8f7b\u4e00\u70b9\u3002"
    ],
    song_fact: [
      `${input.displayArtist} \u7684\u300a${input.speechTitle}\u300b\u3002\u5148\u542c\u5b83\u8fdb\u6765\u7684\u90a3\u4e00\u70b9\u547c\u5438\u611f\u3002`,
      `\u73b0\u5728\u542c ${input.displayArtist} \u7684\u300a${input.speechTitle}\u300b\u3002\u628a\u58f0\u97f3\u653e\u5230\u524d\u9762\u3002`
    ],
    soft_transition: [
      `\u521a\u624d\u7684\u4f59\u6e29\u8fd8\u5728\uff0c\u8fd9\u91cc\u8f7b\u8f7b\u6362\u4e00\u4e2a\u89d2\u5ea6\u3002${input.displayArtist} \u7684\u300a${input.speechTitle}\u300b\u3002`,
      `\u8fd9\u4e00\u6bb5\u8f6c\u573a\u4e0d\u786c\u5207\u3002\u73b0\u5728\u542c ${input.displayArtist} \u7684\u300a${input.speechTitle}\u300b\u3002`
    ],
    direct_play: [
      `\u4e0d\u591a\u4ecb\u7ecd\uff0c\u628a\u58f0\u97f3\u7559\u7ed9\u5b83\u81ea\u5df1\u3002${input.displayArtist} \u7684\u300a${input.speechTitle}\u300b\u3002`,
      `\u8bdd\u6536\u77ed\u4e00\u70b9\u3002${input.displayArtist}\uff0c\u300a${input.speechTitle}\u300b\u3002`,
      ...FALLBACK_DJ_SCRIPTS.normal
    ],
    personal_taste_note: [
      `\u8fd9\u4e00\u9996\u9760\u8fd1\u4f60\u5e38\u505c\u7559\u7684\u90a3\u79cd\u514b\u5236\u611f\u3002${input.displayArtist} \u7684\u300a${input.speechTitle}\u300b\u3002`,
      `\u8fd9\u91cc\u9009\u4e00\u9996\u66f4\u8d34\u8fd1\u79c1\u4eba\u9891\u9053\u6c14\u8d28\u7684\u58f0\u97f3\u3002${input.displayArtist} \u7684\u300a${input.speechTitle}\u300b\u3002`
    ]
  };
  const pool = templates[input.mode] ?? templates.mood_note;
  return pool[Math.floor(Math.random() * pool.length)];
}