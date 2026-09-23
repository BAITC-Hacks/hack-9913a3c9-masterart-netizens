import {useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent} from 'react';
import {askAssistant, AssistantError, exactSelection, loadAssistantOptions, MAX_QUESTION_LENGTH, REQUEST_TIMEOUT_MS} from './api';
import {AnswerCard, NodeLinks} from './AnswerCard';
import type {Conversation, ConversationIssue, ConversationStorage, ConversationStore, StoredTurn} from './conversationStore';
import type {AssistantOptions, AssistantRequest} from './types';
import {buildHistory, effortLabel, modelLabel, resolveSettings} from './modelSettings';
import {ModelEffortMenu} from './ModelEffortMenu';
import {useConversations} from './useConversations';
import './assistant.css';
import './workspace.css';

export interface AssistantWorkspaceProps {
  /** summary.input_sha256 — запасной ключ разговоров, если сервер не сообщил отпечаток набора данных. */
  scope: string;
  /** Выбранные на карте счета — контекст следующего вопроса. */
  selection: string[];
  onSelectNode: (gid: string) => void;
  open: boolean;
  onClose: () => void;
  /** Подмена хранилища для проверок; null — только память. */
  storage?: ConversationStorage | null;
  /** Загрузка настроек помощника (GET /api/assistant/options); подменяется в проверках. */
  loadOptions?: (signal: AbortSignal) => Promise<AssistantOptions>;
  /** Уже известные настройки — для проверок без сети. */
  initialOptions?: AssistantOptions;
}

type OptionsState = {phase: 'loading'} | {phase: 'ready'; options: AssistantOptions} | {phase: 'error'; message: string};
type Pending = {conversationId: string; turnId: string; controller: AbortController; timer: ReturnType<typeof setTimeout>};

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const questions = (n: number) => `${n} ${plural(n, 'вопрос', 'вопроса', 'вопросов')}`;

export function issueText(issue: ConversationIssue): string {
  switch (issue.kind) {
    case 'unavailable': return 'Браузер не разрешает сохранять данные. Разговоры действуют до перезагрузки страницы.';
    case 'write_failed': return 'Не удалось записать разговоры в браузер. Изменения видны сейчас, но пропадут после перезагрузки.';
    case 'reset': return 'Сохранённые разговоры не удалось прочитать, начат новый список.';
    case 'recovered': return `Часть сохранённых записей была повреждена и пропущена: ${issue.dropped}.`;
  }
}

/**
 * Чем получен ответ: модель и усилие называет сам ответ сервера. Если модель была запрошена, а ответ пришёл
 * без неё (нет ключа, ошибка сервиса), это сказано прямо — локальный разбор не выдаётся за ответ модели.
 */
export function turnMeta(turn: StoredTurn, options: AssistantOptions | null): string {
  const response = turn.response;
  if (!response) return '';
  const parts: string[] = [];
  if (response.parser === 'openai') {
    if (response.model) parts.push(`Модель ${modelLabel(options, response.model)}`);
    if (response.effort) parts.push(`усилие «${effortLabel(response.effort).toLowerCase()}»`);
  } else if (turn.model) {
    parts.push(`Запрошена ${modelLabel(options, turn.model)}, ответ получен без модели`);
  }
  if (response.history_turns_used) parts.push(`учтено вопросов из разговора: ${response.history_turns_used}`);
  return parts.join(' · ');
}

function suggestionsFor(selection: string[]): [string, string][] {
  return selection.length
    ? [['Объяснить роль', `Объясни роль счёта ${selection[0]}`],
      ['Цепочки по датам', `Покажи цепочки по датам для счёта ${selection[0]}`],
      ['Что запросить', `Какие дополнительные данные нужны для проверки счёта ${selection[0]}?`]]
    : [['Кого проверить', 'Какие счета проверить в первую очередь?'],
      ['Сравнить режимы', 'Чем отличаются структурные связи и цепочки по датам?'],
      ['Границы данных', 'Какие ограничения есть у этих данных?']];
}

