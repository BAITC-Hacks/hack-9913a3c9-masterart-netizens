"""Читаемые таблицы и схемы строятся только из проверенного результата инструмента."""

from __future__ import annotations

from decimal import Decimal

from .queries import LIMITATION, ROLES
from .render import link, number, render, text

MAX_DIAGRAM_HOPS = 12


def money(value: object) -> str:
    amount = format(Decimal(str(value)), ",.2f").replace(",", "\u202f").replace(".", ",")
    return amount.removesuffix(",00") + " ₸"


def table(headers: list[str], rows: list[list[str]]) -> str:
    return "\n".join(["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
                     + ["| " + " | ".join(row) + " |" for row in rows])


def diagram(hops: list[dict]) -> str:
    if not hops:
        return ""
    chosen = hops[:MAX_DIAGRAM_HOPS]
    ids = list(dict.fromkeys(gid for hop in chosen for gid in (hop["src"], hop["dst"])))
    names = {gid: f"n{i}" for i, gid in enumerate(ids)}
    lines = ["```mermaid", "flowchart TD"]
    lines.extend(f'  {names[gid]}["{gid}"]' for gid in ids)
    for hop in chosen:
        label = (hop["date"] + " · " if "date" in hop else "") + money(hop["sum_kzt"])
        lines.append(f'  {names[hop["src"]]} -->|"{label}"| {names[hop["dst"]]}')
    lines.append("```")
    if len(chosen) < len(hops):
        lines.append(f"\nНа схеме первые {len(chosen)} из {len(hops)} переводов. Полные основания доступны в журнале операции.")
    return "\n".join(lines)


def render_rich(result: dict) -> str:
    kind, facts = result["kind"], result["facts"]
    if kind == "comparison":
        leaders = ", ".join(link(g) for g in facts["leaders"])
        title = ("**Раньше в очереди проверки:** " + leaders + "." if len(facts["leaders"]) == 1
                 else "**Приоритет совпадает:** " + leaders + ". Этот показатель не задаёт предпочтение.")
        rows = [[link(n["gid"]), number(n["priority_score"]), money(n["metrics"]["in_kzt"]), money(n["metrics"]["out_kzt"])]
                for n in facts["rows"]]
        lines = [title, table(["Счёт", "Приоритет", "Получено", "Отправлено"], rows), "### Почему стоит проверить"]
        for node in facts["rows"]:
            lines.append(f"- {link(node['gid'])}: {text(node['evidence'])} Следующий запрос: {text(node['next_request'])}")
            if node["observation"].get("outgoing_censored"):
                lines.append("  Исходящие ограничены границей сбора; ноль не подтверждает конечного получателя.")
            lines.extend("  " + text(w) for w in node["observation"].get("warnings", []))
        lines.extend(["Порядок задаёт вычисленный приоритет, а не вероятность виновности.", LIMITATION])
        return "\n\n".join(lines)
    if kind == "rank":
        rows = [[link(n["gid"]), number(n["priority_score"]), text(n["evidence"])] for n in facts["rows"]]
        return "\n\n".join([f"**Очередь проверки:** {len(rows)} из {facts['total']} счетов по заданному фильтру.",
                             table(["Счёт", "Приоритет", "Наблюдаемое основание"], rows), LIMITATION])
    if kind == "temporal" and facts["witness"]:
        hops = facts["witness"]["hops"]
        temporal = facts["temporal"]
        rows = [[text(h["date"]), link(h["src"]), link(h["dst"]), money(h["sum_kzt"])] for h in hops]
        mode = "строго возрастают по дням" if facts["mode"] == "strict" else "допускают возможный порядок внутри дня"
        return "\n\n".join([f"**Один проверенный путь к {link(facts['gid'])}.** Даты {mode}.",
                             f"Других исходных клиентов с путём: без дат — {temporal['static_seed_count']}; "
                             f"строго по дням — {temporal['strict_seed_count']}; в тот же день — {temporal['same_day_seed_count']}.",
                             diagram(hops), table(["Дата", "Отправитель", "Получатель", "Сумма"], rows), LIMITATION])
    if kind == "node":
        metrics = facts["metrics"]
        rows = [["Гипотеза роли", ROLES[facts["role"]]], ["Приоритет проверки", number(facts["priority_score"])],
                ["Опора роли (эвристика)", number(facts["role_score"])],
                ["Наблюдаемые входящие", money(metrics["in_kzt"])], ["Наблюдаемые исходящие", money(metrics["out_kzt"])],
                ["Плательщиков / получателей", f"{metrics['in_degree']} / {metrics['out_degree']}"]]
        lines = ["### Счёт " + link(facts["gid"]), table(["Показатель", "Наблюдаемое значение"], rows),
                 "**Основание:** " + text(facts["evidence"])]
        alternatives = facts["role_alternatives"]
        if alternatives:
            alt = sorted(alternatives, key=lambda item: (-item["score"], item["role"]))[0]
            lines.append(f"**Альтернатива:** {ROLES[alt['role']]} · {number(alt['score'])}. {text(alt['reason'])}")
        if facts["observation"].get("outgoing_censored"):
            lines.append("Исходящие ограничены границей сбора. Ноль в выборке не означает отсутствие переводов.")
        lines.extend(text(w) for w in facts["observation"].get("warnings", []))
        lines.extend(["**Следующий запрос:** " + text(facts["next_request"]), LIMITATION])
        return "\n\n".join(lines)
    return render(result)
