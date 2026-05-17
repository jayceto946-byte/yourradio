# Personal AI Radio

Windows 本地个人 AI 电台。前端使用 Next.js + TypeScript，播放源使用你自己的音乐 API，音乐信息推荐主路径使用 Last.fm，LLM 只负责串场文案和解释，不负责凭空编歌。
## 页面示例
包含深色/米色两种风格，对应做了小屏适配。
<img width="2560" height="1390" alt="image" src="https://github.com/user-attachments/assets/5f35b01a-ad12-4879-8d9b-70a8dfc40490" />
<img width="2560" height="1390" alt="image" src="https://github.com/user-attachments/assets/69f25daa-0283-4b04-b123-3d609198d0fa" />



## 入门前准备

在启动项目之前，建议先准备好以下几项：

1. **Last.fm API**  
   推荐系统会使用 Last.fm 提供的音乐信息。你需要先注册一个 Last.fm 账号，并在这里创建 API Key：  
   `https://www.last.fm/api/account/create`
   相较于中文歌，英文歌推荐范围更深更广，效果相对更好。

2. **TTS 服务**  
   配置受限，项目当前用于测试和默认演示的方案是 **Qwen3-TTS 0.6B CustomVoice**，使用开源音色"Serena”。
   可以自行接入其他 TTS 服务，但不同模型在音色、中文表现、延迟和稳定性上的实际效果尚未得到广泛测试。

4. **原始歌单**  
   如果你需要先从音乐平台导出自己的歌单，可以使用开源项目 **Go Music** 获取原始歌单，再导入到 YourRadio：  
   `https://music.unmeta.cn/`

5. **可播放音源**  
   项目不内置、也不分发任何音源。请自行准备可用的音乐 API 或播放源，并按环境变量配置接入；Last.fm 只提供音乐信息，不提供最终播放链接。

## 运行

```bash
npm install
npm run dev
```

默认地址：

```text
http://localhost:3100
```

如果端口被占用，可以先清理再启动：

```bash
npm run dev:clean
```

## 环境变量

在 `.env.local` 中配置：

```env
MUSIC_API_BASE_URL=https://your-music-api.example.com/api.php
MUSIC_PROVIDER_ORDER=netease,spotify,apple
MUSIC_BITRATE=320
LASTFM_API_KEY=your_lastfm_api_key_here
LLM_PROVIDER=openai_compatible
LLM_API_URL=https://api.example.com/v1/chat/completions
LLM_API_KEY=your_llm_api_key_here
LLM_MODEL=your_model_name_here
```

`LLM_PROVIDER=openai_compatible` 适用于支持 OpenAI 风格 `/chat/completions` 的服务。若你仍使用 DeepSeek，并希望保留其专用请求参数，可改为 `LLM_PROVIDER=deepseek`。旧的 `DEEPSEEK_*` 环境变量仍会被兼容读取，但新配置优先。

Last.fm 只作为音乐信息 Provider，不提供播放 URL。最终播放仍必须经过 `MUSIC_PROVIDER_ORDER` 中的音乐 API 匹配并确认有 `audioUrl`。

`MUSIC_API_BASE_URL` 用于配置你自己的音乐 API 地址。当前接入层期望该 API 支持 `types=search`、`types=url` 和 `types=pic` 这类查询参数。

## 导入基础歌单

网页中可直接上传 `.csv` 或 `.xlsx` 歌单，先预览，再选择覆盖或合并写入 `user/playlists.json`。最少需要两列：歌名和歌手。

支持的表头别名：

```text
title / 歌曲名 / 歌名 / name / track name
artist / 艺术家 / 歌手 / ar / artist name
album / 专辑 / al
duration / 时长 / dt
```

命令行也可导入：

```powershell
npm run import:playlist -- C:\path\to\playlist.xlsx
npm run import:playlist -- C:\path\to\playlist.csv --merge
```

项目会统一生成内部格式：

```json
[
  {
    "title": "Song Name",
    "artist": "Artist Name",
    "album": "",
    "duration": ""
  }
]
```

可参考 `user/playlists.example.json`。真实的 `user/playlists.json` 会被 `.gitignore` 排除。


## 调试接口

调试接口默认关闭。如果你需要在本地排查推荐、TTS 或运行日志，可在 `.env.local` 中显式打开：

```env
ENABLE_DEBUG_ROUTES=true
```

未打开时，`/api/debug/*` 会统一返回 `404`。

- `POST /api/debug/recommend/seeds`
- `POST /api/debug/recommend/entity-expansion`
- `POST /api/debug/lastfm/expand-by-track`
- `POST /api/debug/lastfm/expand-by-artist`
- `POST /api/debug/lastfm/expand-by-album`
- `POST /api/debug/lastfm/query-variants`
- `POST /api/debug/lastfm/similar-tracks-with-variants`

中文歌曲查询会继续使用简体、繁体、香港繁体、台湾繁体和歌手 alias 变体，以提高 Last.fm 命中率。

## Qwen3-TTS 本地服务

默认 TTS 路线已经切到官方 Qwen3-TTS 本地 HTTP 服务：

```text
qwen3_custom_voice / Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice / Serena / cuda + float32
```

YourRadio 不会在 Next.js 进程里加载模型，也不会自动启动 Python 服务。请先单独启动本地服务：

```powershell
cd C:\path\to\YourRadio
.\scripts\start-qwen3-tts.ps1
```

关闭服务：

```powershell
cd C:\path\to\YourRadio
.\scripts\stop-qwen3-tts.ps1
```

服务地址：

```text
http://127.0.0.1:8010
```

测试 100 字串场是否能在冷启动 120 秒预算内生成：

```powershell
npm run test:tts:qwen3
```

如果当前 TTS Provider 不可用，YourRadio 会直接无串场播放下一首，不会阻塞音乐播放。



## 可选 TTS Provider

如果不想启用语音，可设 `TTS_PROVIDER=none`。若想接入别的 TTS，可设 `TTS_PROVIDER=http_compatible`，并提供一个接受 `text / model / voice / language`、返回 `ok / audioUrl / audioPath / format / cached / latencyMs` 的 JSON HTTP 接口。Qwen3 仍是默认推荐方案；TTS 不可用时，歌曲播放不会被阻塞。
