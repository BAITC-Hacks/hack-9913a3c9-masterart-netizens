import {useEffect, useState} from 'react';
import {useShortlistController, type ShortlistController} from './useShortlist';

/** Закладка в стиле значков рабочего места: контур 1.6 px, заливка — когда счёт сохранён. */
export function BookmarkGlyph({filled = false, size = 18}: {filled?: boolean; size?: number}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
    strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.2a.5.5 0 0 1-.8.4L12 16.4l-5.7 4.2a.5.5 0 0 1-.8-.4V5A1.5 1.5 0 0 1 7 3.5Z" />
  </svg>;
}

const ANNOUNCE = {saved: 'Счёт сохранён в список', removed: 'Счёт убран из списка', unknown: 'Счёт не найден в текущем анализе', already: ''} as const;

/**
 * Сохранить счёт в список или убрать его. Текст кнопки называет состояние («Сохранить» / «Сохранён»),
 * а доступное имя содержит этот текст и следующее действие. Золото появляется только у сохранённого счёта.
 */
export function SaveAccountButton({gid, controller, compact = false}: {gid: string; controller?: ShortlistController; compact?: boolean}) {
  const shortlist = useShortlistController(controller);
  const saved = shortlist.gids.includes(gid);
  const [announce, setAnnounce] = useState('');
  useEffect(() => { setAnnounce(''); }, [gid]);

  const label = saved ? 'Сохранён — убрать из списка' : 'Сохранить счёт в список';
  return <span className="wb-save">
    <button type="button" className={`wb-save__button${compact ? ' wb-save__button--compact' : ''}`} data-saved={saved || undefined}
      aria-label={compact ? label : undefined} title={label}
      onClick={() => setAnnounce(ANNOUNCE[shortlist.toggle(gid)])}>
      <BookmarkGlyph key={saved ? 'on' : 'off'} filled={saved} />
      {!compact && <span>{saved ? 'Сохранён' : 'Сохранить'}</span>}
      {!compact && <span className="wb-visually-hidden">{saved ? ' — убрать из списка' : ' счёт в список'}</span>}
    </button>
    <span className="wb-visually-hidden" role="status">{announce}</span>
  </span>;
}
