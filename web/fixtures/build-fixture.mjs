// Строит web/fixtures/analysis.json — СИНТЕТИЧЕСКИЙ пример для разработки и тестов просмотрщика.
// Это не результат анализа выборки организаторов: счета, суммы, роли и приоритеты придуманы так,
// чтобы на экране встретилось каждое состояние (свёртка, циклы, граница выборки, изолированный клиент,
// путь только в режиме «тот же день»). Результат детерминирован: повторный запуск даёт тот же файл.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let seedState = 20260923;
const rand = () => { seedState = (seedState * 1103515245 + 12345) % 2147483648; return seedState / 2147483648; };
const usedMiddles = new Set();
// Формат похож на выборку (18 цифр), но префикс 999 заведомо отличает синтетику от реальных gid.
const makeGid = (suffix = '100') => {
  let middle;
  do middle = String(Math.floor(rand() * 1e8)).padStart(8, '0'); while (usedMiddles.has(middle));
  usedMiddles.add(middle);
  return `9990000${middle}${suffix}`;
};

const nodes = new Map();
const node = (name, depth, isSeed = false) => { nodes.set(name, {name, gid: makeGid(rand() < 0.5 ? '100' : '150'), depth, is_seed: isSeed}); return name; };
const tx = [];
const pay = (src, dst, day, sum) => tx.push({src, dst, date: `2026-07-${String(day).padStart(2, '0')}`, sum_kzt: sum});

// Исходные клиенты
for (let i = 1; i <= 10; i++) node(`S${i}`, 0, true);
// Группа консолидации: восемь плательщиков сходятся в C, дальше почти всё уходит в T1.
for (let i = 1; i <= 8; i++) node(`P${i}`, 1);
node('C', 2); node('T1', 3); node('Q', 1);
pay('S1', 'P1', 2, 400000); pay('S1', 'P2', 2, 350000); pay('S2', 'P3', 3, 500000); pay('S2', 'P4', 3, 220000);
pay('S3', 'P5', 4, 300000); pay('S3', 'P6', 4, 610000); pay('S4', 'P7', 5, 280000); pay('S4', 'P8', 20, 450000);
[[1, 8, 390000], [2, 8, 340000], [3, 9, 495000], [4, 9, 215000], [5, 10, 295000], [6, 10, 600000], [7, 11, 275000], [8, 12, 440000]]
  .forEach(([i, day, sum]) => pay(`P${i}`, 'C', day, sum));
pay('C', 'T1', 14, 3000000); pay('C', 'T1', 15, 40000);
// Связующий узел Q получает от двух клиентов и платит в три группы.
pay('S1', 'Q', 1, 900000); pay('S3', 'Q', 1, 700000);
pay('Q', 'P2', 2, 150000); pay('Q', 'D', 2, 800000); pay('Q', 'A', 3, 480000);
// Распределитель D: пятнадцать получателей, из них один — исходный клиент S9 (только входящие).
node('D', 1);
pay('S5', 'D', 1, 2100000);
for (let i = 1; i <= 14; i++) { node(`R${i}`, 2); pay('D', `R${i}`, 6, 60000 + ((i * 37) % 14) * 15000); }
pay('D', 'S9', 6, 120000);
node('W1', 3); node('Z1', 4); pay('R1', 'W1', 8, 50000); pay('W1', 'Z1', 9, 45000);
// Транзитная цепочка с датами по порядку: S2 → A → B → F → граница выборки.
node('A', 1); node('B', 2); node('F', 3); node('K', 3);
pay('S2', 'A', 3, 520000); pay('A', 'B', 4, 990000); pay('B', 'F', 6, 700000); pay('B', 'K', 6, 280000);
for (let i = 1; i <= 3; i++) { node(`Y${i}`, 4); pay('F', `Y${i}`, 7 + (i === 3 ? 1 : 0), 250000 - i * 10000); }
node('H4', 4); pay('F', 'H4', 8, 100000); pay('W1', 'H4', 9, 45000); pay('K', 'H4', 9, 60000);
// Возвратный поток: U ↔ G и цикл U → V → X → U.
node('U', 1); node('V', 2); node('X', 3); node('G', 2);
pay('S6', 'U', 3, 400000); pay('U', 'V', 4, 200000); pay('V', 'X', 5, 190000); pay('X', 'U', 7, 180000);
pay('U', 'G', 6, 90000); pay('G', 'U', 8, 85000); pay('X', 'H4', 8, 40000);
// Путь только в пределах одного дня: строгий порядок дат недоказуем, «тот же день» возможен.
node('E1', 1); node('E2', 2); node('E3', 3); node('E4', 4);
pay('S10', 'E1', 16, 300000); pay('E1', 'E2', 16, 295000); pay('E2', 'E3', 16, 290000); pay('E3', 'E4', 18, 280000); pay('E3', 'H4', 17, 5000);
// S7 и S8 — исходные клиенты без переводов в выборке.

