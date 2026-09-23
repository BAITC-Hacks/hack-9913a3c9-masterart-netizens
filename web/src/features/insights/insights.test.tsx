import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {buildIndex} from '../../data/graph';
import {validateAnalysis, type AccountNode, type Analysis} from '../../data/schema';
import {AccountInsights, InsightsPanel, accountLines, honestCheck, parseSections, MAX_EXAMPLE_GIDS} from './index';

// Идентификаторы больше 2^53 (9007199254740992): Number() исказил бы их, поэтому сравниваются только строки.
const G = ['900719925474099312', '900719925474099313', '900719925474099314', '900719925474099315',
  '900719925474099316', '900719925474099317', '900719925474099318'] as const;
expect(Number(G[0]) > 2 ** 53).toBe(true);
expect(String(Number(G[0]))).not.toBe(G[0]);

function node(gid: string, o: {in?: number; out?: number; role?: string; censored?: boolean; depth?: number}): AccountNode {
  return {
    gid, depth: o.depth ?? 1, is_seed: o.depth === 0, role: o.role ?? 'peripheral', role_score: 0, cluster_id: 0,
    priority_score: 0, evidence: 'синтетика', next_request: 'нет', role_alternatives: [],
    metrics: {in_degree: o.in ?? 0, out_degree: o.out ?? 0, in_kzt: 0, out_kzt: 0, in_tx: 0, out_tx: 0,
      seed_in_count: 0, seed_out_count: 0, pass_through: null},
    observation: {outgoing_censored: o.censored ?? false, warnings: []},
    temporal: {static_seed_count: 0, strict_seed_count: 0, same_day_seed_count: 0, strict_seed_ids: [], same_day_seed_ids: [],
      strict_witness: null, same_day_witness: null},
  };
}

const lim = (t: string) => [t];
const INSIGHTS = {
  schema_version: 'finance-insights/v1',
  limitations: ['Наблюдения не доказывают, что переведены те же деньги.'],
  sections: [
    {key: 'pass_through', title: 'Быстрый транзит за 0–2 дня', counts: {accounts: 3, outgoing_matched: 9},
      parameters: {max_lag_days: {value: 2, unit: 'дня'}, amount_ratio: {value: [0.8, 1.2], unit: 'отношение сумм'}},
      limitations: lim('Совпадение сроков не доказывает перевод тех же денег.'),
      examples: [{gid: G[0]}, {gid: G[1]}, {gid: G[0]}, {gid: 123}]},
    {key: 'cycles', title: 'Короткие циклы и возвраты', counts: {cycles: 2}, parameters: {max_length: {value: 4, unit: 'счетов'}},
      limitations: lim('Цикл — структурный факт.'),
      examples: [{cycle: [G[0], G[1], G[2]]}, {cycle: [G[3], G[4], G[5], G[6]]}]},
    {key: 'resilience', title: 'Сценарии удаления счетов', counts: {baseline_components: 1}, parameters: {},
      limitations: lim('Это расчёт на графе выборки, а не прогноз эффекта блокировки.'),
      summary_text: 'На графе выборки: без 2 счетов недостижимы 25% остальных.', examples: [],
      scenarios: [{strategy: 'priority', n_removed: 1, reachable_share: 0.9, removed_gids: [G[2]]},
        {strategy: 'priority', n_removed: 2, reachable_share: 0.75, removed_gids: [G[2], G[3]]},
        {strategy: 'random', n_removed: 2, reachable_share: 0.99}]},
    {key: 'data_requests', title: 'Какие данные запросить', counts: {requests: 1}, parameters: {},
      limitations: lim('Запросы касаются только этого модуля.'),
      examples: [{key: 'intraday_time', request: 'Время операций', example_gids: [G[5], G[6]]}]},
    {key: 'future_thing', title: 'Новый раздел', counts: {widgets: 7}, parameters: {}, limitations: [], examples: []},
  ],
  by_gid: {[G[0]]: [{section: 'pass_through', text: 'Быстрый транзит: 3 из 4 исходящих'}, {section: 'cycles', text: 'Циклы: 1'}]},
};

