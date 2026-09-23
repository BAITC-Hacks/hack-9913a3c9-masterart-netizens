import {describe, expect, it} from 'vitest';
import {formatHash, parseHash} from '../src/app/hash';

describe('[WEB-LINK] ссылка на счёт в адресе', () => {
  it('[WEB-LINK] gid остаётся строкой, режим читается', () => {
    expect(parseHash('#gid=100000005382566100&mode=strict')).toEqual({gid: '100000005382566100', mode: 'strict'});
  });
  it('[WEB-LINK] без mode — режим по умолчанию, чтобы «Назад» и перезагрузка совпадали', () => {
    expect(parseHash('#gid=100000005382566100').mode).toBe('structural');
    expect(parseHash('').mode).toBe('structural');
    expect(parseHash('#mode=unknown').mode).toBe('structural');
  });
  it('[WEB-LINK] запись и чтение взаимно обратны; режим по умолчанию не пишется', () => {
    expect(formatHash({gid: '100000005382566100', mode: 'structural'})).toBe('#gid=100000005382566100');
    for (const mode of ['structural', 'strict', 'same_day'] as const) {
      expect(parseHash(formatHash({gid: '999000012345678100', mode}))).toEqual({gid: '999000012345678100', mode});
    }
  });
});
