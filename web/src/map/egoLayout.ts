import {foldSide, type Neighborhood, type NeighborLink} from '../data/neighborhood';

/**
 * Геометрия окрестности: плательщики над счётом, получатели под ним, встречные потоки по бокам.
 * Слои задаются направлением относительно фокуса, а не «глубиной» графа, поэтому циклы не ломают
 * раскладку. Каждая сторона сворачивается после cap карточек в одну карточку «ещё N · сумма».
 * Размер карточки и изгиб связей взяты из Command Center (projectDagIslands.ts, ревизия 77e1b9b0).
 */
export const CARD_W = 224;
export const CARD_H = 118;
const GAP_X = 24, GAP_Y = 22, BAND_GAP = 104, SIDE_GAP = 76, MARGIN = 44, LABEL = 30;

export type CardKind = 'focus' | 'payer' | 'recipient' | 'mutual' | 'fold' | 'note';
export type Side = 'in' | 'out' | 'mutual';
export interface PlacedCard {
  key: string; kind: CardKind; x: number; y: number;
  link?: NeighborLink; side?: Side;
  fold?: {side: Side; count: number; kzt: number};
  note?: {side: 'in' | 'out'; text: string};
}
export interface PlacedEdge {
  key: string; d: string; kind: 'in' | 'out' | 'mutual-in' | 'mutual-out' | 'inner' | 'fold';
  width: number; src: string; dst: string; cycle: boolean;
}
export interface BandLabel { key: string; x: number; y: number; text: string }
export interface EgoLayout {
  width: number; height: number; focus: PlacedCard;
  cards: PlacedCard[]; edges: PlacedEdge[]; labels: BandLabel[];
}

const rowWidth = (n: number) => n * CARD_W + Math.max(0, n - 1) * GAP_X;
const chunk = <T,>(items: T[], size: number) => Array.from({length: Math.ceil(items.length / size)}, (_, i) => items.slice(i * size, i * size + size));
const amount = (link: NeighborLink) => (link.toFocus?.sum_kzt ?? 0) + (link.fromFocus?.sum_kzt ?? 0);

export interface EgoOptions { cap?: number; columns?: number; notes?: {in: string | null; out: string | null} }

