"""
Round 2 analyst AI: several providers, several keys per provider, automatic fall-over.

Order of attempts for one question
  1. Groq   - every configured key (round-robin start, so teams spread over the keys),
              each key tried with a cascade of models
  2. Gemini - every configured key, each with its model cascade
  3. nothing answered -> returns None and round2_service uses its canned, case-safe reply

So Round 2 stays playable with no key at all, with one dead key, with a rate-limited key, with
a retired model, or with a provider that is down.

Settings (environment first, then backend/.env or ./.env; see config.py). Nothing secret is
ever written in the code, in logs or in the diagnostic status:

  GROQ_API_KEYS      comma separated list of Groq keys (several keys = more rate limit)
  GROQ_API_KEY       one more key (merged with the list)
  GROQ_MODEL         first Groq model to try (default openai/gpt-oss-120b)
  GEMINI_API_KEYS    comma separated list of Gemini keys
  GEMINI_API_KEY     one more key (merged with the list)
  GEMINI_MODEL       first Gemini model to try (default gemini-3.5-flash)
  CHRONOS_AI_DISABLED=1   never call any provider (tests, offline rehearsal)
  AI_TOTAL_TIMEOUT   seconds one question may spend over all attempts (default 20)

Key handling: a key that answers 401/403 is parked for 10 minutes, a rate-limited key (429)
for the time the provider asks for (default 60 s, at most 5 minutes), a model that the
provider no longer serves (404 / decommissioned) is parked for 10 minutes. Parked keys are
only used again when every key is parked.
"""

from __future__ import annotations

import hashlib
import json
import logging
import ssl
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional

from ..config import setting

logger = logging.getLogger("chronos.ai")

# ------------------------------------------------------------------ configuration

GROQ_URL_DEFAULT = "https://api.groq.com/openai/v1/chat/completions"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

# First entry is replaced by GROQ_MODEL / GEMINI_MODEL when set. The later ones are the
# fall-over cascade, from the strongest to the cheapest.
GROQ_MODELS_DEFAULT = [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
]
GEMINI_MODELS_DEFAULT = ["gemini-3.5-flash", "gemini-2.5-flash"]

REQUEST_TIMEOUT_SECONDS = 8.0
DEFAULT_TOTAL_TIMEOUT_SECONDS = 20.0
MAX_OUTPUT_TOKENS = 300
CACHE_SIZE = 256

PARK_BAD_KEY_SECONDS = 600
PARK_RATE_LIMIT_DEFAULT_SECONDS = 60
PARK_RATE_LIMIT_MAX_SECONDS = 300
PARK_BAD_MODEL_SECONDS = 600

# A user agent that is not "Python-urllib": Cloudflare (in front of Groq) answers 403 to that.
_USER_AGENT = "Mozilla/5.0 (compatible; ProjectChronos/1.0)"

_TRUE = {"1", "true", "yes", "on"}

# ------------------------------------------------------------------ state

_lock = threading.Lock()
_rr = {"groq": 0, "gemini": 0}          # round-robin start index per provider
_parked_keys: Dict[str, float] = {}      # fingerprint -> monotonic time until which it rests
_parked_models: Dict[str, float] = {}    # "provider:model" -> monotonic time
_cache: Dict[str, Dict[str, str]] = {}
_stats = {"calls": 0, "answered": 0, "cache_hits": 0, "all_failed": 0}
_last = {"provider": "", "model": "", "error": "", "at": 0.0}


# ------------------------------------------------------------------ helpers

