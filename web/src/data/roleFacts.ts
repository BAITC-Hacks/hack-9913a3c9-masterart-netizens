import type {AccountNode, PolicyRule} from './schema';
import {countLabel, formatInt, formatKzt, formatPercent, formatScore} from './format';

/**
 * Два-три факта, на которых держится гипотеза роли: число, подпись и порог правила, если он есть.
 * Числа берутся из metrics узла, пороги — из правила этой роли в policy; ничего не вычисляется заново,
 * кроме суммы двух полей. Незнакомая роль получает нейтральные факты об объёме связей.
 */
export interface RoleFact { value: string; label: string; threshold?: string; met?: boolean }

/**
 * Кандидаты роли в порядке конвейера: первый — содержательная альтернатива, которую называет текст
 * основания. Пересортировка по числу подняла бы «периферию», чья оценка обратная (1 минус сильнейший
 * признак). Один источник для панели оснований и для справки.
 */
export const roleAlternatives = (node: AccountNode) => node.role_alternatives.filter(a => a.role !== node.role);

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

/**
 * finance-policy/2 снижает опору «сигналов нет», когда наблюдение неполное. Факт называет условие, которое
 * применил конвейер (код role_basis), вместо оборота: иначе низкая опора выглядела бы необъяснённой.
 */
const REDUCED_SUPPORT: Record<string, (m: AccountNode['metrics']) => RoleFact> = {
  'peripheral.short_window': m => ({value: m.value_window_days == null ? '—' : formatInt(m.value_window_days), label: 'дней наблюдения после основной суммы: окно короткое, опора снижена'}),
  'peripheral.late_inflow': m => ({value: m.value_window_days == null ? '—' : formatInt(m.value_window_days), label: 'дней до конца периода: основная сумма пришла поздно, опора снижена'}),
  'peripheral.cutoff': () => ({value: 'нет', label: 'данных об исходящих: граница сбора, опора снижена'}),
};

/**
 * @param distinctCounterparties число разных счетов, с которыми есть переводы в любую сторону. Сумма
 *   in_degree + out_degree считает встречного партнёра дважды, поэтому число передаёт вызывающий код.
 * @param transitRule правило транзита: по нему объясняется отклонённый транзит у периферийного счёта.
 */
