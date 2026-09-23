/**
 * PDF.js загружается по требованию: библиотека и её worker собираются в отдельные файлы и скачиваются
 * только при первом открытии справки. Страницы рисуются на canvas, поэтому просмотр не зависит от
 * встроенного PDF-модуля браузера (во встроенных браузерах приложений и на части телефонов его нет).
 */
import type {PDFDocumentProxy} from 'pdfjs-dist';

export type PdfDocument = Pick<PDFDocumentProxy, 'numPages' | 'getPage'> & {destroy: () => Promise<void>};
export type PdfLoader = (data: Uint8Array) => Promise<PdfDocument>;

export const openPdf: PdfLoader = async data => {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  // Настройки шрифтов по умолчанию: встроенные шрифты справки грузятся из её байтов, а стандартные
  // шрифты без встроенных данных берутся системные (с отключённым FontFace они не рисовались бы).
  const task = pdfjs.getDocument({data});
  const doc = await task.promise;
  // Закрытие задачи загрузки освобождает документ и его worker.
  return {numPages: doc.numPages, getPage: pageNumber => doc.getPage(pageNumber), destroy: () => task.destroy()};
};

/** Самая широкая страница на экране, CSS px, и предел плотности пикселей: память холста ограничена. */
export const MAX_PAGE_WIDTH = 900;
export const MAX_PIXEL_RATIO = 2;

/** Ширина страницы в CSS px: по ширине окна просмотра за вычетом полей, в пределах 240–900. */
export function pageCssWidth(frameWidth: number): number {
  return Math.round(Math.min(MAX_PAGE_WIDTH, Math.max(240, frameWidth - 32)));
}
