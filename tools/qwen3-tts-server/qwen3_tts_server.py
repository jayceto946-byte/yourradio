from __future__ import annotations

import asyncio
import hashlib
import os
import subprocess
import sys
import re
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    import torch
except Exception:  # pragma: no cover
    torch = None  # type: ignore

Qwen3TTSModel = None  # type: ignore

# qwen-tts may still consult the legacy TRANSFORMERS_CACHE variable for
# nested assets such as speech_tokenizer. Keep it pointed at the complete
# HuggingFace hub cache when callers start this server manually.
def align_transformers_cache() -> None:
    hub_cache = os.getenv("HUGGINGFACE_HUB_CACHE")
    transformers_cache = os.getenv("TRANSFORMERS_CACHE")
    if not hub_cache and transformers_cache:
        candidate = os.path.join(os.path.dirname(transformers_cache), "hub")
        if os.path.isdir(candidate):
            hub_cache = candidate
            os.environ["HUGGINGFACE_HUB_CACHE"] = hub_cache
    if not hub_cache:
        return
    if not transformers_cache:
        os.environ["TRANSFORMERS_CACHE"] = hub_cache
        return
    normalized = os.path.normcase(os.path.normpath(transformers_cache))
    legacy_suffix = os.path.normcase(os.path.normpath(os.path.join("huggingface", "transformers")))
    if normalized.endswith(legacy_suffix):
        os.environ["TRANSFORMERS_CACHE"] = hub_cache


align_transformers_cache()

