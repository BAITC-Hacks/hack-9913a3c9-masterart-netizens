import type {Mode, Witness} from './schema';
import {compileNeighborhood, type NeighborLink} from './neighborhood';
import {pairDateRange, type GraphIndex} from './graph';
import {MODE_LABEL, REACH_CAVEAT, countLabel, formatDate, formatInt, formatKzt, formatScore, roleLabel} from './format';

/**
 * Справка для проверки в Markdown. Она только собирает факты, уже записанные в файле анализа:
 * ни одна цифра не вычисляется заново, кроме сумм по показанным связям. Формулировки — гипотезы.
 */
const code = (gid: string) => `\`${gid}\``;
const TOP_COUNTERPARTIES = 8;

function witnessLines(witness: Witness | null, index: GraphIndex): string[] {
  if (!witness) return ['Путь не найден в этом режиме.'];
  const lines = [`Исходный клиент ${code(witness.seed_gid)}, ${countLabel(witness.hops.length, 'переход', 'перехода', 'переходов')}:`];
  witness.hops.forEach((hop, i) => {
    const role = index.byGid.get(hop.dst)?.role;
    lines.push(`${i + 1}. ${formatDate(hop.date, true)}: ${code(hop.src)} → ${code(hop.dst)}${role ? ` (${roleLabel(role).toLowerCase()})` : ''} — ${formatKzt(hop.sum_kzt)}`);
  });
  return lines;
}

function counterpartyLine(index: GraphIndex, focus: string, link: NeighborLink, side: 'in' | 'out'): string {
  const edge = side === 'in' ? link.toFocus! : link.fromFocus!;
  const range = side === 'in' ? pairDateRange(index, link.gid, focus) : pairDateRange(index, focus, link.gid);
  const dates = range ? (range.first === range.last ? `, ${formatDate(range.first)}` : `, ${formatDate(range.first)} — ${formatDate(range.last)}`) : '';
  const role = link.node ? roleLabel(link.node.role).toLowerCase() : 'счёт вне списка узлов';
  return `- ${code(link.gid)} — ${role}; ${formatKzt(edge.sum_kzt)}, ${countLabel(edge.n_tx, 'перевод', 'перевода', 'переводов')}${dates}`;
}

