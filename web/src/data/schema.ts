/**
 * Контракт файла out/analysis.json (schema_version «finance-workbench/v1») и его проверка при загрузке.
 *
 * Главный инвариант: идентификаторы счетов (gid, src, dst, seed_gid) — это строки из цифр.
 * Все 18-значные gid превышают точный диапазон целых чисел JavaScript, поэтому число вместо строки
 * означает, что точность уже потеряна. Такой файл отклоняется целиком, а не «чинится».
 */
export const SCHEMA_VERSION = 'finance-workbench/v1';

export const KNOWN_ROLES = ['consolidator', 'transit', 'distributor', 'terminal', 'coordinator', 'peripheral'] as const;
export type KnownRole = (typeof KNOWN_ROLES)[number];
/** Словарь ролей можно расширить с документацией; незнакомая роль показывается как есть. */
export type Role = KnownRole | (string & {});

export type Mode = 'structural' | 'strict' | 'same_day';

export interface Metrics {
  in_degree: number; out_degree: number;
  in_kzt: number; out_kzt: number;
  in_tx: number; out_tx: number;
  seed_in_count: number; seed_out_count: number;
  pass_through: number | null;
  /** Поля правил finance-policy/2. В файлах первой версии их нет, поэтому они необязательны. */
  counterparties?: number;
  forward_share?: number | null;
  value_window_days?: number | null;
}
export interface Observation { outgoing_censored: boolean; warnings: string[] }
export interface RoleAlternative { role: Role; score: number; reason: string; basis?: string }
export interface WitnessHop { src: string; dst: string; date: string; sum_kzt: number }
export interface Witness { seed_gid: string; hops: WitnessHop[] }
export interface Temporal {
  static_seed_count: number; strict_seed_count: number; same_day_seed_count: number;
  strict_seed_ids: string[]; same_day_seed_ids: string[];
  strict_witness: Witness | null; same_day_witness: Witness | null;
}
export interface AccountNode {
  gid: string; depth: number; is_seed: boolean;
  role: Role; role_score: number; role_basis?: string; cluster_id: number; priority_score: number; evidence: string;
  metrics: Metrics; observation: Observation; role_alternatives: RoleAlternative[];
  next_request: string; temporal: Temporal;
}
export interface Edge { src: string; dst: string; sum_kzt: number; n_tx: number; depth: number }
export interface Transaction { src: string; dst: string; date: string; sum_kzt: number }
export interface Cluster {
  cluster_id: number; n_nodes: number; n_seed: number; sum_kzt_internal: number;
  top_gids: string[]; hypothesis: string;
}
export interface TopNode { rank: number; gid: string; role: Role; priority_score: number; why: string }
export interface PolicyRule { role: string; description: string; thresholds: unknown }
export interface Policy {
  version: string; rules: PolicyRule[];
  priority_description: string; score_description: string; limitations: string[];
}
export interface Summary {
  n_nodes: number; n_edges: number; n_transactions: number; n_seed: number; total_kzt: number;
  period_start: string; period_end: string; n_boundary: number; n_isolates: number;
  n_weak_components: number; input_sha256: string;
}
/** Необязательная пометка синтетического примера для разработки; интерфейс показывает её всегда. */
export interface FixtureMark { synthetic: true; label: string }
export interface Analysis {
  schema_version: string; summary: Summary; policy: Policy;
  nodes: AccountNode[]; edges: Edge[]; transactions: Transaction[];
  clusters: Cluster[]; top_nodes: TopNode[]; temporal_summary: Record<string, unknown>;
  fixture?: FixtureMark;
}

export type Validation = {ok: true; data: Analysis; warnings: string[]} | {ok: false; errors: string[]};

