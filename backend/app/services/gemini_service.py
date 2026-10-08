"""
Gemini wrapper for the Round 2 analyst only (PROJECT_REFERENCE.md Section 14).

The API key stays on the backend: set GEMINI_API_KEY in the environment, or in
backend/.env, or in a .env next to the backend folder. The frontend never sees it.

Any failure (no key, timeout, bad response) returns None after one retry, so the
caller falls back to a predefined analytical reply. Round 2 must stay playable
without Gemini. Gemini only produces text: it never touches state, scores or
unlocks.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

# Tried in order; a model that is retired (404) or overloaded (503) just moves on
# to the next one. Override the first with GEMINI_MODEL in the environment.
# (gemini-2.0-flash and gemini-2.5-flash-lite are retired for new keys.)
_MODELS = [
    os.environ.get("GEMINI_MODEL", "gemini-3.5-flash"),
    "gemini-2.5-flash",
]
_TIMEOUT_SECONDS = 10


def _api_key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key

    root = Path(__file__).resolve().parents[3]  # folder that contains backend/
    for env_file in (root / "backend" / ".env", root / ".env"):
        try:
            for line in env_file.read_text(encoding="utf-8").splitlines():
                if line.startswith("GEMINI_API_KEY="):
                    key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if key:
                        return key
        except OSError:
            continue
    return ""


def is_configured() -> bool:
    return bool(_api_key())


def ask(system_prompt: str, history: list[dict], user_message: str) -> str | None:
    """history: [{"role": "user" | "assistant", "text": str}, ...]. None on any failure."""
    key = _api_key()
    if not key:
        return None

    contents = [
        {"role": "user" if h["role"] == "user" else "model", "parts": [{"text": h["text"]}]}
        for h in history
    ]
    contents.append({"role": "user", "parts": [{"text": user_message}]})

    body = json.dumps(
        {
            "system_instruction": {"parts": [{"text": system_prompt}]},
            "contents": contents,
            # thinkingBudget 0: otherwise the model's hidden "thinking" tokens can
            # use up maxOutputTokens and leave an empty answer.
            "generationConfig": {
                "maxOutputTokens": 300,
                "temperature": 0.5,
                "thinkingConfig": {"thinkingBudget": 0},
            },
        }
    ).encode("utf-8")

    for model in _MODELS:
        request = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=body,
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
            method="POST",
        )
        for attempt in range(2):
            try:
                with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                text = payload["candidates"][0]["content"]["parts"][0]["text"].strip()
                if text:
                    return text
                break
            except urllib.error.HTTPError as error:
                # 503 = the model is busy for a moment: one quick retry, then the next model.
                if error.code == 503 and attempt == 0:
                    time.sleep(1)
                    continue
                break
            except Exception:
                break

    return None
