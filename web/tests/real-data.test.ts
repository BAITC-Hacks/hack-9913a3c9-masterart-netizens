import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {validateAnalysis} from '../src/data/schema';
import {buildIndex} from '../src/data/graph';
import {compileNeighborhood} from '../src/data/neighborhood';
import {searchAccounts} from '../src/data/search';
import {buildReviewBrief} from '../src/data/brief';
import {layoutEgo} from '../src/map/egoLayout';
import {layoutCluster} from '../src/map/clusterLayout';
import {roleAlternatives, roleFacts} from '../src/data/roleFacts';
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
    let maxNeighbours = 0, cycles = 0, layoutMs = 0, terminals = 0, alternativesChecked = 0, smallOutflow = 0;
    for (const gid of index.gids) {
      expect(searchAccounts(index, gid)).toEqual({kind: 'exact', gid});
      const hood = compileNeighborhood(index, gid)!;
      maxNeighbours = Math.max(maxNeighbours, hood.payers.length + hood.recipients.length + hood.mutual.length);
      cycles += hood.cycles.length ? 1 : 0;
      const t = performance.now();
      const layout = layoutEgo(hood);
      layoutMs = Math.max(layoutMs, performance.now() - t);
      expect(layout.cards.filter(card => card.kind !== 'note').length).toBeLessThanOrEqual(1 + 11 + 11 + 5);
      const node = index.byGid.get(gid)!;
      const facts = roleFacts(node, result.data.policy.rules.find(rule => rule.role === node.role), hood.payers.length + hood.recipients.length + hood.mutual.length,
        result.data.policy.rules.find(rule => rule.role === 'transit'));
      expect(facts.length).toBeGreaterThanOrEqual(2);
      expect(facts.every(fact => fact.value !== '' && fact.label !== ''), `факты ${gid}`).toBe(true);
      // Факты роли подтверждают условие, по которому конвейер её назначил: каждый порог, кроме второй ветки «или», выполнен.
      if (node.role !== 'peripheral') {
        const unmet = facts.filter(fact => fact.met === false && !fact.threshold?.startsWith('или'));
        expect(unmet, `${node.role} ${gid}: невыполненный порог у назначенной роли`).toEqual([]);
      }
      if (node.metrics.counterparties !== undefined) {
        const partners = facts.find(fact => fact.label === 'разных контрагентов');
        if (partners) expect(partners.value, `контрагенты ${gid}`).toBe(String(node.metrics.counterparties));
      }
      if (node.role === 'terminal' && node.metrics.out_degree > 0) {
        expect(facts.map(fact => fact.label), `терминал ${gid} с исходящими`).not.toContain('дней без исходящих после последнего поступления');
        smallOutflow += 1;
      }
      if (node.role === 'terminal') {
        const branches = facts.filter(fact => fact.label === 'разных плательщиков' || fact.label === 'получено');
        expect(branches, `терминал ${gid}`).toHaveLength(2);
        expect(branches[0]!.met, `терминал ${gid}: первой идёт выполненная ветка «или»`).toBe(true);
        terminals += 1;
      }
      const named = /Альтернатива: ([^0-9]+?) \d/.exec(node.evidence)?.[1]?.trim();
      if (named) {
        const first = roleAlternatives(node)[0]!;
        const label = (result.data.policy.rules.find(rule => rule.role === first.role) as unknown as {label?: string} | undefined)?.label;
        expect(label, `альтернатива ${gid}`).toBe(named);
        alternativesChecked += 1;
      }
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
    console.info(`[WEB-REAL] ${index.gids.length} счетов, загрузка+индекс ${loadMs.toFixed(0)} мс, макс. соседей ${maxNeighbours}, счетов с циклами ${cycles}, худшая раскладка ${layoutMs.toFixed(1)} мс, худшая карта кластера ${clusterMs.toFixed(1)} мс, терминалов с веткой «или» ${terminals}, альтернатив сверено ${alternativesChecked}, конечных с небольшими исходящими ${smallOutflow}`);
  });
});
