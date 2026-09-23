"""PDF-справки «Граф денег» по одному или нескольким счетам.

Точка входа для кода — `render_pdf(analysis, gids, mode="structural") -> bytes`; для командной
строки — `python -m reports --analysis <analysis.json> --gid <идентификатор> --out <файл.pdf>`.
Справка только переносит факты из analysis.json и ничего не выдумывает: модули `facts`
(проверка запроса и выборка значений) и `pdf` (вёрстка на ReportLab со шрифтом Noto Sans).
"""

from .facts import MAX_ACCOUNTS, MODES, ReportRequestError, report_filename


def render_pdf(analysis: dict, gids, mode: str = "structural") -> bytes:
    """PDF-справка по счетам в порядке запроса. ReportLab загружается только здесь:
    проверка запроса (`facts`) работает и там, где библиотека ещё не установлена."""
    from .pdf import render_pdf as render

    return render(analysis, gids, mode)

__all__ = ["MAX_ACCOUNTS", "MODES", "ReportRequestError", "render_pdf", "report_filename"]
