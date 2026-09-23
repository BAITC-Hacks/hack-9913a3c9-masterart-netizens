import {useCallback, useEffect, useRef, useState} from 'react';
import type {Mode} from '../data/schema';
import {formatHash, parseHash} from './hash';

/**
 * История переходов между счетами — это история браузера, других копий нет. Каждая запись помечена
 * порядковым номером, поэтому стрелки «Назад» и «Вперёд» на карте знают свои границы и совпадают с
 * кнопками браузера. Новый выбор после «Назад» отбрасывает записи впереди (так делает и браузер);
 * смена режима дат меняет текущую запись, а не добавляет новую.
 */
export interface AccountEntry { gid: string | null; mode: Mode }
const MAX_KEY = 'wb-history-max';

const stampedIndex = (): number | null => {
  const state = window.history.state as {wbIndex?: unknown} | null;
  return typeof state?.wbIndex === 'number' ? state.wbIndex : null;
};
const storedMax = (fallback: number) => {
  try { const value = Number(window.sessionStorage.getItem(MAX_KEY)); return Number.isInteger(value) && value >= fallback ? value : fallback; }
  catch { return fallback; }
};

export function useAccountHistory(onEntry: (entry: AccountEntry) => void) {
  // Новая, ещё не помеченная запись начинает историю заново: старый максимум из этой вкладки не в счёт.
  const [nav, setNav] = useState(() => { const index = stampedIndex(); return index === null ? {index: 0, max: 0} : {index, max: storedMax(index)}; });
  const navRef = useRef(nav);
  navRef.current = nav;
  const onEntryRef = useRef(onEntry);
  onEntryRef.current = onEntry;

  const remember = useCallback((index: number, max: number) => {
    setNav({index, max});
    try { window.sessionStorage.setItem(MAX_KEY, String(max)); } catch { /* приватный режим: границы живут до перезагрузки */ }
  }, []);

  const push = useCallback((entry: AccountEntry) => {
    const next = navRef.current.index + 1;
    window.history.pushState({wbIndex: next}, '', formatHash(entry));
    remember(next, next);
  }, [remember]);

  const replace = useCallback((entry: AccountEntry) => {
    if (stampedIndex() === null) remember(navRef.current.index, navRef.current.max);
    window.history.replaceState({wbIndex: navRef.current.index}, '', formatHash(entry));
  }, [remember]);

  useEffect(() => {
    // popstate приходит и на «Назад/Вперёд», и на ручную правку адреса; у последней нет номера — это новая запись.
    const onPop = () => {
      const stamped = stampedIndex();
      if (stamped === null) {
        const next = navRef.current.index + 1;
        window.history.replaceState({wbIndex: next}, '', window.location.hash);
        remember(next, next);
      } else remember(stamped, Math.max(navRef.current.max, stamped));
      onEntryRef.current(parseHash(window.location.hash));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [remember]);

  return {
    push, replace,
    canBack: nav.index > 0,
    canForward: nav.index < nav.max,
    back: () => window.history.back(),
    forward: () => window.history.forward(),
  };
}
export type AccountHistory = ReturnType<typeof useAccountHistory>;