def _fingerprint(key: str) -> str:
    """Stable id of a key for the parked-key table (never the key itself)."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def _ssl_context() -> Optional[ssl.SSLContext]:
    try:
        import certifi  # optional

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        try:
            return ssl.create_default_context()
        except Exception:
            return None


def _split_keys(*raw_values: str) -> List[str]:
    """Merge comma separated key lists, drop blanks, quotes, duplicates and the placeholders
    that come from copying .env.example (so they never reach a provider)."""
    keys: List[str] = []
    for raw in raw_values:
        for part in (raw or "").split(","):
            key = part.strip().strip('"').strip("'")
            lowered = key.lower()
            if not key or key in keys:
                continue
            if "_here" in lowered or lowered.startswith("your") or lowered in {"changeme", "xxx"}:
                continue
            keys.append(key)
    return keys


def disabled() -> bool:
    return setting("CHRONOS_AI_DISABLED").strip().lower() in _TRUE


def groq_keys() -> List[str]:
    return _split_keys(setting("GROQ_API_KEYS"), setting("GROQ_API_KEY"))


def gemini_keys() -> List[str]:
    return _split_keys(setting("GEMINI_API_KEYS"), setting("GEMINI_API_KEY"))


def groq_models() -> List[str]:
    first = setting("GROQ_MODEL").strip()
    models = ([first] if first else []) + GROQ_MODELS_DEFAULT
    return list(dict.fromkeys(models))


def gemini_models() -> List[str]:
    first = setting("GEMINI_MODEL").strip()
    models = ([first] if first else []) + GEMINI_MODELS_DEFAULT
    return list(dict.fromkeys(models))


def is_configured() -> bool:
    return not disabled() and bool(groq_keys() or gemini_keys())


def _total_budget() -> float:
    try:
        return max(3.0, float(setting("AI_TOTAL_TIMEOUT") or DEFAULT_TOTAL_TIMEOUT_SECONDS))
    except ValueError:
        return DEFAULT_TOTAL_TIMEOUT_SECONDS


def _park_key(key: str, seconds: float) -> None:
    with _lock:
        _parked_keys[_fingerprint(key)] = time.monotonic() + seconds


def _park_model(provider: str, model: str, seconds: float = PARK_BAD_MODEL_SECONDS) -> None:
    with _lock:
        _parked_models[f"{provider}:{model}"] = time.monotonic() + seconds


def _model_usable(provider: str, model: str) -> bool:
    with _lock:
        return _parked_models.get(f"{provider}:{model}", 0.0) <= time.monotonic()


def _ordered_keys(provider: str, keys: List[str]) -> List[str]:
    """Keys in the order to try them: rotating start (load spreading), rested keys first,
    parked keys last (still tried: a parked key is better than no answer)."""
    if not keys:
        return []
    with _lock:
        start = _rr[provider] % len(keys)
        _rr[provider] = (start + 1) % len(keys)
        now = time.monotonic()
        rotated = keys[start:] + keys[:start]
        ready = [k for k in rotated if _parked_keys.get(_fingerprint(k), 0.0) <= now]
        parked = [k for k in rotated if k not in ready]
    return ready + parked


def _remember_error(provider: str, text: str) -> None:
    with _lock:
        _last["error"] = f"{provider}: {text}"[:160]
        _last["at"] = time.time()


def _retry_after_seconds(error: urllib.error.HTTPError) -> float:
    try:
        value = float(error.headers.get("Retry-After", ""))
    except (TypeError, ValueError, AttributeError):
        return PARK_RATE_LIMIT_DEFAULT_SECONDS
    return min(max(value, 1.0), PARK_RATE_LIMIT_MAX_SECONDS)


def _cache_key(system_prompt: str, history: list, user_message: str) -> str:
    turns = json.dumps([[h.get("role", ""), h.get("text", "")] for h in history])
    raw = f"{system_prompt}\x1f{turns}\x1f{user_message.strip().lower()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ provider calls
# Each call returns the reply text, or raises urllib.error.HTTPError / another exception.

def _call_groq(key: str, model: str, system_prompt: str, history: list, user_message: str, timeout: float) -> str:
    messages = [{"role": "system", "content": system_prompt}]
    for h in history:
        role = "user" if h.get("role") == "user" else "assistant"
        messages.append({"role": role, "content": h.get("text", "")})
    messages.append({"role": "user", "content": user_message})

    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": 0.4,
        "max_tokens": MAX_OUTPUT_TOKENS,
    }
    if model.startswith("openai/gpt-oss"):
        # Reasoning models spend tokens on hidden thinking: keep it short so an answer is left.
        payload["reasoning_effort"] = "low"

    request = urllib.request.Request(
        setting("GROQ_API_URL") or GROQ_URL_DEFAULT,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
            "User-Agent": _USER_AGENT,
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context()) as response:
        data = json.loads(response.read().decode("utf-8"))
    choice = data["choices"][0]
    text = (choice["message"].get("content") or "").strip()
    if (choice.get("finish_reason") or "").lower() == "length":
        text = _trim_to_sentence(text)
    return text


def _call_gemini(key: str, model: str, system_prompt: str, history: list, user_message: str, timeout: float) -> str:
    contents = [
        {"role": "user" if h.get("role") == "user" else "model", "parts": [{"text": h.get("text", "")}]}
        for h in history
    ]
    contents.append({"role": "user", "parts": [{"text": user_message}]})
    body = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        # thinkingBudget 0: hidden "thinking" tokens could otherwise use up the output budget.
        "generationConfig": {
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
            "temperature": 0.5,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    request = urllib.request.Request(
        (setting("GEMINI_API_URL") or GEMINI_URL).format(model=model),
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key, "User-Agent": _USER_AGENT},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context()) as response:
        data = json.loads(response.read().decode("utf-8"))
    candidate = data["candidates"][0]
    text = "".join(part.get("text", "") for part in candidate.get("content", {}).get("parts", [])).strip()
    finish = (candidate.get("finishReason") or "STOP").upper()
    if finish in ("SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "OTHER"):
        return ""  # a half answer cut by a filter must not reach the player: next model / canned reply
    if finish == "MAX_TOKENS":
        text = _trim_to_sentence(text)
    return text


def _trim_to_sentence(text: str) -> str:
    """A reply cut by the token limit ends at its last complete sentence."""
    if "\n- " in text or "\n• " in text or text.lstrip().startswith(("- ", "• ")):
        return text  # a bullet list has no sentence ends to cut at
    cut = max(text.rfind(". "), text.rfind("! "), text.rfind("? "), text.rfind(".\n"))
    if text.endswith((".", "!", "?")):
        return text
    return text[: cut + 1].strip() if cut > 40 else text


_CALLS: Dict[str, Callable[..., str]] = {"groq": _call_groq, "gemini": _call_gemini}


def _attempt(provider: str, key: str, model: str, system_prompt: str, history: list,
             user_message: str, timeout: float):
    """One request (a single quick retry on a 5xx). Returns (outcome, reply) where outcome is
    ok | bad_key | rate_limited | bad_model | failed."""
    call = _CALLS[provider]
    for attempt in range(2):
        try:
            reply = call(key, model, system_prompt, history, user_message, timeout)
        except urllib.error.HTTPError as error:
            code = error.code
            if code in (401, 403):
                _park_key(key, PARK_BAD_KEY_SECONDS)
                _remember_error(provider, f"key rejected (HTTP {code})")
                return "bad_key", None
            if code == 429:
                _park_key(key, _retry_after_seconds(error))
                _remember_error(provider, "rate limited (HTTP 429)")
                return "rate_limited", None
            if code in (400, 404):
                try:
                    body = error.read(2000).decode("utf-8", "replace").lower()
                except Exception:
                    body = ""
                # Google answers a bad key with HTTP 400 ("API key not valid" / API_KEY_INVALID),
                # not 401: rest that key, do not blame the model.
                if "api key not valid" in body or "api_key_invalid" in body or "invalid api key" in body:
                    _park_key(key, PARK_BAD_KEY_SECONDS)
                    _remember_error(provider, "key rejected (invalid API key)")
                    return "bad_key", None
                if code == 404 or "model" in body:
                    _park_model(provider, model)  # retired / unknown model: skip it for a while
                    _remember_error(provider, f"model {model} unavailable (HTTP {code})")
                    return "bad_model", None
                _remember_error(provider, f"HTTP {code}")
                return "failed", None
            if code >= 500 and attempt == 0:
                time.sleep(0.4)
                continue
            _remember_error(provider, f"HTTP {code}")
            return "failed", None
        except Exception as exc:  # timeout, DNS, TLS, bad JSON ...
            _remember_error(provider, type(exc).__name__)
            return "failed", None
        return ("ok", reply) if reply else ("failed", None)
    return "failed", None


def _try_provider(provider: str, keys: List[str], models: List[str], system_prompt: str,
                  history: list, user_message: str, deadline: float) -> Optional[Dict[str, str]]:
    for key in _ordered_keys(provider, keys):
        for model in models:
            if time.monotonic() >= deadline:
                _remember_error(provider, "time budget used up")
                return None
            if not _model_usable(provider, model):
                continue
            timeout = max(1.0, min(REQUEST_TIMEOUT_SECONDS, deadline - time.monotonic()))
            outcome, reply = _attempt(provider, key, model, system_prompt, history, user_message, timeout)
            if outcome == "ok":
                return {"reply": reply, "provider": provider, "model": model}
            if outcome in ("bad_key", "rate_limited"):
                break  # this key is out: next key
            # bad_model / failed: next model on the same key
    return None


# ------------------------------------------------------------------ public API

def ask_with_metadata(system_prompt: str, history: list, user_message: str) -> Dict[str, Any]:
    """{"reply": str | None, "provider": "groq" | "gemini" | "cache" | "", "model": str}."""
    none = {"reply": None, "provider": "", "model": ""}
    if disabled():
        return none

    groq = groq_keys()
    gem = gemini_keys()
    if not groq and not gem:
        return none

    ck = _cache_key(system_prompt, history, user_message)
    with _lock:
        _stats["calls"] += 1
        hit = _cache.get(ck)
        if hit:
            _stats["cache_hits"] += 1
            return {"reply": hit["reply"], "provider": hit["provider"], "model": hit["model"]}

    deadline = time.monotonic() + _total_budget()
    result = None
    if groq:
        result = _try_provider("groq", groq, groq_models(), system_prompt, history, user_message, deadline)
    if result is None and gem:
        result = _try_provider("gemini", gem, gemini_models(), system_prompt, history, user_message, deadline)

    with _lock:
        if result is None:
            _stats["all_failed"] += 1
            return none
        _stats["answered"] += 1
        _last.update({"provider": result["provider"], "model": result["model"], "at": time.time()})
        if len(_cache) >= CACHE_SIZE:
            _cache.clear()
        _cache[ck] = result
    return dict(result)


def ask(system_prompt: str, history: list, user_message: str) -> Optional[str]:
    """Reply text, or None when nothing answered (caller uses its canned reply)."""
    return ask_with_metadata(system_prompt, history, user_message)["reply"]


def status() -> Dict[str, Any]:
    """Safe diagnostics for the host: counts and names only, never a key or part of one."""
    now = time.monotonic()
    g, m = groq_keys(), gemini_keys()
    with _lock:
        parked = {_fp for _fp, until in _parked_keys.items() if until > now}
        resting_models = [k for k, until in _parked_models.items() if until > now]
        stats = dict(_stats)
        last = dict(_last)
        cache_size = len(_cache)
    return {
        "enabled": not disabled(),
        "configured": is_configured(),
        "providers": [
            {"name": "groq", "keys": len(g), "keys_resting": sum(1 for k in g if _fingerprint(k) in parked),
             "models": groq_models()},
            {"name": "gemini", "keys": len(m), "keys_resting": sum(1 for k in m if _fingerprint(k) in parked),
             "models": gemini_models()},
        ],
        "models_resting": resting_models,
        "cache_entries": cache_size,
        "stats": stats,
        "last_success": {"provider": last["provider"], "model": last["model"]},
        "last_error": last["error"],
        "fallback": "built-in case-safe replies (always available)",
    }


def reset_for_tests() -> None:
    with _lock:
        _parked_keys.clear()
        _parked_models.clear()
        _cache.clear()
        _rr.update({"groq": 0, "gemini": 0})
        for k in _stats:
            _stats[k] = 0
        _last.update({"provider": "", "model": "", "error": "", "at": 0.0})
