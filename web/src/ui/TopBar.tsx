import type {GraphIndex} from '../data/graph';
import {countLabel, formatDate, formatInt, formatKzt} from '../data/format';
import {SearchBox} from './SearchBox';
import {Icon} from '../map/icons';

/**
 * Верхняя строка: название, поиск по gid — главное действие — и одна тихая строка о выборке.
 * Подробности о данных и их происхождении раскрываются по запросу. Синтетика помечена всегда.
 */
export function TopBar({index, warnings, onSelect, notice, onDismissNotice}: {
  index: GraphIndex; warnings: string[]; onSelect: (gid: string) => void; notice: string | null; onDismissNotice: () => void;
}) {
  const {summary, fixture, policy} = index.analysis;
  return <header className="wb-top">
    <div className="wb-top__brand">
      <span className="wb-top__mark" aria-hidden="true" />
      <h1 className="wb-top__title">Граф денег</h1>
    </div>
    <div className="wb-top__search">
      <SearchBox index={index} onSelect={onSelect} />
      {notice && <p className="wb-notice" role="alert"><Icon name="alert" size={15} /><span>{notice}</span>
        <button type="button" className="wb-notice__close" aria-label="Скрыть сообщение" onClick={onDismissNotice}><Icon name="close" size={14} /></button></p>}
    </div>
    <details className="wb-about">
      <summary>
        <span>{countLabel(summary.n_nodes, 'счёт', 'счёта', 'счетов')} · {formatDate(summary.period_start)} — {formatDate(summary.period_end)}</span>
        {warnings.length > 0 && <span className="wb-about__warn" aria-label={`Предупреждений: ${warnings.length}`}>!</span>}
      </summary>
      <div className="wb-about__panel">
        <p className="wb-about__title">О данных</p>
        <dl className="wb-about__facts">
          <div><dt>Счетов</dt><dd>{formatInt(summary.n_nodes)}</dd></div>
          <div><dt>Связей</dt><dd>{formatInt(summary.n_edges)}</dd></div>
          <div><dt>Переводов</dt><dd>{formatInt(summary.n_transactions)}</dd></div>
          <div><dt>Исходных клиентов</dt><dd>{formatInt(summary.n_seed)}</dd></div>
          <div><dt>Оборот</dt><dd>{formatKzt(summary.total_kzt)}</dd></div>
          <div><dt>На границе выборки</dt><dd>{formatInt(summary.n_boundary)}</dd></div>
          <div><dt>Без переводов</dt><dd>{formatInt(summary.n_isolates)}</dd></div>
          <div><dt>Слабых компонент</dt><dd>{formatInt(summary.n_weak_components)}</dd></div>
        </dl>
        <p className="wb-about__line">Период {formatDate(summary.period_start, true)} — {formatDate(summary.period_end, true)} · правила {policy.version}</p>
        <p className="wb-about__line">sha256 входных данных <span className="wb-mono wb-about__hash">{summary.input_sha256}</span></p>
        {warnings.length > 0 && <ul className="wb-about__warnings">{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
      </div>
    </details>
    {fixture?.synthetic && <p className="wb-fixture" role="note"><strong>Синтетический пример.</strong> {fixture.label}</p>}
  </header>;
}
