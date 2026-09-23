import type {AccountNode, PolicyRule} from './schema';
import {formatInt, formatKzt, formatScore} from './format';

/**
 * Два-три факта, на которых держится гипотеза роли: число, подпись и порог правила, если он есть.
 * Числа берутся из metrics узла, пороги — из правила этой роли в policy; ничего не вычисляется заново,
 * кроме суммы двух полей. Незнакомая роль получает нейтральные факты об объёме связей.
 */
export interface RoleFact { value: string; label: string; threshold?: string; met?: boolean }

function thresholdOf(rule: PolicyRule | undefined, ...keys: string[]): number | undefined {
  const table = rule?.thresholds;
  if (!table || typeof table !== 'object') return undefined;
  for (const key of keys) {
    const raw = (table as Record<string, unknown>)[key];
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).value : raw;
    if (typeof value === 'number') return value;
  }
  return undefined;
}

const extraNumber = (node: AccountNode, key: string) => {
  const value = (node.metrics as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
};

export function roleFacts(node: AccountNode, rule: PolicyRule | undefined): RoleFact[] {
  const m = node.metrics;
  const atLeast = (value: number, limit: number | undefined, text: (n: number) => string): Pick<RoleFact, 'threshold' | 'met'> =>
    limit === undefined ? {} : {threshold: text(limit), met: value >= limit};
  switch (node.role) {
    case 'consolidator': {
      const limit = thresholdOf(rule, 'min_payers', 'min_distinct_payers');
      return [
        {value: formatInt(m.in_degree), label: 'разных плательщиков', ...atLeast(m.in_degree, limit, n => `порог ${formatInt(n)}`)},
        {value: formatKzt(m.in_kzt), label: 'получено'},
        {value: formatInt(m.in_tx), label: 'входящих переводов'},
      ];
    }
    case 'distributor': {
      const limit = thresholdOf(rule, 'min_recipients', 'min_distinct_recipients');
      return [
        {value: formatInt(m.out_degree), label: 'разных получателей', ...atLeast(m.out_degree, limit, n => `порог ${formatInt(n)}`)},
        {value: formatKzt(m.out_kzt), label: 'отправлено'},
        {value: formatInt(m.out_tx), label: 'исходящих переводов'},
      ];
    }
    case 'transit': {
      const low = thresholdOf(rule, 'pass_through_low', 'pass_through_min');
      const high = thresholdOf(rule, 'pass_through_high', 'pass_through_max');
      const ratio = m.pass_through;
      return [
        {value: ratio === null ? '—' : formatScore(ratio), label: 'доля отданного от полученного',
          ...(low !== undefined && high !== undefined ? {threshold: `коридор ${formatScore(low)}–${formatScore(high)}`, met: ratio !== null && ratio >= low && ratio <= high} : {})},
        {value: formatKzt(m.in_kzt), label: 'получено'},
        {value: formatKzt(m.out_kzt), label: 'отправлено'},
      ];
    }
    case 'terminal': {
      const margin = extraNumber(node, 'observation_margin_days');
      const marginLimit = thresholdOf(rule, 'min_margin_days', 'min_observation_days');
      const amountLimit = thresholdOf(rule, 'min_in_kzt');
      const facts: RoleFact[] = [];
      if (margin !== undefined) facts.push({value: formatInt(margin), label: 'дней без исходящих после последнего поступления', ...atLeast(margin, marginLimit, n => `нужно ≥ ${formatInt(n)}`)});
      facts.push({value: formatKzt(m.in_kzt), label: 'получено', ...atLeast(m.in_kzt, amountLimit, n => `порог ${formatKzt(n)}`)});
      facts.push({value: formatInt(m.out_degree), label: 'исходящих получателей'});
      return facts;
    }
    case 'coordinator': {
      const links = extraNumber(node, 'seed_links') ?? m.seed_in_count + m.seed_out_count;
      const limit = thresholdOf(rule, 'min_seed_links', 'min_seed_payers');
      return [
        {value: formatInt(links), label: 'исходных клиентов с прямыми переводами', ...atLeast(links, limit, n => `порог ${formatInt(n)}`)},
        {value: `${formatInt(m.seed_in_count)} · ${formatInt(m.seed_out_count)}`, label: 'от них · к ним'},
        {value: formatInt(m.in_degree + m.out_degree), label: 'контрагентов всего'},
      ];
    }
    default: {
      const strongest = Math.max(0, ...node.role_alternatives.filter(a => a.role !== node.role).map(a => a.score));
      const floor = thresholdOf(rule, 'role_signal_floor');
      return [
        {value: formatInt(m.in_degree + m.out_degree), label: 'контрагентов'},
        {value: formatKzt(m.in_kzt + m.out_kzt), label: 'оборот'},
        {value: formatScore(strongest), label: 'сильнейший признак другой роли',
          ...(floor === undefined ? {} : {threshold: `ниже ${formatScore(floor)}`, met: strongest < floor})},
      ];
    }
  }
}
