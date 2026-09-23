"""Русское форматирование чисел для объяснений и выгрузок."""

from __future__ import annotations


def kzt_value(tiyn: int):
    """Тиыны → тенге для JSON: целое, если копеек нет, иначе число с двумя знаками."""
    if tiyn % 100 == 0:
        return tiyn // 100
    return round(tiyn / 100, 2)


def kzt_csv(tiyn: int) -> str:
    """Точная десятичная запись суммы в тенге для CSV."""
    sign = "-" if tiyn < 0 else ""
    whole, frac = divmod(abs(tiyn), 100)
    return f"{sign}{whole}" if frac == 0 else f"{sign}{whole}.{frac:02d}"


def kzt_ru(tiyn: int) -> str:
    """Краткая сумма для текста: «53 000 ₸», «1,2 млн ₸»."""
    kzt = tiyn / 100
    if abs(kzt) >= 1_000_000:
        return f"{kzt / 1_000_000:.1f}".replace(".", ",") + " млн ₸"
    return f"{int(round(kzt)):,}".replace(",", " ") + " ₸"


def score_ru(value: float) -> str:
    return f"{value:.2f}".replace(".", ",")


def percent_ru(ratio: float) -> str:
    return f"{int(round(ratio * 100))}%"


def plural_ru(n: int, one: str, few: str, many: str) -> str:
    """Согласование существительного с числом: 1 счёт, 2 счёта, 5 счетов."""
    tail, tail2 = n % 10, n % 100
    if tail == 1 and tail2 != 11:
        return one
    if 2 <= tail <= 4 and not 12 <= tail2 <= 14:
        return few
    return many


def clip_text(text: str, limit: int) -> str:
    """Обрезает текст по границе слова, сохраняя лимит символов."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    space = cut.rfind(" ")
    if space > limit // 2:
        cut = cut[:space]
    return cut.rstrip(" ,;:.") + "…"