const gidOf = name => nodes.get(name).gid;
const transactions = tx.map(t => ({src: gidOf(t.src), dst: gidOf(t.dst), date: t.date, sum_kzt: t.sum_kzt}))
  .sort((a, b) => a.date.localeCompare(b.date) || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst) || a.sum_kzt - b.sum_kzt);

const edgeMap = new Map();
for (const t of tx) {
  const key = `${t.src}>${t.dst}`;
  const e = edgeMap.get(key) ?? {src: t.src, dst: t.dst, sum_kzt: 0, n_tx: 0};
  e.sum_kzt += t.sum_kzt; e.n_tx += 1; edgeMap.set(key, e);
}
const edges = [...edgeMap.values()].map(e => ({src: gidOf(e.src), dst: gidOf(e.dst), sum_kzt: e.sum_kzt, n_tx: e.n_tx, depth: Math.min(4, nodes.get(e.src).depth + 1)}))
  .sort((a, b) => a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst));

// Метрики по рёбрам
const seedSet = new Set([...nodes.values()].filter(n => n.is_seed).map(n => n.gid));
const metrics = new Map([...nodes.values()].map(n => [n.gid, {in_degree: 0, out_degree: 0, in_kzt: 0, out_kzt: 0, in_tx: 0, out_tx: 0, seed_in_count: 0, seed_out_count: 0, pass_through: null}]));
for (const e of edges) {
  const s = metrics.get(e.src), d = metrics.get(e.dst);
  s.out_degree++; s.out_kzt += e.sum_kzt; s.out_tx += e.n_tx; if (seedSet.has(e.dst)) s.seed_out_count++;
  d.in_degree++; d.in_kzt += e.sum_kzt; d.in_tx += e.n_tx; if (seedSet.has(e.src)) d.seed_in_count++;
}
for (const [gid, m] of metrics) m.pass_through = !seedSet.has(gid) && m.in_kzt > 0 ? Math.round((m.out_kzt / m.in_kzt) * 1000) / 1000 : null;

// Достижимость от исходных клиентов: структура, строго позже по датам, тот же день возможен.
const gids = [...nodes.values()].map(n => n.gid).sort();
const outAdj = new Map(gids.map(g => [g, []]));
for (const e of edges) outAdj.get(e.src).push(e.dst);
const staticReach = new Map(gids.map(g => [g, new Set()]));
for (const seed of [...seedSet].sort()) {
  const seen = new Set([seed]); const queue = [seed];
  while (queue.length) for (const next of outAdj.get(queue.shift())) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  for (const g of seen) if (g !== seed) staticReach.get(g).add(seed);
}
function datedReach(strict) {
  const bySeed = new Map();
  for (const seed of [...seedSet].sort()) {
    const arrival = new Map([[seed, '0000-00-00']]); const parent = new Map();
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of transactions) {
        const at = arrival.get(t.src);
        if (at === undefined || (strict ? !(at < t.date) : !(at <= t.date)) || t.dst === seed) continue;
        const current = arrival.get(t.dst);
        if (current === undefined || t.date < current) { arrival.set(t.dst, t.date); parent.set(t.dst, t); changed = true; }
      }
    }
    bySeed.set(seed, {arrival, parent});
  }
  return bySeed;
}
const strictReach = datedReach(true), sameDayReach = datedReach(false);
function witnessFor(reach, gid) {
  let best = null;
  for (const [seed, {arrival}] of reach) {
    if (seed === gid || !arrival.has(gid)) continue;
    const date = arrival.get(gid);
    if (!best || date < best.date || (date === best.date && seed < best.seed)) best = {seed, date};
  }
  if (!best) return null;
  const {parent} = reach.get(best.seed); const hops = []; let cursor = gid;
  while (cursor !== best.seed) { const t = parent.get(cursor); hops.unshift({src: t.src, dst: t.dst, date: t.date, sum_kzt: t.sum_kzt}); cursor = t.src; }
  return {seed_gid: best.seed, hops};
}
const reachIds = (reach, gid) => [...reach].filter(([seed, {arrival}]) => seed !== gid && arrival.has(gid)).map(([seed]) => seed).sort();

