import fs from 'node:fs';
import path from 'node:path';
import {validateAnalysis, type Analysis} from '../src/data/schema';
import {buildIndex} from '../src/data/graph';

export const fixturePath = path.resolve(__dirname, '../fixtures/analysis.json');
export const loadFixtureRaw = (): Record<string, unknown> => JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
export function loadFixture() {
  const result = validateAnalysis(loadFixtureRaw());
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return {analysis: result.data as Analysis, index: buildIndex(result.data)};
}
/** gid + 1 строковой арифметикой: соседнее большое число без потери точности. */
export function incrementDecimal(gid: string): string {
  const digits = gid.split('');
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] !== '9') { digits[i] = String(Number(digits[i]) + 1); return digits.join(''); }
    digits[i] = '0';
  }
  return `1${digits.join('')}`;
}
