import {useId, useMemo, useRef, useState} from 'react';
import type {GraphIndex} from '../data/graph';
import {searchAccounts} from '../data/search';
import {countLabel} from '../data/format';
import {Gid} from './Gid';
import {RoleGlyph} from './RoleGlyph';
import {Icon} from '../map/icons';

/**
 * Поиск по точному gid. Enter открывает счёт только при полном совпадении; частичные совпадения
 * предлагаются списком и открываются явным выбором, поэтому соседнее число не подменяет счёт.
 * Подсказки появляются под полем поверх страницы и не сдвигают её.
 */
export function SearchBox({index, onSelect}: {index: GraphIndex; onSelect: (gid: string) => void}) {
  const [value, setValue] = useState('');
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId(), statusId = useId();
  const outcome = useMemo(() => searchAccounts(index, value), [index, value]);
  const options = outcome.kind === 'partial' ? outcome.matches : outcome.kind === 'exact' ? [outcome.gid] : [];

  const choose = (gid: string) => { onSelect(gid); setValue(''); setActive(-1); setOpen(false); input.current?.blur(); };
  const status = (() => {
    switch (outcome.kind) {
      case 'empty': return '';
      case 'invalid': return outcome.message;
      case 'exact': return 'Счёт найден — Enter, чтобы открыть';
      case 'partial': return outcome.total
        ? `${countLabel(outcome.total, 'совпадение', 'совпадения', 'совпадений')} по части номера — выберите счёт`
        : 'Нужно не меньше 4 цифр';
      case 'not_found': return `Такого счёта нет среди ${countLabel(index.byGid.size, 'счёта', 'счетов', 'счетов')} выборки`;
    }
  })();
  const showPanel = open && outcome.kind !== 'empty';

  return <div className={`wb-search is-${outcome.kind}`}>
    <label className="wb-search__field">
      <span className="wb-visually-hidden">Найти счёт по gid</span>
      <Icon name="search" size={16} />
      <input ref={input} value={value} inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="Найти счёт по gid"
        role="combobox" aria-expanded={showPanel && options.length > 0} aria-controls={listId} aria-describedby={statusId}
        aria-activedescendant={active >= 0 && options[active] ? `${listId}-${active}` : undefined}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onChange={event => { setValue(event.target.value); setActive(-1); setOpen(true); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' && options.length) { event.preventDefault(); setActive(i => Math.min(options.length - 1, i + 1)); }
          else if (event.key === 'ArrowUp' && options.length) { event.preventDefault(); setActive(i => Math.max(0, i - 1)); }
          else if (event.key === 'Escape') { setValue(''); setActive(-1); }
          else if (event.key === 'Enter') {
            event.preventDefault();
            if (outcome.kind === 'exact') choose(outcome.gid);
            else if (active >= 0 && options[active]) choose(options[active]!);
          }
        }} />
    </label>
    <div className={`wb-search__panel${showPanel ? ' is-open' : ''}`}>
      <p id={statusId} className="wb-search__status" aria-live="polite">{status}</p>
      {options.length > 0 && <ul id={listId} role="listbox" className="wb-search__options" aria-label="Совпадения">
        {options.map((gid, i) => {
          const node = index.byGid.get(gid);
          return <li key={gid} id={`${listId}-${i}`} role="option" aria-selected={i === active}
            className={i === active ? 'is-active' : undefined} onMouseDown={event => event.preventDefault()} onClick={() => choose(gid)}>
            {node && <RoleGlyph role={node.role} />}
            <Gid gid={gid} />
          </li>;
        })}
      </ul>}
    </div>
  </div>;
}