// Роли, объяснения и приоритеты — заданы вручную для синтетики.
const R = (role, score, evidence, alternatives, priority, next) => ({role, score, evidence, alternatives, priority, next});
const alt = (role, score, reason) => ({role, score, reason});
const spec = {
  C: R('consolidator', 0.86, '8 разных плательщиков за 5 дней, 3,05 млн ₸; 99% полученного ушло одному получателю через 2–3 дня.', [alt('transit', 0.55, 'Почти вся сумма сразу уходит дальше одним переводом.')], 0.93, 'Запросить назначение платежей от 8 плательщиков и входящие переводы C за июнь.'),
  D: R('distributor', 0.9, '15 получателей за один день, 1,9 млн ₸ из 2,9 млн полученных; суммы похожи по размеру.', [alt('coordinator', 0.35, 'Получает также от связующего узла Q.')], 0.9, 'Запросить сведения о получателях и назначение переводов 6 июля.'),
  Q: R('coordinator', 0.62, 'Получает от 2 исходных клиентов и платит в 3 разные группы в течение 2 дней.', [alt('distributor', 0.48, '3 получателя — ниже порога распределителя.')], 0.88, 'Запросить связи Q с исходными клиентами вне банка и назначение платежей.'),
  U: R('transit', 0.58, 'Отдаёт 72% полученного; есть возвратные потоки U ↔ G и цикл U → V → X → U.', [alt('coordinator', 0.41, 'Участвует в двух циклах.')], 0.8, 'Запросить выписки U, V, X, G за июль целиком, включая мелкие переводы.'),
  A: R('transit', 0.83, 'Получил 1,0 млн ₸ от 2 плательщиков и через 1 день отдал 99% одному получателю.', [alt('consolidator', 0.3, 'Только 2 плательщика — ниже порога.')], 0.78, 'Запросить назначение платежа A → B от 4 июля.'),
  B: R('transit', 0.8, 'Отдал 99% полученного двум получателям через 2 дня после поступления.', [alt('distributor', 0.4, '2 получателя — ниже порога.')], 0.74, 'Запросить сведения о получателях F и K.'),
  F: R('transit', 0.66, 'Отдал 99% полученного; все получатели на границе выборки.', [alt('distributor', 0.52, '4 получателя, у всех исходящие не наблюдаются.')], 0.7, 'Расширить сбор на 5-й шаг для получателей F.'),
  H4: R('consolidator', 0.44, '5 разных плательщиков; исходящие не наблюдаются — граница выборки.', [alt('peripheral', 0.4, 'Небольшие суммы; роль нельзя уточнить без исходящих.')], 0.66, 'Расширить сбор: исходящие переводы H4 за июль–август.'),
  T1: R('terminal', 0.71, 'Получил 3,04 млн ₸ от одного отправителя; исходящих до 31 июля нет, запас наблюдения 16 дней.', [alt('peripheral', 0.3, 'Один плательщик.')], 0.64, 'Запросить исходящие переводы T1 вне банка и снятие наличных за август.'),
  E3: R('transit', 0.74, 'Цепочка из 3 переводов в один день, 16 июля; отдал 98% полученного.', [alt('peripheral', 0.2, 'Мало переводов.')], 0.6, 'Запросить время переводов 16 июля, чтобы установить порядок внутри дня.'),
  W1: R('transit', 0.6, 'Отдал 90% полученного на следующий день.', [alt('peripheral', 0.35, 'Малые суммы.')], 0.4, 'Уточнить назначение платежа W1 → Z1.'),
};
for (let i = 1; i <= 8; i++) spec[`P${i}`] = R('transit', 0.7 + i / 100, 'Отдал 97–99% полученного одному получателю C.', [alt('peripheral', 0.25, 'Один получатель и один плательщик.')], 0.5 + i / 100, 'Запросить назначение платежа в C.');
const clusterOf = name => {
  if (/^(S[1-4]|P\d|C|T1|Q)$/.test(name)) return 1;
  if (/^(S5|S9|D|R\d+|W1|Z1)$/.test(name)) return 2;
  if (/^(A|B|F|K|Y\d|H4)$/.test(name)) return 3;
  if (/^(S6|U|V|X|G)$/.test(name)) return 4;
  if (/^(S10|E\d)$/.test(name)) return 5;
  return name === 'S7' ? 6 : 7;
};

