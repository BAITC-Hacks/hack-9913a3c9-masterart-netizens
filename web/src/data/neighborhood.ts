import type {AccountNode, Edge} from './schema';
import {compareGids, type GraphIndex} from './graph';

/**
 * Окрестность счёта на один шаг: кто платил ему, кому платил он и с кем деньги шли в обе стороны.
 * Циклы — это наблюдение («возвратный поток»), а не ошибка данных: здесь они перечисляются явно.
 */
export interface NeighborLink {
  gid: string;
  node: AccountNode | undefined;
  /** Перевод соседа в фокус (сосед — плательщик). */
  toFocus: Edge | null;
  /** Перевод фокуса соседу (сосед — получатель). */
  fromFocus: Edge | null;
}

export interface Neighborhood {
  focus: AccountNode;
  payers: NeighborLink[];
  recipients: NeighborLink[];
  mutual: NeighborLink[];
  /** Переводы между соседями, если оба конца входят в окрестность. */
  innerEdges: Edge[];
  /** Направленные циклы через фокус длиной 2 и 3: список gid по ходу денег, первый — фокус. */
  cycles: string[][];
  totals: {inKzt: number; outKzt: number; inTx: number; outTx: number};
}

const MAX_CYCLES = 24;
const weight = (link: NeighborLink) => (link.toFocus?.sum_kzt ?? 0) + (link.fromFocus?.sum_kzt ?? 0);
const byWeight = (a: NeighborLink, b: NeighborLink) => weight(b) - weight(a) || compareGids(a.gid, b.gid);

export function compileNeighborhood(index: GraphIndex, gid: string): Neighborhood | null {
  const focus = index.byGid.get(gid);
  if (!focus) return null;
  const links = new Map<string, NeighborLink>();
  const link = (other: string) => links.get(other) ?? links.set(other, {gid: other, node: index.byGid.get(other), toFocus: null, fromFocus: null}).get(other)!;
  const totals = {inKzt: 0, outKzt: 0, inTx: 0, outTx: 0};
  for (const edge of index.incoming.get(gid) ?? []) {
    if (edge.src === gid) continue;
    link(edge.src).toFocus = edge;
    totals.inKzt += edge.sum_kzt; totals.inTx += edge.n_tx;
  }
  for (const edge of index.outgoing.get(gid) ?? []) {
    if (edge.dst === gid) continue;
    link(edge.dst).fromFocus = edge;
    totals.outKzt += edge.sum_kzt; totals.outTx += edge.n_tx;
  }
  const payers: NeighborLink[] = [], recipients: NeighborLink[] = [], mutual: NeighborLink[] = [];
  for (const entry of links.values()) (entry.toFocus && entry.fromFocus ? mutual : entry.toFocus ? payers : recipients).push(entry);
  payers.sort(byWeight); recipients.sort(byWeight); mutual.sort(byWeight);

  const members = new Set(links.keys());
  const innerEdges: Edge[] = [];
  for (const member of members) for (const edge of index.outgoing.get(member) ?? []) {
    if (edge.dst !== gid && edge.dst !== member && members.has(edge.dst)) innerEdges.push(edge);
  }

  const cycles: string[][] = [];
  for (const entry of mutual) if (cycles.length < MAX_CYCLES) cycles.push([gid, entry.gid]);
  const sendsToFocus = new Set([...payers, ...mutual].map(entry => entry.gid));
  const receivesFromFocus = new Set([...recipients, ...mutual].map(entry => entry.gid));
  for (const edge of innerEdges) {
    if (cycles.length >= MAX_CYCLES) break;
    if (receivesFromFocus.has(edge.src) && sendsToFocus.has(edge.dst)) cycles.push([gid, edge.src, edge.dst]);
  }
  return {focus, payers, recipients, mutual, innerEdges, cycles, totals};
}

/** Делит сторону окрестности на видимую часть и свёрнутый остаток с числом и суммой. */
export function foldSide(links: readonly NeighborLink[], cap: number) {
  const visible = links.slice(0, cap);
  const hidden = links.slice(cap);
  const hiddenKzt = hidden.reduce((sum, entry) => sum + weight(entry), 0);
  return {visible, hidden, hiddenKzt};
}