const DIGITS = /^\d{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ERRORS = 8;

/** Проверяет форму файла и точность идентификаторов. Ссылочные расхождения — предупреждения, не отказ. */
export function validateAnalysis(raw: unknown): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (message: string) => { if (errors.length < MAX_ERRORS) errors.push(message); };
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const gid = (v: unknown, where: string) => {
    if (typeof v === 'number') { fail(`${where}: идентификатор записан числом, точность уже потеряна (ожидается строка из цифр)`); return false; }
    if (typeof v !== 'string' || !DIGITS.test(v)) { fail(`${where}: ожидается строка из цифр, получено ${JSON.stringify(v)}`); return false; }
    return true;
  };

  if (!isObj(raw)) return {ok: false, errors: ['Файл не содержит объект JSON верхнего уровня']};
  if (raw.schema_version !== SCHEMA_VERSION) {
    return {ok: false, errors: [`Версия схемы: ожидается «${SCHEMA_VERSION}», получено ${JSON.stringify(raw.schema_version)}`]};
  }
  for (const key of ['summary', 'policy', 'temporal_summary'] as const) if (!isObj(raw[key])) fail(`Нет обязательного объекта «${key}»`);
  for (const key of ['nodes', 'edges', 'transactions', 'clusters', 'top_nodes'] as const) if (!Array.isArray(raw[key])) fail(`Нет обязательного массива «${key}»`);
  if (errors.length) return {ok: false, errors};

  const nodes = raw.nodes as unknown[];
  const seen = new Set<string>();
  nodes.forEach((n, i) => {
    if (errors.length >= MAX_ERRORS) return;
    if (!isObj(n)) { fail(`nodes[${i}]: не объект`); return; }
    if (!gid(n.gid, `nodes[${i}].gid`)) return;
    const id = n.gid as string;
    if (seen.has(id)) fail(`nodes[${i}]: повтор gid ${id}`);
    seen.add(id);
    for (const k of ['depth', 'role_score', 'cluster_id', 'priority_score']) if (!num(n[k])) fail(`nodes[${i}].${k}: ожидается число`);
    if (typeof n.role !== 'string' || !n.role) fail(`nodes[${i}].role: пусто`);
    if (typeof n.evidence !== 'string' || !n.evidence) fail(`nodes[${i}].evidence: пусто`);
    if (!isObj(n.metrics)) fail(`nodes[${i}].metrics: нет`);
    if (!isObj(n.observation)) fail(`nodes[${i}].observation: нет`);
    if (!Array.isArray(n.role_alternatives)) fail(`nodes[${i}].role_alternatives: нет`);
    if (!isObj(n.temporal)) { fail(`nodes[${i}].temporal: нет`); return; }
    const t = n.temporal;
    for (const key of ['strict_seed_ids', 'same_day_seed_ids'] as const) {
      if (!Array.isArray(t[key])) fail(`nodes[${i}].temporal.${key}: нет`);
      else (t[key] as unknown[]).forEach((s, j) => gid(s, `nodes[${i}].temporal.${key}[${j}]`));
    }
    for (const key of ['strict_witness', 'same_day_witness'] as const) {
      const w = t[key];
      if (w === null) continue;
      if (!isObj(w) || !Array.isArray(w.hops)) { fail(`nodes[${i}].temporal.${key}: неверная форма`); continue; }
      gid(w.seed_gid, `nodes[${i}].temporal.${key}.seed_gid`);
      (w.hops as unknown[]).forEach((h, j) => {
        if (!isObj(h)) { fail(`nodes[${i}].temporal.${key}.hops[${j}]: не объект`); return; }
        gid(h.src, `…${key}.hops[${j}].src`); gid(h.dst, `…${key}.hops[${j}].dst`);
        if (typeof h.date !== 'string' || !DATE.test(h.date)) fail(`…${key}.hops[${j}].date: ожидается ГГГГ-ММ-ДД`);
        if (!num(h.sum_kzt)) fail(`…${key}.hops[${j}].sum_kzt: ожидается число`);
      });
    }
  });

  (raw.edges as unknown[]).forEach((e, i) => {
    if (errors.length >= MAX_ERRORS) return;
    if (!isObj(e)) { fail(`edges[${i}]: не объект`); return; }
    const ok = gid(e.src, `edges[${i}].src`) && gid(e.dst, `edges[${i}].dst`);
    if (!num(e.sum_kzt) || !num(e.n_tx)) fail(`edges[${i}]: сумма и число переводов должны быть числами`);
    if (ok && (!seen.has(e.src as string) || !seen.has(e.dst as string))) warnings.push(`Связь ${String(e.src)} → ${String(e.dst)} ссылается на счёт вне списка узлов`);
  });
  (raw.transactions as unknown[]).forEach((t, i) => {
    if (errors.length >= MAX_ERRORS) return;
    if (!isObj(t)) { fail(`transactions[${i}]: не объект`); return; }
    gid(t.src, `transactions[${i}].src`); gid(t.dst, `transactions[${i}].dst`);
    if (typeof t.date !== 'string' || !DATE.test(t.date)) fail(`transactions[${i}].date: ожидается ГГГГ-ММ-ДД`);
  });
  (raw.clusters as unknown[]).forEach((c, i) => {
    if (errors.length >= MAX_ERRORS) return;
    if (!isObj(c) || !num(c.cluster_id) || !Array.isArray(c.top_gids)) { fail(`clusters[${i}]: неверная форма`); return; }
    (c.top_gids as unknown[]).forEach((g, j) => gid(g, `clusters[${i}].top_gids[${j}]`));
  });
  (raw.top_nodes as unknown[]).forEach((t, i) => {
    if (errors.length >= MAX_ERRORS) return;
    if (!isObj(t)) { fail(`top_nodes[${i}]: не объект`); return; }
    gid(t.gid, `top_nodes[${i}].gid`);
    if (!num(t.rank)) fail(`top_nodes[${i}].rank: ожидается число`);
  });

  if (errors.length) return {ok: false, errors};
  if (warnings.length > 20) warnings.splice(20, warnings.length - 20, `…и ещё ${warnings.length - 20} предупреждений`);
  return {ok: true, data: raw as unknown as Analysis, warnings};
}
