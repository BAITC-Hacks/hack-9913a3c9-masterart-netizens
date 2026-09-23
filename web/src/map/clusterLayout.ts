import type {AccountNode, Edge} from '../data/schema';
import {compareGids} from '../data/graph';

/**
 * Карта кластера: ряды — шаги от исходных клиентов (depth), внутри ряда карточка встаёт под теми, кто ей
 * платил, остальное решает приоритет. Правило размещения перенесено из Command Center
 * (placeIslandMembers в projectDagIslands.ts, ревизия 77e1b9b0); карточки здесь компактнее.
 * Карта ограничена cap карточками по приоритету; остальные участники доступны в списке.
 */
export const CLUSTER_CARD_W = 196;
export const CLUSTER_CARD_H = 84;
const GAP_X = 20, ROW_GAP = 18, BAND_GAP = 56, MARGIN = 40, LABEL = 28;

export interface ClusterCard { gid: string; node: AccountNode; x: number; y: number }
export interface ClusterBand { depth: number; y: number; count: number }
export interface ClusterLayout {
  width: number; height: number; cards: ClusterCard[]; bands: ClusterBand[];
  edges: {key: string; d: string; src: string; dst: string}[];
  hidden: number;
}

export function layoutCluster(members: readonly AccountNode[], outgoing: ReadonlyMap<string, readonly Edge[]>, {cap = 160, columns = 8} = {}): ClusterLayout {
  const ranked = [...members].sort((a, b) => b.priority_score - a.priority_score || compareGids(a.gid, b.gid));
  const shown = ranked.slice(0, cap);
  const visible = new Set(shown.map(node => node.gid));
  const payersOf = new Map<string, string[]>();
  for (const node of shown) for (const edge of outgoing.get(node.gid) ?? []) {
    if (visible.has(edge.dst) && edge.dst !== node.gid) (payersOf.get(edge.dst) ?? payersOf.set(edge.dst, []).get(edge.dst)!).push(node.gid);
  }
  const rows = new Map<number, AccountNode[]>();
  for (const node of shown) (rows.get(node.depth) ?? rows.set(node.depth, []).get(node.depth)!).push(node);
  const widest = Math.min(columns, Math.max(1, ...[...rows.values()].map(row => row.length)));
  const width = MARGIN * 2 + widest * CLUSTER_CARD_W + (widest - 1) * GAP_X;

  const placed = new Map<string, ClusterCard>();
  const bands: ClusterBand[] = [];
  let y = MARGIN;
  for (const depth of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(depth)!;
    const anchor = (node: AccountNode) => {
      const xs = (payersOf.get(node.gid) ?? []).map(id => placed.get(id)?.x).filter((x): x is number => x !== undefined);
      return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : null;
    };
    row.sort((a, b) => {
      const left = anchor(a), right = anchor(b);
      if (left !== null && right !== null) return left - right || b.priority_score - a.priority_score || compareGids(a.gid, b.gid);
      if (left !== null) return -1;
      if (right !== null) return 1;
      return b.priority_score - a.priority_score || compareGids(a.gid, b.gid);
    });
    bands.push({depth, y, count: row.length});
    y += LABEL;
    row.forEach((node, i) => {
      const inRow = Math.min(columns, row.length - Math.floor(i / columns) * columns);
      const x0 = (width - (inRow * CLUSTER_CARD_W + (inRow - 1) * GAP_X)) / 2;
      const card = {gid: node.gid, node, x: x0 + (i % columns) * (CLUSTER_CARD_W + GAP_X), y: y + Math.floor(i / columns) * (CLUSTER_CARD_H + ROW_GAP)};
      placed.set(node.gid, card);
    });
    y += Math.ceil(row.length / columns) * (CLUSTER_CARD_H + ROW_GAP) - ROW_GAP + BAND_GAP;
  }
  const height = y - BAND_GAP + MARGIN;

  const edges: ClusterLayout['edges'] = [];
  for (const card of placed.values()) for (const edge of outgoing.get(card.gid) ?? []) {
    const target = placed.get(edge.dst);
    if (!target || target === card) continue;
    edges.push({key: `${edge.src}>${edge.dst}`, d: link(card, target), src: edge.src, dst: edge.dst});
  }
  return {width, height, cards: [...placed.values()], bands, edges, hidden: members.length - shown.length};
}

/** Связь от края до края карточки: вниз — от низа к верху, вверх — наоборот, внутри ряда — вбок. */
function link(a: {x: number; y: number}, b: {x: number; y: number}): string {
  const w = CLUSTER_CARD_W, h = CLUSTER_CARD_H;
  if (Math.abs(a.y - b.y) < 10) {
    const right = b.x > a.x, x = a.x + (right ? w : 0), end = b.x + (right ? 0 : w), cy = a.y + h / 2, bend = (end - x) / 2;
    return `M ${x} ${cy} C ${x + bend} ${cy - 18}, ${end - bend} ${cy - 18}, ${end} ${cy}`;
  }
  const down = b.y > a.y, x = a.x + w / 2, y = a.y + (down ? h : 0), ex = b.x + w / 2, ey = b.y + (down ? 0 : h);
  const bend = (down ? 1 : -1) * Math.min(90, Math.max(22, Math.abs(ey - y) / 2));
  return `M ${x} ${y} C ${x} ${y + bend}, ${ex} ${ey - bend}, ${ex} ${ey}`;
}
