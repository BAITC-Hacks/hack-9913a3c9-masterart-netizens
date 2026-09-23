import {useEffect, useRef, useState} from 'react';
import type {GraphIndex} from '../../data/graph';
import type {Mode} from '../../data/schema';
import {MODE_LABEL, countLabel, formatInt} from '../../data/format';
import {Gid} from '../../ui/Gid';
import {RoleTag} from '../../ui/RoleGlyph';
import {Icon} from '../../map/icons';
import type {ShortlistIssue} from './store';
import {REPORT_MAX_ACCOUNTS, ReportError, downloadReport, fetchReport, type ReportFetcher, type ReportFile} from './report';
import {useShortlistController, type ShortlistController} from './useShortlist';
import {BookmarkGlyph} from './SaveAccountButton';

const accounts = (n: number) => countLabel(n, 'счёт', 'счёта', 'счетов');

/** Честное описание проблемы со списком — что случилось и что теперь с данными. */
export function issueText(issue: ShortlistIssue): string {
  switch (issue.kind) {
    case 'unavailable': return 'Браузер не разрешает сохранять данные на этом устройстве. Список действует до перезагрузки страницы.';
    case 'write_failed': return 'Не удалось записать список в браузер. Изменения видны сейчас, но пропадут после перезагрузки.';
    case 'reset': return 'Сохранённый список не удалось прочитать, начат новый. Прежние записи не были точными gid.';
    case 'recovered': return `Сохранённый список был повреждён: ${accounts(issue.dropped)} без точного gid ${issue.dropped === 1 ? 'пропущен' : 'пропущены'}, остальные на месте.`;
    case 'unknown': return `${accounts(issue.hidden)} из сохранённых нет в текущем анализе — ${issue.hidden === 1 ? 'он скрыт' : 'они скрыты'}.`;
  }
}

type ReportState =
  | {phase: 'idle'}
  | {phase: 'loading'; count: number}
  | {phase: 'done'; count: number; filename: string}
  | {phase: 'error'; message: string};

export interface ShortlistPanelProps {
  index: GraphIndex;
  /** Режим дат рабочего места; с ним же строится отчёт. */
  mode: Mode;
  /** Открытый сейчас счёт — отмечается в списке. */
  current?: string | null;
  /** Открыть счёт в рабочем месте (выбор, карта, основания). */
  onOpen: (gid: string) => void;
  /** Явный контроллер; без него берётся ShortlistProvider. */
  controller?: ShortlistController;
  /** Подмена запроса и сохранения файла — для проверок. */
  fetcher?: ReportFetcher;
  onReport?: (file: ReportFile) => void;
}

/**
 * Сохранённые счета: отдельный вид для возврата к счетам и выбора их в PDF-отчёт. Счёт открывается нажатием
 * на строку, убирается крестиком с возможностью вернуть. Отмеченные галочкой счета уходят в отчёт.
 */
