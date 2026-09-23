import {describe, expect, it} from 'vitest';
import {roleAlternatives, roleFacts, type RoleFact} from '../src/data/roleFacts';
import {compileNeighborhood} from '../src/data/neighborhood';
import type {AccountNode} from '../src/data/schema';
import {loadFixture} from './helpers';

const {analysis, index} = loadFixture();
const ruleFor = (role: string) => analysis.policy.rules.find(rule => rule.role === role);
const partners = (gid: string) => {
  const hood = compileNeighborhood(index, gid)!;
  return hood.payers.length + hood.recipients.length + hood.mutual.length;
};

describe('[WEB-ROLE-FACTS] факты гипотезы роли', () => {
  it('[WEB-ROLE-FACTS] распределитель: число получателей с порогом и отправленная сумма', () => {
    const node = analysis.nodes.find(n => n.role === 'distributor')!;
    const facts = roleFacts(node, ruleFor('distributor'), partners(node.gid));
    expect(facts[0]).toMatchObject({value: '15', label: 'разных получателей', threshold: 'порог 10', met: true});
    expect(facts[1]!.label).toBe('отправлено');
    expect(facts[1]!.value).toContain('₸');
  });
  it('[WEB-ROLE-FACTS] консолидатор и транзит берут пороги из правила своей роли', () => {
    const c = analysis.nodes.find(n => n.role === 'consolidator' && n.metrics.in_degree === 8)!;
    expect(roleFacts(c, ruleFor('consolidator'), partners(c.gid))[0]).toMatchObject({value: '8', threshold: 'порог 7', met: true});
    const t = analysis.nodes.find(n => n.role === 'transit' && n.metrics.pass_through !== null)!;
    expect(roleFacts(t, ruleFor('transit'), partners(t.gid))[0]!.threshold).toBe('коридор 0,80–1,20');
  });
  it('[WEB-ROLE-FACTS] без правила факты остаются, но без порога', () => {
    const node = analysis.nodes.find(n => n.role === 'distributor')!;
    const facts = roleFacts(node, undefined, partners(node.gid));
    expect(facts[0]!.threshold).toBeUndefined();
    expect(facts).toHaveLength(3);
  });
});

describe('[WEB-ROLE-FACTS] конечный получатель: накопление по условию «или»', () => {
  const base = analysis.nodes.find(n => n.role === 'terminal')!;
  const terminal = (inDegree: number, inKzt: number): AccountNode => ({...base, metrics: {...base.metrics, in_degree: inDegree, in_kzt: inKzt, out_degree: 0}});
  const branches = (node: AccountNode): RoleFact[] => roleFacts(node, ruleFor('terminal'), 3)
    .filter(fact => fact.label === 'разных плательщиков' || fact.label === 'получено');
  it('[WEB-ROLE-FACTS] проходит по числу плательщиков при малой сумме: эта ветка первой, сумма — «или»', () => {
    const [first, second] = branches(terminal(3, 193000));
    expect(first).toMatchObject({label: 'разных плательщиков', value: '3', met: true, threshold: 'от 2 плательщиков'});
    expect(second).toMatchObject({label: 'получено', met: false, threshold: 'или от 500\u00a0000\u00a0₸'});
  });
  it('[WEB-ROLE-FACTS] проходит по сумме при одном плательщике: сумма первой, плательщики — «или»', () => {
    const [first, second] = branches(terminal(1, 678000));
    expect(first).toMatchObject({label: 'получено', met: true, threshold: 'от 500\u00a0000\u00a0₸'});
    expect(second).toMatchObject({label: 'разных плательщиков', met: false, threshold: 'или от 2 плательщиков'});
  });
  it('[WEB-ROLE-FACTS] обе ветки выполнены — обе отмечены; ни одной — обе видны', () => {
    expect(branches(terminal(4, 900000)).map(fact => fact.met)).toEqual([true, true]);
    expect(branches(terminal(1, 10000)).map(fact => fact.met)).toEqual([false, false]);
  });
});

describe('[WEB-ROLE-FACTS] разные контрагенты и порядок альтернатив', () => {
  it('[WEB-ROLE-FACTS] встречный партнёр считается один раз', () => {
    const u = analysis.nodes.find(n => n.evidence.startsWith('Отдаёт 72%'))!;
    expect(partners(u.gid)).toBe(4);
    expect(u.metrics.in_degree + u.metrics.out_degree).toBe(5);
    const fact = roleFacts({...u, role: 'peripheral'}, ruleFor('peripheral'), partners(u.gid)).find(f => f.label === 'разных контрагентов')!;
    expect(fact.value).toBe('4');
  });
  it('[WEB-ROLE-FACTS] непересекающиеся плательщики и получатели складываются', () => {
    const q = analysis.nodes.find(n => n.role === 'coordinator')!;
    expect(partners(q.gid)).toBe(q.metrics.in_degree + q.metrics.out_degree);
    expect(roleFacts(q, ruleFor('coordinator'), partners(q.gid)).find(f => f.label === 'разных контрагентов')!.value).toBe('5');
  });
  it('[WEB-ROLE-FACTS] альтернатива берётся в порядке конвейера, без пересортировки по числу', () => {
    const node: AccountNode = {...analysis.nodes[0]!, role: 'coordinator', role_alternatives: [
      {role: 'consolidator', score: 0.5, reason: 'содержательная альтернатива'},
      {role: 'peripheral', score: 0.9, reason: 'обратная оценка: 1 минус сильнейший признак'},
    ]};
    expect(roleAlternatives(node)[0]!.role).toBe('consolidator');
  });
});
