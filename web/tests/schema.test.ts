import {describe, expect, it} from 'vitest';
import {validateAnalysis} from '../src/data/schema';
import {loadFixtureRaw} from './helpers';

describe('[WEB-SCHEMA] проверка файла анализа', () => {
  it('[WEB-SCHEMA] синтетический пример проходит проверку и помечен как синтетика', () => {
    const result = validateAnalysis(loadFixtureRaw());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.fixture?.synthetic).toBe(true);
  });
  it('[WEB-SCHEMA] чужая версия схемы отклоняется', () => {
    const raw = {...loadFixtureRaw(), schema_version: 'finance-workbench/v0'};
    const result = validateAnalysis(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('finance-workbench/v1');
  });
  it('[WEB-SCHEMA] отсутствие обязательного массива отклоняется', () => {
    const raw = loadFixtureRaw();
    delete raw.transactions;
    expect(validateAnalysis(raw).ok).toBe(false);
  });
});

describe('[WEB-GID-EXACT] идентификаторы остаются строками', () => {
  it('[WEB-GID-EXACT] gid, записанный числом, отклоняется целиком', () => {
    const raw = loadFixtureRaw() as {nodes: {gid: unknown}[]};
    raw.nodes[0]!.gid = Number(raw.nodes[0]!.gid as string);
    const result = validateAnalysis(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('точность уже потеряна');
  });
  it('[WEB-GID-EXACT] src перевода, записанный числом, отклоняется', () => {
    const raw = loadFixtureRaw() as {transactions: {src: unknown}[]};
    raw.transactions[0]!.src = 100000000343175100;
    expect(validateAnalysis(raw).ok).toBe(false);
  });
  it('[WEB-GID-EXACT] 18-значный gid за пределами точных чисел JavaScript', () => {
    const {nodes} = loadFixtureRaw() as {nodes: {gid: string}[]};
    const gid = nodes[0]!.gid;
    expect(gid).toMatch(/^\d{18}$/);
    expect(Number.isSafeInteger(Number(gid))).toBe(false);
  });
});
