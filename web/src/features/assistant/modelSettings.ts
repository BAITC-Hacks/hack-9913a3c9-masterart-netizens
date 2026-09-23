import type {AssistantHistoryTurn, AssistantOptions} from './types';
import type {AssistantSettings, StoredTurn} from './conversationStore';

/**
 * Выбор модели и усилия рассуждения и контекст разговора для следующего вопроса. Список моделей и
 * допустимые уровни усилия называет сервер (/api/assistant/options); здесь только проверка сохранённого
 * выбора по этому списку и русские подписи.
 */
const EFFORT_COPY: Readonly<Record<string, {label: string; mark: string; detail: string}>> = {
  none: {label: 'Без рассуждения', mark: 'Нет', detail: 'самый быстрый ответ'},
  low: {label: 'Низкое', mark: 'Низкое', detail: 'быстрее'},
  medium: {label: 'Среднее', mark: 'Среднее', detail: 'сбалансированно'},
  high: {label: 'Высокое', mark: 'Высокое', detail: 'глубже'},
  xhigh: {label: 'Очень высокое', mark: 'Очень высокое', detail: 'сложные вопросы'},
  max: {label: 'Максимум', mark: 'Максимум', detail: 'наибольшая глубина'},
};

/** Незнакомый уровень показывается как есть: сервер может расширить список. */
export const effortLabel = (effort: string) => EFFORT_COPY[effort]?.label ?? effort;
export const effortMark = (effort: string) => EFFORT_COPY[effort]?.mark ?? effort;
export const effortDetail = (effort: string) => EFFORT_COPY[effort]?.detail ?? '';

export function modelLabel(options: AssistantOptions | null, id: string | undefined): string {
  if (!id) return '';
  return options?.models.find(model => model.id === id)?.label ?? id;
}

export interface ResolvedSettings { model: string; effort: string }


/** Сохранённый выбор, если сервер его ещё поддерживает; иначе значения сервера по умолчанию. */
export function resolveSettings(options: AssistantOptions, stored: AssistantSettings): ResolvedSettings {
  const model = options.models.find(candidate => candidate.id === stored.model)
    ?? options.models.find(candidate => candidate.id === options.defaults.model)
    ?? options.models[0]!;
  const effort = stored.effort && model.efforts.includes(stored.effort)
    ? stored.effort
    : model.id === options.defaults.model && model.efforts.includes(options.defaults.effort) ? options.defaults.effort : model.default_effort;
  return {model: model.id, effort};
}

/** Другая модель: усилие сохраняется, если новая модель его допускает, иначе её усилие по умолчанию. */
export function switchModel(options: AssistantOptions, current: ResolvedSettings, modelId: string): ResolvedSettings {
  const model = options.models.find(candidate => candidate.id === modelId);
  if (!model) return current;
  return {model: model.id, effort: model.efforts.includes(current.effort) ? current.effort : model.default_effort};
}

/**
 * Контекст разговора для сервера: последние завершённые вопросы с ответом, не больше лимитов сервера.
 * Вопрос обрезается до question_chars только в запросе — в ленте он остаётся полным. Текст ответа модели
 * не передаётся: только вопрос, выбор на карте и счета из ответа.
 */
export function buildHistory(turns: readonly StoredTurn[], limits: AssistantOptions['history_limits']): AssistantHistoryTurn[] {
  return turns
    .filter(turn => turn.response)
    .slice(-limits.turns)
    .map(turn => ({
      question: turn.question.slice(0, limits.question_chars),
      selection: turn.selection.slice(0, limits.gids),
      result_gids: turn.response!.nodes.slice(0, limits.gids),
    }));
}
