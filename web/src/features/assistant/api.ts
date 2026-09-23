import type { AssistantCitation, AssistantOptions, AssistantRequest, AssistantResponse, JsonObject, JsonValue } from './types';

export const MAX_QUESTION_LENGTH = 2000;
export const REQUEST_TIMEOUT_MS = 60000;

export class AssistantError extends Error {
  constructor(message: string) { super(message); this.name = 'AssistantError'; }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGid(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|-?[1-9]\d{0,18})$/.test(value)) return false;
  const integer = BigInt(value);
  return integer >= -9223372036854775808n && integer <= 9223372036854775807n;
}

export function exactSelection(values: readonly string[]): string[] {
  if (!values.every(isGid)) throw new AssistantError('Идентификатор счёта должен быть точной строкой цифр.');
  return [...new Set(values)];
}

function malformed(): never {
  throw new AssistantError('Сервер вернул ответ в неизвестном формате. Повторите запрос после обновления приложения.');
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return malformed();
  return value;
}

/** Никаких ссылок и HTML из ответа не исполняется; JSON доступен только как текст. */
function json(value: unknown, depth = 0): JsonValue {
  if (depth > 30) return malformed();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => json(item, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if ((['gid', 'src', 'dst'].includes(key) || key.endsWith('_gid')) && item !== null && !isGid(item)) return malformed();
    if ((key === 'gids' || key.endsWith('_gids') || key.endsWith('_seed_ids'))
      && (!Array.isArray(item) || !item.every(isGid))) return malformed();
    return [key, json(item, depth + 1)];
  }));
  return malformed();
}

function nodeGid(value: unknown): string {
  const gid = object(value) ? value.gid : value;
  if (!isGid(gid)) return malformed();
  return gid;
}

function citation(value: unknown, index: number): AssistantCitation {
  if (typeof value === 'string') {
    return { label: isGid(value) ? `Счёт ${value}` : value, gids: isGid(value) ? [value] : [], detail: value };
  }
  if (!object(value)) return malformed();
  const gids: string[] = [];
  for (const key of ['gid', 'src', 'dst', 'seed_gid']) {
    if (value[key] !== undefined && value[key] !== null) {
      if (!isGid(value[key])) return malformed();
      gids.push(value[key]);
    }
  }
  if (value.gids !== undefined) {
    if (!Array.isArray(value.gids) || !value.gids.every(isGid)) return malformed();
    gids.push(...value.gids);
  }
  const label = [value.label, value.title, value.source, value.kind].find((item) => typeof item === 'string');
  return { label: typeof label === 'string' ? label : `Основание ${index + 1}`, gids: [...new Set(gids)], detail: json(value) };
}

export function parseAssistantResponse(value: unknown): AssistantResponse {
  if (!object(value) || typeof value.answer_md !== 'string' || !value.answer_md.trim()
    || typeof value.intent !== 'string' || !object(value.args)
    || (value.parser !== 'openai' && value.parser !== 'rules' && value.parser !== 'none')
    || !Array.isArray(value.nodes) || !Array.isArray(value.citations) || !Array.isArray(value.tool_trace)
    || (value.model !== undefined && typeof value.model !== 'string')) return malformed();
  return {
    answer_md: value.answer_md,
    nodes: [...new Set(value.nodes.map(nodeGid))],
    intent: value.intent,
    args: json(value.args) as JsonObject,
    parser: value.parser as AssistantResponse['parser'],
    warnings: strings(value.warnings),
    citations: value.citations.map(citation),
    tool_trace: value.tool_trace.map((item) => json(item)),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.effort === 'string' ? { effort: value.effort } : {}),
    ...(typeof value.dataset_fingerprint === 'string' ? { dataset_fingerprint: value.dataset_fingerprint } : {}),
    ...(typeof value.history_turns_used === 'number' ? { history_turns_used: value.history_turns_used } : {}),
  };
}

export async function loadAssistantOptions(signal?: AbortSignal): Promise<AssistantOptions> {
  let response: Response;
  try { response = await fetch('/api/assistant/options', { credentials: 'same-origin', signal }); }
  catch { throw new AssistantError('Не удалось загрузить настройки помощника. Проверьте локальный сервер.'); }
  if (!response.ok) throw new AssistantError('Настройки помощника пока недоступны на этом сервере.');
  const value: unknown = await response.json();
  if (!object(value) || typeof value.dataset_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.dataset_fingerprint)
    || !Array.isArray(value.models) || !value.models.length || !object(value.defaults) || !object(value.history_limits)) return malformed();
  const models = value.models.map((model) => {
    if (!object(model) || typeof model.id !== 'string' || typeof model.label !== 'string'
      || typeof model.default_effort !== 'string') return malformed();
    const efforts = strings(model.efforts);
    if (!efforts.length || !efforts.includes(model.default_effort)) return malformed();
    return { id: model.id, label: model.label, efforts, default_effort: model.default_effort };
  });
  const { model, effort } = value.defaults;
  if (typeof model !== 'string' || typeof effort !== 'string'
    || !models.some((choice) => choice.id === model && choice.efforts.includes(effort))) return malformed();
  const { turns, question_chars, gids } = value.history_limits;
  if (![turns, question_chars, gids].every((limit) => typeof limit === 'number' && Number.isInteger(limit) && limit > 0)) return malformed();
  return { dataset_fingerprint: value.dataset_fingerprint, models, defaults: { model, effort },
    history_limits: { turns: turns as number, question_chars: question_chars as number, gids: gids as number } };
}

export function parserLabel(response: Pick<AssistantResponse, 'parser' | 'model'>): string {
  if (response.parser === 'openai') return `Разбор запроса: OpenAI${response.model ? ` · ${response.model}` : ''}`;
  if (response.parser === 'rules') return 'Локальный разбор · без модели';
  return 'Запрос не распознан';
}

export async function askAssistant(request: AssistantRequest, signal: AbortSignal): Promise<AssistantResponse> {
  const question = request.question.trim();
  if (!question || question.length > MAX_QUESTION_LENGTH) {
    throw new AssistantError(`Введите вопрос длиной от 1 до ${MAX_QUESTION_LENGTH} символов.`);
  }
  const selection = exactSelection(request.selection);
  let response: Response;
  try {
    response = await fetch('/api/assistant', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin', signal, body: JSON.stringify({
        question, selection,
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.effort !== undefined ? { effort: request.effort } : {}),
        ...(request.dataset_fingerprint !== undefined ? { dataset_fingerprint: request.dataset_fingerprint } : {}),
        ...(request.history !== undefined ? { history: request.history.map((turn) => ({
          question: turn.question, selection: exactSelection(turn.selection), result_gids: exactSelection(turn.result_gids),
        })) } : {}),
      }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AssistantError('Нет связи с локальным сервером. Проверьте, что приложение запущено, и повторите запрос.');
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      throw new AssistantError('Помощник пока недоступен на этом сервере. Просмотр графа остаётся доступен.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new AssistantError('Сервер не разрешил запрос. Проверьте настройки помощника на сервере.');
    }
    if (response.status === 429) throw new AssistantError('Помощник занят. Подождите немного и повторите запрос.');
    throw new AssistantError('Не удалось получить ответ. Повторите запрос; если ошибка сохранится, проверьте локальный сервер.');
  }
  let value: unknown;
  try { value = await response.json(); } catch { return malformed(); }
  return parseAssistantResponse(value);
}
