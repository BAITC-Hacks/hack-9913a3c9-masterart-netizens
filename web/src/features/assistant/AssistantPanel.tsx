import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { askAssistant, AssistantError, exactSelection, MAX_QUESTION_LENGTH, REQUEST_TIMEOUT_MS } from './api';
import { AnswerCard, NodeLinks } from './AnswerCard';
import type { AssistantPanelProps, AssistantRequest, AssistantResponse } from './types';
import './assistant.css';

type Turn = AssistantRequest & { id: number; response?: AssistantResponse; error?: string; cancelled?: boolean };
type Pending = { id: number; controller: AbortController; timer: ReturnType<typeof setTimeout> };

/** История хранит контекст каждого вопроса: новый выбор на карте не меняет старый ответ. */
export function AssistantPanel({ selection, onSelectNode, className = '' }: AssistantPanelProps) {
  const prefix = useId();
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [validation, setValidation] = useState('');
  const pending = useRef<Pending | null>(null);
  const sequence = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  let selected: string[] = [];
  let selectionError = '';
  try { selected = exactSelection(selection); } catch { selectionError = 'Выбранный счёт имеет некорректный идентификатор. Выберите его заново на карте.'; }

  useEffect(() => () => {
    if (pending.current) {
      clearTimeout(pending.current.timer);
      pending.current.controller.abort();
      pending.current = null;
    }
  }, []);

  function stop(message = 'Запрос остановлен. Можно задать новый вопрос.') {
    const active = pending.current;
    if (!active) return;
    pending.current = null;
    clearTimeout(active.timer);
    active.controller.abort();
    setTurns((previous) => previous.map((turn) => turn.id === active.id ? { ...turn, cancelled: true, error: message } : turn));
    setBusy(false);
    setNotice(message);
  }

  async function submit(request: AssistantRequest) {
    if (pending.current || selectionError) return;
    const text = request.question.trim();
    if (!text || text.length > MAX_QUESTION_LENGTH) {
      setValidation(`Введите вопрос длиной от 1 до ${MAX_QUESTION_LENGTH} символов.`);
      input.current?.focus();
      return;
    }
    const id = ++sequence.current;
    const snapshot = { question: text, selection: [...request.selection] };
    const controller = new AbortController();
    const timer = setTimeout(() => stop('Сервер не ответил за минуту. Попробуйте повторить запрос.'), REQUEST_TIMEOUT_MS);
    pending.current = { id, controller, timer };
    setTurns((previous) => [...previous, { id, ...snapshot }]);
    setValidation('');
    setBusy(true);
    setNotice('Проверяем вопрос по данным графа.');
    try {
      const response = await askAssistant(snapshot, controller.signal);
      // Отменённый запрос не должен подменить результат следующего, даже если сеть ответила поздно.
      if (pending.current?.id !== id) return;
      setTurns((previous) => previous.map((turn) => turn.id === id ? { ...turn, response } : turn));
      setQuestion((draft) => draft.trim() === text ? '' : draft);
      setNotice('Ответ готов. Счета и основания доступны под вопросом.');
    } catch (error) {
      if (pending.current?.id !== id) return;
      const message = error instanceof AssistantError ? error.message : 'Не удалось получить ответ. Повторите запрос.';
      setTurns((previous) => previous.map((turn) => turn.id === id ? { ...turn, error: message } : turn));
      setNotice(message);
    } finally {
      if (pending.current?.id === id) {
        clearTimeout(timer);
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit({ question, selection: selected });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit({ question, selection: selected });
    }
  }

  const suggestions = selected.length
    ? [
      ['Объяснить роль', `Объясни роль счёта ${selected[0]}`],
      ['Проверить цепочки', `Покажи цепочки по датам для счёта ${selected[0]}`],
      ['Что запросить', `Какие дополнительные данные нужны для проверки счёта ${selected[0]}?`],
    ]
    : [
      ['Кого проверить', 'Какие счета проверить в первую очередь?'],
      ['Сравнить режимы', 'Чем отличаются структурные связи и цепочки по датам?'],
      ['Границы данных', 'Какие ограничения есть у этих данных?'],
    ];

  return <section className={`fa-panel ${className}`.trim()} aria-labelledby={`${prefix}-heading`}>
    <header className="fa-header">
      <div><p className="fa-eyebrow">Работа с основаниями</p><h2 id={`${prefix}-heading`}>Спросить о графе</h2></div>
      {turns.length > 0 && !busy ? <button type="button" className="fa-button fa-clear" onClick={() => {
        setTurns([]); setNotice('История очищена.'); input.current?.focus();
      }}>Очистить историю</button> : null}
    </header>
    <p className="fa-intro">Вопрос, проверяемые факты, переход к счёту. Каждый запрос использует выбранные счета; предыдущие ответы не передаются.</p>
    <div className="fa-context" aria-label="Контекст следующего вопроса">
      <p className="fa-section-label">{selected.length ? `Выбрано счетов: ${selected.length}` : 'Обзор всего графа'}</p>
      <NodeLinks gids={selected} onSelectNode={onSelectNode} />
    </div>
    <div className="fa-suggestions" aria-label="Примеры вопросов">
      {suggestions.map(([label, text]) => <button className="fa-button" type="button" key={label} disabled={busy || Boolean(selectionError)} onClick={() => {
        setQuestion(text ?? ''); setValidation(''); input.current?.focus();
      }}>{label}</button>)}
    </div>
    <form className="fa-form" onSubmit={onSubmit}>
      <label htmlFor={`${prefix}-question`}>Вопрос к данным</label>
      <textarea ref={input} id={`${prefix}-question`} value={question} rows={3} maxLength={MAX_QUESTION_LENGTH}
        placeholder="Например: почему этот счёт попал в список проверки?"
        aria-describedby={`${prefix}-hint${validation || selectionError ? ` ${prefix}-validation` : ''}`}
        aria-invalid={Boolean(validation || selectionError)} onKeyDown={onKeyDown}
        onChange={(event) => { setQuestion(event.target.value); setValidation(''); }} />
      {validation || selectionError ? <p className="fa-error" id={`${prefix}-validation`} role="alert">{selectionError || validation}</p> : null}
      <div className="fa-form-footer">
        <span id={`${prefix}-hint`} className="fa-caption">Ctrl / ⌘ + Enter · {question.length}/{MAX_QUESTION_LENGTH}</span>
        {busy ? <button type="button" className="fa-button" onClick={() => stop()}>Остановить</button>
          : <button type="submit" className="fa-button fa-submit" disabled={!question.trim() || Boolean(selectionError)}>Задать вопрос <span aria-hidden="true">↗</span></button>}
      </div>
    </form>
    <p className="fa-status" role="status" aria-live="polite" aria-atomic="true">{notice || 'Режим разбора будет указан рядом с ответом. Без модели доступен локальный разбор.'}</p>
    {turns.length > 0 ? <ol className="fa-conversation" aria-label="Вопросы и ответы">
      {turns.map((turn) => <li className="fa-turn" key={turn.id} aria-busy={busy && pending.current?.id === turn.id}>
        <div className="fa-question"><p className="fa-eyebrow">Вопрос {turn.id}</p><h3>{turn.question}</h3></div>
        {turn.selection.length ? <details className="fa-details fa-turn-context"><summary>Контекст вопроса · {turn.selection.length}</summary><NodeLinks gids={turn.selection} onSelectNode={onSelectNode} /></details> : null}
        {turn.response ? <AnswerCard response={turn.response} onSelectNode={onSelectNode} />
          : turn.error ? <div className="fa-failure"><p className={turn.cancelled ? 'fa-caption' : 'fa-error'}>{turn.error}</p>
            <button className="fa-button" type="button" disabled={busy} onClick={() => void submit(turn)}>Повторить этот вопрос</button>
          </div> : <p className="fa-pending">Проверяем вопрос по данным графа…</p>}
      </li>)}
    </ol> : null}
    <p className="fa-limitation">Роли — гипотезы для проверки. Цепочка переводов не доказывает движение одних и тех же средств.</p>
  </section>;
}
