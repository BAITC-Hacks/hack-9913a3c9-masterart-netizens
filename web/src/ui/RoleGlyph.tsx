import type {ReactNode} from 'react';
import type {Role} from '../data/schema';
import {roleLabel} from '../data/format';

/**
 * Знак роли: цвет и форма вместе. Форма повторяет смысл роли (схождение, проход, расхождение,
 * остановка, узел связи, пустой круг), поэтому роль читается и без цвета.
 */
const SHAPES: Record<string, ReactNode> = {
  consolidator: <><path d="M2.5 3.5 7.2 7M2.5 12.5 7.2 9M1.8 8h4.6" /><circle cx="10.6" cy="8" r="2.6" /></>,
  transit: <><path d="M1.5 8h13" /><path d="m11.5 5 3 3-3 3" /><circle cx="6.5" cy="8" r="2.1" /></>,
  distributor: <><circle cx="5.4" cy="8" r="2.6" /><path d="M8.8 7 13.5 3.5M8.8 9l4.7 3.5M9.6 8h4.6" /></>,
  terminal: <><path d="M1.5 8h5.2" /><path d="m4.6 5.4 2.6 2.6-2.6 2.6" /><circle cx="11.4" cy="8" r="3" fill="currentColor" /></>,
  coordinator: <><path d="M8 2.2 13.8 8 8 13.8 2.2 8Z" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /></>,
  peripheral: <circle cx="8" cy="8" r="3.4" />,
};

export function RoleGlyph({role, size = 14}: {role: Role; size?: number}) {
  return <svg className={`wb-glyph wb-role--${SHAPES[role] ? role : 'unknown'}`} aria-hidden="true" width={size} height={size}
    viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
    {SHAPES[role] ?? <circle cx="8" cy="8" r="3.4" strokeDasharray="2 2" />}
  </svg>;
}

/** Подпись роли со знаком; цвет задаётся классом роли. */
export function RoleTag({role, score}: {role: Role; score?: string}) {
  return <span className={`wb-role-tag wb-role--${SHAPES[role] ? role : 'unknown'}`}>
    <RoleGlyph role={role} />
    <span className="wb-role-tag__label">{roleLabel(role)}</span>
    {score && <span className="wb-role-tag__score">{score}</span>}
  </span>;
}
