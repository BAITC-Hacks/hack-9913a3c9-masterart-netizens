"""Вёрстка PDF-справки на ReportLab: одна страница-раздел на счёт, при нескольких — сводка впереди.

Оформление сдержанное: один шрифт (Noto Sans, лицензия OFL в fonts/), чёрный текст, серые
подписи, тонкие линии вместо рамок. Иерархия: счёт → гипотеза роли → опора и приоритет
раздельно → потоки → датированный путь → границы наблюдения → следующий запрос → источники.
PDF детерминирован (invariant): одинаковый вход даёт одинаковые байты.
"""

from __future__ import annotations

import io
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Flowable,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.flowables import HRFlowable

from . import facts as F

FONT_DIR = Path(__file__).resolve().parent / "fonts"
REGULAR, BOLD = "ReportSans", "ReportSans-Bold"

INK = colors.HexColor("#1d1d1f")
MUTED = colors.HexColor("#6e6e73")
RULE = colors.HexColor("#d2d2d7")
WASH = colors.HexColor("#f5f5f7")

PAGE_W, PAGE_H = A4
MARGIN_X, MARGIN_TOP, MARGIN_BOTTOM = 56, 62, 60
WIDTH = PAGE_W - 2 * MARGIN_X


def _register_fonts() -> None:
    if REGULAR in pdfmetrics.getRegisteredFontNames():
        return
    pdfmetrics.registerFont(TTFont(REGULAR, str(FONT_DIR / "NotoSans-Regular.ttf")))
    pdfmetrics.registerFont(TTFont(BOLD, str(FONT_DIR / "NotoSans-Bold.ttf")))
    pdfmetrics.registerFontFamily(REGULAR, normal=REGULAR, bold=BOLD, italic=REGULAR, boldItalic=BOLD)


def _styles() -> dict:
    base = ParagraphStyle("body", fontName=REGULAR, fontSize=9, leading=13.5, textColor=INK)
    return {
        "body": base,
        "eyebrow": ParagraphStyle("eyebrow", parent=base, fontSize=7.5, leading=10, textColor=MUTED),
        "gid": ParagraphStyle("gid", parent=base, fontSize=22, leading=27, spaceBefore=2),
        "title": ParagraphStyle("title", parent=base, fontSize=22, leading=27),
        "sub": ParagraphStyle("sub", parent=base, fontSize=9, leading=13, textColor=MUTED),
        "h2": ParagraphStyle("h2", parent=base, fontName=BOLD, fontSize=10.5, leading=14, spaceAfter=6),
        "small": ParagraphStyle("small", parent=base, fontSize=7.8, leading=11, textColor=MUTED),
        "cell": ParagraphStyle("cell", parent=base, fontSize=8.2, leading=11),
        "cell_r": ParagraphStyle("cell_r", parent=base, fontSize=8.2, leading=11, alignment=2),
        "head": ParagraphStyle("head", parent=base, fontSize=7.3, leading=10, textColor=MUTED),
        "head_r": ParagraphStyle("head_r", parent=base, fontSize=7.3, leading=10, textColor=MUTED, alignment=2),
        "figure": ParagraphStyle("figure", parent=base, fontSize=17, leading=21),
        "figure_note": ParagraphStyle("figure_note", parent=base, fontSize=7.5, leading=10, textColor=MUTED),
        "bullet": ParagraphStyle("bullet", parent=base, leftIndent=10, bulletIndent=0, spaceAfter=3),
    }


def P(text: str, style) -> Paragraph:
    """Абзац из готовой разметки. Данные из файла анализа всегда проходят через T()."""
    return Paragraph(text, style)


def T(value) -> str:
    """Экранирование значений из файла: в текстах бывают «<», «&» и кавычки."""
    return escape(str(value))


class _AccountMark(Flowable):
    """Невидимая метка начала раздела счёта: по ней колонтитул знает, чья это страница."""

    def __init__(self, label: str):
        super().__init__()
        self.label = label

    def wrap(self, *_):
        return 0, 0

    def draw(self):
        self.canv._report_account = self.label


