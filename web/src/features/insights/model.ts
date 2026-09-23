/**
 * Чтение блока analysis.json['insights'] (schema finance-insights/v1, backend/insights.py) и «Честной проверки».
 * Блок необязателен и не входит в validateAnalysis, поэтому каждое поле проверяется здесь; незнакомое
 * отбрасывается, а не угадывается. Идентификаторы счетов остаются строками: Number() к ним не применяется.
 */
import type {GraphIndex} from '../../data/graph';
import {formatInt, formatPercent, plural} from '../../data/format';

export interface InsightParameter { name: string; value: string; unit: string }
export interface InsightSection {
  key: string; title: string;
  headline: {value: string; label: string} | null;
  meaning: string;
  parameters: InsightParameter[];
  limitations: string[];
  exampleGids: string[];
}
export interface AccountLine { section: string; sectionTitle: string; text: string }
export interface HonestCheck {
  naive: number; naiveAtBoundary: number; terminal: number; boundary: number; nodes: number;
  reach5: {static: number; strict: number; same_day: number} | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';
/** gid — только строка из цифр; число означало бы, что точность уже потеряна. */
export const isGid = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);

export const MAX_EXAMPLE_GIDS = 5;

export function readInsights(index: GraphIndex): Obj | null {
  const raw = (index.analysis as unknown as {insights?: unknown}).insights;
  return isObj(raw) && Array.isArray(raw.sections) ? raw : null;
}

const count = (counts: Obj, key: string) => (num(counts[key]) ? counts[key] as number : null);

function formatValue(v: unknown): string {
  if (num(v)) return Number.isInteger(v) ? formatInt(v) : String(v).replace('.', ',');
  if (Array.isArray(v)) return v.every(x => num(x)) && v.length === 2 ? `${formatValue(v[0])}–${formatValue(v[1])}` : v.map(formatValue).join(', ');
  if (str(v)) return v;
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  return '—';
}

/** Самое наглядное число раздела и его одна фраза смысла. Незнакомый раздел — первое числовое поле counts. */
function headlineOf(key: string, s: Obj, counts: Obj): {headline: InsightSection['headline']; meaning: string} {
  const n = (k: string) => count(counts, k);
  const h = (value: number | null, label: string, meaning: string) =>
    ({headline: value === null ? null : {value: formatInt(value), label}, meaning});
  const pl = (v: number | null, one: string, few: string, many: string) => (v === null ? many : plural(v, one, few, many));
  switch (key) {
    case 'pass_through': return h(n('accounts'), pl(n('accounts'), 'счёт', 'счёта', 'счетов'),
      'Столько счетов отправляли дальше сумму, сопоставимую с недавно полученной, в течение 0–2 дней.');
    case 'convergence': return h(n('events'), pl(n('events'), 'случай', 'случая', 'случаев'),
      'Столько раз на один счёт в один день поступали переводы от трёх и более разных плательщиков.');
    case 'bursts': return h(n('accounts'), pl(n('accounts'), 'счёт', 'счёта', 'счетов'),
      'У стольких счетов за два дня подряд переводов было намного больше их обычного темпа.');
    case 'routes': return h(n('routes_dated'), pl(n('routes_dated'), 'маршрут', 'маршрута', 'маршрутов'),
      'Столько цепочек A→B→C повторялись в разные дни с интервалом не больше двух дней между звеньями.');
    case 'cycles': return h(n('cycles'), pl(n('cycles'), 'цикл', 'цикла', 'циклов'),
      'Столько коротких кругов переводов есть в графе; это структура связей, а не доказательство возврата тех же денег.');
    case 'splitting': return h(n('pairs'), pl(n('pairs'), 'пара', 'пары', 'пар'),
      'Столько пар отправитель→получатель провели серию из нескольких переводов за два дня.');
    case 'depth_profile': return h(n('accounts'), pl(n('accounts'), 'счёт', 'счёта', 'счетов'),
      'Столько счетов заметно выделяются по суммам или числу связей среди счетов той же глубины.');
    case 'resilience': {
      const scenarios = Array.isArray(s.scenarios) ? s.scenarios.filter(isObj) : [];
      const priority = scenarios.filter(x => x.strategy === 'priority' && num(x.n_removed) && num(x.reachable_share))
        .sort((a, b) => (b.n_removed as number) - (a.n_removed as number))[0];
      const meaning = str(s.summary_text) ? s.summary_text
        : 'Расчёт на графе выборки: как меняется связность, если убрать счета из графа.';
      if (priority) return {headline: {value: formatPercent(1 - (priority.reachable_share as number)),
        label: `счетов становятся недостижимы в графе без ${formatInt(priority.n_removed as number)} счетов с наибольшим приоритетом`}, meaning};
      return h(n('baseline_components'), pl(n('baseline_components'), 'связная часть', 'связные части', 'связных частей'), meaning);
    }
    case 'data_requests': return h(n('requests'), pl(n('requests'), 'запрос', 'запроса', 'запросов'),
      'Каких данных не хватает, чтобы подтвердить или снять наблюдения выше.');
    default: {
      const first = Object.entries(counts).find(([, v]) => num(v));
      return {headline: first ? {value: formatInt(first[1] as number), label: first[0]} : null,
        meaning: str(s.method) ? (s.method.split(/(?<=\.)\s/)[0] ?? '') : ''};
    }
  }
}

