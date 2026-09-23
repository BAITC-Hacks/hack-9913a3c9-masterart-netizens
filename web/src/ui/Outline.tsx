import type {GraphIndex} from '../data/graph';
import {pairTransactions} from '../data/graph';
import type {Neighborhood, NeighborLink} from '../data/neighborhood';
import {countLabel, formatDate, formatInt, formatKzt} from '../data/format';
import {Gid} from './Gid';
import {RoleTag} from './RoleGlyph';
import {Icon} from '../map/icons';

/**
 * Доступный список окрестности: все плательщики, получатели и встречные потоки без свёртки,
 * с датами переводов. Это текстовый двойник карты для клавиатуры, экранного диктора и проверки.
 */
export function Outline({index, hood, onSelect}: {index: GraphIndex; hood: Neighborhood; onSelect: (gid: string) => void}) {
  const focus = hood.focus.gid;
  return <div className="wb-outline">
    <Section id="wb-outline-in" title="Платили этому счёту" links={hood.payers} index={index} focus={focus} side="in" onSelect={onSelect}
      empty={hood.focus.is_seed ? 'Входящие исходного клиента из-за пределов выборки не собирались.' : 'Входящих переводов в выборке нет.'} />
    {hood.mutual.length > 0 && <Section id="wb-outline-mutual" title="Встречные потоки: деньги шли в обе стороны" links={hood.mutual} index={index} focus={focus} side="mutual" onSelect={onSelect} empty="" />}
    <Section id="wb-outline-out" title="Получали от этого счёта" links={hood.recipients} index={index} focus={focus} side="out" onSelect={onSelect}
      empty={hood.focus.observation.outgoing_censored ? 'Исходящие не наблюдаются: счёт на границе сбора данных.' : 'Исходящих переводов в выборке нет.'} />
    {hood.cycles.length > 0 && <section className="wb-outline__section" id="wb-outline-cycles">
      <h3><Icon name="cycle" size={14} />Возвратные потоки <span className="wb-count">{hood.cycles.length}</span></h3>
      <p className="wb-outline__note">Направленные циклы через этот счёт по наблюдаемым связям. Это наблюдение для проверки, а не ошибка данных.</p>
      <ol className="wb-cycles">{hood.cycles.map(cycle => <li key={cycle.join('>')}>
        {[...cycle, cycle[0]!].map((gid, i) => <span key={`${gid}-${i}`} className="wb-cycles__step">
          {i > 0 && <span className="wb-cycles__arrow" aria-hidden="true">→</span>}
          {gid === focus ? <span className="wb-cycles__focus">этот счёт</span> : <button type="button" className="wb-linklike" onClick={() => onSelect(gid)}><Gid gid={gid} /></button>}
        </span>)}
      </li>)}</ol>
    </section>}
  </div>;
}

function Section({id, title, links, index, focus, side, onSelect, empty}: {
  id: string; title: string; links: NeighborLink[]; index: GraphIndex; focus: string; side: 'in' | 'out' | 'mutual'; onSelect: (gid: string) => void; empty: string;
}) {
  return <section className="wb-outline__section" id={id}>
    <h3>{title} <span className="wb-count">{links.length}</span></h3>
    {links.length === 0 ? <p className="wb-outline__note">{empty}</p> : <table className="wb-table">
      <thead><tr><th scope="col">Счёт</th><th scope="col">Роль</th><th scope="col" className="is-num">Сумма</th><th scope="col" className="is-num">Переводов</th><th scope="col">Даты</th></tr></thead>
      <tbody>{links.map(link => {
        const edges = [link.toFocus, link.fromFocus].filter(Boolean);
        const kzt = edges.reduce((sum, edge) => sum + edge!.sum_kzt, 0);
        const tx = edges.reduce((sum, edge) => sum + edge!.n_tx, 0);
        const list = [...(link.toFocus ? pairTransactions(index, link.gid, focus) : []), ...(link.fromFocus ? pairTransactions(index, focus, link.gid) : [])]
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        return <tr key={link.gid}>
          <td><button type="button" className="wb-linklike" onClick={() => onSelect(link.gid)} aria-label={`Открыть счёт ${link.gid}`}><Gid gid={link.gid} /></button></td>
          <td>{link.node ? <RoleTag role={link.node.role} /> : '—'}</td>
          <td className="is-num">{side === 'mutual' ? <>↓ {formatKzt(link.toFocus!.sum_kzt)}<br />↑ {formatKzt(link.fromFocus!.sum_kzt)}</> : formatKzt(kzt)}</td>
          <td className="is-num">{formatInt(tx)}</td>
          <td>{list.length ? <details className="wb-tx">
            <summary>{list[0]!.date === list.at(-1)!.date ? formatDate(list[0]!.date) : `${formatDate(list[0]!.date)} — ${formatDate(list.at(-1)!.date)}`}</summary>
            <ul>{list.map((tx, i) => <li key={i}><span>{formatDate(tx.date)}</span><span>{tx.src === focus ? '→' : '←'}</span><span className="is-num">{formatKzt(tx.sum_kzt)}</span></li>)}</ul>
          </details> : <span className="wb-muted">{countLabel(0, 'перевод', 'перевода', 'переводов')} с датой</span>}</td>
        </tr>;
      })}</tbody>
    </table>}
  </section>;
}
