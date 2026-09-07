"""
Serviço de transcrição de vídeo/áudio genérico — deploy como Web Service
separado no Render (plano free ou starter). Roda faster-whisper (CPU),
sem custo de API, sem chave de terceiro.

Fluxo:
  POST /transcribe { "url": "https://..." }
  1. Baixa o arquivo (vídeo ou áudio) da URL.
  2. Extrai/normaliza o áudio com ffmpeg (16kHz mono WAV).
  3. Transcreve com faster-whisper.
  4. Retorna { text, language, duration }.

Requisitos (requirements.txt):
  fastapi
  uvicorn
  faster-whisper
  requests

Precisa do ffmpeg disponível no ambiente (adicionar no Dockerfile/build,
Render permite apt via Dockerfile custom, ou usar buildpack com ffmpeg).
"""

import os
import tempfile
import subprocess
import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from faster_whisper import WhisperModel

app = FastAPI()

# Modelo pequeno = mais rápido e mais leve em CPU. Trocar para "small" ou
# "medium" se a máquina do Render tiver RAM suficiente (custa mais tempo).
MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "base")
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")

# Limite de tamanho de download para não estourar o disco/tempo do free tier.
MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024  # 200 MB
MAX_DURATION_SECONDS = 60 * 30  # 30 min — ajuste conforme seu limite de plano


class TranscribeRequest(BaseModel):
    url: str
    max_chars: int = 12000


def download_file(url: str, dest_path: str):
    resp = requests.get(url, stream=True, timeout=30)
    resp.raise_for_status()
    total = 0
    with open(dest_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 256):
            total += len(chunk)
            if total > MAX_DOWNLOAD_BYTES:
                raise ValueError("Arquivo excede o limite de tamanho permitido (200MB).")
            f.write(chunk)


def extract_audio(input_path: str, output_path: str):
    # -vn descarta vídeo, 16kHz mono é o formato ideal pro Whisper
    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-vn", "-ac", "1", "-ar", "16000",
        "-t", str(MAX_DURATION_SECONDS),
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Falha ao extrair áudio: {result.stderr[-500:]}")


@app.post("/transcribe")
def transcribe(req: TranscribeRequest):
    with tempfile.TemporaryDirectory() as tmp:
        input_path = os.path.join(tmp, "input")
        audio_path = os.path.join(tmp, "audio.wav")

        try:
            download_file(req.url, input_path)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Erro ao baixar arquivo: {e}")

        try:
            extract_audio(input_path, audio_path)
        except Exception as e:
            raise HTTPException(status_code=422, detail=str(e))

        try:
            segments, info = model.transcribe(audio_path, beam_size=1)
            text_parts = [seg.text.strip() for seg in segments]
            text = " ".join(text_parts).strip()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Falha na transcrição: {e}")

        truncated = len(text) > req.max_chars
        if truncated:
            text = text[: req.max_chars] + "…"

        return {
            "text": text,
            "language": info.language,
            "duration": info.duration,
            "truncated": truncated,
        }


@app.get("/")
def health():
    return {"ok": True, "model": MODEL_SIZE}
