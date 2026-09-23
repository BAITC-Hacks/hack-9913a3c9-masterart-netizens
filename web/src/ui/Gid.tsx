import {gidGroups} from '../data/format';

/**
 * Идентификатор счёта моноширинными цифрами. Промежутки между группами — отступы CSS, а не символы,
 * поэтому выделение и копирование всегда дают исходную строку цифр без пробелов.
 */
export function Gid({gid, className = ''}: {gid: string; className?: string}) {
  return <span className={`wb-gid ${className}`} translate="no">
    {gidGroups(gid).map((group, i) => <span key={i}>{group}</span>)}
  </span>;
}
