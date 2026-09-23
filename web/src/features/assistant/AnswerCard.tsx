import { SafeAnswer } from './SafeAnswer';
import { parserLabel } from './api';
import type { AssistantResponse } from './types';
import { NodeLink } from './NodeLink';
export { NodeLink } from './NodeLink';

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
        <details className="fa-details fa-raw">
          <summary>Данные основания {index + 1}</summary>
          <pre>{JSON.stringify(citation.detail, null, 2)}</pre>
        </details>
      </li>)}</ol>
    </details> : <p className="fa-caption">Ссылки на основания для этого ответа не получены.</p>}
    <details className="fa-details fa-audit">
      <summary>Как получен ответ</summary>
      <dl><div><dt>Разбор вопроса</dt><dd>{parserLabel(response)}</dd></div>
        <div><dt>Операция</dt><dd><code>{response.intent || 'Не определена'}</code></dd></div>
        <div><dt>Параметры</dt><dd><pre>{JSON.stringify(response.args, null, 2)}</pre></dd></div></dl>
      <p className="fa-section-label">Вызовы инструментов · {response.tool_trace.length}</p>
      {response.tool_trace.length ? <ol className="fa-trace">{response.tool_trace.map((trace, index) => <li key={index}><pre>{JSON.stringify(trace, null, 2)}</pre></li>)}</ol>
        : <p className="fa-caption">В ответе нет журнала вызовов.</p>}
    </details>
  </div>;
}
