import type {Mode} from '../data/schema';

/** Состояние в адресе: #gid=…&mode=… — ссылку на счёт можно переслать коллеге. gid остаётся строкой. */
const MODES: readonly Mode[] = ['structural', 'strict', 'same_day'];

export function readHash(): {gid: string | null; mode: Mode | null} {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const gid = params.get('gid');
  const mode = params.get('mode');
  return {gid: gid && /^\d+$/.test(gid) ? gid : gid ? gid : null, mode: MODES.includes(mode as Mode) ? (mode as Mode) : null};
}

export function writeHash(state: {gid: string | null; mode: Mode}, push: boolean) {
  const params = new URLSearchParams();
  if (state.gid) params.set('gid', state.gid);
  if (state.mode !== 'structural') params.set('mode', state.mode);
  const next = `#${params.toString()}`;
  if (next === window.location.hash) return;
  if (push) window.history.pushState(null, '', next);
  else window.history.replaceState(null, '', next);
}