export function layoutEgo(hood: Neighborhood, {cap = 10, columns = 5, notes = {in: null, out: null}}: EgoOptions = {}): EgoLayout {
  const payers = foldSide(hood.payers, cap);
  const recipients = foldSide(hood.recipients, cap);
  const mutual = foldSide(hood.mutual, 4);

  type Cell = Omit<PlacedCard, 'x' | 'y'>;
  const sideCells = (side: 'in' | 'out', folded: ReturnType<typeof foldSide>, note: string | null): Cell[] => {
    const cells: Cell[] = folded.visible.map(link => ({key: `${side}-${link.gid}`, kind: side === 'in' ? 'payer' : 'recipient', link, side}));
    if (folded.hidden.length) cells.push({key: `fold-${side}`, kind: 'fold', fold: {side, count: folded.hidden.length, kzt: folded.hiddenKzt}});
    if (!cells.length && note) cells.push({key: `note-${side}`, kind: 'note', note: {side, text: note}});
    return cells;
  };
  const payerRows = chunk(sideCells('in', payers, notes.in), columns);
  const recipientRows = chunk(sideCells('out', recipients, notes.out), columns);

  const left: Cell[] = [], right: Cell[] = [];
  mutual.visible.forEach((link, i) => (i % 2 === 0 ? right : left).push({key: `mutual-${link.gid}`, kind: 'mutual', link, side: 'mutual'}));
  if (mutual.hidden.length) right.push({key: 'fold-mutual', kind: 'fold', fold: {side: 'mutual', count: mutual.hidden.length, kzt: mutual.hiddenKzt}});
  const sideSpan = (cells: Cell[]) => cells.length * CARD_W + cells.length * SIDE_GAP;
  const focusHalf = CARD_W / 2 + Math.max(sideSpan(left), sideSpan(right));

  const widest = Math.max(...payerRows.map(r => rowWidth(r.length)), ...recipientRows.map(r => rowWidth(r.length)), focusHalf * 2, CARD_W * 2);
  const width = widest + MARGIN * 2;
  const centerX = width / 2;

  const cards: PlacedCard[] = [];
  const labels: BandLabel[] = [];
  let y = MARGIN;
  const placeRows = (rows: Cell[][]) => {
    for (const row of rows) {
      const x0 = centerX - rowWidth(row.length) / 2;
      row.forEach((cell, i) => cards.push({...cell, x: x0 + i * (CARD_W + GAP_X), y}));
      y += CARD_H + GAP_Y;
    }
    if (rows.length) y -= GAP_Y;
  };

  if (payerRows.length) {
    labels.push({key: 'label-in', x: centerX, y: y + 4, text: hood.payers.length ? `Платили этому счёту` : 'Входящие'});
    y += LABEL;
    placeRows(payerRows);
    y += BAND_GAP;
  }
  const focus: PlacedCard = {key: 'focus', kind: 'focus', x: centerX - CARD_W / 2, y, link: {gid: hood.focus.gid, node: hood.focus, toFocus: null, fromFocus: null}};
  cards.push(focus);
  right.forEach((cell, i) => cards.push({...cell, x: focus.x + CARD_W + SIDE_GAP + i * (CARD_W + SIDE_GAP), y}));
  left.forEach((cell, i) => cards.push({...cell, x: focus.x - (i + 1) * (CARD_W + SIDE_GAP), y}));
  if (left.length || right.length) labels.push({key: 'label-mutual', x: centerX, y: y - 22, text: 'Встречные потоки'});
  y += CARD_H;
  if (recipientRows.length) {
    y += BAND_GAP;
    labels.push({key: 'label-out', x: centerX, y: y + 4, text: hood.recipients.length ? `Получали от этого счёта` : 'Исходящие'});
    y += LABEL;
    placeRows(recipientRows);
  }
  const height = y + MARGIN;

  // Связи
  const maxKzt = Math.max(1, ...[...hood.payers, ...hood.recipients, ...hood.mutual].map(amount));
  const stroke = (kzt: number) => 1 + 2.4 * (Math.log1p(kzt) / Math.log1p(maxKzt));
  const edges: PlacedEdge[] = [];
  const spread = (i: number, n: number) => focus.x + CARD_W * (n === 1 ? 0.5 : 0.2 + (0.6 * i) / (n - 1));
  const vertical = (sx: number, sy: number, tx: number, cardEdge: number) => {
    const ty = cardEdge + (cardEdge >= sy ? -ARROW_GAP : ARROW_GAP);
    const bend = Math.max(28, Math.abs(ty - sy) * 0.5) * (ty >= sy ? 1 : -1);
    return `M ${sx} ${sy} C ${sx} ${sy + bend}, ${tx} ${ty - bend}, ${tx} ${ty}`;
  };
  const top = cards.filter(card => card.kind === 'payer' || (card.kind === 'fold' && card.fold?.side === 'in')).sort((a, b) => a.x - b.x || a.y - b.y);
  top.forEach((card, i) => {
    const d = vertical(card.x + CARD_W / 2, card.y + CARD_H, spread(i, top.length), focus.y);
    const kzt = card.link ? amount(card.link) : card.fold!.kzt;
    edges.push({key: `e-${card.key}`, d, kind: card.kind === 'fold' ? 'fold' : 'in', width: stroke(kzt), src: card.link?.gid ?? card.key, dst: hood.focus.gid, cycle: false});
  });
  const bottom = cards.filter(card => card.kind === 'recipient' || (card.kind === 'fold' && card.fold?.side === 'out')).sort((a, b) => a.x - b.x || a.y - b.y);
  bottom.forEach((card, i) => {
    const d = vertical(spread(i, bottom.length), focus.y + CARD_H, card.x + CARD_W / 2, card.y);
    const kzt = card.link ? amount(card.link) : card.fold!.kzt;
    edges.push({key: `e-${card.key}`, d, kind: card.kind === 'fold' ? 'fold' : 'out', width: stroke(kzt), src: hood.focus.gid, dst: card.link?.gid ?? card.key, cycle: false});
  });
  for (const card of cards.filter(c => c.kind === 'mutual' || (c.kind === 'fold' && c.fold?.side === 'mutual'))) {
    const onRight = card.x > focus.x;
    const level = Math.round(Math.abs(card.x - focus.x) / (CARD_W + SIDE_GAP));
    const fx = onRight ? focus.x + CARD_W : focus.x, mx = onRight ? card.x : card.x + CARD_W;
    const lift = level > 1 ? 46 + 18 * level : 16;
    const upper = focus.y + 34, lower = focus.y + CARD_H - 34;
    if (card.fold) {
      edges.push({key: `e-${card.key}`, d: `M ${fx} ${upper} C ${fx} ${focus.y - lift}, ${mx} ${focus.y - lift}, ${mx} ${upper}`, kind: 'fold', width: stroke(card.fold.kzt), src: hood.focus.gid, dst: card.key, cycle: true});
      continue;
    }
    const link = card.link!;
    const mxEnd = mx + (onRight ? -ARROW_GAP : ARROW_GAP), fxEnd = fx + (onRight ? ARROW_GAP : -ARROW_GAP);
    edges.push({key: `out-${card.key}`, d: `M ${fx} ${upper} C ${(fx + mx) / 2} ${upper - lift}, ${(fx + mx) / 2} ${upper - lift}, ${mxEnd} ${upper}`,
      kind: 'mutual-out', width: stroke(link.fromFocus?.sum_kzt ?? 0), src: hood.focus.gid, dst: link.gid, cycle: true});
    edges.push({key: `in-${card.key}`, d: `M ${mx} ${lower} C ${(fx + mx) / 2} ${lower + lift}, ${(fx + mx) / 2} ${lower + lift}, ${fxEnd} ${lower}`,
      kind: 'mutual-in', width: stroke(link.toFocus?.sum_kzt ?? 0), src: link.gid, dst: hood.focus.gid, cycle: true});
  }

  // Переводы между видимыми соседями; замыкающие цикл через фокус помечаются.
  const placed = new Map(cards.filter(card => card.link && card.kind !== 'focus').map(card => [card.link!.gid, card]));
  const sendsToFocus = new Set([...hood.payers, ...hood.mutual].map(link => link.gid));
  const receivesFromFocus = new Set([...hood.recipients, ...hood.mutual].map(link => link.gid));
  for (const edge of hood.innerEdges) {
    const a = placed.get(edge.src), b = placed.get(edge.dst);
    if (!a || !b) continue;
    edges.push({key: `inner-${edge.src}-${edge.dst}`, d: cardToCard(a, b), kind: 'inner', width: 1.1,
      src: edge.src, dst: edge.dst, cycle: receivesFromFocus.has(edge.src) && sendsToFocus.has(edge.dst)});
  }
  return {width, height, focus, cards, edges, labels};
}

