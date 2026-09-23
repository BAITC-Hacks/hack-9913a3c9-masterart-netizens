/**
 * Сохранённые счета — точка входа. Подключение: ShortlistProvider вокруг рабочего места, SaveAccountButton
 * и AccountReportButton рядом с gid в основаниях, ShortlistPanel там, где нужен список. Подробности — README.md.
 */
import './shortlist.css';

export {ShortlistProvider, useShortlist, useShortlistController, browserStorage, type ShortlistController} from './useShortlist';
export {SaveAccountButton, BookmarkGlyph} from './SaveAccountButton';
export {ShortlistPanel, issueText, type ShortlistPanelProps} from './ShortlistPanel';
export {ReportDialog, AccountReportButton, useReportSession, useReportState} from './ReportDialog';
export {createReportSession, type ReportSession, type ReportSessionState, type ReportSessionOptions} from './reportSession';
export {
  createShortlistStore, parseStoredShortlist, shortlistKey, isExactGid, SHORTLIST_KEY_PREFIX,
  type ShortlistStore, type ShortlistSnapshot, type ShortlistActions, type ShortlistIssue, type ShortlistStorage, type SaveResult,
} from './store';
export {
  fetchReport, reportBody, defaultReportName, filenameFromDisposition, ReportError,
  REPORT_ENDPOINT, REPORT_MAX_ACCOUNTS, REPORT_TIMEOUT_MS,
  type ReportRequest, type ReportFile, type ReportFetcher, type ReportErrorKind,
} from './report';
