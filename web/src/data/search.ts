import type {GraphIndex} from './graph';

/**
 * Поиск счёта. Выбирается только точное совпадение всей строки цифр. Соседнее большое число
 * (например, gid + 1) никогда не выбирает реальный счёт: сравнение идёт по строкам, а частичные
 * совпадения только предлагаются списком и требуют явного выбора.
 */
export type SearchOutcome =
  | {kind: 'empty'}
  | {kind: 'invalid'; message: string}
  | {kind: 'exact'; gid: string}
  | {kind: 'partial'; digits: string; matches: string[]; total: number}
  | {kind: 'not_found'; digits: string};

const SEPARATORS = /[\s   _'’.,-]/g;
const SCIENTIFIC = /^[+-]?\d+(?:[.,]\d+)?e[+-]?\d+$/i;
const MIN_PARTIAL = 4;
const MAX_MATCHES = 8;

/** Приводит ввод к строке цифр. Разделители разрядов допускаются; экспоненциальная запись — нет. */
export function normalizeGidInput(raw: string): {digits: string} | {problem: string} | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (SCIENTIFIC.test(trimmed.replace(/\s/g, ''))) {
    return {problem: 'Это число в экспоненциальной записи: при таком округлении точный gid уже потерян. Скопируйте идентификатор как текст.'};
  }
  const digits = trimmed.replace(SEPARATORS, '');
  if (!/^\d+$/.test(digits)) return {problem: 'Идентификатор счёта состоит только из цифр.'};
  return {digits};
}

export function searchAccounts(index: GraphIndex, raw: string): SearchOutcome {
  const normal = normalizeGidInput(raw);
  if (!normal) return {kind: 'empty'};
  if ('problem' in normal) return {kind: 'invalid', message: normal.problem};
  const {digits} = normal;
  if (index.byGid.has(digits)) return {kind: 'exact', gid: digits};
  if (digits.length < MIN_PARTIAL) return {kind: 'partial', digits, matches: [], total: 0};
  const matches: string[] = [];
  let total = 0;
  for (const gid of index.gids) {
    if (gid.includes(digits)) {
      total += 1;
      if (matches.length < MAX_MATCHES) matches.push(gid);
    }
  }
  return total ? {kind: 'partial', digits, matches, total} : {kind: 'not_found', digits};
}
