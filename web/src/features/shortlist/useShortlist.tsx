import {createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode} from 'react';
import type {GraphIndex} from '../../data/graph';
import {createShortlistStore, shortlistKey, type ShortlistActions, type ShortlistSnapshot, type ShortlistStorage} from './store';
import type {ReportFetcher} from './report';
import {createReportSession} from './reportSession';
import {ReportDialog, ReportSessionContext} from './ReportDialog';

/** Состояние списка и действия над ним одним объектом; новый объект — только когда список изменился. */
export type ShortlistController = ShortlistSnapshot & ShortlistActions;

/**
 * localStorage, если браузер действительно даёт в него писать; иначе null. В приватном режиме и при
 * запрете хранилища обращение бросает исключение — тогда список работает в памяти и честно об этом говорит.
 */
export function browserStorage(): ShortlistStorage | null {
  try {
    const storage = window.localStorage;
    const probe = 'finance-workbench:probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/**
 * Список сохранённых счетов текущего анализа. Ключ хранилища — summary.input_sha256, поэтому смена набора
 * данных открывает его собственный список, а прежний остаётся нетронутым. storage: undefined — localStorage
 * браузера, null — только память (так же ведёт себя приватный режим).
 */
export function useShortlist(index: GraphIndex, storage?: ShortlistStorage | null): ShortlistController {
  const scope = index.analysis.summary.input_sha256;
  const backend = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage]);
  const store = useMemo(
    () => createShortlistStore({scope, isKnown: gid => index.byGid.has(gid), storage: backend}),
    [scope, index, backend],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // Другая вкладка изменила этот же список — перечитываем, чтобы кнопки и список не расходились.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const key = shortlistKey(scope);
    const onStorage = (event: StorageEvent) => { if (event.key === key) store.reload(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [scope, store]);

  return useMemo(() => ({
    ...snapshot,
    has: store.has, save: store.save, remove: store.remove, toggle: store.toggle, undoRemove: store.undoRemove,
    setSelected: store.setSelected, selectAll: store.selectAll, selectNone: store.selectNone,
    dismissIssues: store.dismissIssues, selectedGids: store.selectedGids,
  }), [snapshot, store]);
}

const ShortlistContext = createContext<ShortlistController | null>(null);

/**
 * Один список и один просмотр PDF на всё рабочее место: кнопка в основаниях, панель списка и справка по
 * счёту видят одно состояние. Просмотр закрывается и освобождает файл при смене набора данных.
 */
export function ShortlistProvider({index, storage, fetcher, children}: {
  index: GraphIndex; storage?: ShortlistStorage | null; fetcher?: ReportFetcher; children: ReactNode;
}) {
  const controller = useShortlist(index, storage);
  const report = useMemo(() => createReportSession({fetcher}), [fetcher]);
  useEffect(() => () => report.close(), [report, index]);
  return <ShortlistContext.Provider value={controller}>
    <ReportSessionContext.Provider value={report}>
      {children}
      <ReportDialog session={report} />
    </ReportSessionContext.Provider>
  </ShortlistContext.Provider>;
}

/** Контроллер из явного свойства или из ShortlistProvider. */
export function useShortlistController(explicit?: ShortlistController): ShortlistController {
  const fromContext = useContext(ShortlistContext);
  const controller = explicit ?? fromContext;
  if (!controller) throw new Error('Список сохранённых счетов не подключён: оберните рабочее место в ShortlistProvider.');
  return controller;
}
