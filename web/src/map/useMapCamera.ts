import React from 'react';

/**
 * Камера карты: панорамирование остаётся обычной прокруткой (инерция браузера лучше самодельной),
 * а хук добавляет то, чего прокрутка не умеет: масштаб щипком под пальцами, жесты Safari,
 * перетаскивание мышью и щипок двумя пальцами на сенсорном экране.
 *
 * Перенесено из Command Center (useProjectDagCamera.ts, ревизия 77e1b9b0) с переименованием;
 * поведение не менялось. Источник указан в web/README.md.
 */
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 1.5;
const TRACKPAD_ZOOM_RATE = 0.002;
/** До этого сдвига нажатие считается касанием: выбрать карточку можно и не очень твёрдой рукой. */
const DRAG_SLOP = 8;

export function useMapCamera({viewport, zoom, setZoom, minZoom = MIN_ZOOM}: {
  viewport: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  setZoom: (value: number) => void;
  minZoom?: number;
}) {
  const zoomRef = React.useRef(zoom);
  zoomRef.current = zoom;
  const anchor = React.useRef<{x: number; y: number; from: number} | null>(null);
  const pointers = React.useRef(new Map<number, {x: number; y: number}>());
  const drag = React.useRef<{x: number; y: number; spread: number; moved: number} | null>(null);
  const [panning, setPanning] = React.useState(false);

  // Точка сцены под пальцами остаётся под пальцами: прокрутка исправляется в том же кадре, что и масштаб.
  React.useLayoutEffect(() => {
    const frame = viewport.current, pending = anchor.current;
    anchor.current = null;
    if (!frame || !pending || pending.from === zoom) return;
    const ratio = zoom / pending.from;
    frame.scrollLeft = Math.max(0, (frame.scrollLeft + pending.x) * ratio - pending.x);
    frame.scrollTop = Math.max(0, (frame.scrollTop + pending.y) * ratio - pending.y);
  }, [zoom, viewport]);

  const zoomAt = React.useCallback((x: number, y: number, factor: number) => {
    const from = zoomRef.current, next = Math.min(MAX_ZOOM, Math.max(Math.min(MIN_ZOOM, minZoom), from * factor));
    if (Math.abs(next - from) < 0.0005) return;
    anchor.current = {x, y, from};
    setZoom(next);
  }, [setZoom, minZoom]);

  React.useEffect(() => {
    const frame = viewport.current;
    if (!frame) return;
    let safariActive = false;
    const onWheel = (event: WheelEvent) => {
      // Щипок трекпада приходит как ctrl+wheel; обычная прокрутка двумя пальцами остаётся нативной.
      if (!(event.ctrlKey || event.metaKey) || safariActive) return;
      const rect = frame.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * unit * TRACKPAD_ZOOM_RATE));
    };
    type SafariGesture = Event & {scale: number; clientX: number; clientY: number};
    let safariScale = 1;
    const safariStart = (event: Event) => { event.preventDefault(); safariScale = 1; safariActive = event.type !== 'gestureend'; };
    const safariChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as SafariGesture, rect = frame.getBoundingClientRect();
      if (!(gesture.scale > 0) || !rect.width || !rect.height) return;
      zoomAt(
        Number.isFinite(gesture.clientX) ? gesture.clientX - rect.left : rect.width / 2,
        Number.isFinite(gesture.clientY) ? gesture.clientY - rect.top : rect.height / 2,
        gesture.scale / safariScale,
      );
      safariScale = gesture.scale;
    };
    frame.addEventListener('wheel', onWheel, {passive: false});
    frame.addEventListener('gesturestart', safariStart, {passive: false});
    frame.addEventListener('gesturechange', safariChange, {passive: false});
    frame.addEventListener('gestureend', safariStart, {passive: false});
    return () => {
      frame.removeEventListener('wheel', onWheel);
      frame.removeEventListener('gesturestart', safariStart);
      frame.removeEventListener('gesturechange', safariChange);
      frame.removeEventListener('gestureend', safariStart);
    };
  }, [viewport, zoomAt]);

  React.useEffect(() => {
    const clear = () => { pointers.current.clear(); drag.current = null; setPanning(false); };
    window.addEventListener('blur', clear);
    return () => window.removeEventListener('blur', clear);
  }, []);

  const spread = (points: readonly {x: number; y: number}[]) => Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
  const centre = (points: readonly {x: number; y: number}[]) => ({x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2});

  const handlers = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button > 0) return;
      pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
      const points = [...pointers.current.values()];
      drag.current = {x: event.clientX, y: event.clientY, spread: points.length > 1 ? spread(points) : 0, moved: drag.current?.moved ?? 0};
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
      const active = drag.current, frame = viewport.current, points = [...pointers.current.values()];
      if (!active || !frame) return;
      if (points.length > 1) {
        const rect = frame.getBoundingClientRect(), next = spread(points), middle = centre(points);
        if (active.spread > 0 && next > 0) zoomAt(middle.x - rect.left, middle.y - rect.top, next / active.spread);
        drag.current = {x: middle.x, y: middle.y, spread: next, moved: DRAG_SLOP + 1};
        return;
      }
      const dx = event.clientX - active.x, dy = event.clientY - active.y;
      const moved = active.moved + Math.abs(dx) + Math.abs(dy);
      drag.current = {x: event.clientX, y: event.clientY, spread: 0, moved};
      if (moved <= DRAG_SLOP) return;
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.setPointerCapture(event.pointerId); setPanning(true); }
      frame.scrollLeft -= dx;
      frame.scrollTop -= dy;
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (pointers.current.size === 0) setPanning(false);
      else drag.current = {...[...pointers.current.values()][0]!, spread: 0, moved: DRAG_SLOP + 1};
    },
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size === 0) { drag.current = null; setPanning(false); }
    },
    // Нажатие, ставшее перетаскиванием, — не щелчок: ни карточка, ни фон не получают click.
    onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
      const moved = (drag.current?.moved ?? 0) > DRAG_SLOP;
      if (drag.current) drag.current = {...drag.current, moved: 0};
      if (moved) event.stopPropagation();
    },
  };

  return {
    handlers,
    panning,
    zoomBy: (factor: number) => {
      const frame = viewport.current;
      zoomAt((frame?.clientWidth ?? 0) / 2, (frame?.clientHeight ?? 0) / 2, factor);
    },
  };
}
