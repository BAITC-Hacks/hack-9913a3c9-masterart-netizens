import React from 'react';

/**
 * Полноэкранный режим карты с удержанием фокуса. onEscape снимает слои по одному: если он вернул true,
 * Escape уже обработан и рамка остаётся открытой.
 *
 * Перенесено из Command Center (useSessionMapFullscreen.ts, ревизия 77e1b9b0); см. web/README.md.
 */
export function useMapFullscreen({onEscape}: {onEscape?: () => boolean} = {}) {
  const mapRef = React.useRef<HTMLElement>(null);
  const [fullScreen, setFullScreen] = React.useState(false);
  const escape = React.useRef(onEscape);
  escape.current = onEscape;
  const close = React.useCallback(() => setFullScreen(false), []);
  const toggleFullScreen = () => setFullScreen(value => !value);
  React.useEffect(() => {
    const map = mapRef.current;
    if (!fullScreen || !map) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    map.focus({preventScroll: true});
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      const dialog = target?.closest('[role="dialog"]');
      if (dialog && dialog !== map) return;
      if (event.key === 'Escape') { event.preventDefault(); if (!escape.current?.()) close(); }
      if (event.key !== 'Tab') return;
      const elements = [...map.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex="0"]')]
        .filter(element => !element.closest('[inert]'));
      const first = elements[0], last = elements.at(-1);
      if (!map.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === map)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
      if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
    };
  }, [close, fullScreen]);
  return {mapRef, fullScreen, toggleFullScreen};
}
