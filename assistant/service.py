"""Публичная функция помощника: проверенные факты с необязательным разбором OpenAI."""

from __future__ import annotations

import copy
import json
import re
from typing import Callable

from . import openai
from .config import load_config
from .queries import GraphQueries, MAX_SOURCES, QueryError, ROLES
from .render import UNSUPPORTED, render

NO_KEY = "Ключ модели не настроен. Выполнен локальный разбор по правилам, без языковой модели."
API_FAILED = "Запрос к модели не завершён или её операция отклонена. Использован локальный разбор по правилам."
UNSUPPORTED_PATTERN = re.compile(
    r"винов|преступ|мошенни|отмыв|паспорт|\bфио\b|личност|личны[ехй]|адрес\s+клиент|телефон|"
    r"кому\s+принадлеж|владел[еь]ц|происхождени[ея]\s+(?:этих\s+|конкретных\s+)?(?:денег|средств)|"
    r"те\s+же\s+(?:деньги|средства)|\bguilt|\bcriminal|\bfraud|same\s+money|who\s+owns|"
    r"money\s+origin|personal\s+(?:data|attributes)|\bsql\b|\bexec\b|\beval\b|\bshell\b|"
    r"\bsubprocess\b|\bpython\b|выполн[иь].*код|удал[иь].*данн|измени.*данн|"
    r"игнорируй.*инструкц|ignore.*instructions|api[ _-]?key|секрет|\btoken\b",
    re.IGNORECASE,
)
NUMBER_TOKEN = re.compile(r"(?<![\w.])[-+]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.])")
ID_CONTEXT = re.compile(r"(?:\bgid|сч[её]т(?:а|у|е|ом)?|\baccount)\s*[:#=]?\s*`?$", re.IGNORECASE)


def _base(message: str, *, warnings: list[str] | None = None, intent: str = "help") -> dict:
    return {"answer_md": message, "nodes": [], "intent": intent, "args": {}, "parser": "none",
            "warnings": warnings or [], "citations": [], "tool_trace": []}


def _inputs(question: object, selection: object, graph: GraphQueries) -> tuple[str, list[str], list[str]]:
    if not isinstance(question, str) or len(question) > 4000 or "\x00" in question:
        raise QueryError("Вопрос должен быть строкой длиной не более 4000 символов.")
    if not isinstance(selection, list) or len(selection) > MAX_SOURCES:
        raise QueryError("Выделение должно быть списком не более 100 точных идентификаторов.")
    selected = list(dict.fromkeys(graph.require_gid(gid) for gid in selection))
    mentioned = []
    q = question.strip()
    for explicit in re.finditer(r"\bgid\s*[:#=]?\s+([^\s,;]+)|\bgid\s*[:#=]\s*([^\s,;]+)", q, re.IGNORECASE):
        candidate = next(value for value in explicit.groups() if value is not None).strip("`\"'")
        mentioned.append(graph.require_gid(candidate))
    if re.search(r"(?:\bgid|сч[её]т(?:а|у|е|ом)?|\baccount)\s*[:#=]?\s*0[xX][0-9a-fA-F]+", q):
        raise QueryError("Идентификатор счёта должен быть точной десятичной строкой int64 без округления.")
    for token in NUMBER_TOKEN.finditer(q):
        candidate = token.group()
        is_id = (len(re.sub(r"\D", "", candidate)) >= 15 or ID_CONTEXT.search(q[:token.start()])
                 or candidate == q or (re.search(r"(?:объясни|explain|покажи)\s+$", q[:token.start()], re.IGNORECASE)
                                          and candidate in graph.nodes))
        if is_id:
            mentioned.append(graph.require_gid(candidate))
    return q, selected, list(dict.fromkeys(mentioned))


def _limit(q: str) -> int:
    match = re.search(r"(?:топ|top|первые|первых|покажи)\s+(\d+)\b", q)
    return min(30, max(1, int(match.group(1)))) if match else 10


def _mode(q: str) -> str:
    if re.search(r"одного дня|один день|внутри.*дня|внутриднев|same.day|same_day", q):
        return "same_day"
    if re.search(r"строг|поздн|strict|по дат|по дням|времен|chronolog", q):
        return "strict"
    return "static"