/** Зазор между остриём стрелки и рамкой карточки, px: направление видно, стрелка не упирается в край. */
export const ARROW_GAP = 5;

/** Связь между двумя карточками: вбок внутри ряда, иначе от края до края (как в Command Center). */
export function cardToCard(a: {x: number; y: number}, b: {x: number; y: number}): string {
  if (Math.abs(a.y - b.y) < 30 && Math.abs(a.x - b.x) > CARD_W) {
    const right = b.x > a.x, x = a.x + (right ? CARD_W : 0), end = b.x + (right ? -ARROW_GAP : CARD_W + ARROW_GAP), y = a.y + CARD_H / 2, ey = b.y + CARD_H / 2;
    const bend = (end - x) / 2;
    return `M ${x} ${y} C ${x + bend} ${y}, ${end - bend} ${ey}, ${end} ${ey}`;
  }
  const down = b.y >= a.y, x = a.x + CARD_W / 2, y = a.y + (down ? CARD_H : 0), end = b.y + (down ? -ARROW_GAP : CARD_H + ARROW_GAP);
  const bend = (down ? 1 : -1) * Math.min(80, Math.max(24, Math.abs(end - y) / 2));
  return `M ${x} ${y} C ${x} ${y + bend}, ${b.x + CARD_W / 2} ${end - bend}, ${b.x + CARD_W / 2} ${end}`;
}