const out = [];
for (const n of [...nodes.values()].sort((a, b) => a.gid.localeCompare(b.gid))) {
  const m = metrics.get(n.gid);
  const censored = n.depth === 4 && m.out_degree === 0;
  const isolated = m.in_degree === 0 && m.out_degree === 0;
  const warnings = [];
  if (censored) warnings.push('Исходящие не наблюдаются: счёт на границе сбора данных (4 шага от исходных клиентов).');
  if (n.is_seed) warnings.push('Входящие переводы исходного клиента из-за пределов выборки не видны; баланс неполный.');
  if (isolated) warnings.push('В выборке нет ни одного перевода с участием этого счёта.');
  const s = spec[n.name] ?? R('peripheral', isolated ? 0.05 : 0.15 + (rand() * 0.1), isolated ? 'Исходный клиент без переводов в выборке.' : `Мало связей: ${m.in_degree} вх., ${m.out_degree} исх.; выраженных признаков роли нет.`,
    [alt('terminal', censored ? 0.1 : 0.12, censored ? 'Граница выборки: отсутствие исходящих не доказывает остановку денег.' : 'Мало исходящих.')], n.is_seed ? 0.3 + rand() * 0.15 : 0.1 + rand() * 0.2,
    censored ? 'Расширить сбор на 5-й шаг: исходящие переводы этого счёта.' : 'Дополнительный запрос не требуется, пока нет других признаков.');
  const round = v => Math.round(v * 1000) / 1000;
  out.push({
    gid: n.gid, depth: n.depth, is_seed: n.is_seed,
    role: s.role, role_score: round(s.score), cluster_id: clusterOf(n.name), priority_score: round(s.priority), evidence: s.evidence,
    metrics: m,
    observation: {outgoing_censored: censored, warnings},
    role_alternatives: [{role: s.role, score: round(s.score), reason: 'Основная гипотеза.'}, ...s.alternatives.map(a => ({...a, score: round(a.score)}))],
    next_request: s.next,
    temporal: {
      static_seed_count: staticReach.get(n.gid).size,
      strict_seed_count: reachIds(strictReach, n.gid).length,
      same_day_seed_count: reachIds(sameDayReach, n.gid).length,
      strict_seed_ids: reachIds(strictReach, n.gid),
      same_day_seed_ids: reachIds(sameDayReach, n.gid),
      strict_witness: witnessFor(strictReach, n.gid),
      same_day_witness: witnessFor(sameDayReach, n.gid),
    },
    _name: n.name,
  });
}

// Кластеры
const hypotheses = {
  1: 'Восемь промежуточных счетов переводят средства четырёх исходных клиентов в один счёт C; дальше почти вся сумма уходит одному получателю.',
  2: 'Один счёт раздаёт средства пятнадцати получателям в один день; один из получателей — исходный клиент.',
  3: 'Цепочка передачи с сохранением суммы (A → B → F); продолжение за границей выборки.',
  4: 'Небольшая группа с возвратными потоками: деньги возвращаются к отправителю через один или два шага.',
  5: 'Цепочка переводов внутри одного дня; порядок по датам установить нельзя.',
  6: 'Исходный клиент без переводов в выборке.',
  7: 'Исходный клиент без переводов в выборке.',
};
const byName = new Map(out.map(n => [n._name, n]));
const clusters = Object.keys(hypotheses).map(Number).map(id => {
  const members = out.filter(n => n.cluster_id === id);
  const set = new Set(members.map(n => n.gid));
  const internal = edges.filter(e => set.has(e.src) && set.has(e.dst)).reduce((sum, e) => sum + e.sum_kzt, 0);
  const top = [...members].sort((a, b) => b.priority_score - a.priority_score || a.gid.localeCompare(b.gid)).slice(0, 3).map(n => n.gid);
  return {cluster_id: id, n_nodes: members.length, n_seed: members.filter(n => n.is_seed).length, sum_kzt_internal: internal, top_gids: top, hypothesis: hypotheses[id]};
});

const ranked = [...out].sort((a, b) => b.priority_score - a.priority_score || a.gid.localeCompare(b.gid)).slice(0, 20);
const top_nodes = ranked.map((n, i) => ({rank: i + 1, gid: n.gid, role: n.role, priority_score: n.priority_score, why: n.evidence}));

