import { SafeAnswer } from './SafeAnswer';
import { isGid, parserLabel } from './api';
import type { AssistantResponse, JsonObject, JsonValue } from './types';
import {ROLE_LABEL} from '../../data/format';
import { NodeLink } from './NodeLink';
export { NodeLink } from './NodeLink';

const OPERATION_LABELS: Record<string, string> = {
  node: 'Карточка счёта', get_node: 'Карточка счёта', explain_node: 'Карточка счёта',
  neighbors: 'Наблюдаемые переводы', get_neighbors: 'Наблюдаемые переводы',
  rank: 'Очередь проверки', rank_nodes: 'Очередь проверки',
  comparison: 'Сравнение счетов', compare_nodes: 'Сравнение счетов',
  clusters: 'Метрики кластеров', get_clusters: 'Метрики кластеров',
  convergence: 'Схождение путей', find_convergence: 'Схождение путей',
  temporal: 'Путь с датами', get_temporal: 'Путь с датами', gaps: 'Пробелы наблюдения', get_gaps: 'Пробелы наблюдения',
  insights: 'Рассчитанные наблюдения', get_insights: 'Рассчитанные наблюдения',
  navigation: 'Переход по приложению', navigate_view: 'Переход по приложению', help: 'Справка',
  invalid: 'Проверка запроса', unsupported: 'Границы возможностей',
};

function operationLabel(name: JsonValue | undefined): string {
  return typeof name === 'string' && typeof OPERATION_LABELS[name] === 'string' ? OPERATION_LABELS[name] : 'Запрос к графу';
}

function record(value: JsonValue): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** В интерфейсе — смысл условий и ссылки на счета. Полные доказательства остаются в ответе API. */
function Conditions({args, allowedGids, onSelectNode}: {args: JsonObject; allowedGids: string[]; onSelectNode: (gid: string) => void}) {
  const rows: {label: string; value?: string; gids?: string[]}[] = [];
  if (isGid(args.gid)) rows.push({label: 'Счёт', gids: [args.gid]});
  if (Array.isArray(args.gids)) rows.push({label: 'Сравниваемые счета', gids: args.gids.filter(isGid)});
  if (Array.isArray(args.sources)) rows.push(args.sources.length
    ? {label: 'Источники путей', gids: args.sources.filter(isGid)} : {label: 'Источники путей', value: 'Все исходные клиенты'});
  if (typeof args.limit === 'number') rows.push({label: 'Показать не больше', value: String(args.limit)});
  if (typeof args.min_sources === 'number') rows.push({label: 'Минимум источников', value: String(args.min_sources)});
  if (typeof args.cluster_id === 'number') rows.push({label: 'Кластер', value: String(args.cluster_id)});
  if (typeof args.role === 'string' && typeof ROLE_LABEL[args.role] === 'string') rows.push({label: 'Гипотеза роли', value: ROLE_LABEL[args.role]});
  const modes: Record<string, string> = {static: 'Без учёта дат', strict: 'Только более поздний день', same_day: 'Возможный порядок в тот же день'};
  if (typeof args.mode === 'string' && typeof modes[args.mode] === 'string') rows.push({label: 'Порядок дат', value: modes[args.mode]});
  const directions: Record<string, string> = {in: 'Входящие', out: 'Исходящие', both: 'Входящие и исходящие'};
  if (typeof args.direction === 'string' && typeof directions[args.direction] === 'string') rows.push({label: 'Переводы', value: directions[args.direction]});
  if (!rows.length) return null;
  return <dl>{rows.map((row, index) => <div key={index}><dt>{row.label}</dt><dd>
    {row.gids ? row.gids.every(gid => allowedGids.includes(gid))
      ? <NodeLinks gids={row.gids} onSelectNode={onSelectNode} /> : row.gids.join(' · ') : row.value}
  </dd></div>)}</dl>;
}

export function NodeLinks({ gids, onSelectNode }: { gids: string[]; onSelectNode: (gid: string) => void }) {
  if (gids.length === 0) return null;
  const visible = gids.slice(0, 4);
  return <div className="fa-node-list">
    {visible.map((gid) => <NodeLink key={gid} gid={gid} onSelectNode={onSelectNode} />)}
    {gids.length > visible.length ? <details className="fa-details fa-more">
      <summary>Ещё счетов: {gids.length - visible.length}</summary>
      <div className="fa-node-list">{gids.slice(visible.length).map((gid) => <NodeLink key={gid} gid={gid} onSelectNode={onSelectNode} />)}</div>
    </details> : null}
  </div>;
}

export function AnswerCard({ response, onSelectNode }: { response: AssistantResponse; onSelectNode: (gid: string) => void }) {
  return <div className="fa-result" data-parser={response.parser}>
    <p className="fa-mode">{parserLabel(response)}</p>
    {response.parser === 'openai' ? <p className="fa-caption">Модель помогает разобрать вопрос. Основания ответа — результаты операций с графом.</p> : null}
    {/* Таблицы и схема пути — из проверенного результата инструмента; без них — обычный ответ. */}
    <SafeAnswer text={response.answer_rich_md ?? response.answer_md} gids={response.nodes} onSelectNode={onSelectNode} />
    {response.warnings.length > 0 ? <div className="fa-warnings">
      <p className="fa-section-label">Ограничения ответа</p>
      <ul>{response.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </div> : null}
    {response.nodes.length > 0 ? <div className="fa-sources">
      <p className="fa-section-label">Счета в ответе · {response.nodes.length}</p>
      <NodeLinks gids={response.nodes} onSelectNode={onSelectNode} />
    </div> : null}
    {response.citations.length > 0 ? <details className="fa-details">
      <summary>Основания ответа · {response.citations.length}</summary>
      <ol className="fa-citations">{response.citations.map((citation, index) => <li key={index}>
        <p>{citation.label}</p>
        <NodeLinks gids={citation.gids} onSelectNode={onSelectNode} />
        {typeof record(citation.detail)?.source === 'string'
          ? <p className="fa-caption">Источник: {String(record(citation.detail)?.source).split(/[\\/]/).pop()}</p> : null}
      </li>)}</ol>
    </details> : <p className="fa-caption">Ссылки на основания для этого ответа не получены.</p>}
    <details className="fa-details fa-audit">
      <summary>Как получен ответ</summary>
      <dl><div><dt>Разбор вопроса</dt><dd>{parserLabel(response)}</dd></div>
        <div><dt>Операция</dt><dd>{operationLabel(response.intent)}</dd></div></dl>
      <Conditions args={response.args} allowedGids={response.nodes} onSelectNode={onSelectNode} />
      {response.tool_trace.length ? <>
        <p className="fa-section-label">Проверенные операции · {response.tool_trace.length}</p>
        <ol className="fa-trace">{response.tool_trace.map((trace, index) => <li key={index}>
          {operationLabel(record(trace)?.name ?? record(trace)?.tool)}
        </li>)}</ol>
      </> : <p className="fa-caption">Операция с графом не выполнялась.</p>}
    </details>
  </div>;
}
