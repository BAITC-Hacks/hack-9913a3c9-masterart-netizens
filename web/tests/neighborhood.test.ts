import {describe, expect, it} from 'vitest';
import {compileNeighborhood} from '../src/data/neighborhood';
import {layoutEgo} from '../src/map/egoLayout';
import {loadFixture} from './helpers';

const {analysis, index} = loadFixture();
const byEvidence = (start: string) => analysis.nodes.find(node => node.evidence.startsWith(start))!;

describe('[WEB-MAP] окрестность на один шаг', () => {
  it('[WEB-MAP-CYCLE] встречный поток и цикл длиной 3 через фокус', () => {
    const u = byEvidence('Отдаёт 72%');
    const hood = compileNeighborhood(index, u.gid)!;
    expect(hood.mutual).toHaveLength(1);
    const lengths = hood.cycles.map(cycle => cycle.length).sort();
    expect(lengths).toEqual([2, 3]);
    for (const cycle of hood.cycles) expect(cycle[0]).toBe(u.gid);
    const layout = layoutEgo(hood);
    expect(layout.edges.some(edge => edge.kind === 'mutual-out' && edge.cycle)).toBe(true);
    expect(layout.edges.some(edge => edge.kind === 'inner' && edge.cycle)).toBe(true);
  });
  it('[WEB-MAP-FOLD] больше 10 получателей сворачиваются с числом и суммой', () => {
    const d = analysis.nodes.find(node => node.role === 'distributor')!;
    const hood = compileNeighborhood(index, d.gid)!;
    expect(hood.recipients).toHaveLength(15);
    const layout = layoutEgo(hood);
    const fold = layout.cards.find(card => card.kind === 'fold' && card.fold?.side === 'out')!;
    expect(fold.fold!.count).toBe(5);
    const hiddenSum = hood.recipients.slice(10).reduce((sum, link) => sum + link.fromFocus!.sum_kzt, 0);
    expect(fold.fold!.kzt).toBe(hiddenSum);
    expect(layout.cards.filter(card => card.kind === 'recipient')).toHaveLength(10);
  });
  it('[WEB-MAP-ISOLATE] изолированный исходный клиент показан с пояснением, а не пустым', () => {
    const iso = analysis.nodes.find(node => node.metrics.in_degree + node.metrics.out_degree === 0)!;
    const hood = compileNeighborhood(index, iso.gid)!;
    expect(hood.payers.length + hood.recipients.length + hood.mutual.length).toBe(0);
    const layout = layoutEgo(hood, {notes: {in: 'нет входящих', out: 'нет исходящих'}});
    expect(layout.cards.filter(card => card.kind === 'note')).toHaveLength(2);
  });
  it('[WEB-MAP-BOUNDARY] у счёта на границе выборки нет получателей и есть отметка', () => {
    const boundary = analysis.nodes.find(node => node.observation.outgoing_censored)!;
    const hood = compileNeighborhood(index, boundary.gid)!;
    expect(hood.recipients).toHaveLength(0);
    expect(boundary.observation.warnings.join(' ')).toContain('границе');
  });
  it('[WEB-MAP] несуществующий gid не даёт окрестности', () => {
    expect(compileNeighborhood(index, '999')).toBeNull();
  });
});