function makeAnalysis(withInsights = true): Analysis {
  const nodes = [
    node(G[0], {depth: 0, out: 2}),
    node(G[1], {in: 1, out: 0, role: 'terminal'}),
    node(G[2], {in: 1, out: 0, censored: true}),
    node(G[3], {in: 2, out: 0, censored: true, role: 'terminal'}),
    node(G[4], {in: 1, out: 1, role: 'transit'}),
    node(G[5], {in: 0, out: 0, censored: true}),
    node(G[6], {in: 1, out: 1}),
  ];
  const raw = {
    schema_version: 'finance-workbench/v1',
    summary: {n_nodes: 7, n_edges: 0, n_transactions: 0, n_seed: 1, total_kzt: 0, period_start: '2026-07-01', period_end: '2026-07-31',
      n_boundary: 3, n_isolates: 0, n_weak_components: 1, input_sha256: 'x'},
    policy: {version: 't', rules: [], priority_description: '', score_description: '', limitations: []},
    nodes, edges: [], transactions: [], clusters: [], top_nodes: [],
    temporal_summary: {reachable_from_at_least_5_seeds: {static: 40, strict: 3, same_day: 4}},
    ...(withInsights ? {insights: INSIGHTS} : {}),
  };
  const v = validateAnalysis(raw);
  if (!v.ok) throw new Error(v.errors.join('\n'));
  return v.data;
}

/** Разворачивает дерево элементов, вызывая функциональные компоненты, и собирает кнопки. */
function buttons(el: ReactNode, out: ReactElement<{onClick?: () => void; children?: ReactNode}>[] = []) {
  if (Array.isArray(el)) { el.forEach(e => buttons(e, out)); return out; }
  if (!isValidElement(el)) return out;
  const e = el as ReactElement<{children?: ReactNode; onClick?: () => void}>;
  if (typeof e.type === 'function') return buttons((e.type as (p: unknown) => ReactNode)(e.props), out);
  if (e.type === 'button') out.push(e);
  buttons(e.props.children, out);
  return out;
}

describe('Честная проверка', () => {
  it('считает всё по файлу, без зашитых чисел', () => {
    const index = buildIndex(makeAnalysis());
    expect(honestCheck(index)).toEqual({naive: 3, naiveAtBoundary: 2, terminal: 2, boundary: 3, nodes: 7,
      reach5: {static: 40, strict: 3, same_day: 4}});
    const html = renderToStaticMarkup(<InsightsPanel index={index} onSelect={() => {}} />);
    expect(html).toContain('Честная проверка');
    expect(html).toContain('40 → 3 → 4');
  });
  it('без temporal_summary строка про ≥5 клиентов не выводится', () => {
    const a = makeAnalysis();
    const index = buildIndex({...a, temporal_summary: {}});
    expect(honestCheck(index).reach5).toBeNull();
    expect(renderToStaticMarkup(<InsightsPanel index={index} onSelect={() => {}} />)).not.toContain('≥5');
  });
});