export function ShortlistPanel({index, mode, current = null, onOpen, controller, fetcher, onReport = downloadReport}: ShortlistPanelProps) {
  const shortlist = useShortlistController(controller);
  const {gids, selected, issues, lastRemoved} = shortlist;
  const chosen = gids.filter(gid => selected.has(gid));
  const allChosen = gids.length > 0 && chosen.length === gids.length;
  const overLimit = chosen.length > REPORT_MAX_ACCOUNTS;

  const [report, setReport] = useState<ReportState>({phase: 'idle'});
  const inflight = useRef<AbortController | null>(null);
  useEffect(() => () => inflight.current?.abort(), []);
  // Выбор изменился — прежнее сообщение об отчёте больше не относится к нему.
  const selectionKey = chosen.join(',');
  useEffect(() => { setReport(state => (state.phase === 'loading' ? state : {phase: 'idle'})); }, [selectionKey, mode]);

  const requestReport = async () => {
    if (!chosen.length || overLimit || report.phase === 'loading') return;
    const abort = new AbortController();
    inflight.current = abort;
    setReport({phase: 'loading', count: chosen.length});
    try {
      const file = await fetchReport({gids: chosen, mode}, {fetcher, signal: abort.signal});
      if (abort.signal.aborted) return;
      onReport(file);
      setReport({phase: 'done', count: file.count, filename: file.filename});
    } catch (error) {
      if (abort.signal.aborted) return;
      setReport({phase: 'error', message: error instanceof ReportError ? error.message : 'Не удалось получить отчёт. Попробуйте ещё раз.'});
    } finally {
      if (inflight.current === abort) inflight.current = null;
    }
  };

  const loading = report.phase === 'loading';
  return <section className="wb-shortlist" aria-labelledby="wb-shortlist-title">
    <header className="wb-shortlist__head">
      <h2 id="wb-shortlist-title" className="wb-shortlist__title">Сохранённые счета</h2>
      <span className="wb-count" aria-label={accounts(gids.length)}>{formatInt(gids.length)}</span>
    </header>

    {issues.length > 0 && <div className="wb-notice wb-shortlist__notice" role="status">
      <Icon name="alert" size={16} />
      <span>{issues.map(issue => <span key={issue.kind} className="wb-shortlist__issue">{issueText(issue)}</span>)}</span>
      <button type="button" className="wb-shortlist__dismiss" onClick={shortlist.dismissIssues} aria-label="Скрыть сообщение">
        <Icon name="close" size={14} />
      </button>
    </div>}

    {gids.length === 0
      ? <div className="wb-shortlist__empty">
          <span className="wb-shortlist__empty-glyph"><BookmarkGlyph size={22} /></span>
          <p className="wb-shortlist__empty-title">Сохранённых счетов пока нет</p>
          <p className="wb-muted">Откройте счёт и нажмите «Сохранить» рядом с его gid. Счёт появится здесь и останется после перезагрузки страницы.</p>
        </div>
      : <>
          <div className="wb-shortlist__bar">
            <button type="button" className="wb-shortlist__all" onClick={allChosen ? shortlist.selectNone : shortlist.selectAll}>
              {allChosen ? 'Снять выбор' : 'Выбрать все'}
            </button>
            <span className="wb-muted" aria-live="polite">В отчёт: {formatInt(chosen.length)} из {formatInt(gids.length)}</span>
          </div>
          <ul className="wb-shortlist__list">
            {gids.map(gid => {
              const node = index.byGid.get(gid);
              const rank = index.topRank.get(gid);
              const isCurrent = gid === current;
              return <li key={gid} className={`wb-shortlist__row${isCurrent ? ' is-current' : ''}`}>
                <label className="wb-shortlist__check">
                  <input type="checkbox" checked={selected.has(gid)} onChange={event => shortlist.setSelected(gid, event.currentTarget.checked)} />
                  <span className="wb-visually-hidden">Включить счёт {gid} в отчёт</span>
                </label>
                <button type="button" className="wb-shortlist__open" onClick={() => onOpen(gid)} aria-current={isCurrent || undefined}>
                  <span className="wb-visually-hidden">Открыть счёт </span>
                  <Gid gid={gid} className="wb-shortlist__gid" />
                  <span className="wb-shortlist__meta">
                    {node && <RoleTag role={node.role} />}
                    {rank !== undefined && <span className="wb-shortlist__rank">№ {formatInt(rank)} в очереди</span>}
                  </span>
                </button>
                <button type="button" className="wb-shortlist__remove" onClick={() => shortlist.remove(gid)} aria-label={`Убрать счёт ${gid} из сохранённых`} title="Убрать из сохранённых">
                  <Icon name="close" size={15} />
                </button>
              </li>;
            })}
          </ul>
        </>}

    {lastRemoved && <p className="wb-shortlist__undo" role="status">
      <span>Счёт <Gid gid={lastRemoved.gid} /> убран.</span>
      <button type="button" className="wb-shortlist__undo-button" onClick={shortlist.undoRemove}>Вернуть</button>
    </p>}

    {gids.length > 0 && <footer className="wb-shortlist__report">
      <button type="button" className="wb-button wb-shortlist__download" onClick={requestReport}
        disabled={!chosen.length || overLimit || loading} aria-busy={loading || undefined}>
        <Icon name="download" size={16} />
        {loading ? 'Готовим PDF…' : `Скачать отчёт PDF · ${formatInt(chosen.length)}`}
      </button>
      <p className="wb-shortlist__hint">Режим дат в отчёте: {MODE_LABEL[mode].toLowerCase()}. Не больше {REPORT_MAX_ACCOUNTS} счетов в одном отчёте.</p>
      {overLimit && <p className="wb-shortlist__error" role="alert">Выбрано {accounts(chosen.length)}; снимите галочки, чтобы осталось не больше {REPORT_MAX_ACCOUNTS}.</p>}
      {!chosen.length && <p className="wb-shortlist__hint">Отметьте счета галочками, чтобы собрать отчёт.</p>}
      {report.phase === 'done' && <p className="wb-shortlist__done" role="status">Отчёт по {accounts(report.count)} сохранён: {report.filename}</p>}
      {report.phase === 'error' && <p className="wb-shortlist__error" role="alert">{report.message}</p>}
    </footer>}
  </section>;
}
