import {describe, expect, it} from 'vitest';
import {formatKzt, formatKztCompact} from '../src/data/format';

describe('[WEB-AMOUNT] суммы в тенге', () => {
  it('[WEB-AMOUNT] разряды и знак ₸ отделены неразрывными пробелами — сумма не делится', () => {
    const text = formatKzt(8588655);
    expect(text).not.toMatch(/ /);
    expect(text.replace(/[\u00a0\u202f]/g, '')).toBe('8588655₸');
  });
  it('[WEB-AMOUNT] краткая запись для сводок; до миллиона — точная сумма', () => {
    expect(formatKztCompact(29510727.39)).toBe('29,5\u00a0млн\u00a0₸');
    expect(formatKztCompact(1_234_000_000)).toBe('1,2\u00a0млрд\u00a0₸');
    expect(formatKztCompact(425500)).toBe(formatKzt(425500));
    expect(formatKztCompact(29510727.39)).not.toMatch(/ /);
  });
});
