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
      `${input.displayArtist} 的《${input.speechTitle}》。不多铺垫，让声音自己慢慢展开，适合把注意力放回耳朵里。`,
      `这里放一首 ${input.displayArtist}。这首《${input.speechTitle}》不用讲得太满，留一点空间给旋律就好。`
    ],
    mood_note: [
      `这首的氛围不用说满，情绪贴近${input.timeOfDay}里安静下来的那一段，声音不抢，留白也够。`,
      `把音量留在舒服的位置。接下来这段更轻一点，不急着往前走，适合让注意力慢慢落下来。`
    ],
    song_fact: [
      `${input.displayArtist} 的《${input.speechTitle}》。资料点到为止，真正值得听的还是它进来之后那一点呼吸感。`,
      `关于这首歌，知道一点背景就够了。现在先把说明放轻，听 ${input.displayArtist} 的《${input.speechTitle}》。`
    ],
    soft_transition: [
      `刚才的余温不用接得太满，这里轻轻换一个角度。${input.displayArtist} 的《${input.speechTitle}》，让频道继续往前。`,
      `这一段转场不硬切，只把情绪放低一点。现在听 ${input.displayArtist} 的《${input.speechTitle}》。`
    ],
    direct_play: [
      `不多介绍，把声音留给它自己。${input.displayArtist} 的《${input.speechTitle}》。`,
      `话收短一点。${input.displayArtist}，《${input.speechTitle}》。`
    ],
    personal_taste_note: [
      `这一首靠近你常停留的那种克制感，但不用讲成理由。${input.displayArtist} 的《${input.speechTitle}》，直接听。`,
      `这里选一首更贴近私人频道气质的声音。${input.displayArtist} 的《${input.speechTitle}》，慢慢进来。`
    ]
  };
  const pool = templates[input.mode] ?? templates.mood_note;
  return pool[Math.floor(Math.random() * pool.length)];
}
