import {describe, expect, it} from 'vitest';
import {layoutCluster} from '../src/map/clusterLayout';
import {loadFixture} from './helpers';

const {analysis, index} = loadFixture();

describe('[WEB-CLUSTER-MAP] карта кластера', () => {
  const biggest = [...analysis.clusters].sort((a, b) => b.n_nodes - a.n_nodes)[0]!;
  const members = index.clusterMembers.get(biggest.cluster_id)!;
  it('[WEB-CLUSTER-MAP] ограничение карты: показаны самые приоритетные, остальные посчитаны', () => {
    const layout = layoutCluster(members, index.outgoing, {cap: 10, columns: 4});
    expect(layout.cards).toHaveLength(10);
    expect(layout.hidden).toBe(members.length - 10);
    const shownMin = Math.min(...layout.cards.map(card => card.node.priority_score));
    const hiddenMax = Math.max(...members.filter(node => !layout.cards.some(card => card.gid === node.gid)).map(node => node.priority_score));
    expect(shownMin).toBeGreaterThanOrEqual(hiddenMax);
  });
  it('[WEB-CLUSTER-MAP] ряды идут по шагам от исходных клиентов, связи — только между показанными', () => {
    const layout = layoutCluster(members, index.outgoing);
    expect(layout.cards).toHaveLength(members.length);
    const depths = layout.bands.map(band => band.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    const placed = new Set(layout.cards.map(card => card.gid));
    for (const edge of layout.edges) expect(placed.has(edge.src) && placed.has(edge.dst)).toBe(true);
    for (const card of layout.cards) expect(card.y).toBeGreaterThanOrEqual(layout.bands.find(band => band.depth === card.node.depth)!.y);
  });
  it('[WEB-CLUSTER-MAP] фильтр по роли — тот же набор для карты и списка', () => {
    const role = members[0]!.role;
    const filtered = members.filter(node => node.role === role);
    const layout = layoutCluster(filtered, index.outgoing, {cap: 160});
    expect(layout.cards.every(card => card.node.role === role)).toBe(true);
    expect(layout.cards.length + layout.hidden).toBe(filtered.length);
  });
});
