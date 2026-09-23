import type {Mode} from '../../data/schema';
import {fetchReport, ReportError, type ReportFetcher, type ReportFile} from './report';

/**
 * Один просмотр PDF на рабочее место: запрос, ожидание, готовый файл или ошибка. Без React, чтобы жизненный
 * цикл временной ссылки на файл проверялся тестом: ссылка создаётся только для настоящего PDF и
 * освобождается при закрытии, при новом запросе и при смене набора данных.
 */
export type ReportSessionState =
  | {phase: 'idle'}
  | {phase: 'loading'; gids: readonly string[]; mode: Mode}
  | {phase: 'ready'; gids: readonly string[]; mode: Mode; file: ReportFile; url: string}
  | {phase: 'error'; gids: readonly string[]; mode: Mode; message: string};

export interface ReportSession {
  getState(): ReportSessionState;
  subscribe(listener: () => void): () => void;
  /** Запрашивает PDF; прежний запрос отменяется, прежняя ссылка освобождается. */
  request(gids: readonly string[], mode: Mode): Promise<void>;
  /** Повторяет запрос после ошибки. */
  retry(): Promise<void>;
  /** Закрывает просмотр: отменяет запрос и освобождает ссылку. Сессией можно пользоваться дальше. */
  close(): void;
}

export interface ReportSessionOptions {
  fetcher?: ReportFetcher;
  timeoutMs?: number;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

export function createReportSession(options: ReportSessionOptions = {}): ReportSession {
  const createUrl = options.createUrl ?? (blob => URL.createObjectURL(blob));
  const revokeUrl = options.revokeUrl ?? (url => URL.revokeObjectURL(url));
  const listeners = new Set<() => void>();
  let state: ReportSessionState = {phase: 'idle'};
  let inflight: AbortController | null = null;

  const set = (next: ReportSessionState) => {
    if (state.phase === 'ready' && (next.phase !== 'ready' || next.url !== state.url)) revokeUrl(state.url);
    state = next;
    for (const listener of listeners) listener();
  };

  const request = async (gids: readonly string[], mode: Mode) => {
    inflight?.abort();
    const abort = new AbortController();
    inflight = abort;
    const list = [...gids];
    set({phase: 'loading', gids: list, mode});
    try {
      const file = await fetchReport({gids: list, mode}, {fetcher: options.fetcher, signal: abort.signal, timeoutMs: options.timeoutMs});
      if (inflight !== abort) return;
      set({phase: 'ready', gids: list, mode, file, url: createUrl(file.blob)});
    } catch (error) {
      if (inflight !== abort) return;
      set({phase: 'error', gids: list, mode, message: error instanceof ReportError ? error.message : 'Не удалось получить отчёт. Попробуйте ещё раз.'});
    } finally {
      if (inflight === abort) inflight = null;
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    request,
    retry: () => (state.phase === 'error' ? request(state.gids, state.mode) : Promise.resolve()),
    close() {
      inflight?.abort();
      inflight = null;
      if (state.phase !== 'idle') set({phase: 'idle'});
    },
  };
}