function exampleGids(s: Obj): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { if (isGid(v) && !out.includes(v)) out.push(v); };
  const pools: unknown[] = Array.isArray(s.examples) ? [...s.examples] : [];
  if (Array.isArray(s.scenarios)) pools.push(...s.scenarios.filter(x => isObj(x) && x.strategy === 'priority'));
  for (const ex of pools) {
    if (!isObj(ex)) continue;
    for (const k of ['gid', 'src', 'dst']) add(ex[k]);
    for (const k of ['route', 'cycle', 'example_gids', 'removed_gids']) if (Array.isArray(ex[k])) (ex[k] as unknown[]).forEach(add);
    if (out.length >= MAX_EXAMPLE_GIDS) break;
  }
  return out.slice(0, MAX_EXAMPLE_GIDS);
}

export function parseSections(index: GraphIndex): InsightSection[] {
  const insights = readInsights(index);
  if (!insights) return [];
  return (insights.sections as unknown[]).filter(isObj).filter(s => str(s.key)).map(s => {
    const key = s.key as string;
    const counts = isObj(s.counts) ? s.counts : {};
    const params = isObj(s.parameters) ? s.parameters : {};
    return {
      key, title: str(s.title) ? s.title : key,
      ...headlineOf(key, s, counts),
      parameters: Object.entries(params).filter(([, p]) => isObj(p)).map(([name, p]) => ({
        name, value: formatValue((p as Obj).value), unit: str((p as Obj).unit) ? (p as Obj).unit as string : '',
      })),
      limitations: Array.isArray(s.limitations) ? s.limitations.filter(str) : [],
      exampleGids: exampleGids(s),
    };
  });
}

export function generalLimitations(index: GraphIndex): string[] {
  const insights = readInsights(index);
  return insights && Array.isArray(insights.limitations) ? insights.limitations.filter(str) : [];
}

export function accountLines(index: GraphIndex, gid: string): AccountLine[] {
  const insights = readInsights(index);
  if (!insights || !isObj(insights.by_gid)) return [];
  const lines = insights.by_gid[gid];
  if (!Array.isArray(lines)) return [];
  const titles = new Map<string, string>();
  for (const s of insights.sections as unknown[]) if (isObj(s) && str(s.key) && str(s.title)) titles.set(s.key, s.title);
  return lines.filter(isObj).filter(l => str(l.text)).map(l => {
    const section = str(l.section) ? l.section : '';
    return {section, sectionTitle: titles.get(section) ?? section, text: l.text as string};
  });
}

/** Всё считается по текущему файлу при каждом вызове: ни одного зашитого числа. */
export function honestCheck(index: GraphIndex): HonestCheck {
  let naive = 0, naiveAtBoundary = 0, terminal = 0, boundary = 0;
  for (const node of index.analysis.nodes) {
    const censored = node.observation?.outgoing_censored === true;
    if (node.metrics.in_degree > 0 && node.metrics.out_degree === 0) { naive++; if (censored) naiveAtBoundary++; }
    if (node.role === 'terminal') terminal++;
    if (censored) boundary++;
  }
  const r = index.analysis.temporal_summary?.reachable_from_at_least_5_seeds;
  const reach5 = isObj(r) && num(r.static) && num(r.strict) && num(r.same_day)
    ? {static: r.static, strict: r.strict, same_day: r.same_day} : null;
  return {naive, naiveAtBoundary, terminal, boundary, nodes: index.analysis.nodes.length, reach5};
}