/** Строка разговора в списке: заголовок, счёт начала и число вопросов. */
function ConversationRow({conversation, active, onOpen}: {conversation: Conversation; active: boolean; onOpen: () => void}) {
  return <li>
    <button type="button" className={`fa-ws-row${active ? ' is-active' : ''}`} aria-current={active || undefined} onClick={onOpen}>
      <span className="fa-ws-row-title">{conversation.title || 'Новый разговор'}</span>
      <span className="fa-ws-row-meta">
        {conversation.startGid ? <span className="fa-gid" dir="ltr">{conversation.startGid}</span> : <span>Весь граф</span>}
        <span>{questions(conversation.turns.length)}</span>
      </span>
    </button>
  </li>;
}

const Icon = ({d, size = 18}: {d: string; size?: number}) =>
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;

/**
 * Рабочая область разговоров: сохранённые разговоры слева, лента вопросов и ответов, поле вопроса внизу.
 * Разговоры привязаны к отпечатку набора данных от сервера и к счёту, с которого начаты. Следующий вопрос
 * уходит с выбранной моделью и усилием и с ограниченным контекстом разговора (вопросы, выбор, счета из
 * ответов — не текст ответов). Переход к счёту из ответа закрывает окно; открытый разговор не меняется.
 */
export function AssistantWorkspace({scope, selection, onSelectNode, open, onClose, storage, loadOptions, initialOptions}: AssistantWorkspaceProps) {
  const prefix = useId();
  const [optionsState, setOptionsState] = useState<OptionsState>(initialOptions ? {phase: 'ready', options: initialOptions} : {phase: 'loading'});
  const options = optionsState.phase === 'ready' ? optionsState.options : null;
  const optionsLoading = optionsState.phase === 'loading';
  const {snapshot, store} = useConversations(options?.dataset_fingerprint ?? scope, storage);
  const settings = options ? resolveSettings(options, snapshot.settings) : null;
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const feed = useRef<HTMLOListElement>(null);
  const pending = useRef<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [newDraft, setNewDraft] = useState('');
  const [validation, setValidation] = useState('');
  const [notice, setNotice] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  let context: string[] = [];
  let contextError = '';
  try { context = exactSelection(selection); } catch { contextError = 'Выбранный счёт имеет некорректный идентификатор. Выберите его заново на карте.'; }

  // Пока сервер не назвал отпечаток данных, разговоры не показываются: иначе мелькнул бы чужой список.
  const conversations = optionsLoading ? [] : snapshot.conversations;
  const active = conversations.find(c => c.id === snapshot.activeId) ?? null;
  const draft = active ? active.draft : newDraft;

  useEffect(() => {
    if (initialOptions) return;
    const controller = new AbortController();
    (loadOptions ?? loadAssistantOptions)(controller.signal)
      .then(loaded => { if (!controller.signal.aborted) setOptionsState({phase: 'ready', options: loaded}); })
      .catch(error => {
        if (!controller.signal.aborted) setOptionsState({phase: 'error', message: error instanceof AssistantError ? error.message : 'Настройки помощника недоступны.'});
      });
    return () => controller.abort();
  }, [initialOptions, loadOptions]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      if (typeof element.showModal === 'function') element.showModal(); else element.setAttribute('open', '');
      requestAnimationFrame(() => input.current?.focus());
    }
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => () => {
    const current = pending.current;
    if (current) { clearTimeout(current.timer); current.controller.abort(); pending.current = null; }
  }, []);

  // Новая реплика — прокрутка к концу ленты, как в любом разговоре.
  const turnCount = active?.turns.length ?? 0;
  useEffect(() => { feed.current?.lastElementChild?.scrollIntoView({block: 'end', behavior: 'smooth'}); }, [turnCount, snapshot.activeId]);

  function stop(message = 'Запрос остановлен. Можно задать новый вопрос.') {
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    clearTimeout(current.timer);
    current.controller.abort();
    store.fail(current.conversationId, current.turnId, message);
    setBusy(false);
    setNotice(message);
  }

  async function send(text: string) {
    if (pending.current || contextError || optionsLoading) return;
    const question = text.trim();
    if (!question || question.length > MAX_QUESTION_LENGTH) {
      setValidation(`Введите вопрос длиной от 1 до ${MAX_QUESTION_LENGTH} символов.`);
      input.current?.focus();
      return;
    }
    // Контекст — завершённые вопросы этого разговора до нового; лимиты называет сервер.
    const history = options && active ? buildHistory(active.turns, options.history_limits) : [];
    const conversationId = active?.id ?? store.create(context[0] ?? null);
    const turnId = store.ask(conversationId, question, context, settings ?? undefined);
    if (!turnId) return;
    const request: AssistantRequest = options && settings
      ? {question, selection: context, model: settings.model, effort: settings.effort, dataset_fingerprint: options.dataset_fingerprint, history}
      : {question, selection: context};
    setNewDraft('');
    setValidation('');
    const controller = new AbortController();
    const timer = setTimeout(() => stop('Сервер не ответил за минуту. Попробуйте повторить запрос.'), REQUEST_TIMEOUT_MS);
    pending.current = {conversationId, turnId, controller, timer};
    setBusy(true);
    setNotice('Проверяем вопрос по данным графа.');
    try {
      const response = await askAssistant(request, controller.signal);
      // Отменённый запрос не подменяет следующий, даже если сеть ответила поздно.
      if (pending.current?.turnId !== turnId) return;
      store.answer(conversationId, turnId, response);
      setNotice('Ответ готов.');
    } catch (error) {
      if (pending.current?.turnId !== turnId) return;
      const message = error instanceof AssistantError ? error.message : 'Не удалось получить ответ. Повторите запрос.';
      store.fail(conversationId, turnId, message);
      setNotice(message);
    } finally {
      if (pending.current?.turnId === turnId) { clearTimeout(timer); pending.current = null; setBusy(false); }
    }
  }

  const setDraft = (value: string) => {
    setValidation('');
    if (active) store.setDraft(active.id, value); else setNewDraft(value);
  };

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(draft);
    }
  }

  const navigate = (gid: string) => { onSelectNode(gid); onClose(); };
  const startNew = () => { store.open(null); setNewDraft(''); setListOpen(false); requestAnimationFrame(() => input.current?.focus()); };
  const pendingTurn = pending.current?.turnId;
  const keys = `Enter — отправить, Shift + Enter — новая строка · ${draft.length}/${MAX_QUESTION_LENGTH}.`;
  const hint = options
    ? `${keys} Помощник учитывает до ${options.history_limits.turns} последних вопросов этого разговора; текст прежних ответов не передаётся.`
    : optionsState.phase === 'error' ? `${keys} Каждый вопрос проверяется отдельно: прежние ответы в запрос не передаются.` : keys;

  return <dialog ref={dialog} className="fa-ws" aria-labelledby={`${prefix}-title`} onClose={() => { store.flush(); if (open) onClose(); }}>
    <div className={`fa-ws-frame fa-panel${listOpen ? ' is-list-open' : ''}`}>
      <aside className="fa-ws-side" aria-label="Сохранённые разговоры">
        <div className="fa-ws-side-head">
          <p className="fa-section-label">Разговоры</p>
          <button type="button" className="fa-button fa-ws-new" onClick={startNew} disabled={busy}>Новый разговор</button>
        </div>
        {optionsLoading
          ? <p className="fa-caption fa-ws-side-empty">Загружаем разговоры…</p>
          : conversations.length
            ? <ul className="fa-ws-list">{conversations.map(c => <ConversationRow key={c.id} conversation={c} active={c.id === snapshot.activeId}
                onOpen={() => { store.open(c.id); setListOpen(false); }} />)}</ul>
            : <p className="fa-caption fa-ws-side-empty">Здесь появятся разговоры по этому набору данных. Они сохраняются в браузере.</p>}
        {!optionsLoading && snapshot.foreign.length > 0 && <div className="fa-ws-foreign">
          <p className="fa-section-label">Другие наборы данных · {snapshot.foreign.length}</p>
          <p className="fa-caption">Эти разговоры велись на другом файле анализа. Продолжить их можно, только открыв тот файл.</p>
          <ul className="fa-ws-list">{snapshot.foreign.map(c => <li key={c.id} className="fa-ws-foreign-row">
            <span className="fa-ws-row-title">{c.title || 'Разговор без вопросов'}</span>
            <span className="fa-ws-row-meta"><span className="fa-gid" title={c.scope}>данные {c.scope.slice(0, 12)}…</span><span>{questions(c.turns.length)}</span></span>
            <button type="button" className="fa-ws-icon" onClick={() => store.remove(c.id)} aria-label={`Удалить разговор «${c.title || 'без вопросов'}»`}>
              <Icon d="m6 6 12 12M18 6 6 18" size={16} />
            </button>
          </li>)}</ul>
        </div>}
      </aside>

      <section className="fa-ws-main" aria-label="Разговор">
        <header className="fa-ws-head">
          <button type="button" className="fa-ws-icon fa-ws-list-toggle" aria-expanded={listOpen} onClick={() => setListOpen(value => !value)} aria-label="Список разговоров">
            <Icon d="M4 7h16M4 12h16M4 17h10" />
          </button>
          {active && renaming === active.id
            ? <form className="fa-ws-rename" onSubmit={event => { event.preventDefault(); store.rename(active.id, new FormData(event.currentTarget).get('title') as string); setRenaming(null); }}>
                <label className="fa-sr" htmlFor={`${prefix}-rename`}>Название разговора</label>
                <input id={`${prefix}-rename`} name="title" defaultValue={active.title} maxLength={80} autoFocus
                  onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenaming(null); } }} />
                <button type="submit" className="fa-button">Сохранить</button>
              </form>
            : <h2 id={`${prefix}-title`} className="fa-ws-title">{active ? active.title || 'Новый разговор' : 'Новый разговор'}</h2>}
          <div className="fa-ws-actions">
            {active && renaming !== active.id && <button type="button" className="fa-ws-icon" onClick={() => setRenaming(active.id)} aria-label="Переименовать разговор" title="Переименовать">
              <Icon d="M4 20h4L19 9l-4-4L4 16v4Zm9.5-13.5 4 4" size={17} />
            </button>}
            {active && <button type="button" className="fa-ws-icon" disabled={busy} onClick={() => store.remove(active.id)} aria-label="Удалить разговор" title="Удалить">
              <Icon d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" size={17} />
            </button>}
            <button type="button" className="fa-ws-icon" onClick={onClose} aria-label="Закрыть разговоры">
              <Icon d="m6 6 12 12M18 6 6 18" />
            </button>
          </div>
        </header>

        {snapshot.issues.length > 0 && <div className="fa-ws-notice" role="status">
          <span>{snapshot.issues.map(issue => <span key={issue.kind} className="fa-ws-issue">{issueText(issue)}</span>)}</span>
          <button type="button" className="fa-button" onClick={store.dismissIssues}>Скрыть</button>
        </div>}
        {snapshot.lastDeleted && <div className="fa-ws-notice fa-ws-undo" role="status">
          <span>Разговор «{snapshot.lastDeleted.title || 'без вопросов'}» удалён.</span>
          <button type="button" className="fa-button" onClick={store.undoRemove}>Вернуть</button>
        </div>}

        <div className="fa-ws-scroll">
          {active && active.startGid && <p className="fa-caption fa-ws-origin">Начат со счёта <span className="fa-gid" dir="ltr">{active.startGid}</span></p>}
          {!active || active.turns.length === 0
            ? <div className="fa-ws-empty">
                <p className="fa-ws-empty-title">Спросите о графе переводов</p>
                <p className="fa-caption">Ответы опираются на операции с графом; счета в ответе открываются на карте. Роли — гипотезы для проверки.</p>
                <div className="fa-suggestions">{suggestionsFor(context).map(([label, text]) =>
                  <button type="button" className="fa-button" key={label} disabled={busy || Boolean(contextError)} onClick={() => { setDraft(text); input.current?.focus(); }}>{label}</button>)}</div>
              </div>
            : <ol ref={feed} className="fa-ws-feed" aria-label="Вопросы и ответы">
                {active.turns.map(turn => {
                  const meta = turnMeta(turn, options);
                  return <li key={turn.id} className="fa-ws-turn" aria-busy={turn.id === pendingTurn || undefined}>
                    <div className="fa-ws-question"><p>{turn.question}</p>
                      {turn.selection.length > 0 && <span className="fa-caption">Контекст: {turn.selection.length === 1 ? <span className="fa-gid" dir="ltr">{turn.selection[0]}</span> : `${turn.selection.length} счёта`}</span>}
                    </div>
                    {turn.response ? <div>
                        <AnswerCard response={turn.response} onSelectNode={navigate} />
                        {meta && <p className="fa-caption fa-ws-meta">{meta}</p>}
                      </div>
                      : turn.error ? <div className="fa-failure"><p className={turn.error.startsWith('Запрос остановлен') ? 'fa-caption' : 'fa-error'}>{turn.error}</p>
                          <button type="button" className="fa-button" disabled={busy} onClick={() => void send(turn.question)}>Спросить ещё раз</button></div>
                        : <p className="fa-pending">Проверяем вопрос по данным графа…</p>}
                  </li>;
                })}
              </ol>}
        </div>

        <form className="fa-ws-composer" onSubmit={onSubmit}>
          <div className="fa-ws-context" aria-label="Контекст следующего вопроса">
            <span className="fa-caption">{context.length ? 'Вопрос о счёте' : 'Вопрос о графе в целом'}</span>
            <NodeLinks gids={context} onSelectNode={navigate} />
          </div>
          <label className="fa-sr" htmlFor={`${prefix}-question`}>Вопрос к данным</label>
          <div className="fa-ws-field">
            <textarea ref={input} id={`${prefix}-question`} value={draft} rows={2} maxLength={MAX_QUESTION_LENGTH}
              placeholder="Спросите о счёте или о графе…" aria-invalid={Boolean(validation || contextError)}
              aria-describedby={`${prefix}-hint${validation || contextError ? ` ${prefix}-validation` : ''}`}
              onKeyDown={onKeyDown} onChange={event => setDraft(event.target.value)} />
            <div className="fa-ws-bar">
              {options && settings
                ? <ModelEffortMenu options={options} settings={settings} onChange={next => store.setSettings(next)} disabled={busy} />
                : <span className="fa-caption fa-ws-model">{optionsState.phase === 'error' ? `${optionsState.message} Модель выбирает сервер.` : 'Загружаем настройки модели…'}</span>}
              {busy
                ? <button type="button" className="fa-ws-send is-stop" onClick={() => stop()} aria-label="Остановить запрос">
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg>
                  </button>
                : <button type="submit" className="fa-ws-send" disabled={!draft.trim() || Boolean(contextError) || optionsLoading} aria-label="Отправить вопрос">
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
                  </button>}
            </div>
          </div>
          {validation || contextError ? <p className="fa-error" id={`${prefix}-validation`} role="alert">{contextError || validation}</p> : null}
          <p className="fa-caption fa-ws-hint" id={`${prefix}-hint`}>{hint}</p>
          <p className="fa-sr" role="status" aria-live="polite">{notice}</p>
        </form>
      </section>
    </div>
  </dialog>;
}

/** Значок разговоров для шапки: открывает рабочую область и держит её состояние. */
export function AssistantLauncher(props: Omit<AssistantWorkspaceProps, 'open' | 'onClose'>) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="fa-launcher" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}
      aria-label="Разговоры с помощником" title="Разговоры с помощником">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.2 3.2a.5.5 0 0 1-.8-.4V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5Z" />
        <path d="M8 10h8M8 13h5" />
      </svg>
    </button>
    <AssistantWorkspace {...props} open={open} onClose={() => setOpen(false)} />
  </>;
}

export type {ConversationStore};
