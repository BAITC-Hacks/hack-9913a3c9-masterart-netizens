import {useEffect, useRef} from 'react';
import type {GraphIndex} from '../data/graph';
import {KNOWN_ROLES} from '../data/schema';
import {countLabel, formatDate, formatInt, formatKzt, roleLabel} from '../data/format';
import {SearchBox} from './SearchBox';
import {Icon} from '../map/icons';
import {RoleGlyph} from './RoleGlyph';
import {MODE_LABEL} from '../data/format';

/**
 * Верхняя строка: название, поиск по gid — главное действие — и одна тихая строка о выборке.
 * Подробности о данных и их происхождении раскрываются по запросу. Синтетика помечена всегда.
 */
export function TopBar({index, warnings, onSelect, notice, onDismissNotice}: {
  index: GraphIndex; warnings: string[]; onSelect: (gid: string) => void; notice: string | null; onDismissNotice: () => void;
}) {
  const {summary, fixture, policy} = index.analysis;
  const about = useRef<HTMLDetailsElement>(null);
  const reach = reachRows(index.analysis.temporal_summary);
  // Сведения о данных закрываются щелчком вне панели и клавишей Escape, как обычное всплывающее окно.
  useEffect(() => {
    const close = (event: Event) => {
      const el = about.current;
      if (!el?.open) return;
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !el.contains(event.target as Node)) {
        el.open = false;
        if (event instanceof KeyboardEvent) el.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, []);
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
    <details className="wb-about" ref={about}>
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
        <p className="wb-about__title">Роли-гипотезы</p>
        <ul className="wb-about__roles">{[...KNOWN_ROLES, ...[...index.roleCounts.keys()].filter(r => !(KNOWN_ROLES as readonly string[]).includes(r))]
          .filter(role => index.roleCounts.has(role)).map(role => <li key={role} className={`wb-role--${role}`}><RoleGlyph role={role} /><span>{roleLabel(role)}</span><strong>{formatInt(index.roleCounts.get(role)!)}</strong></li>)}</ul>
        {reach.length > 0 && <>
          <p className="wb-about__title">Достижимость от исходных клиентов</p>
          <table className="wb-about__reach">
            <thead><tr><th scope="col">Счетов, до которых есть путь</th>{reach.map(r => <th key={r.min} scope="col" className="is-num">от ≥ {r.min}</th>)}</tr></thead>
            <tbody>{(['structural', 'strict', 'same_day'] as const).map(mode => <tr key={mode}><th scope="row">{MODE_LABEL[mode]}</th>
              {reach.map(r => <td key={r.min} className="is-num">{r.values[mode] === undefined ? '—' : formatInt(r.values[mode]!)}</td>)}</tr>)}</tbody>
          </table>
        </>}
        <p className="wb-about__line">Период {formatDate(summary.period_start, true)} — {formatDate(summary.period_end, true)} · правила {policy.version}</p>
        <p className="wb-about__line">sha256 входных данных <span className="wb-mono wb-about__hash">{summary.input_sha256}</span></p>
        {warnings.length > 0 && <ul className="wb-about__warnings">{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
      </div>
    </details>
    {fixture?.synthetic && <p className="wb-fixture" role="note"><strong>Синтетический пример.</strong> {fixture.label}</p>}
  </header>;
}

/**
 * Строки «от ≥ N исходных клиентов» из temporal_summary. Ключи вида *_at_least_N_seed(s) с числами по
 * режимам; «static» и «structural» — одно и то же. Незнакомая форма просто не показывается.
 */
function reachRows(summary: Record<string, unknown>) {
  const rows: {min: number; values: Partial<Record<'structural' | 'strict' | 'same_day', number>>}[] = [];
  for (const [key, value] of Object.entries(summary)) {
    const match = /at_least_(\d+)_seeds?$/.exec(key);
    if (!match || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const pick = (...names: string[]) => names.map(n => v[n]).find((x): x is number => typeof x === 'number');
    rows.push({min: Number.parseInt(match[1]!, 10), values: {structural: pick('structural', 'static'), strict: pick('strict'), same_day: pick('same_day')}});
  }
  return rows.sort((a, b) => a.min - b.min);
}
