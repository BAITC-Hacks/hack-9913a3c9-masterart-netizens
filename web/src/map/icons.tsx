/**
 * Иконки интерфейса. Контуры zoom-in, zoom-out, fit, expand, close, graph, tasks, search, download,
 * arrow-up, arrow-down, alert, back, chevron, link и spark перенесены без изменений из
 * Command Center (CommandCenterIcons.tsx, ревизия 77e1b9b0, см. web/README.md). copy и cycle добавлены здесь.
 */
export type IconName =
  | 'alert' | 'arrow-down' | 'arrow-up' | 'back' | 'chevron' | 'close' | 'copy' | 'cycle' | 'download'
  | 'expand' | 'fit' | 'graph' | 'link' | 'search' | 'spark' | 'tasks' | 'zoom-in' | 'zoom-out';

function pathFor(name: IconName) {
  switch (name) {
    case 'alert': return <><path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" /><path d="M12 9.5v4.5M12 17.2h.01" /></>;
    case 'arrow-down': return <><path d="M12 5v14" /><path d="m6.5 13.5 5.5 5.5 5.5-5.5" /></>;
    case 'arrow-up': return <><path d="M12 19V5" /><path d="m6.5 10.5 5.5-5.5 5.5 5.5" /></>;
    case 'back': return <path d="m15 18-6-6 6-6" />;
    case 'chevron': return <path d="m9 6 6 6-6 6" />;
    case 'close': return <path d="m6 6 12 12M18 6 6 18" />;
    case 'copy': return <><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></>;
    case 'cycle': return <><path d="M19.5 12a7.5 7.5 0 0 1-12.9 5.2" /><path d="M4.5 12a7.5 7.5 0 0 1 12.9-5.2" /><path d="M17.8 3.6v3.6h-3.6M6.2 20.4v-3.6h3.6" /></>;
    case 'download': return <><path d="M12 3v12" /><path d="m7 10 5 5 5-5M5 21h14" /></>;
    case 'expand': return <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />;
    case 'fit': return <path d="M9 4v3a2 2 0 0 1-2 2H4m16 0h-3a2 2 0 0 1-2-2V4M4 15h3a2 2 0 0 1 2 2v3m6 0v-3a2 2 0 0 1 2-2h3" />;
    case 'graph': return <><circle cx="5" cy="12" r="2.2" /><circle cx="12" cy="5" r="2.2" /><circle cx="19" cy="9" r="2.2" /><circle cx="15" cy="19" r="2.2" /><path d="m6.6 10.4 3.8-3.8M14 5.7l3.2 2.1M18.3 11l-2.5 5.9M7.1 13.3l5.9 4.4" /></>;
    case 'link': return <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>;
    case 'search': return <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></>;
    case 'spark': return <><path d="m12 3 1.4 4.3L18 9l-4.6 1.7L12 15l-1.4-4.3L6 9l4.6-1.7L12 3Z" /><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" /></>;
    case 'tasks': return <><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.2 1.2L7 4.9M3.5 12l1.2 1.2L7 10.9M3.5 18l1.2 1.2L7 16.9" /></>;
    case 'zoom-in': return <path d="M12 7v10M7 12h10" />;
    case 'zoom-out': return <path d="M7 12h10" />;
  }
}

export function Icon({name, size = 18, strokeWidth = 1.6}: {name: IconName; size?: number; strokeWidth?: number}) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">{pathFor(name)}</svg>;
}
