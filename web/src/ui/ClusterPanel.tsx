import {useState} from 'react';
import type {GraphIndex} from '../data/graph';
import {countLabel, formatInt, formatKzt, formatScore, roleLabel} from '../data/format';
import {Gid} from './Gid';
import {RoleGlyph, RoleTag} from './RoleGlyph';
import {Icon} from '../map/icons';

/** Обзор кластера: гипотеза о структуре, состав ролей и все участники по приоритету проверки. */
const PAGE = 120;

export function ClusterPanel({index, clusterId, selected, onSelect, onClose}: {
  index: GraphIndex; clusterId: number; selected: string | null; onSelect: (gid: string) => void; onClose: () => void;
}) {
  const cluster = index.clusters.get(clusterId);
  const members = index.clusterMembers.get(clusterId) ?? [];
  const [limit, setLimit] = useState(PAGE);
  const roles = new Map<string, number>();
  for (const node of members) roles.set(node.role, (roles.get(node.role) ?? 0) + 1);
  return <div className="wb-clusterview">
    <header className="wb-clusterview__head">
      <button type="button" className="wb-button wb-button--quiet" onClick={onClose}><Icon name="back" size={15} />К связям счёта</button>
      <p className="wb-eyebrow">Кластер</p>
      <h2 className="wb-clusterview__title">{clusterId}</h2>
      {cluster ? <>
        <p className="wb-cluster-line">{countLabel(cluster.n_nodes, 'счёт', 'счёта', 'счетов')} · исходных клиентов {formatInt(cluster.n_seed)} · внутренний оборот {formatKzt(cluster.sum_kzt_internal)}</p>
        <p className="wb-hypothesis">{cluster.hypothesis}</p>
      </> : <p className="wb-muted">Описание кластера в файле отсутствует.</p>}
      <ul className="wb-role-mix" aria-label="Роли в кластере">{[...roles].sort((a, b) => b[1] - a[1]).map(([role, n]) =>
        <li key={role} className={`wb-role--${role}`}><RoleGlyph role={role} /><span>{roleLabel(role)}</span><strong>{formatInt(n)}</strong></li>)}</ul>
    </header>
    <table className="wb-table wb-table--members">
      <caption className="wb-visually-hidden">Участники кластера по приоритету проверки</caption>
      <thead><tr><th scope="col">Счёт</th><th scope="col">Роль</th><th scope="col" className="is-num">Приоритет</th><th scope="col" className="is-num">Вх.</th><th scope="col" className="is-num">Исх.</th><th scope="col" className="is-num">Получено</th><th scope="col" className="is-num">Отправлено</th></tr></thead>
      <tbody>{members.slice(0, limit).map(node => <tr key={node.gid} className={node.gid === selected ? 'is-selected' : undefined}>
        <td><button type="button" className="wb-linklike" onClick={() => onSelect(node.gid)} aria-label={`Открыть счёт ${node.gid}`}><Gid gid={node.gid} /></button>
          {node.is_seed && <em className="wb-flag">исходный</em>}{node.observation.outgoing_censored && <em className="wb-flag">граница</em>}</td>
        <td><RoleTag role={node.role} /></td>
        <td className="is-num">{formatScore(node.priority_score)}</td>
        <td className="is-num">{formatInt(node.metrics.in_degree)}</td>
        <td className="is-num">{formatInt(node.metrics.out_degree)}</td>
        <td className="is-num">{formatKzt(node.metrics.in_kzt)}</td>
        <td className="is-num">{formatKzt(node.metrics.out_kzt)}</td>
      </tr>)}</tbody>
    </table>
    {members.length > limit && <button type="button" className="wb-button wb-button--quiet wb-more" onClick={() => setLimit(members.length)}>
      Показать всех · ещё {formatInt(members.length - limit)}</button>}
  </div>;
}
