import {useEffect, useId, useRef, useState, type CSSProperties} from 'react';
import type {AssistantOptions} from './types';
import {effortDetail, effortLabel, effortMark, modelLabel, switchModel, type ResolvedSettings} from './modelSettings';

/**
 * Модель и усилие рассуждения. Устройство взято из Command Center (CommandConfigurationMenu.tsx:257–328):
 * строки моделей с ролью radio и отметкой выбранной, ступенчатый ползунок усилия поверх настоящего
 * <input type="range"> с захватом указателя, подписанные ступени и строка пояснения. Ступени — ровно
 * уровни, которые сервер допускает для выбранной модели.
 */
export function EffortSlider({efforts, effort, onChange}: {efforts: readonly string[]; effort: string; onChange: (effort: string) => void}) {
  const [scrubbing, setScrubbing] = useState(false);
  const index = Math.max(0, efforts.indexOf(effort));
  const ratio = efforts.length > 1 ? index / (efforts.length - 1) : 0;
  return <div className={`fa-effort${scrubbing ? ' is-scrubbing' : ''}`} style={{'--fa-effort-ratio': ratio} as CSSProperties}>
    <div className="fa-effort-track">
      <i aria-hidden="true" />
      <span className="fa-effort-thumb" aria-hidden="true" />
      <input type="range" min={0} max={Math.max(0, efforts.length - 1)} step={1} value={index}
        aria-label="Усилие рассуждения" aria-valuetext={`${effortLabel(effort)}${effortDetail(effort) ? ` · ${effortDetail(effort)}` : ''}`}
        onChange={event => { const next = efforts[Number(event.currentTarget.value)]; if (next) onChange(next); }}
        onPointerDown={event => { setScrubbing(true); event.currentTarget.setPointerCapture?.(event.pointerId); }}
        onPointerUp={event => { setScrubbing(false); event.currentTarget.releasePointerCapture?.(event.pointerId); }}
        onPointerCancel={() => setScrubbing(false)} onBlur={() => setScrubbing(false)} />
    </div>
    <div className="fa-effort-marks" role="radiogroup" aria-label="Уровни усилия">
      {efforts.map(candidate => <button key={candidate} type="button" role="radio" aria-checked={candidate === effort}
        className={candidate === effort ? 'is-selected' : ''} onClick={() => onChange(candidate)}>
        <span>{effortMark(candidate)}</span>
      </button>)}
    </div>
    <small className="fa-effort-detail">{effortLabel(effort)}{effortDetail(effort) ? ` — ${effortDetail(effort)}` : ''}</small>
  </div>;
}

export function ModelEffortMenu({options, settings, onChange, disabled = false}: {
  options: AssistantOptions; settings: ResolvedSettings; onChange: (settings: ResolvedSettings) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Нажатие вне меню закрывает его, как в Command Center.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  return <div className="fa-config" ref={root}>
    <button ref={trigger} type="button" className="fa-config-trigger" aria-expanded={open} aria-controls={`${id}-menu`} disabled={disabled}
      onClick={() => setOpen(value => !value)}>
      <span>{modelLabel(options, settings.model)}</span>
      <span className="fa-config-effort">{effortLabel(settings.effort)}</span>
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m7 14 5-5 5 5" /></svg>
    </button>
    {open && <div id={`${id}-menu`} className="fa-config-menu" role="group" aria-label="Модель и усилие"
      onKeyDown={event => {
        // Esc закрывает только меню: окно разговора остаётся открытым.
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      }}>
      <ModelEffortPanel options={options} settings={settings} onChange={onChange} />
    </div>}
  </div>;
}

/** Содержимое меню: строки моделей и ползунок усилия выбранной модели. */
export function ModelEffortPanel({options, settings, onChange}: {
  options: AssistantOptions; settings: ResolvedSettings; onChange: (settings: ResolvedSettings) => void;
}) {
  const model = options.models.find(candidate => candidate.id === settings.model) ?? options.models[0]!;
  return <>
  <section>
    <span className="fa-config-label">Модель</span>
    <div className="fa-model-options" role="radiogroup" aria-label="Модель">
      {options.models.map(candidate => <button key={candidate.id} type="button" role="radio" aria-checked={candidate.id === settings.model}
        className={candidate.id === settings.model ? 'is-selected' : ''} onClick={() => onChange(switchModel(options, settings, candidate.id))}>
        <span><strong>{candidate.label}</strong><small>{candidate.id}</small></span>
        {candidate.id === settings.model && <i aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>
        </i>}
      </button>)}
    </div>
  </section>
  <section>
    <span className="fa-config-label">Усилие рассуждения</span>
    <EffortSlider efforts={model.efforts} effort={settings.effort} onChange={effort => onChange({...settings, effort})} />
  </section>
  </>;
}
