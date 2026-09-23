import type {GraphIndex} from '../../data/graph';
import type {Mode} from '../../data/schema';
import {MODE_LABEL, countLabel, formatInt} from '../../data/format';
import {Gid} from '../../ui/Gid';
import {RoleTag} from '../../ui/RoleGlyph';
import {Icon} from '../../map/icons';
import type {ShortlistIssue} from './store';
import {REPORT_MAX_ACCOUNTS} from './report';
import type {ReportSession} from './reportSession';
import {useReportSession, useReportState} from './ReportDialog';
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
  /** Явная сессия просмотра PDF; без неё берётся ShortlistProvider. */
  report?: ReportSession;
}

/**
 * Сохранённые счета: отдельный вид для возврата к счетам и выбора их в PDF-отчёт. Счёт открывается нажатием
 * на строку, убирается крестиком с возможностью вернуть. Отмеченные галочкой счета уходят в отчёт, который
 * открывается в общем просмотре PDF.
 */
export function ShortlistPanel({index, mode, current = null, onOpen, controller, report}: ShortlistPanelProps) {
  const shortlist = useShortlistController(controller);
  const {gids, selected, issues, lastRemoved} = shortlist;
  const chosen = gids.filter(gid => selected.has(gid));
  const allChosen = gids.length > 0 && chosen.length === gids.length;
  const overLimit = chosen.length > REPORT_MAX_ACCOUNTS;

  const session = useReportSession(report);
  const reportState = useReportState(session);
  const loading = reportState.phase === 'loading';
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
      <button type="button" className="wb-button wb-shortlist__download" onClick={() => void session.request(chosen, mode)}
        disabled={!chosen.length || overLimit || loading} aria-busy={loading || undefined}>
        {loading ? 'Готовим PDF…' : `Показать отчёт PDF · ${formatInt(chosen.length)}`}
      </button>
      <p className="wb-shortlist__hint">Режим дат в отчёте: {MODE_LABEL[mode].toLowerCase()}. Не больше {REPORT_MAX_ACCOUNTS} счетов в одном отчёте.</p>
      {overLimit && <p className="wb-shortlist__error" role="alert">Выбрано {accounts(chosen.length)}; снимите галочки, чтобы осталось не больше {REPORT_MAX_ACCOUNTS}.</p>}
      {!chosen.length && <p className="wb-shortlist__hint">Отметьте счета галочками, чтобы собрать отчёт.</p>}
    </footer>}
  </section>;
}
