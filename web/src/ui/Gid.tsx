import {Fragment} from 'react';
import {gidGroups} from '../data/format';

/**
 * Идентификатор счёта моноширинными цифрами. Промежутки между группами — отступы CSS, а не символы,
 * поэтому выделение и копирование всегда дают исходную строку цифр без пробелов. Между группами стоит
 * <wbr>: там, где перенос разрешён, номер переносится только по границе группы, а не посреди цифр.
 */
export function Gid({gid, className = ''}: {gid: string; className?: string}) {
  return <span className={`wb-gid ${className}`} translate="no">
    {gidGroups(gid).map((group, i) => <Fragment key={i}>{i > 0 && <wbr />}<span>{group}</span></Fragment>)}
  </span>;
}
