import {useEffect, useRef, useState} from 'react';
import {Icon} from '../map/icons';

/**
 * Копирование точного gid. Поведение и анимация перенесены из Command Center (CommandNodeIdentity.tsx и
 * CodeBlockCopyButton, ревизия 77e1b9b0): значок «копировать» сменяется галочкой на 2 секунды, успех
 * засчитывается только для того счёта, который был выбран в момент копирования. Копируется исходная
 * строка цифр без пробелов.
 */
export function CopyGid({gid}: {gid: string}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef(gid);
  active.current = gid;
  useEffect(() => { setCopied(false); setFailed(false); }, [gid]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    const target = gid;
    if (!navigator.clipboard?.writeText) { setFailed(true); return; }
    try {
      await navigator.clipboard.writeText(target);
      if (active.current === target) { setCopied(true); setFailed(false); }
    } catch {
      if (active.current === target) setFailed(true);
    }
  };
  return <span className="wb-copy">
    <button type="button" className="wb-copy__button" data-copied={copied || undefined} onClick={copy}
      aria-label={copied ? 'gid скопирован' : 'Копировать gid'} title={copied ? 'Скопировано' : 'Копировать gid'}>
      <Icon key={copied ? 'check' : 'copy'} name={copied ? 'check' : 'copy'} size={20} />
    </button>
    <span className="wb-visually-hidden" role="status">{copied ? 'gid скопирован' : ''}</span>
    {failed && <span className="wb-copy__fail" role="alert">Выделите gid и скопируйте вручную</span>}
  </span>;
}
