import type {GraphIndex} from '../data/graph';
import {formatDate, formatInt, formatKzt} from '../data/format';

/** Название, объём выборки и происхождение данных. Синтетический пример помечен всегда и заметно. */
export function TopBar({index, warnings}: {index: GraphIndex; warnings: string[]}) {
  const {summary, fixture, policy} = index.analysis;
  return <header className="wb-top">
    <div className="wb-top__brand">
      <span className="wb-top__mark" aria-hidden="true" />
      <div>
        <h1 className="wb-top__title">Граф денег</h1>
        <p className="wb-top__subtitle">Рабочее место проверки</p>
      </div>
    </div>
    <dl className="wb-top__facts" aria-label="Выборка">
      <div><dt>Счетов</dt><dd>{formatInt(summary.n_nodes)}</dd></div>
      <div><dt>Связей</dt><dd>{formatInt(summary.n_edges)}</dd></div>
      <div><dt>Переводов</dt><dd>{formatInt(summary.n_transactions)}</dd></div>
      <div><dt>Исходных клиентов</dt><dd>{formatInt(summary.n_seed)}</dd></div>
      <div><dt>Оборот</dt><dd>{formatKzt(summary.total_kzt)}</dd></div>
      <div><dt>Период</dt><dd>{formatDate(summary.period_start)} — {formatDate(summary.period_end, true)}</dd></div>
    </dl>
    <p className="wb-top__source" title={`Входные данные sha256 ${summary.input_sha256}`}>
      Правила {policy.version} · sha256 <span className="wb-mono">{summary.input_sha256.slice(0, 10)}</span>
      {warnings.length > 0 && <span className="wb-top__warn" title={warnings.join('\n')}> · предупреждений: {warnings.length}</span>}
    </p>
    {fixture?.synthetic && <p className="wb-fixture" role="note"><strong>Синтетический пример</strong> {fixture.label}</p>}
  </header>;
}
