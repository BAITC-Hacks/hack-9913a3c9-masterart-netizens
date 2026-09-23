"""Правила ролей: каждое правило даёт опору и причину, выбор основной роли детерминирован.

Все шесть правил оцениваются для каждого счёта. Сначала выбирается первый сработавший
уровень `policy.ROLE_TIERS`, внутри него — максимальная опора не ниже 0,5; при равенстве
решает `policy.ROLE_PRECEDENCE`. Остальные правила сохраняются как альтернативы.
У каждого кандидата есть устойчивый код ветви правила (`code`), по которому интерфейс и
отчёт показывают, какое именно условие сработало.
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
    code: str = ""


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
    return Candidate("consolidator", score, reason, "consolidator.payers")


def distributor(m: NodeMetrics) -> Candidate:
    need = T("distributor", "min_recipients")
    if m.outgoing_censored:
        return Candidate("distributor", 0.0, "исходящие за границей выгрузки не наблюдаются", "distributor.cutoff")
    score = ramp(m.out_degree, need, T("distributor", "saturation_recipients"))
    reason = f"разных получателей: {m.out_degree} (порог {need}), отправлено {kzt_ru(m.out_tiyn)}"
    return Candidate("distributor", score, reason, "distributor.recipients")


def transit(m: NodeMetrics) -> Candidate:
    """Транзит: дальше ушло 80–120% полученного, причём другим счетам и не раньше поступлений.

    Доля считается по `forward_share`: исходящий перевод засчитывается, только если счёт до него
    (или в тот же день) получил деньги от другого плательщика. Поэтому ни перевод раньше первого
    поступления, ни встречные переводы с единственным контрагентом транзитом не считаются,
    а цепочка A→B→C остаётся, даже если C тоже платил B.
    """
    low, high = T("transit", "pass_through_low"), T("transit", "pass_through_high")
    if m.is_seed:
        return Candidate("transit", 0.0, "исходный клиент: входящие извне выборки не видны, доля транзита не оценивается", "transit.seed")
    if m.outgoing_censored:
        return Candidate("transit", 0.0, "исходящие за границей выгрузки не наблюдаются", "transit.cutoff")
    if m.in_tiyn == 0 or m.out_tiyn == 0:
        side = "поступлений" if m.in_tiyn == 0 else "исходящих переводов"
        return Candidate("transit", 0.0, f"нет наблюдаемых {side}", "transit.one_sided")
    ratio = m.forward_share
    if ratio == 0:
        return Candidate(
            "transit",
            0.0,
            f"исходящие = {percent_ru(m.pass_through)} входящих, но ни один перевод не следует за поступлением от другого счёта",
            "transit.no_dated_forward",
        )
    half_band = (high - low) / 2
    centre = (high + low) / 2
    full = T("transit", "full_support_transfers")
    volume = min(1.0, min(m.in_tx, m.out_tx) / full)

    def corridor_support(share: float) -> float:
        distance = abs(share - centre)
        if distance <= half_band:
            return 0.5 + 0.5 * (1 - distance / half_band) * volume
        return min(0.4999, 0.5 * max(0.0, 1 - (distance - half_band) / T("transit", "decay_width")))

    # Обе доли должны попасть в коридор: согласование по датам только снимает ложный транзит,
    # но не создаёт новый у счёта, который отправил заметно больше наблюдаемых поступлений.
    raw = m.pass_through
    score = min(corridor_support(ratio), corridor_support(raw))
    reason = f"после поступлений другим счетам ушло {percent_ru(ratio)} полученного (коридор {percent_ru(low)}–{percent_ru(high)})"
    if raw > high:
        reason += f"; всего исходящих {percent_ru(raw)}: баланс в выгрузке неполон"
    elif ratio < raw - 0.005:
        reason += f"; всего исходящих {percent_ru(raw)}"
    if score >= FIRE and volume < 1:
        reason += f"; операций мало: входящих {m.in_tx}, исходящих {m.out_tx}"
    return Candidate("transit", score, reason, "transit.dated_forward")


def terminal(m: NodeMetrics) -> Candidate:
    """Конечный получатель: поступления накоплены, исходящих нет или они малы (до 20%)."""
    if m.outgoing_censored:
        return Candidate("terminal", 0.0, "исходящие не собирались: отсутствие переводов не доказывает остаток на счёте", "terminal.cutoff")
    if m.in_tiyn == 0:
        return Candidate("terminal", 0.0, "нет наблюдаемых поступлений", "terminal.no_inflow")
    max_share = T("terminal", "max_pass_through")
    passed = m.pass_through if m.out_degree > 0 else 0.0
    if m.out_degree > 0 and (passed is None or passed > max_share):
        if passed is None:
            return Candidate("terminal", 0.0, f"есть исходящие переводы, получателей: {m.out_degree}", "terminal.outgoing")
        return Candidate(
            "terminal",
            0.0,
            f"исходящие — {percent_ru(passed)} наблюдаемых входящих (для накопления — не больше {percent_ru(max_share)})",
            "terminal.outgoing",
        )
    need_payers, need_kzt = T("terminal", "min_payers"), T("terminal", "min_in_kzt")
    accumulation = max(m.in_degree / need_payers, m.in_tiyn / 100 / need_kzt)
    margin = m.window_days if m.window_days is not None else 0
    min_margin = T("terminal", "min_margin_days")
    value_share = percent_ru(T("terminal", "window_value_share"))
    if m.out_degree == 0:
        base, code = f"исходящих нет; плательщиков: {m.in_degree}, получено {kzt_ru(m.in_tiyn)}", "terminal.no_outgoing"
    else:
        base = f"исходящие — {percent_ru(passed)} наблюдаемых входящих; плательщиков: {m.in_degree}, получено {kzt_ru(m.in_tiyn)}"
        code = "terminal.small_outflow"
    if margin < min_margin:
        score = min(0.4999, 0.5 * min(1.0, accumulation) * margin / min_margin)
        return Candidate("terminal", score, f"{base}; окно после {value_share} суммы — {margin} дн. (нужно {min_margin})", code)
    if accumulation < 1:
        return Candidate("terminal", min(0.4999, 0.5 * accumulation), f"{base}: ниже порога накопления", code)
    amount = min(1.0, max(0.0, (m.in_tiyn / 100 - need_kzt) / (T("terminal", "saturation_in_kzt") - need_kzt)))
    window = min(1.0, (margin - min_margin) / (T("terminal", "saturation_margin_days") - min_margin))
    score = 0.5 + 0.25 * amount + 0.25 * window
    if passed:
        # Чем больше ушло дальше, тем слабее опора накопления; на пределе 20% остаётся порог 0,5.
        score = 0.5 + (score - 0.5) * (1 - passed / max_share)
    return Candidate("terminal", score, f"{base}; окно после {value_share} суммы — {margin} дн.", code)


def coordinator(m: NodeMetrics) -> Candidate:
    need = T("coordinator", "min_seed_links")
    score = ramp(m.seed_links, need, T("coordinator", "saturation_seed_links"))
    reason = (
        f"связей с исходными клиентами: {m.seed_links} (порог {need}); "
        f"от них {m.seed_in_count}, к ним {m.seed_out_count}"
    )
    return Candidate("coordinator", score, reason, "coordinator.seed_links")


RULES = (coordinator, distributor, consolidator, transit, terminal)


SHORT_WINDOW = "короткое окно наблюдения"
SHORT_VALUE_WINDOW = "поздние поступления"


def observation_gap(m: NodeMetrics) -> str:
    """Пробел наблюдения, из-за которого отсутствие сигналов нельзя считать сильным доводом."""
    if m.outgoing_censored:
        return "исходящие не собирались"
    min_margin = T("terminal", "min_margin_days")
    if m.in_degree > 0 and m.out_degree == 0 and m.margin_days is not None and m.margin_days < min_margin:
        return SHORT_WINDOW
    # Признаки накопления есть (ушло не больше 20%), но основная сумма пришла так поздно,
    # что исходящие могли ещё не появиться: вывод откладывается, а не заменяется «сигналов нет».
    share = m.pass_through
    if (
        m.in_degree > 0
        and m.out_degree > 0
        and share is not None
        and share <= T("terminal", "max_pass_through")
        and m.window_days is not None
        and m.window_days < min_margin
    ):
        return SHORT_VALUE_WINDOW
    return ""


def evaluate(m: NodeMetrics) -> list:
    """Все шесть кандидатов с опорой и причиной, в порядке `ROLE_PRECEDENCE`."""
    candidates = [rule(m) for rule in RULES]
    strongest = max(c.score for c in candidates)
    gap = observation_gap(m)
    if m.in_degree == 0 and m.out_degree == 0:
        peripheral = Candidate("peripheral", 0.0, "нет наблюдаемых переводов в выгрузке: роль не оценивается", "peripheral.no_transfers")
    else:
        weight = T("peripheral", "partial_observation_weight") if gap else 1.0
        if strongest < FIRE:
            reason = f"ни одно правило не достигло порога; сильнейший признак {score_ru(strongest)}"
        else:
            reason = f"вариант «сигналов нет»: 1 минус сильнейший признак ({score_ru(strongest)})"
        if gap:
            reason += f"; опора снижена: {gap}"
        code = {
            "": "peripheral.below_threshold",
            SHORT_WINDOW: "peripheral.short_window",
            SHORT_VALUE_WINDOW: "peripheral.late_inflow",
        }.get(gap, "peripheral.cutoff")
        peripheral = Candidate("peripheral", weight * (1.0 - strongest), reason, code)
    candidates.append(peripheral)
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
    gap = observation_gap(m)
    head = f"«{policy.ROLE_LABELS_RU[primary.role]}» {score_ru(primary.score)}"
    if primary.role == "peripheral" and gap:
        # Пометка о пробеле наблюдения нужна, но не ценой обрезанного объяснения:
        # если вместе она не помещается в 200 символов, она остаётся в предупреждениях карточки.
        noted = _evidence_body(m, primary, runner_up, f"{head} (снижено: {gap})")
        if len(noted) <= 200:
            return noted
    return clip_text(_evidence_body(m, primary, runner_up, head), 200)


def _evidence_body(m: NodeMetrics, primary: Candidate, runner_up: Candidate, head: str) -> str:
    alt = policy.ROLE_LABELS_RU[runner_up.role]
    raw = m.pass_through
    corridor = T("transit", "pass_through_low") <= (raw or 0) <= T("transit", "pass_through_high")
    if m.in_degree == 0 and m.out_degree == 0:
        text = f"{head}: в выгрузке нет переводов счёта, роль не оценивается."
    elif primary.role == "peripheral" and corridor and m.forward_share == 0:
        # Суммы похожи на транзит, но даты и контрагенты его опровергают: это и есть объяснение.
        text = (
            f"{head}: исходящие = {percent_ru(raw)} входящих, но это встречные или более ранние переводы — "
            f"транзит датами не подтверждён."
        )
    elif primary.role == "peripheral" and runner_up.score == 0:
        text = f"{head}: признаков ролей не найдено."
    elif primary.role == "peripheral":
        text = f"{head}: признаки ниже порога. Ближайший — {alt} {score_ru(runner_up.score)}: {runner_up.reason.rstrip('.')}."
    elif runner_up.score > primary.score:
        # При одинаковом округлении «сильнее» читалось бы как противоречие «0,58 сильнее 0,58».
        stronger = "сильнее" if score_ru(runner_up.score) != score_ru(primary.score) else "не слабее"
        text = (
            f"Гипотеза {head}: {primary.reason.rstrip('.')}. "
            f"{alt.capitalize()} {score_ru(runner_up.score)} {stronger}, но признаки веера приоритетнее."
        )
    else:
        text = f"Гипотеза {head}: {primary.reason.rstrip('.')}. Альтернатива: {alt} {score_ru(runner_up.score)}."
    if m.outgoing_censored and primary.role in ("consolidator", "coordinator", "peripheral") and "не собирались" not in text:
        text = text[:-1] + "; исходящие не собирались."
    return " ".join(text.split())


def _before_end(days) -> str:
    """«за N дн. до конца периода» или «в последний день периода» вместо «за 0 дн.»."""
    return "в последний день периода" if not days else f"за {days} дн. до конца периода"


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
        if m.window_days is not None and m.window_days >= min_margin:
            # 90% суммы пришло раньше: окно достаточное, поздним был лишь последний небольшой перевод.
            notes.append(f"Последнее небольшое поступление — {_before_end(m.margin_days)}; 90% суммы набралось раньше, за {m.window_days} дн. до конца.")
        else:
            notes.append(f"Последнее поступление — {_before_end(m.margin_days)}: окно наблюдения короткое.")
    if observation_gap(m) == SHORT_VALUE_WINDOW:
        notes.append(f"90% суммы набралось {_before_end(m.window_days)}: окно наблюдения короткое.")
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
    gap = observation_gap(m)
    if gap == SHORT_WINDOW:
        return f"Запросить операции счёта после конца периода: последнее поступление — {_before_end(m.margin_days)}."
    if gap == SHORT_VALUE_WINDOW:
        return f"Запросить операции счёта после конца периода: 90% суммы набралось {_before_end(m.window_days)}."
    if m.is_seed:
        return "Запросить входящие переводы исходного клиента, не попавшие в выгрузку."
    if m.out_tiyn > m.in_tiyn * T("transit", "pass_through_high"):
        return "Запросить поступления на счёт из других банков и наличными: исходящие превышают наблюдаемые поступления."
    return "Дополнительный запрос не нужен, пока нет признаков роли; сверить с очередью приоритета."