def _rules(question: str, selected: list[str], mentioned: list[str], graph: GraphQueries) -> tuple[str, dict]:
    q = question.lower()
    gids = mentioned or selected
    gid = gids[0] if len(gids) == 1 else None
    limit = _limit(q)
    if re.search(r"сход|схожд|достиж|пересеч|хотя бы|конверген|converg|reachable|\d+\s*(?:из|of)\s*\d+", q):
        match = re.search(r"(?:хотя бы|не менее|минимум|at least)\s+(\d+)|\b(\d+)\s*(?:из|of)\s*\d+", q)
        k = int(next(g for g in match.groups() if g is not None)) if match else 2
        if re.search(r"от всех|from all|общие.*всех", q):
            k = len(gids) if gids else sum(n["is_seed"] for n in graph.nodes.values())
        return "find_convergence", {"sources": gids, "min_sources": k, "mode": _mode(q), "limit": limit}
    if re.search(r"кластер|cluster", q):
        match = re.search(r"(?:кластер(?:а|е|у)?|cluster)\s*[:#]?\s*(\d+)\b", q)
        cid = int(match.group(1)) if match else graph.nodes[gid]["cluster_id"] if gid else None
        return "get_clusters", {"cluster_id": cid, "limit": limit}
    if re.search(r"не хватает|пробел|ограничени|дозапрос|каких данных|границ|gaps|missing|limitations", q):
        return "get_gaps", {"gid": gid}
    if re.search(r"сосед|связ|входящ|исходящ|контрагент|neighbors|neighbours|incoming|outgoing", q) and gid:
        incoming = bool(re.search(r"входящ|incoming", q))
        outgoing = bool(re.search(r"исходящ|outgoing", q))
        direction = "in" if incoming and not outgoing else "out" if outgoing and not incoming else "both"
        return "get_neighbors", {"gid": gid, "direction": direction, "limit": limit}
    if re.search(r"путь|пути|по дат|по дням|времен|temporal|witness|path", q) and gid:
        return "get_temporal", {"gid": gid, "mode": "same_day" if _mode(q) == "same_day" else "strict"}
    if re.search(r"\bтоп|\btop|ранжир|рейтинг|кого.*провер|приоритет.*перв|rank", q):
        role = next((r for r in ROLES if r in q), None)
        stems = {"консолид": "consolidator", "транзит": "transit", "распредел": "distributor",
                 "конечн": "terminal", "координатор": "coordinator", "перифер": "peripheral"}
        role = role or next((r for s, r in stems.items() if s in q), None)
        return "rank_nodes", {"limit": limit, "role": role}
    if gid and (not q or mentioned or re.search(r"сч[её]т|объясн|объясни|роль|почему|карточк|выбран|выделен|node|explain|account", q)):
        return "get_node", {"gid": gid}
    return "help", {"topic": "help"}


def _parse_arguments(raw: object) -> dict:
    if not isinstance(raw, str) or len(raw) > 16384:
        raise QueryError("Модель вернула некорректные параметры операции.")

    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise QueryError("В параметрах модели повторяется имя поля.")
            value[key] = item
        return value

    def constant(_):
        raise QueryError("Неконечные числа в параметрах модели запрещены.")

    try:
        args = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, TypeError, RecursionError):
        raise QueryError("Модель вернула некорректный JSON операции.") from None
    if not isinstance(args, dict):
        raise QueryError("Параметры модели должны быть объектом.")
    return args


def _response_output(response: object) -> list[dict]:
    if not isinstance(response, dict) or response.get("status", "completed") != "completed":
        raise openai.ModelError("Ответ модели не завершён.")
    output = response.get("output")
    if not isinstance(output, list) or len(output) > 16 or any(not isinstance(item, dict) for item in output):
        raise openai.ModelError("Модель вернула некорректный список результатов.")
    return output


