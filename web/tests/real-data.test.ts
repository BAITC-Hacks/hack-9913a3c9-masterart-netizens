import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {validateAnalysis} from '../src/data/schema';
import {buildIndex} from '../src/data/graph';
import {compileNeighborhood} from '../src/data/neighborhood';
import {searchAccounts} from '../src/data/search';
import {buildReviewBrief} from '../src/data/brief';
import {layoutEgo} from '../src/map/egoLayout';
import {layoutCluster} from '../src/map/clusterLayout';
import {incrementDecimal} from './helpers';

// Проверка на настоящем out/analysis.json. Запуск: WORKBENCH_REAL=../out/analysis.json npm test
const file = process.env.WORKBENCH_REAL;
describe.skipIf(!file)('[WEB-REAL] настоящий файл анализа', () => {
  it('[WEB-REAL] проходит проверку, каждый счёт ищется, окрестность и справка строятся', () => {
    const started = performance.now();
    const result = validateAnalysis(JSON.parse(fs.readFileSync(file!, 'utf8')));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const index = buildIndex(result.data);
    const loadMs = performance.now() - started;
    let maxNeighbours = 0, cycles = 0, layoutMs = 0;
    for (const gid of index.gids) {
      expect(searchAccounts(index, gid)).toEqual({kind: 'exact', gid});
      const hood = compileNeighborhood(index, gid)!;
      maxNeighbours = Math.max(maxNeighbours, hood.payers.length + hood.recipients.length + hood.mutual.length);
      cycles += hood.cycles.length ? 1 : 0;
      const t = performance.now();
      const layout = layoutEgo(hood);
      layoutMs = Math.max(layoutMs, performance.now() - t);
      expect(layout.cards.filter(card => card.kind !== 'note').length).toBeLessThanOrEqual(1 + 11 + 11 + 5);
    }
    let falseHits = 0;
    for (const gid of index.gids.slice(0, 200)) { const next = incrementDecimal(gid); if (!index.byGid.has(next) && searchAccounts(index, next).kind === 'exact') falseHits++; }
    expect(falseHits).toBe(0);
    for (const top of result.data.top_nodes.slice(0, 3)) expect(buildReviewBrief(index, top.gid, 'strict')).toContain(top.gid);
    let clusterMs = 0;
    for (const [id, members] of index.clusterMembers) {
      const t = performance.now();
      const layout = layoutCluster(members, index.outgoing);
      clusterMs = Math.max(clusterMs, performance.now() - t);
      expect(layout.cards.length + layout.hidden, `кластер ${id}`).toBe(members.length);
    }
    console.info(`[WEB-REAL] ${index.gids.length} счетов, загрузка+индекс ${loadMs.toFixed(0)} мс, макс. соседей ${maxNeighbours}, счетов с циклами ${cycles}, худшая раскладка ${layoutMs.toFixed(1)} мс, худшая карта кластера ${clusterMs.toFixed(1)} мс`);
  });
});
