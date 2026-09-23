"""Серверная конфигурация: только известные имена, без исполнения shell."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping

DEFAULT_MODEL = "gpt-6-astra"
KNOWN_NAMES = ("OPENAI_API_KEY", "OPENAI_MODEL")
# Допустимые пары Responses API; расширяются только после проверки поддержки сервером.
MODEL_EFFORTS = {
    "gpt-6-astra": ("low", "medium", "high", "xhigh", "max"),
    "gpt-5.6-sol": ("none", "low", "medium", "high", "xhigh", "max"),
    "gpt-5.6-luna": ("none", "low", "medium", "high", "xhigh", "max"),
}
DEFAULT_EFFORT = "medium"


def load_config(env_file: str | Path | None = None, *, environ: Mapping[str, str] | None = None) -> dict:
    """Файл читается только по явному пути сервера; окружение имеет приоритет."""
    values = {}
    if env_file is not None:
        try:
            with open(env_file, encoding="utf-8") as stream:
                raw = stream.read(16385)
            if len(raw) > 16384:
                raise ValueError("Файл конфигурации слишком велик.")
            for line in raw.splitlines():
                key, separator, value = line.strip().partition("=")
                if separator and key in KNOWN_NAMES:
                    value = value.strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                        value = value[1:-1]
                    if any(c in value for c in ("\r", "\n", "\x00")):
                        raise ValueError("Некорректная серверная конфигурация.")
                    values[key] = value
        except OSError:
            raise ValueError("Не удалось прочитать серверную конфигурацию.") from None
    env = os.environ if environ is None else environ
    for key in KNOWN_NAMES:
        if key in env:
            values[key] = env[key]
    return {"api_key": values.get("OPENAI_API_KEY", ""), "model": values.get("OPENAI_MODEL") or DEFAULT_MODEL}
