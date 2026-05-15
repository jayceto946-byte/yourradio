# Qwen3-TTS Local Server for YourRadio

This service wraps the official Qwen3-TTS Python package as a local HTTP API for YourRadio.

It intentionally runs outside the Next.js process. YourRadio calls it over HTTP at `http://127.0.0.1:8010`.

## Requirements

Install PyTorch for your own CUDA/CPU environment first. Do not rely on this folder to install torch.

Then install the lightweight service dependencies:

```powershell
pip install -r requirements.txt
```

## Cache location

Model and package caches should live on `D:` instead of the Windows user profile on `C:`.
Run this once from the YourRadio project root:

```powershell
cd C:\path\to\YourRadio
.\scripts\migrate-ai-caches-to-d.ps1
```

The start script also sets these environment variables for the Qwen3 server process:

```text
HF_HOME=C:\path\to\yourradio-cache\huggingface
HUGGINGFACE_HUB_CACHE=C:\path\to\yourradio-cache\huggingface\hub
TRANSFORMERS_CACHE=C:\path\to\yourradio-cache\huggingface\transformers
PIP_CACHE_DIR=C:\path\to\yourradio-cache\pip
```

## Start on Windows

Recommended:

```powershell
cd C:\path\to\YourRadio
.\scripts\start-qwen3-tts.ps1
```

Check whether it is running:

```powershell
cd C:\path\to\YourRadio
.\scripts\check-qwen3-tts.ps1
```

Stop it:

```powershell
cd C:\path\to\YourRadio
.\scripts\stop-qwen3-tts.ps1
```

Manual equivalent using your existing Python 3.12 environment:

```powershell
cd C:\path\to\YourRadio\tools\qwen3-tts-server
$env:HF_HOME="C:\path\to\yourradio-cache\huggingface"
$env:HUGGINGFACE_HUB_CACHE="C:\path\to\yourradio-cache\huggingface\hub"
$env:TRANSFORMERS_CACHE="C:\path\to\yourradio-cache\huggingface\transformers"
$env:PIP_CACHE_DIR="C:\path\to\yourradio-cache\pip"
C:\path\to\qwen3-tts-env\Scripts\python.exe -m uvicorn qwen3_tts_server:app --host 127.0.0.1 --port 8010
```

The service defaults are conservative for the current machine:

- model: `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- device: `cuda`
- dtype: `float32`
- speaker: `Vivian`
- attention: `eager`

Do not switch to float16 on this setup unless you have retested it; local testing showed CUDA float16 can trigger device-side assert errors.

## Endpoints

- `GET /health`
- `GET /speakers`
- `POST /tts`
- `POST /tts/test`

Generated wav files are cached under `C:\path\to\YourRadio\data\tts-cache` and served by this service at `/tts-cache/<hash>.wav`.