export function roleFacts(node: AccountNode, rule: PolicyRule | undefined, distinctCounterparties: number, transitRule?: PolicyRule): RoleFact[] {
  const m = node.metrics;
  // Правила второй версии сами считают контрагентов без повторов; для первой берётся число из окрестности.
  const counterparties = typeof m.counterparties === 'number' ? m.counterparties : distinctCounterparties;
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
      // finance-policy/2: в коридор должны попасть обе доли — ушедшая дальше после поступлений по датам и вся.
      if (m.forward_share !== undefined) {
        const band = low !== undefined && high !== undefined ? {threshold: `коридор ${formatPercent(low)}–${formatPercent(high)}`} : undefined;
        const share = (value: number | null, label: string): RoleFact => ({value: value === null ? '—' : formatPercent(value), label,
          ...(band ? {...band, met: value !== null && value >= low! && value <= high!} : {})});
        return [share(m.forward_share, 'ушло дальше после поступлений'), share(ratio, 'всего отправлено от полученного'), {value: formatKzt(m.in_kzt), label: 'получено'}];
      }
      return [
        {value: ratio === null ? '—' : formatScore(ratio), label: 'доля отданного от полученного',
          ...(low !== undefined && high !== undefined ? {threshold: `коридор ${formatScore(low)}–${formatScore(high)}`, met: ratio !== null && ratio >= low && ratio <= high} : {})},
        {value: formatKzt(m.in_kzt), label: 'получено'},
        {value: formatKzt(m.out_kzt), label: 'отправлено'},
      ];
    }
    case 'terminal': {
      const lastInflow = extraNumber(node, 'observation_margin_days');
      const valueWindow = typeof m.value_window_days === 'number' ? m.value_window_days : undefined;
      const valueShare = thresholdOf(rule, 'window_value_share');
      const marginLimit = thresholdOf(rule, 'min_margin_days', 'min_observation_days');
      const payersLimit = thresholdOf(rule, 'min_payers');
      const amountLimit = thresholdOf(rule, 'min_in_kzt');
      const facts: RoleFact[] = [];
      // Вторая версия правил считает окно от дня, к которому пришла основная часть суммы, и допускает небольшие
      // исходящие. Подпись «без исходящих» верна только для счёта, у которого исходящих нет вовсе.
      const needDays = (n: number) => `нужно ≥ ${formatInt(n)}`;
      if (valueWindow !== undefined) {
        facts.push({value: formatInt(valueWindow), label: `дней после поступления ${valueShare === undefined ? 'основной части' : formatPercent(valueShare)} суммы`, ...atLeast(valueWindow, marginLimit, needDays)});
      } else if (lastInflow !== undefined) {
        facts.push({value: formatInt(lastInflow), label: m.out_degree === 0 ? 'дней без исходящих после последнего поступления' : 'дней после последнего поступления', ...atLeast(lastInflow, marginLimit, needDays)});
      }
      // Накопление — условие «или»: достаточно плательщиков ИЛИ суммы. Видны обе ветки: выполненная
      // стоит первой, вторая помечена «или», поэтому невыполненная ветка не читается как провал правила.
      const payersMet = payersLimit !== undefined && m.in_degree >= payersLimit;
      const amountMet = amountLimit !== undefined && m.in_kzt >= amountLimit;
      const amountFirst = amountMet && !payersMet;
      const branch = (limit: number | undefined, met: boolean, text: string, second: boolean): Pick<RoleFact, 'threshold' | 'met'> =>
        limit === undefined ? {} : {met, threshold: second ? `или ${text}` : text};
      const payersFact: RoleFact = {value: formatInt(m.in_degree), label: 'разных плательщиков',
        ...branch(payersLimit, payersMet, `от ${countLabel(payersLimit ?? 0, 'плательщика', 'плательщиков', 'плательщиков')}`, amountFirst)};
      const amountFact: RoleFact = {value: formatKzt(m.in_kzt), label: 'получено',
        ...branch(amountLimit, amountMet, `от ${formatKzt(amountLimit ?? 0)}`, !amountFirst && payersLimit !== undefined)};
      facts.push(...(amountFirst ? [amountFact, payersFact] : [payersFact, amountFact]));
      const maxShare = thresholdOf(rule, 'max_pass_through');
      if (m.out_degree === 0) facts.push({value: '0', label: 'исходящих получателей'});
      else facts.push({value: m.pass_through === null ? '—' : formatPercent(m.pass_through), label: 'полученного ушло дальше',
        ...(maxShare === undefined ? {} : {threshold: `не больше ${formatPercent(maxShare)}`, met: m.pass_through !== null && m.pass_through <= maxShare})});
      return facts;
    }
    case 'coordinator': {
      const links = extraNumber(node, 'seed_links') ?? m.seed_in_count + m.seed_out_count;
      const limit = thresholdOf(rule, 'min_seed_links', 'min_seed_payers');
      return [
        {value: formatInt(links), label: 'исходных клиентов с прямыми переводами', ...atLeast(links, limit, n => `порог ${formatInt(n)}`)},
        {value: `${formatInt(m.seed_in_count)} · ${formatInt(m.seed_out_count)}`, label: 'от них · к ним'},
        {value: formatInt(counterparties), label: 'разных контрагентов'},
      ];
    }
    default: {
      // Счёт без переводов роль не получает по признакам: показывать «сильнейший признак ниже порога» было бы неверно.
      if (m.in_tx + m.out_tx === 0) return [{value: '0', label: 'переводов в выгрузке'}, {value: '—', label: 'роль по признакам не оценивается'}];
      const strongest = Math.max(0, ...node.role_alternatives.filter(a => a.role !== node.role).map(a => a.score));
      const floor = thresholdOf(rule, 'role_signal_floor');
      const reduced = node.role_basis ? REDUCED_SUPPORT[node.role_basis] : undefined;
      // Отклонённый транзит (finance-policy/2): вся доля исходящих в коридоре, а доля, ушедшая дальше после
      // поступлений, — нет. Этот факт объясняет, почему счёт с балансом «сколько пришло, столько ушло» не транзит.
      const low = thresholdOf(transitRule, 'pass_through_low', 'pass_through_min');
      const high = thresholdOf(transitRule, 'pass_through_high', 'pass_through_max');
      const within = (v: number | null | undefined) => v != null && low !== undefined && high !== undefined && v >= low && v <= high;
      if (!reduced && m.forward_share !== undefined && within(m.pass_through) && !within(m.forward_share)) {
        return [
          {value: formatInt(counterparties), label: 'разных контрагентов'},
          {value: formatPercent(m.pass_through!), label: 'всего отправлено от полученного', threshold: `коридор ${formatPercent(low!)}–${formatPercent(high!)}`, met: true},
          {value: m.forward_share === null ? '—' : formatPercent(m.forward_share), label: 'ушло дальше после поступлений: транзит датами не подтверждён',
            threshold: `коридор ${formatPercent(low!)}–${formatPercent(high!)}`, met: false},
        ];
      }
      return [
        {value: formatInt(counterparties), label: 'разных контрагентов'},
        reduced ? reduced(m) : {value: formatKzt(m.in_kzt + m.out_kzt), label: 'оборот'},
        {value: formatScore(strongest), label: 'сильнейший признак другой роли',
          ...(floor === undefined ? {} : {threshold: `ниже ${formatScore(floor)}`, met: strongest < floor})},
      ];
    }
  }
}
