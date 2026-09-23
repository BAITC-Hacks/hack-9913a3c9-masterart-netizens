import {describe, expect, it} from 'vitest';
import {buildReviewBrief} from '../src/data/brief';
import {loadFixture} from './helpers';

const {analysis, index} = loadFixture();

describe('[WEB-BRIEF] справка для проверки', () => {
  const consolidator = analysis.nodes.find(node => node.role === 'consolidator' && node.metrics.in_degree === 8)!;
  const brief = buildReviewBrief(index, consolidator.gid, 'strict')!;
  it('[WEB-BRIEF] содержит точный gid, роль, альтернативу и основание', () => {
    expect(brief).toContain(`# Справка для проверки: счёт ${consolidator.gid}`);
    expect(brief).toContain('**Консолидатор**');
    expect(brief).toContain('Ближайшая альтернатива: Транзит');
    expect(brief).toContain(consolidator.evidence);
  });
  it('[WEB-BRIEF] датированные пути и оговорка о тех же деньгах', () => {
    expect(brief).toMatch(/\d{1,2} июля 2026: `\d{18}` → `\d{18}`/);
    expect(brief).toContain('не доказывает, что двигались те же деньги');
  });
  it('[WEB-BRIEF] синтетика помечена, выводов о виновности нет', () => {
    expect(brief).toContain('Синтетический пример для разработки');
    expect(brief).toMatch(/гипотеза для проверки/i);
    expect(brief.toLowerCase()).not.toMatch(/виновен|преступн|мошенни|отмыв/);
  });
  it('[WEB-BRIEF] путь только «в тот же день» показан честно', () => {
    const sameDayOnly = analysis.nodes.find(node => node.temporal.same_day_witness && !node.temporal.strict_witness && node.temporal.same_day_witness.hops.length === 3)!;
    const text = buildReviewBrief(index, sameDayOnly.gid, 'same_day')!;
    expect(text).toContain('Путь не найден в этом режиме.');
    expect(text).toContain('16 июля 2026');
  });
});
