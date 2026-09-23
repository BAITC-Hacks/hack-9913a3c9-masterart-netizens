"""Правила ролей: каждое правило даёт опору и причину, выбор основной роли детерминирован.

Все шесть правил оцениваются для каждого счёта. Основная роль — правило с наибольшей
опорой не ниже 0,5; при равенстве решает `policy.ROLE_PRECEDENCE`. Остальные правила
сохраняются как альтернативы, поэтому аналитик видит сильнейшее конкурирующее объяснение.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import policy
from .fmt import clip_text, kzt_ru, percent_ru, score_ru
from .metrics import NodeMetrics

T = policy.threshold
FIRE = policy.threshold("peripheral", "role_signal_floor")


@dataclass(frozen=True)
class Candidate:
    role: str
    score: float
    reason: str


def ramp(value: float, threshold: float, saturation: float) -> float:
    """0 при нуле, 0,5 ровно на пороге, 1,0 на уровне насыщения и выше."""
    if value <= 0:
        return 0.0
    if value < threshold:
        return min(0.5 * value / threshold, 0.4999)
    return 0.5 + 0.5 * min(1.0, (value - threshold) / (saturation - threshold))


def consolidator(m: NodeMetrics) -> Candidate:
    need = T("consolidator", "min_payers")
    score = ramp(m.in_degree, need, T("consolidator", "saturation_payers"))
    reason = f"разных плательщиков: {m.in_degree} (порог {need}), получено {kzt_ru(m.in_tiyn)}"
    return Candidate("consolidator", score, reason)


def distributor(m: NodeMetrics) -> Candidate:
    need = T("distributor", "min_recipients")
    if m.outgoing_censored:
        return Candidate("distributor", 0.0, "исходящие за границей выгрузки не наблюдаются")
    score = ramp(m.out_degree, need, T("distributor", "saturation_recipients"))
    reason = f"разных получателей: {m.out_degree} (порог {need}), отправлено {kzt_ru(m.out_tiyn)}"
    return Candidate("distributor", score, reason)


def transit(m: NodeMetrics) -> Candidate:
    low, high = T("transit", "pass_through_low"), T("transit", "pass_through_high")
    if m.is_seed:
        return Candidate("transit", 0.0, "исходный клиент: входящие извне выборки не видны, доля транзита не оценивается")
    if m.outgoing_censored:
        return Candidate("transit", 0.0, "исходящие за границей выгрузки не наблюдаются")
    if m.in_tiyn == 0 or m.out_tiyn == 0:
        side = "поступлений" if m.in_tiyn == 0 else "исходящих переводов"
        return Candidate("transit", 0.0, f"нет наблюдаемых {side}")
    ratio = m.pass_through
    half_band = (high - low) / 2
    centre = (high + low) / 2
    distance = abs(ratio - centre)
    if distance <= half_band:
        score = 0.5 + 0.5 * (1 - distance / half_band)
    else:
        score = min(0.4999, 0.5 * max(0.0, 1 - (distance - half_band) / T("transit", "decay_width")))
    reason = f"передано дальше {percent_ru(ratio)} полученного (коридор {percent_ru(low)}–{percent_ru(high)})"
    return Candidate("transit", score, reason)


def terminal(m: NodeMetrics) -> Candidate:
    if m.outgoing_censored:
        return Candidate("terminal", 0.0, "исходящие не собирались: отсутствие переводов не доказывает остаток на счёте")
    if m.in_tiyn == 0:
        return Candidate("terminal", 0.0, "нет наблюдаемых поступлений")
    if m.out_degree > 0:
        return Candidate("terminal", 0.0, f"есть исходящие переводы, получателей: {m.out_degree}")
    need_payers, need_kzt = T("terminal", "min_payers"), T("terminal", "min_in_kzt")
    accumulation = max(m.in_degree / need_payers, m.in_tiyn / 100 / need_kzt)
    margin = m.margin_days if m.margin_days is not None else 0
    min_margin = T("terminal", "min_margin_days")
    base = f"исходящих нет; плательщиков: {m.in_degree}, получено {kzt_ru(m.in_tiyn)}"
    if margin < min_margin:
        score = min(0.4999, 0.5 * min(1.0, accumulation) * margin / min_margin)
        return Candidate("terminal", score, f"{base}; после последнего поступления {margin} дн. (нужно не меньше {min_margin})")
    if accumulation < 1:
        return Candidate("terminal", min(0.4999, 0.5 * accumulation), f"{base}: ниже порога накопления")
    amount = min(1.0, max(0.0, (m.in_tiyn / 100 - need_kzt) / (T("terminal", "saturation_in_kzt") - need_kzt)))
    window = min(1.0, (margin - min_margin) / (T("terminal", "saturation_margin_days") - min_margin))
    score = 0.5 + 0.25 * amount + 0.25 * window
    return Candidate("terminal", score, f"{base}; наблюдение {margin} дн. после поступления")


def coordinator(m: NodeMetrics) -> Candidate:
    need = T("coordinator", "min_seed_links")
    score = ramp(m.seed_links, need, T("coordinator", "saturation_seed_links"))
    reason = (
        f"связей с исходными клиентами: {m.seed_links} (порог {need}); "
        f"от них {m.seed_in_count}, к ним {m.seed_out_count}"
    )
    return Candidate("coordinator", score, reason)


RULES = (coordinator, distributor, consolidator, transit, terminal)


def evaluate(m: NodeMetrics) -> list:
    """Все шесть кандидатов с опорой и причиной, в порядке `ROLE_PRECEDENCE`."""
    candidates = [rule(m) for rule in RULES]
    strongest = max(c.score for c in candidates)
    if m.in_degree == 0 and m.out_degree == 0:
        reason = "нет наблюдаемых переводов в выгрузке"
    elif strongest < FIRE:
        reason = f"ни одно правило не достигло порога; сильнейший признак {score_ru(strongest)}"
    else:
        reason = f"вариант «сигналов нет»: 1 минус сильнейший признак ({score_ru(strongest)})"
    candidates.append(Candidate("peripheral", 1.0 - strongest, reason))
    order = {role: i for i, role in enumerate(policy.ROLE_PRECEDENCE)}
    return sorted(candidates, key=lambda c: order[c.role])


def select(candidates: list) -> tuple:
    """Основная роль и альтернативы, упорядоченные по убыванию опоры."""
    order = {role: i for i, role in enumerate(policy.ROLE_PRECEDENCE)}
    primary = next(c for c in candidates if c.role == "peripheral")
    for tier in policy.ROLE_TIERS:
        fired = [c for c in candidates if c.role in tier and c.score >= FIRE]
        if fired:
            primary = min(fired, key=lambda c: (-round(c.score, 6), order[c.role]))
            break
    def by_support(c):
        return (-round(c.score, 6), order[c.role])

    competing = sorted((c for c in candidates if c.role not in (primary.role, "peripheral")), key=by_support)
    if primary.role == "peripheral":
        return primary, competing
    # Сильнейшая конкурирующая роль важнее «сигналов нет»: то лишь дополнение к основной опоре.
    fallback = [c for c in candidates if c.role == "peripheral"]
    if competing and competing[0].score > 0:
        return primary, competing + fallback
    return primary, fallback + competing


def evidence_text(m: NodeMetrics, primary: Candidate, runner_up: Candidate) -> str:
    """Объяснение для nodes_roles.csv: 1–200 символов, только собственные метрики счёта."""
    label = policy.ROLE_LABELS_RU[primary.role]
    alt = policy.ROLE_LABELS_RU[runner_up.role]
    if m.in_degree == 0 and m.out_degree == 0:
        text = f"«{label}» {score_ru(primary.score)}: в выгрузке нет переводов счёта, роль не оценивается."
    elif primary.role == "peripheral" and runner_up.score == 0:
        text = f"«{label}» {score_ru(primary.score)}: признаков ролей не найдено."
    elif primary.role == "peripheral":
        text = (
            f"«{label}» {score_ru(primary.score)}: ни один признак не достиг порога. "
            f"Ближайший — {alt} {score_ru(runner_up.score)}: {runner_up.reason}."
        )
    else:
        text = (
            f"Гипотеза «{label}» {score_ru(primary.score)}: {primary.reason}. "
            f"Альтернатива: {alt} {score_ru(runner_up.score)}."
        )
    if m.outgoing_censored and primary.role in ("consolidator", "coordinator", "peripheral"):
        text = text[:-1] + "; исходящие не собирались."
    return clip_text(text, 200)


def warnings_for(m: NodeMetrics) -> list:
    """Ограничения наблюдения конкретного счёта."""
    notes = []
    if m.outgoing_censored:
        notes.append("Исходящие переводы за границей выгрузки (глубина 4) не собирались.")
    if m.is_seed:
        notes.append("Исходный клиент: поступления извне выборки не видны, баланс неполон.")
    if m.in_degree == 0 and m.out_degree == 0:
        notes.append("В выгрузке нет переводов этого счёта.")
    if not m.is_seed and not m.outgoing_censored and m.out_tiyn > m.in_tiyn * T("transit", "pass_through_high"):
        notes.append("Исходящие превышают наблюдаемые поступления: баланс неполон (остаток или поступления вне выборки).")
    min_margin = T("terminal", "min_margin_days")
    if m.out_degree == 0 and m.margin_days is not None and m.margin_days < min_margin and not m.outgoing_censored:
        notes.append(f"Последнее поступление за {m.margin_days} дн. до конца периода: окно наблюдения короткое.")
    return notes


def next_request(m: NodeMetrics, role: str) -> str:
    """Какие данные запросить, чтобы подтвердить или опровергнуть гипотезу."""
    if m.outgoing_censored:
        return "Запросить исходящие переводы счёта за пределами 4-го шага выгрузки."
    if m.in_degree == 0 and m.out_degree == 0:
        return "Запросить операции клиента ниже 5 000 ₸, наличные и межбанковские переводы."
    requests = {
        "consolidator": "Запросить назначения входящих платежей и поступления из других банков.",
        "transit": "Запросить время операций внутри дня, чтобы проверить порядок зачисления и списания.",
        "distributor": "Запросить назначения платежей и дальнейшие переводы получателей.",
        "terminal": "Запросить снятия наличных, межбанковские и мелкие (< 5 000 ₸) списания после поступлений.",
        "coordinator": "Запросить полную историю переводов между связанными исходными клиентами.",
    }
    if role in requests:
        return requests[role]
    if m.is_seed:
        return "Запросить входящие переводы исходного клиента, не попавшие в выгрузку."
    return "Дополнительный запрос не нужен, пока нет признаков роли; сверить с очередью приоритета."
