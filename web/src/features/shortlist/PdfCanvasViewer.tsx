import {useEffect, useRef, useState} from 'react';
import {MAX_PIXEL_RATIO, openPdf, pageCssWidth, type PdfDocument, type PdfLoader} from './pdfEngine';

/** Если страницы не удалось показать: ссылки на тот же файл, открыть или скачать. */
export function PdfFallback({url, filename}: {url: string; filename: string}) {
  return <div className="wb-report__status" role="alert">
    <p>Этот браузер не показывает PDF внутри страницы.</p>
    <p><a href={url} target="_blank" rel="noopener">Открыть {filename}</a> или <a href={url} download={filename}>скачать файл</a>.</p>
  </div>;
}

/**
 * Просмотр PDF без встроенного модуля браузера: PDF.js рисует одну страницу на canvas по ширине окна,
 * «Назад» и «Далее» листают страницы. Рисуется только текущая страница, поэтому память ограничена
 * и для длинного отчёта. Любая ошибка загрузки или отрисовки показывает ссылки «Открыть» и «Скачать».
 */
export function PdfCanvasViewer({blob, url, filename, load = openPdf}: {blob: Blob; url: string; filename: string; load?: PdfLoader}) {
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: PdfDocument | null = null;
    setDoc(null); setFailed(false); setPage(1);
    blob.arrayBuffer()
      .then(buffer => load(new Uint8Array(buffer)))
      .then(result => { opened = result; if (cancelled) void result.destroy(); else setDoc(result); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (opened) void opened.destroy(); };
  }, [blob, load]);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: {cancel: () => void} | null = null;
    doc.getPage(page).then(pdfPage => {
      const canvas = canvasRef.current, frame = frameRef.current;
      if (cancelled || !canvas || !frame) return;
      const ratio = Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1);
      const cssWidth = pageCssWidth(frame.clientWidth);
      const viewport = pdfPage.getViewport({scale: (cssWidth / pdfPage.getViewport({scale: 1}).width) * ratio});
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${cssWidth}px`;
      const render = pdfPage.render({canvas, viewport});
      task = render;
      return render.promise;
    }).catch((error: unknown) => {
      if (!cancelled && !(error instanceof Error && error.name === 'RenderingCancelledException')) setFailed(true);
    });
    return () => { cancelled = true; task?.cancel(); };
  }, [doc, page]);

  if (failed) return <PdfFallback url={url} filename={filename} />;
  const total = doc?.numPages ?? 0;
  return <div className="wb-pdf">
    <div className="wb-pdf__frame" ref={frameRef}>
      {!doc && <p className="wb-report__status" role="status" aria-busy="true">Открываем страницы…</p>}
      <canvas ref={canvasRef} className="wb-pdf__page" hidden={!doc} role="img" aria-label={`${filename}: страница ${page} из ${total || 1}`} />
    </div>
    {total > 1 && <nav className="wb-pdf__pager" aria-label="Страницы справки">
      <button type="button" className="wb-button wb-button--quiet" disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>Назад</button>
      <span aria-live="polite">Страница {page} из {total}</span>
      <button type="button" className="wb-button wb-button--quiet" disabled={page >= total} onClick={() => setPage(current => Math.min(total, current + 1))}>Далее</button>
    </nav>}
  </div>;
}
