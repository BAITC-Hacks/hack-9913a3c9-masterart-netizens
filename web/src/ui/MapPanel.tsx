import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {GraphIndex} from '../data/graph';
import type {Mode} from '../data/schema';
import type {Neighborhood} from '../data/neighborhood';
import {countLabel, formatInt, formatKzt, formatScore} from '../data/format';
import {CARD_H, CARD_W, layoutEgo, type PlacedCard} from '../map/egoLayout';
import {MapFrame, MapTools, MapViewport, useMapView} from '../map/MapFrame';
import {Icon} from '../map/icons';
import {Gid} from './Gid';
import {RoleTag} from './RoleGlyph';
import {Outline} from './Outline';

/**
 * Центр рабочего места: направленная окрестность выбранного счёта. Карточка соседа открывает его,
 * свёрнутая карточка ведёт в список, где видны все участники без исключения.
 */
export function MapPanel({index, hood, mode, onSelect}: {index: GraphIndex; hood: Neighborhood; mode: Mode; onSelect: (gid: string) => void}) {
  const focus = hood.focus;
  // Пояснение нужно только там, где денег в эту сторону нет совсем; встречный поток — тоже поток.
  const notes = useMemo(() => ({
    in: hood.mutual.length ? null : focus.is_seed ? 'Входящие исходного клиента из-за пределов выборки не собирались' : 'Входящих переводов в выборке нет',
    out: hood.mutual.length ? null : focus.observation.outgoing_censored ? 'Исходящие не наблюдаются: граница сбора данных' : 'Исходящих переводов в выборке нет',
  }), [focus, hood.mutual.length]);
  // Число колонок следует ширине окна, чтобы карточки оставались читаемыми без мелкого масштаба.
  const [viewportWidth, setViewportWidth] = useState(0);
  const columns = viewportWidth ? Math.max(2, Math.min(5, Math.floor((viewportWidth / 0.9 - 64) / (CARD_W + 24)))) : 4;
  const layout = useMemo(() => layoutEgo(hood, {notes, columns}), [hood, notes, columns]);
  const witness = mode === 'strict' ? focus.temporal.strict_witness : mode === 'same_day' ? focus.temporal.same_day_witness : null;
  const witnessPayer = witness?.hops.at(-1)?.src ?? null;
  const outlineTarget = useRef<string | null>(null);

  const view = useMapView({width: layout.width, height: layout.height, onEscape: () => false});
  useLayoutEffect(() => {
    const el = view.viewport.current;
    if (!el) return;
    // offsetWidth не зависит от появления полосы прокрутки, поэтому число колонок не «дрожит».
    setViewportWidth(el.offsetWidth);
    const observer = new ResizeObserver(() => setViewportWidth(el.offsetWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [view.viewport, view.mode]);
  useLayoutEffect(() => { view.focusMap({x: layout.focus.x, y: layout.focus.y, w: CARD_W, h: CARD_H}); }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (view.mode !== 'outline' || !outlineTarget.current) return;
    document.getElementById(outlineTarget.current)?.scrollIntoView({block: 'start'});
    outlineTarget.current = null;
  }, [view.mode]);

  const openFold = (side: string) => { outlineTarget.current = `wb-outline-${side}`; view.setMode('outline'); };
  const cycles = hood.cycles.length;

  return <MapFrame view={view} label="Связи счёта">
    <header className="wb-map__head">
      <p className="wb-map__title">
        <span>{countLabel(hood.payers.length + hood.mutual.length, 'плательщик', 'плательщика', 'плательщиков')}</span>
        <span>{countLabel(hood.recipients.length + hood.mutual.length, 'получатель', 'получателя', 'получателей')}</span>
        {cycles > 0 && <span className="wb-map__cycles"><Icon name="cycle" size={13} />{countLabel(cycles, 'возвратный поток', 'возвратных потока', 'возвратных потоков')}</span>}
      </p>
      <MapTools view={view} />
    </header>
    {view.mode === 'map'
      ? <MapViewport view={view} width={layout.width} height={layout.height} label="Карта: плательщики сверху, получатели снизу">
        <svg className="wb-map__edges" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            {(['plain', 'witness', 'cycle'] as const).map(kind => <marker key={kind} id={`wb-arrow-${kind}`} viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M1 1.4 8.8 5 1 8.6Z" className={`wb-arrowhead wb-arrowhead--${kind}`} /></marker>)}
          </defs>
          {layout.edges.map(edge => {
            const isWitness = witnessPayer !== null && edge.kind === 'in' && edge.src === witnessPayer;
            const kind = isWitness ? 'witness' : edge.cycle ? 'cycle' : 'plain';
            return <path key={edge.key} d={edge.d} className={`wb-edge wb-edge--${edge.kind}${edge.cycle ? ' is-cycle' : ''}${isWitness ? ' is-witness' : ''}`}
              strokeWidth={edge.width} markerEnd={`url(#wb-arrow-${kind})`} />;
          })}
        </svg>
        {layout.labels.map(label => <span key={label.key} className="wb-map__band" style={{left: label.x, top: label.y}}>{label.text}</span>)}
        {layout.cards.map(card => <MapCard key={card.key} card={card} index={index} witnessPayer={witnessPayer} onSelect={onSelect} onOpenFold={openFold} />)}
      </MapViewport>
      : <Outline index={index} hood={hood} onSelect={onSelect} />}
    <p className="wb-map__legend">
      <span><i className="wb-legend-line" />стрелка — направление денег, толщина — сумма</span>
      {cycles > 0 && <span><i className="wb-legend-line is-cycle" />возвратный поток</span>}
      {witness && <span><i className="wb-legend-line is-witness" />последний шаг пути по датам</span>}
    </p>
  </MapFrame>;
}

function MapCard({card, index, witnessPayer, onSelect, onOpenFold}: {
  card: PlacedCard; index: GraphIndex; witnessPayer: string | null; onSelect: (gid: string) => void; onOpenFold: (side: string) => void;
}) {
  const style = {left: card.x, top: card.y, width: CARD_W, height: CARD_H};
  if (card.kind === 'note') return <div className={`wb-card wb-card--note is-${card.note!.side}`} style={style}><p>{card.note!.text}</p></div>;
  if (card.kind === 'fold') {
    const fold = card.fold!;
    const noun: [string, string, string] = fold.side === 'in' ? ['плательщик', 'плательщика', 'плательщиков'] : fold.side === 'out' ? ['получатель', 'получателя', 'получателей'] : ['встречный', 'встречных', 'встречных'];
    return <button type="button" className="wb-card wb-card--fold" style={style} onClick={() => onOpenFold(fold.side)}>
      <strong>ещё {countLabel(fold.count, noun[0], noun[1], noun[2])}</strong>
      <span>{formatKzt(fold.kzt)}</span>
      <small>Показать всех в списке <Icon name="chevron" size={12} /></small>
    </button>;
  }
  const link = card.link!;
  const node = link.node;
  const isFocus = card.kind === 'focus';
  const m = node?.metrics;
  const edgeLine = card.kind === 'payer' ? link.toFocus : card.kind === 'recipient' ? link.fromFocus : null;
  const relation = edgeLine ? <><span className="wb-mono">{formatKzt(edgeLine.sum_kzt)}</span> · {countLabel(edgeLine.n_tx, 'перевод', 'перевода', 'переводов')}</>
    : card.kind === 'mutual' ? <><span className="wb-mono">↓ {formatKzt(link.toFocus!.sum_kzt)}</span> <span className="wb-mono">↑ {formatKzt(link.fromFocus!.sum_kzt)}</span></>
    : m ? <>{formatInt(m.in_degree)} вх. · {formatInt(m.out_degree)} исх.</> : null;
  const rank = index.topRank.get(link.gid);
  const flag = node?.observation.outgoing_censored ? 'граница выборки' : node?.is_seed ? 'исходный клиент'
    : m && m.in_degree + m.out_degree === 0 ? 'нет переводов' : rank ? `№ ${rank} в очереди` : null;
  const content = <>
    <span className="wb-card__role">{node ? <><RoleTag role={node.role} /><span className="wb-card__score">{formatScore(node.role_score)}</span></> : <span className="wb-card__missing">нет в списке узлов</span>}</span>
    <Gid gid={link.gid} className="wb-card__gid" />
    {relation && <span className="wb-card__relation">{relation}</span>}
    {flag && <span className="wb-card__flag">{flag}</span>}
  </>;
  const className = `wb-card wb-card--${card.kind}${link.gid === witnessPayer ? ' is-witness' : ''}`;
  if (isFocus) return <div className={className} style={style} aria-label={`Выбранный счёт ${link.gid}`}>{content}</div>;
  return <button type="button" className={className} style={style} onClick={() => onSelect(link.gid)} aria-label={`Открыть счёт ${link.gid}`}>{content}</button>;
}

