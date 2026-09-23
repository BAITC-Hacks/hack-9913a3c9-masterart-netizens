import type {Mode} from '../data/schema';

/**
 * Состояние в адресе: #gid=…&mode=… — ссылку на счёт можно переслать коллеге. gid остаётся строкой.
 * Отсутствующий mode означает режим по умолчанию («без дат»), поэтому «Назад» и перезагрузка
 * одной и той же ссылки всегда показывают одно и то же.
 */
const MODES: readonly Mode[] = ['structural', 'strict', 'same_day'];

export function parseHash(hash: string): {gid: string | null; mode: Mode} {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const gid = params.get('gid');
  const mode = params.get('mode');
  return {gid: gid ? gid.trim() : null, mode: MODES.includes(mode as Mode) ? (mode as Mode) : 'structural'};
}

export const readHash = () => parseHash(window.location.hash);

export function formatHash(state: {gid: string | null; mode: Mode}): string {
  const params = new URLSearchParams();
  if (state.gid) params.set('gid', state.gid);
  if (state.mode !== 'structural') params.set('mode', state.mode);
  return `#${params.toString()}`;
}

export function writeHash(state: {gid: string | null; mode: Mode}, push: boolean) {
  const next = formatHash(state);
  if (next === window.location.hash) return;
  if (push) window.history.pushState(null, '', next);
  else window.history.replaceState(null, '', next);
}
