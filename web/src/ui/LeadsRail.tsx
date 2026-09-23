import type {GraphIndex} from '../data/graph';
import type {RailTab} from '../app/Workbench';
import {countLabel, formatScore, roleLabel} from '../data/format';
import {Gid} from './Gid';
import {RoleGlyph} from './RoleGlyph';
import {CompactKzt} from './Amount';

/**
 * Очередь проверки и кластеры. Строка — две линии: номер, знак роли, gid и приоритет; ниже — одна
 * причина. Полный текст причины — в подсказке и в панели оснований справа.
 */
export function LeadsRail({index, selected, tab, onTab, onSelect, openCluster, onOpenCluster}: {
  index: GraphIndex; selected: string | null; tab: RailTab; onTab: (tab: RailTab) => void; onSelect: (gid: string) => void;
  openCluster: number | null; onOpenCluster: (id: number) => void;
}) {
  const {top_nodes, clusters} = index.analysis;
  const orderedClusters = [...clusters].sort((a, b) => b.n_nodes - a.n_nodes || a.cluster_id - b.cluster_id);
  return <nav className="wb-rail" aria-label="Очередь и кластеры">
    <div className="wb-rail__head"><div className="wb-segmented wb-rail__tabs" role="tablist" aria-label="Список">
      <button type="button" role="tab" aria-selected={tab === 'leads'} className={tab === 'leads' ? 'is-active' : undefined} onClick={() => onTab('leads')}>
        Очередь <span className="wb-count">{top_nodes.length}</span></button>
      <button type="button" role="tab" aria-selected={tab === 'clusters'} className={tab === 'clusters' ? 'is-active' : undefined} onClick={() => onTab('clusters')}>
        Кластеры <span className="wb-count">{clusters.length}</span></button>
    </div></div>
    {tab === 'leads'
      ? <ol className="wb-leads" aria-label="Очередь проверки по приоритету">
        {top_nodes.map(top => <li key={`${top.rank}-${top.gid}`}>
          <button type="button" className={`wb-lead${top.gid === selected ? ' is-selected' : ''}`} aria-current={top.gid === selected ? 'true' : undefined}
            title={top.why} onClick={() => onSelect(top.gid)}>
            <span className="wb-lead__rank"><span className="wb-visually-hidden">№ </span>{top.rank}</span>
            <span className={`wb-lead__glyph wb-role--${top.role}`}><RoleGlyph role={top.role} /><span className="wb-visually-hidden">{roleLabel(top.role)}, счёт</span></span>
            <Gid gid={top.gid} className="wb-lead__gid" />
            <span className="wb-lead__score"><span className="wb-visually-hidden">приоритет </span>{formatScore(top.priority_score)}</span>
            <span className="wb-lead__why">{top.why}</span>
          </button>
        </li>)}
      </ol>
      : <ul className="wb-clusters" aria-label="Кластеры">
        {orderedClusters.map(cluster => <li key={cluster.cluster_id}>
          <button type="button" className={`wb-cluster${cluster.cluster_id === openCluster ? ' is-selected' : ''}`} aria-current={cluster.cluster_id === openCluster ? 'true' : undefined}
            title={cluster.hypothesis} onClick={() => onOpenCluster(cluster.cluster_id)}>
            <span className="wb-cluster__head"><strong>Кластер {cluster.cluster_id}</strong>
              <span>{countLabel(cluster.n_nodes, 'счёт', 'счёта', 'счетов')}{cluster.n_seed > 0 && ` · исходных ${cluster.n_seed}`}</span></span>
            <span className="wb-cluster__meta">{cluster.sum_kzt_internal > 0 ? <>оборот внутри <CompactKzt value={cluster.sum_kzt_internal} /></> : 'переводов внутри нет'}</span>
          </button>
        </li>)}
      </ul>}
  </nav>;
}
