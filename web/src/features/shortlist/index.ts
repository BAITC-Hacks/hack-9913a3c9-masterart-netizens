/**
 * Сохранённые счета — точка входа. Подключение: ShortlistProvider вокруг рабочего места, SaveAccountButton
 * рядом с gid в основаниях, ShortlistPanel там, где нужен список. Подробности — README.md рядом.
 */
import './shortlist.css';

export {ShortlistProvider, useShortlist, useShortlistController, browserStorage, type ShortlistController} from './useShortlist';
export {SaveAccountButton, BookmarkGlyph} from './SaveAccountButton';
export {ShortlistPanel, issueText, type ShortlistPanelProps} from './ShortlistPanel';
export {
  createShortlistStore, parseStoredShortlist, shortlistKey, isExactGid, SHORTLIST_KEY_PREFIX,
  type ShortlistStore, type ShortlistSnapshot, type ShortlistActions, type ShortlistIssue, type ShortlistStorage, type SaveResult,
} from './store';
export {
  fetchReport, downloadReport, reportBody, defaultReportName, filenameFromDisposition, ReportError,
  REPORT_ENDPOINT, REPORT_MAX_ACCOUNTS, REPORT_TIMEOUT_MS,
  type ReportRequest, type ReportFile, type ReportFetcher, type ReportErrorKind,
} from './report';