PROVIDER = "qwen3_custom_voice"
MODEL_NAME = os.getenv("QWEN3_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
DEVICE = os.getenv("QWEN3_TTS_DEVICE", "cuda")
DTYPE = os.getenv("QWEN3_TTS_DTYPE", "float32")
DEFAULT_SPEAKER = os.getenv("QWEN3_TTS_SPEAKER", "Serena")
DEFAULT_LANGUAGE = os.getenv("QWEN3_TTS_LANGUAGE", "Chinese")
DEFAULT_INSTRUCT = os.getenv(
    "QWEN3_TTS_INSTRUCT",
    "更像深夜电台主持人，声音放松、贴近麦克风，语速慢，情绪稳定，声音慵懒，不要夸张。",
)

ROOT_DIR = Path(__file__).resolve().parents[2]
CACHE_DIR = Path(os.getenv("TTS_CACHE_DIR", str(ROOT_DIR / "data" / "tts-cache")))
CACHE_MAX_AGE_DAYS = float(os.getenv("TTS_CACHE_MAX_AGE_DAYS", "7"))
CACHE_MAX_SIZE_MB = float(os.getenv("TTS_CACHE_MAX_SIZE_MB", "1024"))
CACHE_CLEANUP_INTERVAL_SEC = int(os.getenv("TTS_CACHE_CLEANUP_INTERVAL_SEC", "3600"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
POSTPROCESS_ENABLED = os.getenv("QWEN3_TTS_POSTPROCESS_ENABLED", "true").lower() not in {"0", "false", "no"}
POSTPROCESS_SCRIPT_RAW = os.getenv("QWEN3_TTS_POSTPROCESS_SCRIPT", "").strip()
POSTPROCESS_SCRIPT = Path(POSTPROCESS_SCRIPT_RAW) if POSTPROCESS_SCRIPT_RAW else None
_last_cleanup_at = 0.0

app = FastAPI(title="YourRadio Qwen3 TTS Server")
app.mount("/tts-cache", StaticFiles(directory=str(CACHE_DIR)), name="tts-cache")

_model: Any = None
_model_loading = False
_model_lock = asyncio.Lock()
_generation_lock = asyncio.Lock()


class TtsRequest(BaseModel):
    text: str = Field(min_length=1)
    speaker: Optional[str] = None
    language: Optional[str] = None
    instruct: Optional[str] = None


def normalize_text(text: str) -> str:
    text = re.sub(r"\b[A-Z]{2,}\b", lambda match: match.group(0).lower(), text)
    return " ".join(text.split()).strip()


def cache_key(text: str, speaker: str, language: str, instruct: str) -> str:
    body = "\n".join([
        PROVIDER,
        MODEL_NAME,
        DEVICE,
        DTYPE,
        speaker,
        language,
        instruct,
        normalize_text(text),
    ])
    return hashlib.sha256(body.encode("utf-8")).hexdigest()



def write_processed_wav(raw_path: Path, audio_path: Path) -> dict[str, Any]:
    if not POSTPROCESS_ENABLED or POSTPROCESS_SCRIPT is None or not POSTPROCESS_SCRIPT.exists():
        raw_path.replace(audio_path)
        return {"postprocessed": False, "postprocessError": None if not POSTPROCESS_ENABLED else "script_not_found"}

    try:
        result = subprocess.run(
            [sys.executable, str(POSTPROCESS_SCRIPT), str(raw_path), str(audio_path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
        try:
            raw_path.unlink(missing_ok=True)
        except Exception:
            pass
        return {"postprocessed": True, "postprocessError": None, "postprocessLog": result.stdout[-1000:]}
    except Exception as exc:
        try:
            if audio_path.exists():
                audio_path.unlink()
            raw_path.replace(audio_path)
        except Exception:
            pass
        return {"postprocessed": False, "postprocessError": str(exc)}
def dtype_value() -> Any:
    if DTYPE != "float32":
        raise RuntimeError(f"Unsupported dtype '{DTYPE}'. This service is intentionally fixed to float32 by default.")
    if torch is None:
        raise RuntimeError("torch is not available. Install a working PyTorch build before starting this server.")
    return torch.float32


def device_map_value() -> str:
    if DEVICE == "cuda":
        return "cuda:0"
    return DEVICE


def load_model_sync() -> Any:
    global Qwen3TTSModel
    if Qwen3TTSModel is None:
        try:
            from qwen_tts import Qwen3TTSModel as ImportedQwen3TTSModel
            Qwen3TTSModel = ImportedQwen3TTSModel
        except Exception as exc:
            raise RuntimeError(f"qwen-tts is not importable. Install qwen-tts and SoX in this Python environment. Details: {exc}") from exc
    return Qwen3TTSModel.from_pretrained(
        MODEL_NAME,
        device_map=device_map_value(),
        dtype=dtype_value(),
        attn_implementation="eager",
    )


async def get_model() -> Any:
    global _model, _model_loading
    if _model is not None:
        return _model
    async with _model_lock:
        if _model is not None:
            return _model
        _model_loading = True
        try:
            _model = await asyncio.to_thread(load_model_sync)
            return _model
        finally:
            _model_loading = False


def flatten_wav(value: Any) -> np.ndarray:
    wav = np.asarray(value, dtype=np.float32)
    if wav.ndim > 1:
        wav = np.squeeze(wav)
    if wav.ndim > 1:
        wav = wav.reshape(-1)
    return wav


def peak_normalize(wav: np.ndarray) -> np.ndarray:
    if wav.size == 0:
        return wav
    peak = float(np.max(np.abs(wav)))
    if peak > 0:
        wav = wav / peak * 0.98
    return np.clip(wav, -1.0, 1.0).astype(np.float32)


def public_url(file_path: Path) -> str:
    return f"/tts-cache/{file_path.name}"


def cleanup_tts_cache(protected_path: Optional[Path] = None) -> None:
    global _last_cleanup_at
    now = time.time()
    if now - _last_cleanup_at < CACHE_CLEANUP_INTERVAL_SEC:
        return
    _last_cleanup_at = now
    protected = protected_path.resolve() if protected_path else None

    wav_files = [path for path in CACHE_DIR.glob("*.wav") if path.is_file()]
    max_age_sec = CACHE_MAX_AGE_DAYS * 86400
    for path in wav_files:
        try:
            if protected and path.resolve() == protected:
                continue
            if max_age_sec > 0 and now - path.stat().st_mtime > max_age_sec:
                path.unlink(missing_ok=True)
        except Exception:
            pass

    wav_files = [path for path in CACHE_DIR.glob("*.wav") if path.is_file()]
    max_bytes = int(CACHE_MAX_SIZE_MB * 1024 * 1024)
    if max_bytes <= 0:
        return
    total = sum(path.stat().st_size for path in wav_files)
    if total <= max_bytes:
        return
    for path in sorted(wav_files, key=lambda item: item.stat().st_mtime):
        try:
            if protected and path.resolve() == protected:
                continue
            size = path.stat().st_size
            path.unlink(missing_ok=True)
            total -= size
            if total <= max_bytes:
                break
        except Exception:
            pass


@app.get("/health")
async def health() -> dict[str, Any]:
    cleanup_tts_cache()
    return {
        "ok": True,
        "provider": PROVIDER,
        "model": MODEL_NAME,
        "device": DEVICE,
        "dtype": DTYPE,
        "speaker": DEFAULT_SPEAKER,
        "loaded": _model is not None,
        "loading": _model_loading,
    }


@app.get("/speakers")
async def speakers() -> dict[str, Any]:
    try:
        model = await get_model()
        if hasattr(model, "get_supported_speakers"):
            supported = list(model.get_supported_speakers())
        else:
            supported = []
        return {"ok": True, "speakers": supported, "defaultSpeaker": DEFAULT_SPEAKER}
    except Exception as exc:
        return {"ok": False, "speakers": [], "defaultSpeaker": DEFAULT_SPEAKER, "error": str(exc)}


@app.post("/tts")
async def tts(request: TtsRequest) -> dict[str, Any]:
    started = time.perf_counter()
    text = normalize_text(request.text)
    speaker = request.speaker or DEFAULT_SPEAKER
    language = request.language or DEFAULT_LANGUAGE
    instruct = request.instruct or DEFAULT_INSTRUCT
    key = cache_key(text, speaker, language, instruct)
    audio_path = CACHE_DIR / f"{key}.wav"

    cleanup_tts_cache(audio_path)

    if audio_path.exists():
        return {
            "ok": True,
            "cached": True,
            "provider": PROVIDER,
            "model": MODEL_NAME,
            "device": DEVICE,
            "dtype": DTYPE,
            "speaker": speaker,
            "language": language,
            "latencyMs": round((time.perf_counter() - started) * 1000),
            "audioPath": str(audio_path),
            "audioUrl": public_url(audio_path),
        }

    async with _generation_lock:
        if audio_path.exists():
            return {
                "ok": True,
                "cached": True,
                "provider": PROVIDER,
                "model": MODEL_NAME,
                "device": DEVICE,
                "dtype": DTYPE,
                "speaker": speaker,
                "language": language,
                "latencyMs": round((time.perf_counter() - started) * 1000),
                "audioPath": str(audio_path),
                "audioUrl": public_url(audio_path),
            }

        try:
            model = await get_model()
            wavs, sr = await asyncio.to_thread(
                model.generate_custom_voice,
                text=text,
                language=language,
                speaker=speaker,
                instruct=instruct,
            )
            first_wav = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
            wav = peak_normalize(flatten_wav(first_wav))
            raw_path = audio_path.with_suffix(".raw.wav")
            sf.write(str(raw_path), wav, int(sr), subtype="PCM_16")
            postprocess = write_processed_wav(raw_path, audio_path)
            cleanup_tts_cache(audio_path)
            return {
                "ok": True,
                "cached": False,
                "provider": PROVIDER,
                "model": MODEL_NAME,
                "device": DEVICE,
                "dtype": DTYPE,
                "speaker": speaker,
                "language": language,
                "latencyMs": round((time.perf_counter() - started) * 1000),
                "audioPath": str(audio_path),
                "audioUrl": public_url(audio_path),
                **postprocess,
            }
        except Exception as exc:
            return {
                "ok": False,
                "cached": False,
                "provider": PROVIDER,
                "model": MODEL_NAME,
                "device": DEVICE,
                "dtype": DTYPE,
                "speaker": speaker,
                "language": language,
                "latencyMs": round((time.perf_counter() - started) * 1000),
                "error": str(exc),
            }


@app.post("/tts/test")
async def tts_test(request: Optional[TtsRequest] = None) -> dict[str, Any]:
    payload = request or TtsRequest(
        text="这里是 YourRadio。接下来这首不用说得太满，它的声音更像夜里慢慢亮起的一盏灯，节奏不急，留白也够，适合让注意力从上一段旋律里自然落下来。",
        speaker=DEFAULT_SPEAKER,
        language=DEFAULT_LANGUAGE,
        instruct=DEFAULT_INSTRUCT,
    )
    return await tts(payload)


