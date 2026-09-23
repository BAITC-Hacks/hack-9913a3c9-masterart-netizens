import {useCallback, useEffect, useMemo, useState} from 'react';
import type {GraphIndex} from '../data/graph';
import type {Mode} from '../data/schema';
import {compileNeighborhood} from '../data/neighborhood';
import {countLabel} from '../data/format';
import {readHash} from './hash';
import {useAccountHistory, type AccountEntry} from './useAccountHistory';
import {TopBar} from '../ui/TopBar';
import {LeadsRail} from '../ui/LeadsRail';
import {MapPanel} from '../ui/MapPanel';
import {EvidencePanel} from '../ui/EvidencePanel';
import {ClusterPanel} from '../ui/ClusterPanel';

/**
 * Рабочее место: очередь и кластеры слева, направленная окрестность счёта в центре, основания справа.
 * Выбор счёта, режим дат и открытый кластер — единственное состояние; всё остальное выводится из файла.
 */
export type RailTab = 'leads' | 'clusters';

const unknownGid = (gid: string, index: GraphIndex) => `Счёт ${gid} из ссылки не найден среди ${countLabel(index.byGid.size, 'счёта', 'счетов', 'счетов')} выборки.`;

function initialState(index: GraphIndex) {
  const hash = readHash();
  const fallback = index.analysis.top_nodes.find(top => index.byGid.has(top.gid))?.gid ?? index.gids[0] ?? null;
  if (hash.gid && !index.byGid.has(hash.gid)) return {gid: fallback, mode: hash.mode, notice: unknownGid(hash.gid, index)};
  return {gid: hash.gid ?? fallback, mode: hash.mode, notice: null as string | null};
}

export function Workbench({index, warnings}: {index: GraphIndex; warnings: string[]}) {
  const initial = useMemo(() => initialState(index), [index]);
  const [selected, setSelected] = useState<string | null>(initial.gid);
  const [mode, setModeState] = useState<Mode>(initial.mode);
  const [notice, setNotice] = useState<string | null>(initial.notice);
  const [cluster, setCluster] = useState<number | null>(null);
  const [railTab, setRailTab] = useState<RailTab>('leads');

  const applyEntry = useCallback((entry: AccountEntry) => {
    setModeState(entry.mode);
    if (!entry.gid) return;
    if (index.byGid.has(entry.gid)) { setSelected(entry.gid); setNotice(null); setCluster(null); }
    else setNotice(unknownGid(entry.gid, index));
  }, [index]);
  const history = useAccountHistory(applyEntry);

  useEffect(() => { history.replace({gid: selected, mode}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const select = useCallback((gid: string) => {
    if (!index.byGid.has(gid)) { setNotice(unknownGid(gid, index)); return; }
    setCluster(null); setNotice(null);
    if (gid === selected) return;
    setSelected(gid);
    history.push({gid, mode});
  }, [index, mode, selected, history]);

  const setMode = useCallback((next: Mode) => { setModeState(next); history.replace({gid: selected, mode: next}); }, [selected, history]);

  const hood = useMemo(() => (selected ? compileNeighborhood(index, selected) : null), [index, selected]);
  const openCluster = useCallback((id: number) => { setCluster(id); setRailTab('clusters'); }, []);

  return <div className="wb-app">
    <TopBar index={index} warnings={warnings} onSelect={select} notice={notice} onDismissNotice={() => setNotice(null)} />
    <div className="wb-main">
      <LeadsRail index={index} selected={selected} tab={railTab} onTab={setRailTab} onSelect={select} openCluster={cluster} onOpenCluster={openCluster} />
      <section className="wb-center" aria-label={cluster !== null ? 'Кластер' : 'Связи счёта'}>
        {cluster !== null
          ? <ClusterPanel key={cluster} index={index} clusterId={cluster} selected={selected} onSelect={select} onClose={() => setCluster(null)} />
          : hood
            ? <MapPanel index={index} hood={hood} mode={mode} onSelect={select} history={history} />
            : <p className="wb-empty">Выберите счёт в очереди или найдите его по gid.</p>}
      </section>
      {selected && hood
        ? <EvidencePanel key={selected} index={index} hood={hood} mode={mode} onMode={setMode} onSelect={select} onOpenCluster={openCluster} openCluster={cluster} />
        : <aside className="wb-inspector" aria-label="Основания" />}
    </div>
  </div>;
}
