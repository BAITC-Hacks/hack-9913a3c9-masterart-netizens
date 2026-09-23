import {describe, expect, it} from 'vitest';
import {normalizeGidInput, searchAccounts} from '../src/data/search';
import {incrementDecimal, loadFixture} from './helpers';

const {index} = loadFixture();
const gid = index.gids[5]!;

describe('[WEB-SEARCH] поиск по точному gid', () => {
  it('[WEB-SEARCH] точное совпадение, в том числе с пробелами между группами', () => {
    expect(searchAccounts(index, gid)).toEqual({kind: 'exact', gid});
    const spaced = gid.replace(/(\d{3})(?=\d)/g, '$1 ');
    expect(searchAccounts(index, spaced)).toEqual({kind: 'exact', gid});
    expect(searchAccounts(index, `  ${gid} `)).toEqual({kind: 'exact', gid});
  });
  it('[WEB-SEARCH] соседнее большое число не выбирает реальный счёт', () => {
    const neighbour = incrementDecimal(gid);
    expect(index.byGid.has(neighbour)).toBe(false);
    // Как числа JavaScript они неразличимы — поэтому сравнение идёт только по строкам.
    expect(Number(neighbour)).toBe(Number(gid));
    const outcome = searchAccounts(index, neighbour);
    expect(outcome.kind).toBe('not_found');
  });
  it('[WEB-SEARCH] число, прошедшее через Number(), не находит исходный счёт', () => {
    const rounded = String(Number(gid));
    if (rounded !== gid) expect(searchAccounts(index, rounded).kind).not.toBe('exact');
    expect(searchAccounts(index, Number(gid).toExponential()).kind).toBe('invalid');
  });
  it('[WEB-SEARCH] частичное совпадение только предлагается и никогда не выбирается само', () => {
    const outcome = searchAccounts(index, gid.slice(-6));
    expect(outcome.kind).toBe('partial');
    if (outcome.kind === 'partial') expect(outcome.matches).toContain(gid);
  });
  it('[WEB-SEARCH] буквы и экспоненциальная запись отклоняются с пояснением', () => {
    expect('problem' in (normalizeGidInput('12ab34') ?? {})).toBe(true);
    expect(searchAccounts(index, '1.0000000034E+17').kind).toBe('invalid');
    expect(searchAccounts(index, '').kind).toBe('empty');
  });
});