// Слабые компоненты
const parentUF = new Map(gids.map(g => [g, g]));
const find = g => { while (parentUF.get(g) !== g) { parentUF.set(g, parentUF.get(parentUF.get(g))); g = parentUF.get(g); } return g; };
for (const e of edges) parentUF.set(find(e.src), find(e.dst));
const components = new Set(gids.map(find)).size;

const count = (reach, min) => out.filter(n => reachIds(reach, n.gid).length >= min).length;
const analysis = {
  schema_version: 'finance-workbench/v1',
  fixture: {synthetic: true, label: 'Синтетические данные для разработки интерфейса. Это не результат анализа выборки организаторов.'},
  summary: {
    n_nodes: out.length, n_edges: edges.length, n_transactions: transactions.length, n_seed: seedSet.size,
    total_kzt: transactions.reduce((sum, t) => sum + t.sum_kzt, 0),
    period_start: transactions[0].date, period_end: '2026-07-31',
    n_boundary: out.filter(n => n.observation.outgoing_censored).length,
    n_isolates: out.filter(n => n.metrics.in_degree + n.metrics.out_degree === 0).length,
    n_weak_components: components,
    input_sha256: crypto.createHash('sha256').update(JSON.stringify(transactions)).digest('hex'),
  },
  policy: {
    version: 'fixture-0',
    rules: [
      {role: 'consolidator', description: 'Много разных плательщиков у одного счёта.', thresholds: {min_payers: {value: 7, unit: 'разных плательщиков', rationale: 'Синтетика: порог для показа интерфейса.'}}},
      {role: 'transit', description: 'Отдаёт примерно столько же, сколько получил.', thresholds: {pass_through_low: {value: 0.8, unit: 'доля исходящей суммы от входящей', rationale: 'Синтетика.'}, pass_through_high: {value: 1.2, unit: 'доля исходящей суммы от входящей', rationale: 'Синтетика.'}}},
      {role: 'distributor', description: 'Много разных получателей у одного счёта.', thresholds: {min_recipients: {value: 10, unit: 'разных получателей', rationale: 'Синтетика.'}}},
      {role: 'terminal', description: 'Получает, но исходящих нет при достаточном запасе наблюдения.', thresholds: {min_margin_days: {value: 7, unit: 'дней после последнего поступления', rationale: 'Синтетика.'}, min_in_kzt: {value: 500000, unit: 'тенге поступлений', rationale: 'Синтетика.'}}},
      {role: 'coordinator', description: 'Связывает несколько групп и исходных клиентов.', thresholds: {min_seed_links: {value: 2, unit: 'разных исходных клиентов с прямыми переводами', rationale: 'Синтетика.'}}},
      {role: 'peripheral', description: 'Признаков других ролей не найдено.', thresholds: {role_signal_floor: {value: 0.5, unit: 'опора правила', rationale: 'Синтетика.'}}},
    ],
    priority_description: 'Синтетика: приоритет задан вручную, чтобы показать очередь. В реальном анализе он складывается из нескольких раскрытых групп признаков.',
    score_description: 'Опора правила — эвристическая сила признаков, а не вероятность и не вывод о виновности.',
    limitations: [
      'Собраны только исходящие переводы от исходных клиентов на глубину 4 шага.',
      'Переводы меньше 5 000 ₸ в выборку не попали.',
      'Порядок переводов внутри одного дня неизвестен.',
      'Полный баланс счёта по этим данным не вычисляется.',
    ],
  },
  nodes: out.map(({_name, ...rest}) => rest),
  edges, transactions, clusters, top_nodes,
  temporal_summary: {
    semantics: {
      structural: 'Путь по наблюдаемым переводам без учёта дат.',
      strict: 'Каждый следующий перевод строго позже предыдущего.',
      same_day: 'Переводы одного дня допускаются в любом порядке.',
    },
    reachable_from_at_least_1_seed: {static: out.filter(n => n.temporal.static_seed_count >= 1).length, strict: count(strictReach, 1), same_day: count(sameDayReach, 1)},
    reachable_from_at_least_5_seeds: {static: out.filter(n => n.temporal.static_seed_count >= 5).length, strict: count(strictReach, 5), same_day: count(sameDayReach, 5)},
  },
};
void byName;
const target = path.join(here, 'analysis.json');
fs.writeFileSync(target, JSON.stringify(analysis, null, 1) + '\n');
console.log(`Синтетический пример записан: ${path.relative(process.cwd(), target)} — ${out.length} счетов, ${edges.length} связей, ${transactions.length} переводов.`);
