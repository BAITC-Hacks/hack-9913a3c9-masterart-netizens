"""Ограниченный контекст диалога: только вопросы и повторно проверенные ссылки на счета."""

from __future__ import annotations

import hashlib
import json
import re

from .config import DEFAULT_EFFORT, DEFAULT_MODEL, MODEL_EFFORTS
from .queries import GraphQueries, QueryError

MAX_HISTORY_TURNS = 6
MAX_HISTORY_QUESTION = 1000
MAX_HISTORY_GIDS = 100


def dataset_fingerprint(analysis: dict) -> str:
    payload = json.dumps(analysis, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def assistant_options(analysis: dict, *, model: str | None = None) -> dict:
    return {
        "dataset_fingerprint": dataset_fingerprint(analysis),
        "models": [{"id": name, "label": "GPT-" + name.removeprefix("gpt-").rsplit("-", 1)[0] + " " + name.rsplit("-", 1)[1].title(),
                    "efforts": list(efforts), "default_effort": DEFAULT_EFFORT}
                   for name, efforts in MODEL_EFFORTS.items()],
        "defaults": {"model": model if model in MODEL_EFFORTS else DEFAULT_MODEL, "effort": DEFAULT_EFFORT},
        "history_limits": {"turns": MAX_HISTORY_TURNS, "question_chars": MAX_HISTORY_QUESTION, "gids": MAX_HISTORY_GIDS},
    }


def validate_history(history: object, fingerprint: object, current: str, graph: GraphQueries) -> list[dict]:
    if fingerprint is not None and fingerprint != current:
        raise QueryError("Данные изменились. Начните новый диалог для текущего набора; прежняя история сохранена отдельно.")
    if history is None:
        return []
    if not isinstance(history, list) or len(history) > MAX_HISTORY_TURNS:
        raise QueryError("Контекст может содержать не больше шести предыдущих вопросов.")
    if history and fingerprint != current:
        raise QueryError("Для продолжения диалога нужен отпечаток текущего набора данных.")
    result = []
    for turn in history:
        if not isinstance(turn, dict) or set(turn) != {"question", "selection", "result_gids"}:
            raise QueryError("Некорректный формат истории диалога.")
        question = turn["question"]
        if not isinstance(question, str) or len(question) > MAX_HISTORY_QUESTION or "\x00" in question:
            raise QueryError("Предыдущий вопрос слишком длинный или повреждён.")
        item = {"question": question}
        for key in ("selection", "result_gids"):
            values = turn[key]
            if not isinstance(values, list) or len(values) > MAX_HISTORY_GIDS:
                raise QueryError("В одном предыдущем вопросе допускается не больше 100 ссылок на счета.")
            item[key] = list(dict.fromkeys(graph.require_gid(gid) for gid in values))
        result.append(item)
    return result


def referenced_gids(question: str, history: list[dict]) -> list[str]:
    """Обычные порядковые ссылки разбираются и без модели; числа из её прозы не используются."""
    latest = next((turn["result_gids"] for turn in reversed(history) if turn["result_gids"]), [])
    if not latest:
        return []
    q = question.lower()
    if re.search(r"перв(?:ые|ых)\s+(?:два|двух|2)|first\s+(?:two|2)", q):
        if len(latest) < 2:
            raise QueryError("В предыдущем ответе меньше двух счетов. Укажите два точных gid для сравнения.")
        return latest[:2]
    for pattern, index in ((r"перв(?:ый|ого|ому|ом)|\bfirst\b", 0),
                           (r"втор(?:ой|ого|ому|ом)|\bsecond\b", 1),
                           (r"трет(?:ий|ьего|ьему|ьем)|\bthird\b", 2)):
        if re.search(pattern, q):
            if index >= len(latest):
                raise QueryError("В предыдущем ответе нет счёта с таким порядковым номером.")
            return [latest[index]]
    return []
