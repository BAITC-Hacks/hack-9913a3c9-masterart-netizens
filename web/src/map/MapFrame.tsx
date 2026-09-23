import React from 'react';
import {Icon} from './icons';
import {useMapFullscreen} from './useMapFullscreen';
import {MAX_ZOOM, MIN_ZOOM, useMapCamera} from './useMapCamera';

/**
 * Общая рамка карты: переключатель «Карта / Список», масштаб, который всегда достаёт до всей карты,
 * камера трекпада и касаний, полноэкранный режим. Адаптировано из ProjectDagView.tsx Command Center
 * (ревизия 77e1b9b0): вписывание учитывает обе оси, подписи переведены, Fleet-зависимостей нет.
 */
export type MapMode = 'map' | 'outline';

export function useMapView({width, height, onEscape}: {width: number; height: number; onEscape: () => boolean}) {
  const [mode, setMode] = React.useState<MapMode>('map');
  const [zoom, setZoom] = React.useState(1);
  const viewport = React.useRef<HTMLDivElement>(null);
  const [fitZoom, setFitZoom] = React.useState(MIN_ZOOM);
  const camera = useMapCamera({viewport, zoom, setZoom, minZoom: fitZoom});
  const {mapRef: frame, fullScreen, toggleFullScreen} = useMapFullscreen({onEscape});
  const fit = React.useCallback(() => {
    const el = viewport.current;
    if (!el?.clientWidth || !el.clientHeight || !width || !height) return 1;
    return Math.max(Math.min(MIN_ZOOM, 1), Math.min(MAX_ZOOM, 1, el.clientWidth / width, el.clientHeight / height));
  }, [width, height]);
  const fitMap = React.useCallback(() => {
    const next = fit();
    setFitZoom(Math.min(MIN_ZOOM, next));
    setZoom(next);
    const el = viewport.current;
    if (el) requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, (width * next - el.clientWidth) / 2);
      el.scrollTop = Math.max(0, (height * next - el.clientHeight) / 2);
    });
  }, [fit, width, height]);
  return {mode, setMode, zoom, viewport, camera, frame, fullScreen, toggleFullScreen, fitMap};
}
export type MapView = ReturnType<typeof useMapView>;

export function MapFrame({view, label, children}: {view: MapView; label: string; children: React.ReactNode}) {
  return <section ref={view.frame} className={`wb-map${view.fullScreen ? ' is-fullscreen' : ''}`} aria-label={label}
    role={view.fullScreen ? 'dialog' : undefined} aria-modal={view.fullScreen || undefined} tabIndex={view.fullScreen ? -1 : undefined}>
    {children}
  </section>;
}

export function MapTools({view}: {view: MapView}) {
  return <div className="wb-map__tools">
    <div className="wb-segmented wb-segmented--compact" role="group" aria-label="Представление">
      {(['map', 'outline'] as const).map(value => <button type="button" key={value} className={view.mode === value ? 'is-active' : undefined}
        aria-pressed={view.mode === value} onClick={() => view.setMode(value)}>
        <Icon name={value === 'map' ? 'graph' : 'tasks'} size={15} />{value === 'map' ? 'Карта' : 'Список'}</button>)}
    </div>
    {view.mode === 'map' && <div className="wb-zoom" role="group" aria-label="Масштаб карты">
      <button type="button" aria-label="Уменьшить" onClick={() => view.camera.zoomBy(1 / 1.18)}><Icon name="zoom-out" size={17} strokeWidth={1.5} /></button>
      <button type="button" aria-label="Вписать карту" onClick={view.fitMap}><Icon name="fit" size={17} strokeWidth={1.5} /></button>
      <button type="button" aria-label="Увеличить" onClick={() => view.camera.zoomBy(1.18)}><Icon name="zoom-in" size={17} strokeWidth={1.5} /></button>
      <button type="button" aria-label={view.fullScreen ? 'Выйти из полноэкранного режима' : 'Во весь экран'} aria-pressed={view.fullScreen}
        title={view.fullScreen ? 'Выйти (Esc)' : 'Во весь экран'} onClick={view.toggleFullScreen}><Icon name={view.fullScreen ? 'close' : 'expand'} size={17} strokeWidth={1.5} /></button>
    </div>}
  </div>;
}

export function MapViewport({view, width, height, label, children}: {view: MapView; width: number; height: number; label: string; children: React.ReactNode}) {
  return <div className={`wb-map__viewport${view.camera.panning ? ' is-panning' : ''}`} ref={view.viewport} tabIndex={0} aria-label={label} {...view.camera.handlers}>
    <div style={{width: width * view.zoom, height: height * view.zoom}}>
      <div className="wb-map__canvas" style={{width, height, transform: `scale(${view.zoom})`, transformOrigin: 'top left'}}>{children}</div>
    </div>
  </div>;
}