def _model_query(question: str, selected: list[str], mentioned: list[str], graph: GraphQueries,
                 api_key: str, model: str, transport: Callable) -> tuple[str, dict, dict]:
    payload = {"model": model, "store": False, "include": ["reasoning.encrypted_content"],
               "instructions": openai.INSTRUCTIONS, "tools": openai.tools(), "tool_choice": "required",
               "parallel_tool_calls": False, "max_output_tokens": 2500,
               "input": [{"role": "user", "content": json.dumps({
                   "question": question, "selection": selected,
                   "selection_clusters": sorted({graph.nodes[g]["cluster_id"] for g in selected}),
               }, ensure_ascii=False)}]}
    first = transport(copy.deepcopy(payload), api_key=api_key, timeout=openai.TIMEOUT_SECONDS)
    output = _response_output(first)
    calls = [item for item in output if item.get("type") == "function_call"]
    if len(calls) != 1:
        raise openai.ModelError("Модель должна выбрать ровно одну операцию чтения.")
    call = calls[0]
    if not isinstance(call.get("call_id"), str) or not 1 <= len(call["call_id"]) <= 256:
        raise openai.ModelError("В вызове модели отсутствует корректный call_id.")
    name = call.get("name")
    if not isinstance(name, str):
        raise QueryError("Модель не указала имя операции.")
    args = _parse_arguments(call.get("arguments"))
    allowed = set(mentioned or selected)
    if args.get("gid") is not None and args["gid"] not in allowed:
        raise QueryError("Модель указала счёт, которого нет в вопросе или выделении.")
    if "sources" in args and (not isinstance(args["sources"], list)
                              or any(not isinstance(g, str) or g not in allowed for g in args["sources"])):
        raise QueryError("Источники модели не соответствуют вопросу или выделению.")
    if name == "find_convergence" and allowed and set(args.get("sources", [])) != allowed:
        raise QueryError("Модель изменила выбранное множество источников.")
    if name == "get_clusters" and args.get("cluster_id") is not None:
        allowed_clusters = {graph.nodes[g]["cluster_id"] for g in allowed}
        allowed_clusters.update(int(m.group(1)) for m in re.finditer(
            r"(?:кластер(?:а|е|у)?|cluster)\s*[:#]?\s*(\d+)\b", question, re.IGNORECASE))
        if args["cluster_id"] not in allowed_clusters:
            raise QueryError("Модель указала кластер, которого нет в запросе.")
    result = graph.execute(name, args)
    # Для store:false переносим все элементы, включая зашифрованное рассуждение, без публикации в ответе.
    payload["input"].extend(copy.deepcopy(output))
    payload["input"].append({"type": "function_call_output", "call_id": call["call_id"],
                             "output": json.dumps(result, ensure_ascii=False, allow_nan=False)})
    payload["tool_choice"] = "none"
    second = transport(copy.deepcopy(payload), api_key=api_key, timeout=openai.TIMEOUT_SECONDS)
    continuation = _response_output(second)
    if any(item.get("type") == "function_call" for item in continuation):
        raise openai.ModelError("После результата инструмента модель запросила лишнюю операцию.")
    return name, args, result


def answer(question, selection, analysis, *, api_key=None, model=None, transport=None) -> dict:
    """Возвращает факты и их ссылки. transport(payload, *, api_key, timeout) подменяет только HTTP."""
    try:
        if not isinstance(question, str) or len(question) > 4000 or "\x00" in question:
            return _base("Вопрос должен быть строкой длиной не более 4000 символов.", intent="invalid")
        if isinstance(question, str) and UNSUPPORTED_PATTERN.search(question):
            return _base(UNSUPPORTED, intent="unsupported")
        graph = GraphQueries(analysis)
        question, selected, mentioned = _inputs(question, selection, graph)
        config = load_config()
        key = config["api_key"] if api_key is None else api_key
        chosen_model = config["model"] if model is None else model
        if not isinstance(key, str) or any(c in key for c in ("\r", "\n", "\x00")) or len(key) > 1024:
            return _base("Некорректная серверная конфигурация помощника.", intent="invalid")
        if not isinstance(chosen_model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}", chosen_model):
            return _base("Некорректное имя модели в серверной конфигурации.", intent="invalid")
        if key and (key in question or key == chosen_model):
            return _base("В запросе обнаружено значение серверной конфигурации. Удалите его из текста.", intent="invalid")
        warnings = []
        parser = "rules"
        model_used = None
        if key:
            try:
                name, args, result = _model_query(question, selected, mentioned, graph, key, chosen_model, transport or openai.request)
                parser = "openai"
                model_used = chosen_model
            except Exception:
                # Транспорт и провайдер могут включать ключ в исключение; его текст не выходит наружу.
                warnings.append(API_FAILED)
                name, args = _rules(question, selected, mentioned, graph)
                result = graph.execute(name, args)
        else:
            warnings.append(NO_KEY)
            name, args = _rules(question, selected, mentioned, graph)
            result = graph.execute(name, args)
        message = render(result)
        if parser == "rules":
            message = "Локальный разбор по правилам (без языковой модели).\n\n" + message
        warnings.extend(result["warnings"])
        response = {"answer_md": message, "nodes": result["nodes"], "intent": result["kind"], "args": args,
                    "parser": parser, "warnings": list(dict.fromkeys(warnings)), "citations": result["citations"],
                    "tool_trace": [{"name": name, "args": copy.deepcopy(args), "result": result}]}
        if model_used is not None:
            response["model"] = model_used
        return response
    except QueryError as exc:
        return _base(str(exc), intent="invalid")
    except Exception:
        return _base("Не удалось выполнить проверяемый запрос по analysis.json. Проверьте формат данных.", intent="invalid")
