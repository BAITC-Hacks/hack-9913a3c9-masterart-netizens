import {formatKzt, formatKztCompact} from '../data/format';

/**
 * Краткая сумма для сводок: на экране «29,5 млн ₸», для экранного диктора и в подсказке — точная
 * сумма. Суммы меньше миллиона показываются точно, без сокращения.
 */
export function CompactKzt({value}: {value: number}) {
  const exact = formatKzt(value);
  const compact = formatKztCompact(value);
  if (compact === exact) return <span className="wb-amount">{exact}</span>;
  return <span className="wb-amount" title={exact}>
    <span aria-hidden="true">{compact}</span>
    <span className="wb-visually-hidden">{exact}</span>
  </span>;
}
