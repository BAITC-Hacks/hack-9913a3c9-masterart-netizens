import type {GraphIndex} from '../data/graph';
import type {RailTab} from '../app/Workbench';
import {countLabel, formatKzt, formatScore} from '../data/format';
import {SearchBox} from './SearchBox';
import {Gid} from './Gid';
import {RoleTag} from './RoleGlyph';
import {Icon} from '../map/icons';

/** Левая колонка: поиск, очередь проверки (top_nodes) и кластеры. Списки — обычные кнопки для клавиатуры. */
export function LeadsRail({index, selected, tab, onTab, onSelect, openCluster, onOpenCluster, notice, onDismissNotice}: {
  index: GraphIndex; selected: string | null; tab: RailTab; onTab: (tab: RailTab) => void; onSelect: (gid: string) => void;
  openCluster: number | null; onOpenCluster: (id: number) => void; notice: string | null; onDismissNotice: () => void;
}) {
  const {top_nodes, clusters} = index.analysis;
  const orderedClusters = [...clusters].sort((a, b) => b.n_nodes - a.n_nodes || a.cluster_id - b.cluster_id);
  return <nav className="wb-rail" aria-label="Очередь и кластеры">
    <SearchBox index={index} onSelect={onSelect} />
    {notice && <p className="wb-notice" role="alert"><Icon name="alert" size={15} /><span>{notice}</span>
      <button type="button" className="wb-notice__close" aria-label="Скрыть сообщение" onClick={onDismissNotice}><Icon name="close" size={14} /></button></p>}
    <div className="wb-segmented" role="tablist" aria-label="Список">
      <button type="button" role="tab" aria-selected={tab === 'leads'} className={tab === 'leads' ? 'is-active' : undefined} onClick={() => onTab('leads')}>
        Очередь <span className="wb-count">{top_nodes.length}</span></button>
      <button type="button" role="tab" aria-selected={tab === 'clusters'} className={tab === 'clusters' ? 'is-active' : undefined} onClick={() => onTab('clusters')}>
        Кластеры <span className="wb-count">{clusters.length}</span></button>
    </div>
    {tab === 'leads'
      ? <ol className="wb-leads" aria-label="Очередь проверки по приоритету">
        {top_nodes.map(top => <li key={`${top.rank}-${top.gid}`}>
          <button type="button" className={`wb-lead${top.gid === selected ? ' is-selected' : ''}`} aria-current={top.gid === selected ? 'true' : undefined} onClick={() => onSelect(top.gid)}>
            <span className="wb-lead__rank">{top.rank}</span>
            <span className="wb-lead__body">
              <span className="wb-lead__head"><RoleTag role={top.role} /><span className="wb-lead__score" title="Оценка приоритета проверки">{formatScore(top.priority_score)}</span></span>
              <Gid gid={top.gid} className="wb-lead__gid" />
              <span className="wb-lead__why">{top.why}</span>
            </span>
          </button>
        </li>)}
      </ol>
      : <ul className="wb-clusters" aria-label="Кластеры">
        {orderedClusters.map(cluster => <li key={cluster.cluster_id}>
          <button type="button" className={`wb-cluster${cluster.cluster_id === openCluster ? ' is-selected' : ''}`} aria-current={cluster.cluster_id === openCluster ? 'true' : undefined} onClick={() => onOpenCluster(cluster.cluster_id)}>
            <span className="wb-cluster__head"><strong>Кластер {cluster.cluster_id}</strong>
              <span>{countLabel(cluster.n_nodes, 'счёт', 'счёта', 'счетов')} · исходных {cluster.n_seed}</span></span>
            <span className="wb-cluster__sum">внутри {formatKzt(cluster.sum_kzt_internal)}</span>
            <span className="wb-cluster__hypothesis">{cluster.hypothesis}</span>
          </button>
        </li>)}
      </ul>}
  </nav>;
}
