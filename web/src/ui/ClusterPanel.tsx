import {useLayoutEffect, useMemo, useState} from 'react';
import type {GraphIndex} from '../data/graph';
import {countLabel, formatInt, formatKzt, formatScore, roleLabel} from '../data/format';
import {CLUSTER_CARD_H, CLUSTER_CARD_W, layoutCluster} from '../map/clusterLayout';
import {MapFrame, MapTools, MapViewport, useMapView} from '../map/MapFrame';
import {Gid} from './Gid';
import {RoleGlyph, RoleTag} from './RoleGlyph';
import {Icon} from '../map/icons';
import {CompactKzt} from './Amount';

/**
 * Обзор кластера: гипотеза о структуре, фильтр по ролям и два вида одного набора — карта по шагам
 * от исходных клиентов и полный список по приоритету. Фильтр общий для обоих видов; на карте не больше
 * MAP_CAP карточек, все участники всегда доступны в списке. Панель создаётся заново для каждого кластера,
 * поэтому фильтр сбрасывается при смене кластера.
 */
const PAGE = 120;
const MAP_CAP = 160;

export function ClusterPanel({index, clusterId, selected, onSelect, onClose}: {
  index: GraphIndex; clusterId: number; selected: string | null; onSelect: (gid: string) => void; onClose: () => void;
}) {
  const cluster = index.clusters.get(clusterId);
  const members = index.clusterMembers.get(clusterId) ?? [];
  const [role, setRole] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const roles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of members) counts.set(node.role, (counts.get(node.role) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [members]);
  const shown = useMemo(() => (role ? members.filter(node => node.role === role) : members), [members, role]);

  const [viewportWidth, setViewportWidth] = useState(0);
  const columns = viewportWidth ? Math.max(2, Math.min(8, Math.floor((viewportWidth / 0.85 - 60) / (CLUSTER_CARD_W + 20)))) : 5;
  const layout = useMemo(() => layoutCluster(shown, index.outgoing, {cap: MAP_CAP, columns}), [shown, index.outgoing, columns]);
  const view = useMapView({width: layout.width, height: layout.height, onEscape: () => false});
  useLayoutEffect(() => {
    const el = view.viewport.current;
    if (!el) return;
    setViewportWidth(el.offsetWidth);
    const observer = new ResizeObserver(() => setViewportWidth(el.offsetWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [view.viewport, view.mode]);
  useLayoutEffect(() => { if (view.mode === 'map') view.focusMap({x: layout.width / 2 - 1, y: 0, w: 2, h: 0}); }, [layout, view.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="wb-clusterview">
    <header className="wb-clusterview__head">
      <button type="button" className="wb-button wb-button--quiet" onClick={onClose}><Icon name="back" size={15} />К связям счёта</button>
      <h2 className="wb-clusterview__title">Кластер {clusterId}</h2>
      {cluster ? <>
        <p className="wb-cluster-summary">{countLabel(cluster.n_nodes, 'счёт', 'счёта', 'счетов')} · {countLabel(cluster.n_seed, 'исходный клиент', 'исходных клиента', 'исходных клиентов')} · оборот внутри <CompactKzt value={cluster.sum_kzt_internal} /></p>
        <p className="wb-cluster-caveat">Наблюдаемая структура переводов, а не вывод о связи владельцев.</p>
      </> : <p className="wb-muted">Описание кластера в файле отсутствует.</p>}
      <div className="wb-role-filter" role="group" aria-label="Фильтр по ролям">
        <button type="button" aria-pressed={role === null} className={role === null ? 'is-active' : undefined} onClick={() => setRole(null)}>
          Все<strong>{formatInt(members.length)}</strong></button>
        {roles.map(([name, n]) => <button key={name} type="button" aria-pressed={role === name} className={`wb-role--${name}${role === name ? ' is-active' : ''}`}
          onClick={() => setRole(role === name ? null : name)}><RoleGlyph role={name} /><span>{roleLabel(name)}</span><strong>{formatInt(n)}</strong></button>)}
      </div>
      <p className="wb-role-filter__count" aria-live="polite">{role
        ? <>В фильтре {formatInt(shown.length)} из {formatInt(members.length)} · <button type="button" className="wb-linklike wb-reset" onClick={() => setRole(null)}>сбросить фильтр</button></>
        : null}</p>
      {cluster && <details className="wb-disclosure wb-cluster-about">
        <summary>О кластере</summary>
        <p className="wb-hypothesis">{cluster.hypothesis}</p>
        <dl className="wb-cluster-exact">
          <div><dt>Счетов</dt><dd>{formatInt(cluster.n_nodes)}</dd></div>
          <div><dt>Исходных клиентов</dt><dd>{formatInt(cluster.n_seed)}</dd></div>
          <div><dt>Оборот внутри, точно</dt><dd>{formatKzt(cluster.sum_kzt_internal)}</dd></div>
        </dl>
        {cluster.top_gids.length > 0 && <>
          <p className="wb-cluster-keys__title">Ключевые счета по расчёту конвейера</p>
          <ul className="wb-cluster-keys">{cluster.top_gids.map(gid => <li key={gid}>
            <button type="button" className="wb-linklike" onClick={() => onSelect(gid)} aria-label={`Открыть счёт ${gid}`}><Gid gid={gid} /></button></li>)}</ul>
        </>}
      </details>}
      {selected && !members.some(node => node.gid === selected) && members[0] && <p className="wb-context" role="note">
        <Icon name="link" size={15} />
        <span>Справа — счёт из другого кластера. Нажмите участника этого кластера или <button type="button" className="wb-linklike wb-reset" onClick={() => onSelect(members[0]!.gid)}>откройте первого по приоритету</button>.</span>
      </p>}
    </header>

    <MapFrame view={view} label={`Кластер ${clusterId}`}>
      <header className="wb-map__head">
        <p className="wb-map__title">{view.mode === 'map' && layout.hidden > 0
          ? <span>На карте {formatInt(layout.cards.length)} из {formatInt(shown.length)} — с наибольшим приоритетом · <button type="button" className="wb-linklike wb-reset" onClick={() => view.setMode('outline')}>все в списке</button></span>
          : <span>{view.mode === 'map' ? 'Ряды — шаги от исходных клиентов' : 'По приоритету проверки'}</span>}
          {view.mode === 'map' && (role || layout.hidden > 0) && <span className="wb-map__note">Связи со счетами вне карты не показаны.</span>}</p>
        <MapTools view={view} />
      </header>
      {view.mode === 'map'
        ? <MapViewport view={view} width={layout.width} height={layout.height} label="Карта кластера по шагам от исходных клиентов">
          <svg className="wb-map__edges" width={layout.width} height={layout.height} aria-hidden="true">
            <defs><marker id="wb-arrow-cluster" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M1 1.4 8.8 5 1 8.6Z" className="wb-arrowhead wb-arrowhead--plain" /></marker></defs>
            {layout.edges.map(edge => <path key={edge.key} d={edge.d} className={`wb-edge wb-edge--cluster${edge.src === selected || edge.dst === selected ? ' is-witness' : ''}`} markerEnd="url(#wb-arrow-cluster)" />)}
          </svg>
          {layout.bands.map(band => <span key={band.depth} className="wb-map__band wb-map__band--left" style={{left: 40, top: band.y + 4}}>
            {band.depth === 0 ? 'Исходные клиенты' : `Шаг ${band.depth}`} · {formatInt(band.count)}</span>)}
          {layout.cards.map(card => <button key={card.gid} type="button" className={`wb-card wb-card--compact${card.gid === selected ? ' wb-card--focus' : ''}`}
            style={{left: card.x, top: card.y, width: CLUSTER_CARD_W, height: CLUSTER_CARD_H}} onClick={() => onSelect(card.gid)}
            aria-label={`Открыть: счёт ${card.gid}, ${roleLabel(card.node.role)}, приоритет ${formatScore(card.node.priority_score)}`}>
            <span className="wb-card__role"><RoleTag role={card.node.role} /></span>
            <Gid gid={card.gid} className="wb-card__gid" />
            <span className="wb-card__meta"><span>приоритет <span className="wb-mono">{formatScore(card.node.priority_score)}</span></span>
              {(card.node.is_seed || card.node.observation.outgoing_censored) && <span>{card.node.observation.outgoing_censored ? 'граница выборки' : 'исходный клиент'}</span>}</span>
          </button>)}
        </MapViewport>
        : <div className="wb-outline">
          <table className="wb-table wb-table--members">
            <caption className="wb-visually-hidden">Участники кластера по приоритету проверки</caption>
            <thead><tr><th scope="col">Счёт</th><th scope="col">Роль</th><th scope="col" className="is-num">Приоритет</th><th scope="col" className="is-num">Вх.</th><th scope="col" className="is-num">Исх.</th><th scope="col" className="is-num">Получено</th><th scope="col" className="is-num">Отправлено</th></tr></thead>
            <tbody>{shown.slice(0, limit).map(node => <tr key={node.gid} className={node.gid === selected ? 'is-selected' : undefined}>
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
          {shown.length > limit && <button type="button" className="wb-button wb-button--quiet wb-more" onClick={() => setLimit(shown.length)}>
            Показать всех · ещё {formatInt(shown.length - limit)}</button>}
        </div>}
    </MapFrame>
  </div>;
}