describe('Разделы', () => {
  const index = buildIndex(makeAnalysis());
  const sections = parseSections(index);
  it('одна карточка на раздел, с числом, параметрами и ограничением', () => {
    expect(sections.map(s => s.key)).toEqual(['pass_through', 'cycles', 'resilience', 'data_requests', 'future_thing']);
    const pt = sections[0]!;
    expect(pt.headline).toEqual({value: '3', label: 'счёта'});
    expect(pt.parameters.map(p => p.value)).toEqual(['2', '0,8–1,2']);
    expect(pt.limitations).toEqual(['Совпадение сроков не доказывает перевод тех же денег.']);
    expect(sections[2]!.headline?.value).toBe('25%');
    expect(sections[2]!.meaning).toContain('25%');
    expect(sections[4]!.headline).toEqual({value: '7', label: 'widgets'});
  });
  it('gid примеров — строки, без повторов, числа отброшены, не больше пяти', () => {
    expect(sections[0]!.exampleGids).toEqual([G[0], G[1]]);
    expect(sections[1]!.exampleGids).toEqual([G[0], G[1], G[2], G[3], G[4]]);
    expect(sections[1]!.exampleGids.length).toBe(MAX_EXAMPLE_GIDS);
    expect(sections[2]!.exampleGids).toEqual([G[2], G[3]]);
    expect(sections[3]!.exampleGids).toEqual([G[5], G[6]]);
    for (const s of sections) for (const g of s.exampleGids) expect(typeof g).toBe('string');
  });
  it('кнопка передаёт в onSelect точную строку gid', () => {
    const got: unknown[] = [];
    const all = buttons(<InsightsPanel index={index} onSelect={g => got.push(g)} />);
    expect(all.length).toBe(2 + 5 + 2 + 2);
    all.forEach(b => b.props.onClick?.());
    expect(got[0]).toBe(G[0]);
    expect(got.every(g => typeof g === 'string' && G.includes(g as never))).toBe(true);
  });
  it('в разметке — русские заголовки, ограничения и точные gid', () => {
    const html = renderToStaticMarkup(<InsightsPanel index={index} onSelect={() => {}} />);
    for (const t of ['Быстрый транзит за 0–2 дня', 'Короткие циклы и возвраты', 'Цикл — структурный факт.',
      'не доказательство возврата', 'Наблюдения не доказывают', G[4]]) expect(html).toContain(t);
    expect(html).not.toMatch(/заблокирован|виновн/i);
  });
  it('без блока insights — пояснение вместо карточек', () => {
    const bare = buildIndex(makeAnalysis(false));
    expect(parseSections(bare)).toEqual([]);
    const html = renderToStaticMarkup(<InsightsPanel index={bare} onSelect={() => {}} />);
    expect(html).toContain('нет раздела наблюдений');
    expect(html).toContain('Честная проверка');
  });
});

describe('AccountInsights', () => {
  const index = buildIndex(makeAnalysis());
  it('строки by_gid для счёта с заголовком раздела', () => {
    expect(accountLines(index, G[0]).map(l => l.sectionTitle)).toEqual(['Быстрый транзит за 0–2 дня', 'Короткие циклы и возвраты']);
    const html = renderToStaticMarkup(<AccountInsights index={index} gid={G[0]} />);
    expect(html).toContain('Быстрый транзит: 3 из 4 исходящих');
  });
  it('нет строк — ничего не выводит (и соседний gid не совпадает)', () => {
    expect(renderToStaticMarkup(<AccountInsights index={index} gid={G[1]} />)).toBe('');
    expect(renderToStaticMarkup(<AccountInsights index={index} gid={'900719925474099311'} />)).toBe('');
  });
});

// Настоящий файл: INSIGHTS_REAL=/path/analysis.json npx vitest run --config src/features/insights/vitest.config.ts
const REAL = process.env.INSIGHTS_REAL;
describe.skipIf(!REAL || !fs.existsSync(REAL))('настоящий analysis.json', () => {
  it('каждый раздел даёт карточку с числом и ограничением', () => {
    const v = validateAnalysis(JSON.parse(fs.readFileSync(REAL!, 'utf8')));
    if (!v.ok) throw new Error(v.errors.join('\n'));
    const index = buildIndex(v.data);
    const sections = parseSections(index);
    const check = honestCheck(index);
    console.log(JSON.stringify({check, sections: sections.map(s => [s.key, s.headline, s.exampleGids.length, s.limitations.length])}));
    expect(sections.length).toBeGreaterThanOrEqual(9);
    for (const s of sections) { expect(s.headline).not.toBeNull(); expect(s.limitations.length).toBeGreaterThan(0); }
    for (const s of sections) for (const g of s.exampleGids) expect(index.byGid.has(g)).toBe(true);
    const html = renderToStaticMarkup(<InsightsPanel index={index} onSelect={() => {}} />);
    expect(html).toContain('Честная проверка');
  });
});