class _NumberedCanvas(Canvas):
    """Холст, который знает общее число страниц: «стр. 2 из 5» дописывается при сохранении."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._pages = []

    def showPage(self):
        self._pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._pages)
        for state in self._pages:
            self.__dict__.update(state)
            self.setFont(REGULAR, 7.3)
            self.setFillColor(MUTED)
            self.drawRightString(PAGE_W - MARGIN_X, 30, f"стр. {self._pageNumber} из {total}")
            super().showPage()
        super().save()


def _frame_decorations(provenance: dict):
    def draw(canvas, _doc):
        canvas.saveState()
        canvas.setFont(REGULAR, 7.3)
        canvas.setFillColor(MUTED)
        canvas.drawString(MARGIN_X, PAGE_H - 34, "Граф денег · справка для проверки")
        canvas.drawRightString(PAGE_W - MARGIN_X, PAGE_H - 34, getattr(canvas, "_report_account", ""))
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.4)
        canvas.line(MARGIN_X, 42, PAGE_W - MARGIN_X, 42)
        canvas.drawString(
            MARGIN_X, 30,
            f"{provenance['schema']} · {provenance['policy']} · входные данные sha256 {provenance['sha256'][:12]}…",
        )
        canvas.restoreState()

    return draw


def _table(rows: list, widths: list, header: bool = True, zebra: bool = False) -> Table:
    table = Table(rows, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LINEBELOW", (0, 0), (-1, -1), 0.3, RULE),
    ]
    if header:
        style.append(("LINEBELOW", (0, 0), (-1, 0), 0.6, MUTED))
    table.setStyle(TableStyle(style))
    return table


def _section(title: str, styles: dict) -> list:
    return [
        CondPageBreak(90),
        HRFlowable(width="100%", thickness=0.4, color=RULE, spaceBefore=14, spaceAfter=8),
        P(T(title), styles["h2"]),
    ]


def _key_figures(index, node: dict, styles: dict) -> Table:
    rank = index.rank.get(node["gid"])
    queue = f"№ {rank} в очереди проверки" if rank else f"вне первых {index.top_size} в очереди"
    cells = [
        [P("Гипотеза роли", styles["figure_note"]), P("Опора правила роли", styles["figure_note"]), P("Приоритет проверки", styles["figure_note"])],
        [P(T(F.capital(index.label(node["role"]))), styles["figure"]), P(F.score(node["role_score"]), styles["figure"]), P(F.score(node["priority_score"]), styles["figure"])],
        [
            P(f"основание {T(node['role_basis'])}", styles["figure_note"]),
            P("эвристика 0–1, не вероятность", styles["figure_note"]),
            P(T(queue), styles["figure_note"]),
        ],
    ]
    table = Table(cells, colWidths=[WIDTH * 0.46, WIDTH * 0.27, WIDTH * 0.27], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ("LINEABOVE", (0, 0), (-1, 0), 0.6, INK),
        ("TOPPADDING", (0, 0), (-1, 0), 7),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 8),
        ("LINEBELOW", (0, -1), (-1, -1), 0.3, RULE),
    ]))
    return table


def _flows(node: dict, styles: dict) -> list:
    m = node["metrics"]
    unobserved = node["observation"].get("outgoing_censored") and m["out_degree"] == 0

    def out(text: str) -> str:
        # На границе выборки исходящие не собирались: ноль читался бы как известный ноль.
        return "не наблюдаются" if unobserved else text

    head, cell, right = styles["head"], styles["cell"], styles["cell_r"]
    rows = [
        [P("", head), P("Входящие", styles["head_r"]), P("Исходящие", styles["head_r"])],
        [P("Контрагентов", cell), P(F.integer(m["in_degree"]), right), P(out(F.integer(m["out_degree"])), right)],
        [P("Переводов", cell), P(F.integer(m["in_tx"]), right), P(out(F.integer(m["out_tx"])), right)],
        [P("Сумма", cell), P(F.kzt(m["in_kzt"]), right), P(out(F.kzt(m["out_kzt"])), right)],
        [P("Связей с исходными клиентами", cell), P(F.integer(m["seed_in_count"]), right), P(out(F.integer(m["seed_out_count"])), right)],
    ]
    story = [_table(rows, [WIDTH * 0.46, WIDTH * 0.27, WIDTH * 0.27])]
    ratio = "не определено по наблюдаемым данным" if m.get("pass_through") is None else F.share(m["pass_through"])
    notes = [f"Отдано дальше от полученного: {ratio}."]
    if m.get("last_in_date"):
        notes.append(f"Последнее поступление {F.date_ru(m['last_in_date'])}")
        if m.get("observation_margin_days") is not None:
            notes[-1] += f", до конца периода {F.count(m['observation_margin_days'], 'день', 'дня', 'дней')}"
        if m.get("value_window_days") is not None:
            notes[-1] += f"; после поступления основной суммы — {F.count(m['value_window_days'], 'день', 'дня', 'дней')}"
        notes[-1] += "."
    story.append(Spacer(1, 5))
    story.append(P(T(" ".join(notes)), styles["small"]))
    return story


def _witness(index, node: dict, mode: str, styles: dict) -> list:
    t = node.get("temporal", {})
    counts = {"structural": t.get("static_seed_count", 0), "strict": t.get("strict_seed_count", 0), "same_day": t.get("same_day_seed_count", 0)}
    head = [P(("<b>%s</b>" if key == mode else "%s") % T(F.MODE_LABEL[key]), styles["head"]) for key in F.MODES]
    values = [P(("<b>%s</b>" if key == mode else "%s") % F.integer(counts[key]), styles["figure"]) for key in F.MODES]
    table = Table([head, values], colWidths=[WIDTH / 3] * 3, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    story = [
        P("Исходных клиентов, от которых есть путь к счёту:", styles["small"]),
        Spacer(1, 3),
        table,
        Spacer(1, 4),
        P(f"Выбранный режим — «{T(F.MODE_LABEL[mode])}»: {T(F.MODE_HINT[mode])}.", styles["small"]),
        Spacer(1, 6),
    ]
    witness_mode, witness = F.witness_for(node, mode)
    if not witness:
        story.append(P("Датированный путь от исходных клиентов в этом режиме не найден.", styles["body"]))
    else:
        hops = witness["hops"]
        story.append(P(
            f"Пример датированного пути («{T(F.MODE_LABEL[witness_mode])}»): от исходного клиента "
            f"{T(witness['seed_gid'])}, {F.count(len(hops), 'переход', 'перехода', 'переходов')}.",
            styles["body"],
        ))
        rows = [[P(h, styles["head"]) for h in ("№", "Дата", "Отправитель", "Получатель")] + [P("Сумма перевода", styles["head_r"])]]
        for number, hop in enumerate(hops, start=1):
            dst = hop["dst"] if hop["dst"] != node["gid"] else f"<b>{T(hop['dst'])}</b>"
            rows.append([
                P(str(number), styles["cell"]), P(T(F.date_ru(hop["date"])), styles["cell"]),
                P(T(hop["src"]), styles["cell"]), P(dst if dst.startswith("<b>") else T(dst), styles["cell"]),
                P(F.kzt(hop["sum_kzt"]), styles["cell_r"]),
            ])
        story += [Spacer(1, 4), _table(rows, [18, WIDTH * 0.2, WIDTH * 0.27, WIDTH * 0.27, WIDTH * 0.26 - 18])]
    story += [Spacer(1, 5), P(T(F.REACH_CAVEAT), styles["small"])]
    return story


def _counterparty_tables(index, node: dict, styles: dict) -> list:
    sides = F.counterparties(index, node["gid"])
    story = []
    titles = {"in": "Платили этому счёту", "out": "Получали от этого счёта"}
    for side in ("in", "out"):
        rows = sides[side]
        if not rows:
            if side == "out" and node["observation"].get("outgoing_censored"):
                story.append(P("Исходящие переводы не наблюдаются: граница сбора данных.", styles["small"]))
            else:
                story.append(P("Входящих переводов в выборке нет." if side == "in" else "Исходящих переводов в выборке нет.", styles["small"]))
            story.append(Spacer(1, 6))
            continue
        shown = rows[: F.TOP_COUNTERPARTIES]
        caption = titles[side] + (f" · показаны {len(shown)} крупнейших из {len(rows)}" if len(rows) > len(shown) else "")
        table_rows = [[P(h, styles["head"]) for h in ("Счёт", "Роль-гипотеза")] + [P("Сумма", styles["head_r"]), P("Переводов", styles["head_r"])] + [P("Даты", styles["head"])]]
        for row in shown:
            dates = F.date_ru(row["first"], False) if row["first"] == row["last"] else f"{F.date_ru(row['first'], False)} — {F.date_ru(row['last'], False)}"
            table_rows.append([
                P(T(row["gid"]), styles["cell"]), P(T(row["role"]), styles["cell"]),
                P(F.kzt(row["sum"]), styles["cell_r"]), P(F.integer(row["n_tx"]), styles["cell_r"]), P(T(dates), styles["cell"]),
            ])
        story += [P(T(caption), styles["small"]), Spacer(1, 2), _table(table_rows, [WIDTH * 0.25, WIDTH * 0.2, WIDTH * 0.2, WIDTH * 0.11, WIDTH * 0.24]), Spacer(1, 8)]
    return story


def _source_table(index, node: dict, styles: dict) -> list:
    rows, total = F.source_rows(index, node["gid"])
    if not rows:
        return [P("В выгрузке нет переводов этого счёта.", styles["body"])]
    note = (
        f"Все переводы счёта из файла: {F.integer(total)}."
        if total == len(rows)
        else f"Показаны {len(rows)} крупнейших из {F.integer(total)} переводов, по дате."
    )
    table_rows = [[P(h, styles["head"]) for h in ("Дата", "Направление", "Отправитель", "Получатель")] + [P("Сумма", styles["head_r"])]]
    for tx in rows:
        direction = "входящий" if tx["dst"] == node["gid"] else "исходящий"
        table_rows.append([
            P(T(F.date_ru(tx["date"])), styles["cell"]), P(direction, styles["cell"]),
            P(T(tx["src"]), styles["cell"]), P(T(tx["dst"]), styles["cell"]), P(F.kzt(tx["sum_kzt"]), styles["cell_r"]),
        ])
    return [P(T(note), styles["small"]), Spacer(1, 3), _table(table_rows, [WIDTH * 0.17, WIDTH * 0.14, WIDTH * 0.24, WIDTH * 0.24, WIDTH * 0.21])]


def _account(index, node: dict, position: int, total: int, mode: str, styles: dict, provenance: dict) -> list:
    gid = node["gid"]
    m = node["metrics"]
    kind = "Исходный клиент" if node.get("is_seed") else "Счёт"
    story = [
        _AccountMark(f"счёт {position} из {total} · {gid}" if total > 1 else gid),
        P(f"СПРАВКА ДЛЯ ПРОВЕРКИ{f' · СЧЁТ {position} ИЗ {total}' if total > 1 else ''}", styles["eyebrow"]),
        P(T(gid), styles["gid"]),
        P(T(f"{kind} · {F.count(node.get('depth', 0), 'шаг', 'шага', 'шагов')} от исходных клиентов · кластер {node.get('cluster_id', '—')}"), styles["sub"]),
        Spacer(1, 14),
        _key_figures(index, node, styles),
        Spacer(1, 7),
        P(
            "Это гипотеза для проверки, а не вывод о виновности клиента. Опора правила показывает, насколько "
            "выполнено правило роли; приоритет упорядочивает очередь проверки. Это разные величины, и ни одна не вероятность.",
            styles["small"],
        ),
    ]

    story += _section("Почему такая гипотеза", styles)
    story.append(P(T(node.get("evidence", "")), styles["body"]))
    rule = index.rules.get(node["role"])
    if rule and rule.get("description"):
        story += [Spacer(1, 4), P(f"Правило роли: {T(rule['description'])}", styles["small"])]
    alt = F.strongest_alternative(node)
    story.append(Spacer(1, 6))
    if alt:
        story.append(P(
            f"<b>Ближайшая альтернатива: {T(index.label(alt['role']))} {F.score(alt['score'])}</b> — {T(alt.get('reason', ''))}. "
            f"Основание {T(alt.get('basis', '—'))}.",
            styles["body"],
        ))
    else:
        story.append(P("Альтернативные роли не набрали опоры: у всех кандидатов 0,00.", styles["body"]))

    story += _section("Наблюдаемые потоки", styles)
    story += _flows(node, styles)

    story += _section("Путь от исходных клиентов", styles)
    story += _witness(index, node, mode, styles)

    limits = F.observation_limits(node)
    story += _section("Границы наблюдения", styles)
    if limits:
        for limit in limits:
            item = P(T(limit), styles["bullet"])
            item.bulletText = "–"
            story.append(item)
    else:
        story.append(P("Особых ограничений для этого счёта не отмечено; общие ограничения данных — в конце справки.", styles["body"]))

    story += _section("Следующий запрос данных", styles)
    story.append(P(T(node.get("next_request", "—")), styles["body"]))

    story += _section("Контрагенты", styles)
    story += _counterparty_tables(index, node, styles)

    cluster = index.clusters.get(node.get("cluster_id"))
    if cluster:
        story += _section(f"Кластер {cluster['cluster_id']}", styles)
        story.append(P(T(
            f"{F.count(cluster['n_nodes'], 'счёт', 'счёта', 'счетов')}, исходных клиентов: {F.integer(cluster['n_seed'])}; "
            f"внутренний оборот {F.kzt(cluster['sum_kzt_internal'])}."
        ), styles["body"]))
        if cluster.get("hypothesis"):
            story += [Spacer(1, 3), P(T(cluster["hypothesis"]), styles["small"])]

    story += _section("Переводы-источники", styles)
    story += _source_table(index, node, styles)
    return story


def _cover(index, nodes: list, mode: str, styles: dict, provenance: dict) -> list:
    story = [
        _AccountMark("сводка"),
        P("СПРАВКА ДЛЯ ПРОВЕРКИ", styles["eyebrow"]),
        P(T(f"{F.count(len(nodes), 'счёт', 'счёта', 'счетов')} для проверки"), styles["title"]),
        P(T(f"Режим путей: {F.MODE_LABEL[mode]} · период {provenance['period']}"), styles["sub"]),
        Spacer(1, 18),
    ]
    rows = [[P(h, styles["head"]) for h in ("№", "Счёт", "Роль-гипотеза")] + [P(h, styles["head_r"]) for h in ("Опора", "Приоритет")] + [P("Очередь", styles["head"])]]
    for position, node in enumerate(nodes, start=1):
        rank = index.rank.get(node["gid"])
        rows.append([
            P(str(position), styles["cell"]), P(T(node["gid"]), styles["cell"]), P(T(F.capital(index.label(node["role"]))), styles["cell"]),
            P(F.score(node["role_score"]), styles["cell_r"]), P(F.score(node["priority_score"]), styles["cell_r"]),
            P(f"№ {rank}" if rank else "—", styles["cell"]),
        ])
    story += [_table(rows, [20, WIDTH * 0.3, WIDTH * 0.27, WIDTH * 0.12, WIDTH * 0.14, WIDTH * 0.17 - 20]), Spacer(1, 10)]
    story.append(P(
        "Каждый счёт — отдельный раздел: гипотеза роли и её основание, ближайшая альтернатива, наблюдаемые потоки, "
        "датированный путь, границы наблюдения и следующий запрос данных. Это гипотезы для проверки, а не выводы о виновности.",
        styles["small"],
    ))
    return story


def _closing(analysis: dict, styles: dict, provenance: dict) -> list:
    story = _section("Ограничения данных", styles)
    for limit in analysis.get("policy", {}).get("limitations", []):
        item = P(T(limit), styles["bullet"])
        item.bulletText = "–"
        story.append(item)
    rows = [
        [P("Схема файла анализа", styles["cell"]), P(T(provenance["schema"]), styles["cell"])],
        [P("Версия правил", styles["cell"]), P(T(provenance["policy"]), styles["cell"])],
        [P("Период данных", styles["cell"]), P(T(provenance["period"]), styles["cell"])],
        [P("Входные данные, sha256", styles["cell"]), P(T(provenance["sha256"]), styles["cell"])],
    ]
    story += _section("Происхождение", styles)
    story += [
        _table(rows, [WIDTH * 0.3, WIDTH * 0.7], header=False),
        Spacer(1, 6),
        P("Справка собрана из файла анализа без изменения значений: идентификаторы, суммы и даты перенесены как в источнике.", styles["small"]),
    ]
    return [KeepTogether(story[:3])] + story[3:]


def render_pdf(analysis: dict, gids, mode: str = "structural") -> bytes:
    """PDF-справка по выбранным счетам в порядке запроса. Ошибка запроса — ReportRequestError."""
    nodes = F.validate_request(analysis, gids, mode)
    _register_fonts()
    styles = _styles()
    index = F.AnalysisIndex(analysis)
    provenance = F.provenance(analysis)

    buffer = io.BytesIO()
    title = f"Справка для проверки: счёт {nodes[0]['gid']}" if len(nodes) == 1 else f"Справка для проверки: {F.count(len(nodes), 'счёт', 'счёта', 'счетов')}"
    doc = BaseDocTemplate(
        buffer, pagesize=A4, invariant=1, title=title, author="Граф денег", subject="Гипотезы для проверки, не выводы о виновности",
        creator="reports.render_pdf", leftMargin=MARGIN_X, rightMargin=MARGIN_X, topMargin=MARGIN_TOP, bottomMargin=MARGIN_BOTTOM,
    )
    frame = Frame(MARGIN_X, MARGIN_BOTTOM, WIDTH, PAGE_H - MARGIN_TOP - MARGIN_BOTTOM, id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="page", frames=[frame], onPageEnd=_frame_decorations(provenance))])

    story: list = []
    if len(nodes) > 1:
        story += _cover(index, nodes, mode, styles, provenance)
        story.append(PageBreak())
    for position, node in enumerate(nodes, start=1):
        if position > 1:
            story.append(PageBreak())
        story += _account(index, node, position, len(nodes), mode, styles, provenance)
    story += _closing(analysis, styles, provenance)
    doc.build(story, canvasmaker=_NumberedCanvas)
    return buffer.getvalue()
