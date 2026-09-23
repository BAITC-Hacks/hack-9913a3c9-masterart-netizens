import {useEffect, useLayoutEffect, useMemo, useRef} from 'react';
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
  const notes = useMemo(() => ({
    in: focus.is_seed ? 'Входящие исходного клиента из-за пределов выборки не собирались' : 'Входящих переводов в выборке нет',
    out: focus.observation.outgoing_censored ? 'Исходящие не наблюдаются: граница сбора данных' : 'Исходящих переводов в выборке нет',
  }), [focus]);
  const layout = useMemo(() => layoutEgo(hood, {notes}), [hood, notes]);
  const witness = mode === 'strict' ? focus.temporal.strict_witness : mode === 'same_day' ? focus.temporal.same_day_witness : null;
  const witnessPayer = witness?.hops.at(-1)?.src ?? null;
  const outlineTarget = useRef<string | null>(null);

  const view = useMapView({width: layout.width, height: layout.height, onEscape: () => false});
  useLayoutEffect(() => { view.fitMap(); }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (view.mode !== 'outline' || !outlineTarget.current) return;
    document.getElementById(outlineTarget.current)?.scrollIntoView({block: 'start'});
    outlineTarget.current = null;
  }, [view.mode]);

  const openFold = (side: string) => { outlineTarget.current = `wb-outline-${side}`; view.setMode('outline'); };
  const cycles = hood.cycles.length;

  return <MapFrame view={view} label="Связи счёта">
    <header className="wb-map__head">
      <div className="wb-map__title">
        <h2>Направленные связи</h2>
        <p>{countLabel(hood.payers.length + hood.mutual.length, 'плательщик', 'плательщика', 'плательщиков')} · {countLabel(hood.recipients.length + hood.mutual.length, 'получатель', 'получателя', 'получателей')}
          {cycles > 0 && <> · <span className="wb-map__cycles"><Icon name="cycle" size={13} />{countLabel(cycles, 'возвратный поток', 'возвратных потока', 'возвратных потоков')}</span></>}</p>
      </div>
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
      <span><i className="wb-legend-line" />перевод, стрелка — направление денег</span>
      <span><i className="wb-legend-line is-cycle" />возвратный поток</span>
      {witness && <span><i className="wb-legend-line is-witness" />последний шаг датированного пути</span>}
      <span>толщина — сумма</span>
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
  const relation = card.kind === 'payer' ? `заплатил ${formatKzt(link.toFocus!.sum_kzt)} · ${formatInt(link.toFocus!.n_tx)} пер.`
    : card.kind === 'recipient' ? `получил ${formatKzt(link.fromFocus!.sum_kzt)} · ${formatInt(link.fromFocus!.n_tx)} пер.`
    : card.kind === 'mutual' ? `↓ ${formatKzt(link.toFocus!.sum_kzt)} · ↑ ${formatKzt(link.fromFocus!.sum_kzt)}`
    : m ? `${formatInt(m.in_degree)} вх. · ${formatInt(m.out_degree)} исх. · приоритет ${formatScore(node!.priority_score)}` : '';
  const badges = [
    node?.is_seed && 'исходный клиент',
    node?.observation.outgoing_censored && 'граница выборки',
    m && m.in_degree + m.out_degree === 0 && 'нет переводов',
    index.topRank.has(link.gid) && `№ ${index.topRank.get(link.gid)} в очереди`,
  ].filter(Boolean) as string[];
  const content = <>
    <span className="wb-card__role">{node ? <RoleTag role={node.role} score={formatScore(node.role_score)} /> : <span className="wb-card__missing">нет в списке узлов</span>}</span>
    <Gid gid={link.gid} className="wb-card__gid" />
    <span className="wb-card__relation">{relation}</span>
    {badges.length > 0 && <span className="wb-card__badges">{badges.slice(0, 2).map(badge => <em key={badge}>{badge}</em>)}</span>}
  </>;
  const className = `wb-card wb-card--${card.kind}${link.gid === witnessPayer ? ' is-witness' : ''}`;
  if (isFocus) return <div className={className} style={style} aria-label={`Выбранный счёт ${link.gid}`}><span className="wb-card__eyebrow">выбранный счёт</span>{content}</div>;
  return <button type="button" className={className} style={style} onClick={() => onSelect(link.gid)} aria-label={`Открыть счёт ${link.gid}`}>{content}</button>;
}

export {CARD_H};