export function buildReviewBrief(index: GraphIndex, gid: string, mode: Mode, generatedAt?: string): string | null {
  const node = index.byGid.get(gid);
  const hood = compileNeighborhood(index, gid);
  if (!node || !hood) return null;
  const {analysis} = index;
  const m = node.metrics;
  const alt = [...node.role_alternatives].sort((a, b) => b.score - a.score).find(a => a.role !== node.role);
  const rank = index.topRank.get(gid);
  const cluster = index.clusters.get(node.cluster_id);
  const out: string[] = [];

  out.push(`# Справка для проверки: счёт ${gid}`, '');
  if (analysis.fixture?.synthetic) out.push(`> **Синтетический пример для разработки.** ${analysis.fixture.label}`, '');
  out.push('> Это гипотеза для проверки, а не вывод о виновности клиента. Роль и приоритет — эвристические оценки по наблюдаемой структуре переводов.', '');
  out.push(`Источник: файл анализа (схема ${analysis.schema_version}, правила ${analysis.policy.version}, входные данные sha256 ${analysis.summary.input_sha256}), период ${formatDate(analysis.summary.period_start, true)} — ${formatDate(analysis.summary.period_end, true)}.`);
  if (generatedAt) out.push(`Составлено: ${generatedAt}.`);
  out.push('');

  out.push('## Гипотеза роли', '');
  out.push(`- Роль: **${roleLabel(node.role)}**, опора правила ${formatScore(node.role_score)}. ${analysis.policy.score_description}`);
  out.push(`- Основание: ${node.evidence}`);
  out.push(alt ? `- Ближайшая альтернатива: ${roleLabel(alt.role)} (${formatScore(alt.score)}) — ${alt.reason}` : '- Альтернативная роль в файле не указана.');
  out.push('');

  out.push('## Приоритет проверки', '');
  out.push(`- Оценка приоритета: ${formatScore(node.priority_score)}; ${rank ? `место в очереди проверки: ${rank}` : 'в топ-список очереди не входит'}.`);
  out.push(`- Как считается приоритет: ${analysis.policy.priority_description}`);
  out.push('');

  out.push('## Наблюдаемые потоки', '');
  out.push('| | Входящие | Исходящие |', '|---|---:|---:|');
  out.push(`| Контрагентов | ${formatInt(m.in_degree)} | ${formatInt(m.out_degree)} |`);
  out.push(`| Переводов | ${formatInt(m.in_tx)} | ${formatInt(m.out_tx)} |`);
  out.push(`| Сумма | ${formatKzt(m.in_kzt)} | ${formatKzt(m.out_kzt)} |`);
  out.push(`| Связей с исходными клиентами | ${formatInt(m.seed_in_count)} | ${formatInt(m.seed_out_count)} |`, '');
  out.push(`- Отношение исходящих к входящим: ${m.pass_through === null ? 'не определено по наблюдаемым данным' : formatScore(m.pass_through)}.`);
  out.push(`- Шагов от исходных клиентов: ${node.depth}; ${node.is_seed ? 'это исходный клиент выборки' : 'не исходный клиент'}.`, '');

  const payers = [...hood.payers, ...hood.mutual].slice(0, TOP_COUNTERPARTIES);
  const recipients = [...hood.recipients, ...hood.mutual].slice(0, TOP_COUNTERPARTIES);
  out.push('### Крупнейшие контрагенты', '');
  out.push(payers.length ? 'Платили этому счёту:' : 'Входящих переводов в выборке нет.');
  for (const link of payers) out.push(counterpartyLine(index, gid, link, 'in'));
  out.push('');
  out.push(recipients.length ? 'Получали от этого счёта:' : 'Исходящих переводов в выборке нет.');
  for (const link of recipients) out.push(counterpartyLine(index, gid, link, 'out'));
  out.push('');
  if (hood.cycles.length) {
    out.push('Возвратные потоки (направленные циклы через этот счёт):');
    for (const cycle of hood.cycles) out.push(`- ${[...cycle, cycle[0]!].map(code).join(' → ')}`);
    out.push('');
  }

  out.push('## Границы наблюдения', '');
  if (node.observation.outgoing_censored) out.push('- Исходящие переводы не наблюдаются из-за границы сбора данных. Это не доказывает, что деньги остались на счёте.');
  for (const warning of node.observation.warnings) out.push(`- ${warning}`);
  if (!node.observation.outgoing_censored && !node.observation.warnings.length) out.push('- Для этого счёта особых ограничений не отмечено; общие ограничения данных — ниже.');
  out.push('');

  const t = node.temporal;
  out.push(`## Пути от исходных клиентов (выбранный режим: ${MODE_LABEL[mode]})`, '');
  out.push(`- Исходных клиентов, от которых есть путь: структура — ${formatInt(t.static_seed_count)}, позже по датам — ${formatInt(t.strict_seed_count)}, тот же день возможен — ${formatInt(t.same_day_seed_count)}.`, '');
  out.push(`Пример пути «${MODE_LABEL.strict}»:`, '', ...witnessLines(t.strict_witness, index), '');
  out.push(`Пример пути «${MODE_LABEL.same_day}»:`, '', ...witnessLines(t.same_day_witness, index), '');
  out.push(`> ${REACH_CAVEAT}`, '');

  if (cluster) {
    out.push(`## Кластер ${cluster.cluster_id}`, '');
    out.push(`- ${countLabel(cluster.n_nodes, 'счёт', 'счёта', 'счетов')}, из них исходных клиентов: ${formatInt(cluster.n_seed)}; внутренний оборот ${formatKzt(cluster.sum_kzt_internal)}.`);
    out.push(`- Гипотеза о структуре: ${cluster.hypothesis}`, '');
  }

  out.push('## Следующий запрос данных', '', node.next_request, '');
  if (analysis.policy.limitations.length) {
    out.push('## Ограничения данных', '');
    for (const limit of analysis.policy.limitations) out.push(`- ${limit}`);
    out.push('');
  }
  out.push('---', 'Справка собрана локально в «Граф денег» из файла анализа; значения перенесены без изменений.', '');
  return out.join('\n');
}

export const briefFileName = (gid: string) => `spravka-${gid}.md`;
