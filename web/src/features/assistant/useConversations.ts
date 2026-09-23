import {useEffect, useMemo, useSyncExternalStore} from 'react';
import {CONVERSATIONS_KEY, createConversationStore, type ConversationSnapshot, type ConversationStorage, type ConversationStore} from './conversationStore';

/** localStorage, если браузер даёт в него писать; иначе null — разговоры живут в памяти и об этом сказано. */
export function conversationStorage(): ConversationStorage | null {
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

/** Разговоры текущего набора данных; другая вкладка с тем же ключом перечитывается автоматически. */
export function useConversations(scope: string, storage?: ConversationStorage | null): {snapshot: ConversationSnapshot; store: ConversationStore} {
  const backend = useMemo(() => (storage === undefined ? conversationStorage() : storage), [storage]);
  const store = useMemo(() => createConversationStore({scope, storage: backend}), [scope, backend]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent) => { if (event.key === CONVERSATIONS_KEY) store.reload(); };
    const onHide = () => store.flush();
    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', onHide);
    return () => { store.flush(); window.removeEventListener('storage', onStorage); window.removeEventListener('pagehide', onHide); };
  }, [store]);
  return {snapshot, store};
}
