import {describe, expect, it} from 'vitest';
import {roleFacts} from '../src/data/roleFacts';
import {loadFixture} from './helpers';

const {analysis} = loadFixture();
const ruleFor = (role: string) => analysis.policy.rules.find(rule => rule.role === role);

describe('[WEB-ROLE-FACTS] факты гипотезы роли', () => {
  it('[WEB-ROLE-FACTS] распределитель: число получателей с порогом и отправленная сумма', () => {
    const node = analysis.nodes.find(n => n.role === 'distributor')!;
    const facts = roleFacts(node, ruleFor('distributor'));
    expect(facts[0]).toMatchObject({value: '15', label: 'разных получателей', threshold: 'порог 10', met: true});
    expect(facts[1]!.label).toBe('отправлено');
    expect(facts[1]!.value).toContain('₸');
  });
  it('[WEB-ROLE-FACTS] консолидатор и транзит берут пороги из правила своей роли', () => {
    const c = analysis.nodes.find(n => n.role === 'consolidator' && n.metrics.in_degree === 8)!;
    expect(roleFacts(c, ruleFor('consolidator'))[0]).toMatchObject({value: '8', threshold: 'порог 7', met: true});
    const t = analysis.nodes.find(n => n.role === 'transit' && n.metrics.pass_through !== null)!;
    expect(roleFacts(t, ruleFor('transit'))[0]!.threshold).toBe('коридор 0,80–1,20');
  });
  it('[WEB-ROLE-FACTS] без правила факты остаются, но без порога', () => {
    const node = analysis.nodes.find(n => n.role === 'distributor')!;
    const facts = roleFacts(node, undefined);
    expect(facts[0]!.threshold).toBeUndefined();
    expect(facts).toHaveLength(3);
  });
});
