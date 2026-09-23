import {createContext, useContext, useEffect, useRef, useSyncExternalStore} from 'react';
import type {Mode} from '../../data/schema';
import {countLabel} from '../../data/format';
import {Gid} from '../../ui/Gid';
import {Icon} from '../../map/icons';
import type {ReportSession, ReportSessionState} from './reportSession';

export const ReportSessionContext = createContext<ReportSession | null>(null);

/** Сессия просмотра PDF из явного свойства или из ShortlistProvider. */
export function useReportSession(explicit?: ReportSession): ReportSession {
  const fromContext = useContext(ReportSessionContext);
  const session = explicit ?? fromContext;
  if (!session) throw new Error('Просмотр PDF не подключён: оберните рабочее место в ShortlistProvider.');
  return session;
}

export function useReportState(session: ReportSession): ReportSessionState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}

function Title({state}: {state: ReportSessionState}) {
  if (state.phase === 'idle') return null;
  if (state.gids.length === 1) return <>Справка PDF по счёту <Gid gid={state.gids[0]!} /></>;
  return <>Отчёт PDF по {countLabel(state.gids.length, 'счёту', 'счетам', 'счетам')}</>;
}

/**
 * Просмотр PDF поверх рабочего места (модальный dialog: фокус внутри, Esc закрывает). Файл показывается
 * встроенным просмотрщиком браузера; если браузер его не показывает (часть телефонов), видны ссылки
 * «Открыть» и «Скачать». Закрытие освобождает временную ссылку на файл.
 */
export function ReportDialog({session}: {session: ReportSession}) {
  const state = useReportState(session);
  const ref = useRef<HTMLDialogElement>(null);
  const open = state.phase !== 'idle';

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return <dialog ref={ref} className="wb-report" aria-labelledby="wb-report-title" onClose={() => session.close()}>
    <header className="wb-report__head">
      <h2 id="wb-report-title" className="wb-report__title"><Title state={state} /></h2>
      <div className="wb-report__actions">
        {state.phase === 'ready' && <>
          <a className="wb-button" href={state.url} download={state.file.filename}><Icon name="download" size={16} />Скачать</a>
          <a className="wb-button wb-button--quiet" href={state.url} target="_blank" rel="noopener">Открыть в новой вкладке</a>
        </>}
        <button type="button" className="wb-report__close" onClick={() => session.close()} aria-label="Закрыть просмотр">
          <Icon name="close" size={16} />
        </button>
      </div>
    </header>
    <div className="wb-report__body">
      {state.phase === 'loading' && <p className="wb-report__status" role="status" aria-busy="true">
        Готовим PDF по {countLabel(state.gids.length, 'счёту', 'счетам', 'счетам')}…
      </p>}
      {state.phase === 'error' && <div className="wb-report__status" role="alert">
        <p className="wb-report__error">{state.message}</p>
        <button type="button" className="wb-button" onClick={() => void session.retry()}>Повторить</button>
      </div>}
      {state.phase === 'ready' && <object className="wb-report__frame" data={state.url} type="application/pdf" aria-label={`Просмотр файла ${state.file.filename}`}>
        <div className="wb-report__status">
          <p>Этот браузер не показывает PDF внутри страницы.</p>
          <p><a href={state.url} target="_blank" rel="noopener">Открыть {state.file.filename}</a> или <a href={state.url} download={state.file.filename}>скачать файл</a>.</p>
        </div>
      </object>}
    </div>
  </dialog>;
}

/** Справка PDF по открытому счёту: тот же просмотр, что и отчёт по сохранённым. */
export function AccountReportButton({gid, mode, report}: {gid: string; mode: Mode; report?: ReportSession}) {
  const session = useReportSession(report);
  const state = useReportState(session);
  const busy = state.phase === 'loading' && state.gids.length === 1 && state.gids[0] === gid;
  return <button type="button" className="wb-button wb-report-button" onClick={() => void session.request([gid], mode)}
    disabled={busy} aria-busy={busy || undefined}>
    {busy ? 'Готовим PDF…' : 'Справка PDF'}
  </button>;
}
