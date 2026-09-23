import {describe, expect, it} from 'vitest';
import {roleAlternatives, roleFacts, type RoleFact} from '../src/data/roleFacts';
import {compileNeighborhood} from '../src/data/neighborhood';
import type {AccountNode, PolicyRule} from '../src/data/schema';
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

describe('[WEB-ROLE-FACTS] правила второй версии: небольшие исходящие, окно по основной сумме, контрагенты', () => {
  const rule = (role: string, thresholds: Record<string, number>): PolicyRule =>
    ({role, description: '', thresholds: Object.fromEntries(Object.entries(thresholds).map(([k, value]) => [k, {value, unit: '', rationale: ''}]))});
  const terminalRule = rule('terminal', {max_pass_through: 0.2, window_value_share: 0.9, min_margin_days: 7, min_payers: 2, min_in_kzt: 500_000});
  const base = analysis.nodes.find(n => n.role === 'terminal')!;
  const v2 = (metrics: Partial<AccountNode['metrics']> & Record<string, unknown>, extra: Partial<AccountNode> = {}): AccountNode =>
    ({...base, ...extra, metrics: {...base.metrics, ...metrics} as AccountNode['metrics']});

  it('[WEB-ROLE-FACTS] конечный с небольшими исходящими: доля с порогом «не больше 20%», окно от 90% суммы, нет «без исходящих»', () => {
    const node = v2({out_degree: 2, in_degree: 3, in_kzt: 1_000_000, out_kzt: 120_000, pass_through: 0.12, forward_share: 0.12,
      value_window_days: 30, observation_margin_days: 3, counterparties: 5}, {role_basis: 'terminal.small_outflow'});
    const facts = roleFacts(node, terminalRule, 99);
    expect(facts.map(f => f.label)).not.toContain('дней без исходящих после последнего поступления');
    expect(facts[0]).toMatchObject({value: '30', label: 'дней после поступления 90% суммы', threshold: 'нужно ≥ 7', met: true});
    expect(facts.at(-1)).toMatchObject({value: '12%', label: 'полученного ушло дальше', threshold: 'не больше 20%', met: true});
  });
  it('[WEB-ROLE-FACTS] конечный без исходящих во второй версии: «0 получателей» и окно по основной сумме', () => {
    const facts = roleFacts(v2({out_degree: 0, out_kzt: 0, pass_through: 0, forward_share: 0, value_window_days: 12}), terminalRule, 3);
    expect(facts.at(-1)).toMatchObject({value: '0', label: 'исходящих получателей'});
    expect(facts[0]).toMatchObject({value: '12', met: true});
  });
  it('[WEB-ROLE-FACTS] транзит второй версии: обе доли проверяются по коридору', () => {
    const t = analysis.nodes.find(n => n.role === 'transit')!;
    const facts = roleFacts({...t, metrics: {...t.metrics, pass_through: 1.35, forward_share: 0.95}}, rule('transit', {pass_through_low: 0.8, pass_through_high: 1.2}), 4);
    expect(facts[0]).toMatchObject({value: '95%', label: 'ушло дальше после поступлений', threshold: 'коридор 80%–120%', met: true});
    expect(facts[1]).toMatchObject({value: '135%', met: false});
  });
  it('[WEB-ROLE-FACTS] контрагенты берутся из metrics.counterparties, если конвейер их посчитал', () => {
    const p = analysis.nodes.find(n => n.role === 'peripheral')!;
    expect(roleFacts({...p, metrics: {...p.metrics, counterparties: 5}}, ruleFor('peripheral'), 9)[0]).toMatchObject({value: '5', label: 'разных контрагентов'});
    expect(roleFacts(p, ruleFor('peripheral'), 9)[0]!.value).toBe('9');
  });
});

describe('[WEB-ROLE-FACTS] периферийный: счёт без переводов и сниженная опора', () => {
  const p = analysis.nodes.find(n => n.role === 'peripheral')!;
  it('[WEB-ROLE-FACTS] без переводов роль не оценивается, порог сильнейшего признака не показан', () => {
    const facts = roleFacts({...p, metrics: {...p.metrics, in_tx: 0, out_tx: 0, in_degree: 0, out_degree: 0}}, ruleFor('peripheral'), 0);
    expect(facts[0]).toMatchObject({value: '0', label: 'переводов в выгрузке'});
    expect(facts.some(f => f.threshold)).toBe(false);
  });
  it('[WEB-ROLE-FACTS] сниженная опора называет условие конвейера вместо оборота', () => {
    const late = roleFacts({...p, role_basis: 'peripheral.late_inflow', metrics: {...p.metrics, value_window_days: 6}}, ruleFor('peripheral'), 3);
    expect(late[1]).toMatchObject({value: '6', label: 'дней до конца периода: основная сумма пришла поздно, опора снижена'});
    const cut = roleFacts({...p, role_basis: 'peripheral.cutoff'}, ruleFor('peripheral'), 1);
    expect(cut[1]!.label).toContain('граница сбора');
    expect(roleFacts(p, ruleFor('peripheral'), 1)[1]!.label).toBe('оборот');
  });
});

describe('[WEB-ROLE-FACTS] отклонённый транзит второй версии', () => {
  it('[WEB-ROLE-FACTS] вся доля в коридоре, доля после поступлений — нет: факт объясняет отказ', () => {
    const p = analysis.nodes.find(n => n.role === 'peripheral' && n.metrics.in_tx + n.metrics.out_tx > 0)!;
    const transit: PolicyRule = {role: 'transit', description: '', thresholds: {pass_through_low: {value: 0.8}, pass_through_high: {value: 1.2}}};
    const node = {...p, role_basis: 'peripheral.below_threshold', metrics: {...p.metrics, pass_through: 1, forward_share: 0}};
    const facts = roleFacts(node, ruleFor('peripheral'), 1, transit);
    expect(facts[1]).toMatchObject({value: '100%', threshold: 'коридор 80%–120%', met: true});
    expect(facts[2]).toMatchObject({value: '0%', label: 'ушло дальше после поступлений: транзит датами не подтверждён', met: false});
    expect(roleFacts({...node, metrics: {...node.metrics, pass_through: 0.3}}, ruleFor('peripheral'), 1, transit)[2]!.label).toBe('сильнейший признак другой роли');
  });
});
