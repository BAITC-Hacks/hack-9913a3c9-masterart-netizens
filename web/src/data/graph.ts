import type {AccountNode, Analysis, Cluster, Edge, Transaction} from './schema';

/**
 * Индекс поверх проверенного analysis.json: всё, что интерфейсу нужно искать быстро.
 * Ключи — строки gid; ни одно преобразование не превращает идентификатор в число.
 */
export interface GraphIndex {
  analysis: Analysis;
  byGid: ReadonlyMap<string, AccountNode>;
  outgoing: ReadonlyMap<string, readonly Edge[]>;
  incoming: ReadonlyMap<string, readonly Edge[]>;
  transactionsByPair: ReadonlyMap<string, readonly Transaction[]>;
  clusters: ReadonlyMap<number, Cluster>;
  clusterMembers: ReadonlyMap<number, readonly AccountNode[]>;
  topRank: ReadonlyMap<string, number>;
  gids: readonly string[];
  roleCounts: ReadonlyMap<string, number>;
}

export const pairKey = (src: string, dst: string) => `${src}>${dst}`;

/** Сравнение строк из цифр как целых чисел без преобразования: сначала длина, потом лексикографически. */
export function compareGids(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

const byAmount = (a: Edge, b: Edge, key: 'src' | 'dst') => b.sum_kzt - a.sum_kzt || compareGids(a[key], b[key]);

export function buildIndex(analysis: Analysis): GraphIndex {
  const byGid = new Map<string, AccountNode>();
  for (const node of analysis.nodes) byGid.set(node.gid, node);

  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const edge of analysis.edges) {
    if (!byGid.has(edge.src) || !byGid.has(edge.dst)) continue;
    (outgoing.get(edge.src) ?? outgoing.set(edge.src, []).get(edge.src)!).push(edge);
    (incoming.get(edge.dst) ?? incoming.set(edge.dst, []).get(edge.dst)!).push(edge);
  }
  for (const list of outgoing.values()) list.sort((a, b) => byAmount(a, b, 'dst'));
  for (const list of incoming.values()) list.sort((a, b) => byAmount(a, b, 'src'));

  const transactionsByPair = new Map<string, Transaction[]>();
  for (const tx of analysis.transactions) {
    const key = pairKey(tx.src, tx.dst);
    (transactionsByPair.get(key) ?? transactionsByPair.set(key, []).get(key)!).push(tx);
  }
  for (const list of transactionsByPair.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.sum_kzt - a.sum_kzt));

  const clusters = new Map<number, Cluster>();
  for (const cluster of analysis.clusters) clusters.set(cluster.cluster_id, cluster);
  const clusterMembers = new Map<number, AccountNode[]>();
  for (const node of analysis.nodes) (clusterMembers.get(node.cluster_id) ?? clusterMembers.set(node.cluster_id, []).get(node.cluster_id)!).push(node);
  for (const list of clusterMembers.values()) list.sort((a, b) => b.priority_score - a.priority_score || compareGids(a.gid, b.gid));

  const topRank = new Map<string, number>();
  for (const top of analysis.top_nodes) if (!topRank.has(top.gid)) topRank.set(top.gid, top.rank);

  const roleCounts = new Map<string, number>();
  for (const node of analysis.nodes) roleCounts.set(node.role, (roleCounts.get(node.role) ?? 0) + 1);

  const gids = analysis.nodes.map(node => node.gid).sort(compareGids);
  return {analysis, byGid, outgoing, incoming, transactionsByPair, clusters, clusterMembers, topRank, gids, roleCounts};
}

/** Переводы по направленной паре в порядке дат; пустой список, если пары нет. */
export function pairTransactions(index: GraphIndex, src: string, dst: string): readonly Transaction[] {
  return index.transactionsByPair.get(pairKey(src, dst)) ?? [];
}

/** Первая и последняя дата переводов по паре, если они есть. */
export function pairDateRange(index: GraphIndex, src: string, dst: string): {first: string; last: string} | null {
  const list = pairTransactions(index, src, dst);
  if (!list.length) return null;
  return {first: list[0]!.date, last: list.at(-1)!.date};
}
