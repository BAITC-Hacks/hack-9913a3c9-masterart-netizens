import type {Mode} from '../../data/schema';
import {isExactGid} from './store';

/**
 * Запрос PDF-отчёта по выбранным сохранённым счетам: POST /api/report с {gids, mode}.
 *
 * Файл сохраняется, только если сервер ответил 2xx, объявил application/pdf и тело начинается с «%PDF-».
 * Страница HTML или JSON с ошибкой никогда не скачивается под видом PDF: вместо файла показывается
 * понятная причина.
 */
export const REPORT_ENDPOINT = '/api/report';
/** Сколько ждать готовый файл, включая его получение. */
export const REPORT_TIMEOUT_MS = 60_000;
/** Предел сервера на один отчёт (reports.MAX_ACCOUNTS в конвейере): больше 25 счетов сервер отклоняет с ответом 413. */
export const REPORT_MAX_ACCOUNTS = 25;

export interface ReportRequest {
  /** Точные строки gid в порядке списка. */
  gids: readonly string[];
  /** Режим дат, в котором аналитик смотрит пути. */
  mode: Mode;
}

export type ReportErrorKind = 'empty' | 'invalid' | 'unavailable' | 'rejected' | 'not_pdf' | 'network' | 'timeout' | 'aborted';

export class ReportError extends Error {
  constructor(readonly kind: ReportErrorKind, message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

export interface ReportFile { blob: Blob; filename: string; count: number }

export type ReportFetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface ReportOptions {
  fetcher?: ReportFetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Тело запроса: gid остаются строками, поэтому 18-значные номера доходят до сервера без округления. */
export const reportBody = (request: ReportRequest) => JSON.stringify({gids: [...request.gids], mode: request.mode});

/** То же имя, что даёт сервер (reports.report_filename), если заголовок Content-Disposition не пришёл. */
export function defaultReportName(gids: readonly string[]): string {
  return gids.length === 1 ? `spravka-${gids[0]}.pdf` : `spravka-${gids.length}-schetov.pdf`;
}

/** Имя из Content-Disposition, только безопасные символы и расширение .pdf; иначе null. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  let name: string | null = null;
  if (star?.[1]) { try { name = decodeURIComponent(star[1].trim()); } catch { name = null; } }
  if (!name) name = /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? /filename\s*=\s*([^;\s]+)/i.exec(header)?.[1] ?? null;
  return name && /^[A-Za-z0-9._-]{1,120}\.pdf$/i.test(name) && !name.startsWith('.') ? name : null;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Причина отказа из тела ответа. Текст из JSON {error|detail|message} — это ответ самого обработчика
 * отчёта; короткий простой текст — ответ сервера вообще; разметку HTML не показываем никогда.
 */
async function refusalDetail(response: Response): Promise<{text: string; fromHandler: boolean}> {
  let text = '';
  try { text = (await response.text()).slice(0, 4000); } catch { return {text: '', fromHandler: false}; }
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json') || /^\s*[{[]/.test(text)) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      for (const key of ['error', 'detail', 'message']) {
        if (typeof body[key] === 'string' && body[key]) return {text: oneLine(body[key] as string), fromHandler: true};
      }
    } catch { /* не JSON: причины нет */ }
    return {text: '', fromHandler: false};
  }
  if (type.includes('html') || /^\s*</.test(text)) return {text: '', fromHandler: false};
  return {text: oneLine(text), fromHandler: false};
}

async function startsWithPdfMagic(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  return head.length === 5 && String.fromCharCode(...head) === '%PDF-';
}

export async function fetchReport(request: ReportRequest, options: ReportOptions = {}): Promise<ReportFile> {
  const {fetcher = (input, init) => fetch(input, init), signal, timeoutMs = REPORT_TIMEOUT_MS} = options;
  if (!request.gids.length) throw new ReportError('empty', 'Выберите хотя бы один сохранённый счёт для отчёта.');
  if (!request.gids.every(isExactGid)) throw new ReportError('invalid', 'В выборе есть неточный идентификатор счёта; отчёт не запрошен.');
  if (request.gids.length > REPORT_MAX_ACCOUNTS) {
    throw new ReportError('invalid', `В одном отчёте не больше ${REPORT_MAX_ACCOUNTS} счетов, выбрано ${request.gids.length}.`);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', forward, {once: true});
  const interrupted = () => (timedOut
    ? new ReportError('timeout', `Сервер не подготовил отчёт за ${Math.round(timeoutMs / 1000)} с. Попробуйте выбрать меньше счетов.`)
    : new ReportError('aborted', 'Запрос отчёта отменён.'));

  try {
    let response: Response;
    try {
      response = await fetcher(REPORT_ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json', accept: 'application/pdf'},
        body: reportBody(request),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) throw interrupted();
      throw new ReportError('network', 'Сервер отчётов не отвечает. Проверьте, что приложение запущено командой ./run.sh.');
    }

    if (!response.ok) {
      const detail = await refusalDetail(response);
      const suffix = detail.text ? `: ${detail.text}` : '.';
      // 404 с причиной от обработчика отчёта — неизвестный счёт; иначе на сервере просто нет такого адреса.
      if (response.status === 404 && detail.fromHandler) throw new ReportError('rejected', `Сервер не нашёл счёт для отчёта (ответ 404)${suffix}`);
      if ([404, 405, 501].includes(response.status)) throw new ReportError('unavailable', `PDF-отчёт на этом сервере не подключён (ответ ${response.status})${suffix}`);
      if (response.status === 503) throw new ReportError('unavailable', `PDF-отчёт временно недоступен (ответ 503)${suffix}`);
      if (response.status === 413) throw new ReportError('rejected', `Слишком много счетов для одного отчёта (ответ 413)${suffix}`);
      throw new ReportError('rejected', `Сервер отклонил запрос отчёта (ответ ${response.status})${suffix}`);
    }

    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/pdf') {
      throw new ReportError('not_pdf', `Сервер вернул ${type || 'ответ без типа'} вместо PDF. Файл не сохранён.`);
    }
    let blob: Blob;
    try { blob = await response.blob(); } catch {
      if (controller.signal.aborted) throw interrupted();
      throw new ReportError('network', 'Связь прервалась во время получения PDF. Попробуйте ещё раз.');
    }
    if (!(await startsWithPdfMagic(blob))) throw new ReportError('not_pdf', 'Ответ назван PDF, но не является файлом PDF. Файл не сохранён.');
    const filename = filenameFromDisposition(response.headers.get('content-disposition')) ?? defaultReportName(request.gids);
    return {blob, filename, count: request.gids.length};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}
