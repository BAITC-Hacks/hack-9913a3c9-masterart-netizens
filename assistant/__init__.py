"""Проверяемый помощник по локальному графу переводов."""

from .config import load_config
from .service import answer

__all__ = ["answer", "load_config"]
