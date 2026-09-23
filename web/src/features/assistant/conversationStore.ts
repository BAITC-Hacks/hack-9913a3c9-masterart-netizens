import {isGid, MAX_QUESTION_LENGTH, parseAssistantResponse} from './api';
import type {AssistantResponse, JsonValue} from './types';

/**
 * Сохранённые разговоры с помощником. Без React, чтобы чтение, проверка и запись проверялись тестами.
 *
 * Все разговоры лежат под одним ключом localStorage, у каждого — sha256 входных данных (scope) и счёт,
 * с которого он начат. Разговоры другого набора данных не продолжаются: они видны отдельно с пометкой.
 * Сохранённый ответ при чтении снова проходит parseAssistantResponse — та же проверка, что у ответа
 * сервера, поэтому испорченный или подменённый ответ не показывается как настоящий.
 */
export const CONVERSATIONS_KEY = 'finance-workbench:assistant:v1';
/** Сколько разговоров и вопросов в разговоре хранится; старые вытесняются, чтобы не переполнить хранилище. */
export const MAX_CONVERSATIONS = 30;
export const MAX_TURNS = 40;
export const MAX_TITLE_LENGTH = 80;

export type ConversationStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface StoredTurn {
  id: string;
  question: string;
  /** Выбор на карте в момент вопроса — точные строки gid. */
  selection: string[];
  askedAt: string;
  response?: AssistantResponse;
  error?: string;
}

export interface Conversation {
  id: string;
  /** summary.input_sha256 набора данных, на котором шёл разговор. */
  scope: string;
  /** Счёт, открытый при начале разговора; null — разговор о графе в целом. */
  startGid: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: StoredTurn[];
  /** Черновик следующего вопроса. */
  draft: string;
}

/** Выбор модели и усилия — только идентификаторы вариантов, которые назвал сервер. */
export interface AssistantSettings { model?: string; effort?: string }

export type ConversationIssue =
  | {kind: 'unavailable'}
  | {kind: 'write_failed'}
  | {kind: 'reset'}
  | {kind: 'recovered'; dropped: number};

export interface ConversationSnapshot {
  readonly scope: string;
  /** Разговоры этого набора данных, последние изменённые — первыми. */
  readonly conversations: readonly Conversation[];
  /** Разговоры других наборов данных: только просмотр списка и удаление. */
  readonly foreign: readonly Conversation[];
  readonly activeId: string | null;
  readonly settings: AssistantSettings;
  readonly persistent: boolean;
  readonly issues: readonly ConversationIssue[];
  readonly lastDeleted: Conversation | null;
}

export interface ConversationStore {
  getSnapshot(): ConversationSnapshot;
  subscribe(listener: () => void): () => void;
  /** Новый пустой разговор; становится открытым. */
  create(startGid: string | null): string;
  open(id: string | null): void;
  rename(id: string, title: string): void;
  remove(id: string): void;
  undoRemove(): void;
  setDraft(id: string, draft: string): void;
  /** Добавляет вопрос; заголовок пустого разговора берётся из первого вопроса. */
  ask(id: string, question: string, selection: readonly string[]): string | null;
  answer(id: string, turnId: string, response: AssistantResponse): void;
  fail(id: string, turnId: string, message: string): void;
  setSettings(settings: AssistantSettings): void;
  dismissIssues(): void;
  /** Немедленно записывает отложенный черновик. */
  flush(): void;
  reload(): void;
}

export interface ConversationStoreOptions {
  scope: string;
  storage: ConversationStorage | null;
  now?: () => Date;
  newId?: () => string;
  /** Задержка записи черновика, мс. */
  draftDelayMs?: number;
}

const INTERRUPTED = 'Ответ не получен: страница была закрыта или перезагружена во время запроса.';
const BROKEN_ANSWER = 'Сохранённый ответ повреждён и не показывается. Задайте вопрос заново.';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 100_000): v is string => typeof v === 'string' && v.length <= max;

/** Ответ в том виде, в каком его прислал сервер: основания — исходными объектами, чтобы повторный разбор дал то же. */
export function toWire(response: AssistantResponse): Record<string, unknown> {
  return {...response, citations: response.citations.map(citation => citation.detail)};
}

function parseTurn(raw: unknown): StoredTurn | null {
  if (!isObj(raw) || !str(raw.id, 100) || !str(raw.question, MAX_QUESTION_LENGTH) || !str(raw.askedAt, 40)) return null;
  if (!Array.isArray(raw.selection) || !raw.selection.every(isGid)) return null;
  const turn: StoredTurn = {id: raw.id, question: raw.question, selection: [...raw.selection], askedAt: raw.askedAt};
  if (raw.response !== undefined) {
    try { turn.response = parseAssistantResponse(raw.response); } catch { turn.error = BROKEN_ANSWER; }
  } else if (str(raw.error, 2000)) {
    turn.error = raw.error;
  } else {
    turn.error = INTERRUPTED;
  }
  return turn;
}

function parseConversation(raw: unknown): {conversation: Conversation | null; droppedTurns: number} {
  if (!isObj(raw) || !str(raw.id, 100) || !str(raw.scope, 200) || !raw.scope || !str(raw.title, MAX_TITLE_LENGTH)
    || !str(raw.createdAt, 40) || !str(raw.updatedAt, 40) || !Array.isArray(raw.turns)
    || !(raw.startGid === null || isGid(raw.startGid))) return {conversation: null, droppedTurns: 0};
  const turns: StoredTurn[] = [];
  let droppedTurns = 0;
  for (const item of raw.turns.slice(-MAX_TURNS)) {
    const turn = parseTurn(item);
    if (turn) turns.push(turn); else droppedTurns++;
  }
  return {
    conversation: {
      id: raw.id, scope: raw.scope, startGid: raw.startGid as string | null, title: raw.title,
      createdAt: raw.createdAt, updatedAt: raw.updatedAt, turns, draft: str(raw.draft, MAX_QUESTION_LENGTH) ? raw.draft : '',
    },
    droppedTurns,
  };
}

export interface ParsedConversations {
  conversations: Conversation[];
  activeId: string | null;
  settings: AssistantSettings;
  issues: ConversationIssue[];
  dirty: boolean;
}

/** Разбирает сохранённое значение; неверные разговоры и вопросы отбрасываются и считаются. */
export function parseStoredConversations(raw: string | null): ParsedConversations {
  const empty: ParsedConversations = {conversations: [], activeId: null, settings: {}, issues: [], dirty: false};
  if (raw === null) return empty;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return {...empty, issues: [{kind: 'reset'}], dirty: true}; }
  if (!isObj(value) || value.v !== 1 || !Array.isArray(value.conversations)) return {...empty, issues: [{kind: 'reset'}], dirty: true};
  const conversations: Conversation[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let droppedTurns = 0;
  for (const item of value.conversations.slice(0, MAX_CONVERSATIONS)) {
    const parsed = parseConversation(item);
    droppedTurns += parsed.droppedTurns;
    if (!parsed.conversation || seen.has(parsed.conversation.id)) { dropped++; continue; }
    seen.add(parsed.conversation.id);
    conversations.push(parsed.conversation);
  }
  const settings: AssistantSettings = {};
  if (isObj(value.settings)) {
    if (str(value.settings.model, 100)) settings.model = value.settings.model;
    if (str(value.settings.effort, 100)) settings.effort = value.settings.effort;
  }
  const activeId = str(value.activeId, 100) && seen.has(value.activeId) ? value.activeId : null;
  const issues: ConversationIssue[] = dropped + droppedTurns ? [{kind: 'recovered', dropped: dropped + droppedTurns}] : [];
  return {conversations, activeId, settings, issues, dirty: dropped + droppedTurns > 0};
}

const byUpdated = (a: Conversation, b: Conversation) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

export function createConversationStore(options: ConversationStoreOptions): ConversationStore {
  const {scope, storage} = options;
  const now = options.now ?? (() => new Date());
  let counter = 0;
  const newId = options.newId ?? (() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c${Date.now()}-${++counter}`));
  const draftDelay = options.draftDelayMs ?? 400;
  const listeners = new Set<() => void>();
  /** Все разговоры всех наборов данных — источник истины для записи. */
  let all: Conversation[] = [];
  let draftTimer: ReturnType<typeof setTimeout> | null = null;

  const serialize = (activeId: string | null, settings: AssistantSettings) => JSON.stringify({
    v: 1, activeId, settings,
    conversations: all.map(c => ({...c, turns: c.turns.map(t => (t.response ? {...t, response: toWire(t.response)} : t))})),
  });

  const write = (activeId: string | null, settings: AssistantSettings): boolean => {
    if (!storage) return false;
    try { storage.setItem(CONVERSATIONS_KEY, serialize(activeId, settings)); return true; } catch { return false; }
  };

  const view = (base: Omit<ConversationSnapshot, 'conversations' | 'foreign'>): ConversationSnapshot => {
    const sorted = [...all].sort(byUpdated);
    return {...base, conversations: sorted.filter(c => c.scope === scope), foreign: sorted.filter(c => c.scope !== scope)};
  };

  const read = (): ConversationSnapshot => {
    const offline = () => view({scope, activeId: null, settings: {}, persistent: false, issues: [{kind: 'unavailable'}], lastDeleted: null});
    if (!storage) { all = []; return offline(); }
    let raw: string | null;
    try { raw = storage.getItem(CONVERSATIONS_KEY); } catch { all = []; return offline(); }
    const parsed = parseStoredConversations(raw);
    all = parsed.conversations;
    const activeId = parsed.activeId && all.some(c => c.id === parsed.activeId && c.scope === scope) ? parsed.activeId : null;
    const issues = [...parsed.issues];
    let persistent = true;
    if (parsed.dirty && !write(activeId, parsed.settings)) { persistent = false; issues.push({kind: 'write_failed'}); }
    return view({scope, activeId, settings: parsed.settings, persistent, issues, lastDeleted: null});
  };

  let snapshot = read();

  const emit = () => { for (const listener of listeners) listener(); };

  /** Применяет изменение, пишет и честно отмечает неудачную или восстановившуюся запись. */
  const commit = (patch: Partial<Pick<ConversationSnapshot, 'activeId' | 'settings' | 'lastDeleted'>> = {}) => {
    const activeId = patch.activeId !== undefined ? patch.activeId : snapshot.activeId;
    const settings = patch.settings ?? snapshot.settings;
    let {persistent, issues} = snapshot;
    if (storage) {
      if (write(activeId, settings)) {
        persistent = true;
        issues = issues.filter(issue => issue.kind !== 'write_failed');
      } else {
        persistent = false;
        if (!issues.some(issue => issue.kind === 'write_failed')) issues = [...issues, {kind: 'write_failed'}];
      }
    }
    snapshot = view({scope, activeId, settings, persistent, issues, lastDeleted: patch.lastDeleted !== undefined ? patch.lastDeleted : snapshot.lastDeleted});
    emit();
  };

  const find = (id: string) => all.find(c => c.id === id && c.scope === scope);
  const replace = (next: Conversation) => { all = all.map(c => (c.id === next.id ? next : c)); };
  const stamp = () => now().toISOString();

  const cancelDraftTimer = () => { if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; } };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    create(startGid) {
      const at = stamp();
      const conversation: Conversation = {id: newId(), scope, startGid: startGid && isGid(startGid) ? startGid : null, title: '', createdAt: at, updatedAt: at, turns: [], draft: ''};
      all = [conversation, ...all];
      // Вытесняем самые старые разговоры, чтобы хранилище не росло без предела.
      if (all.length > MAX_CONVERSATIONS) all = [...all].sort(byUpdated).slice(0, MAX_CONVERSATIONS);
      commit({activeId: conversation.id});
      return conversation.id;
    },
    open(id) {
      if (id !== null && !find(id)) return;
      commit({activeId: id});
    },
    rename(id, title) {
      const conversation = find(id);
      const clean = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
      if (!conversation || !clean || clean === conversation.title) return;
      replace({...conversation, title: clean});
      commit();
    },
    remove(id) {
      const conversation = all.find(c => c.id === id);
      if (!conversation) return;
      all = all.filter(c => c.id !== id);
      commit({activeId: snapshot.activeId === id ? null : snapshot.activeId, lastDeleted: conversation});
    },
    undoRemove() {
      const last = snapshot.lastDeleted;
      if (!last || all.some(c => c.id === last.id)) return;
      all = [last, ...all];
      commit({activeId: last.scope === scope ? last.id : snapshot.activeId, lastDeleted: null});
    },
    setDraft(id, draft) {
      const conversation = find(id);
      if (!conversation || conversation.draft === draft) return;
      replace({...conversation, draft: draft.slice(0, MAX_QUESTION_LENGTH)});
      snapshot = view({...snapshot});
      emit();
      cancelDraftTimer();
      draftTimer = setTimeout(() => { draftTimer = null; commit(); }, draftDelay);
    },
    ask(id, question, selection) {
      const conversation = find(id);
      const text = question.trim();
      if (!conversation || !text || text.length > MAX_QUESTION_LENGTH || !selection.every(isGid)) return null;
      const turn: StoredTurn = {id: newId(), question: text, selection: [...new Set(selection)], askedAt: stamp()};
      const title = conversation.title || text.replace(/\s+/g, ' ').slice(0, MAX_TITLE_LENGTH);
      replace({...conversation, title, draft: '', updatedAt: turn.askedAt, turns: [...conversation.turns, turn].slice(-MAX_TURNS)});
      cancelDraftTimer();
      commit({activeId: id, lastDeleted: null});
      return turn.id;
    },
    answer(id, turnId, response) {
      const conversation = find(id);
      if (!conversation || !conversation.turns.some(t => t.id === turnId)) return;
      replace({...conversation, updatedAt: stamp(), turns: conversation.turns.map(t => (t.id === turnId ? {...t, response, error: undefined} : t))});
      commit();
    },
    fail(id, turnId, message) {
      const conversation = find(id);
      if (!conversation || !conversation.turns.some(t => t.id === turnId)) return;
      replace({...conversation, turns: conversation.turns.map(t => (t.id === turnId ? {...t, error: message} : t))});
      commit();
    },
    setSettings(settings) {
      const clean: AssistantSettings = {};
      if (settings.model) clean.model = settings.model.slice(0, 100);
      if (settings.effort) clean.effort = settings.effort.slice(0, 100);
      commit({settings: clean});
    },
    dismissIssues() {
      if (!snapshot.issues.length) return;
      snapshot = view({...snapshot, issues: []});
      emit();
    },
    flush() {
      if (!draftTimer) return;
      cancelDraftTimer();
      commit();
    },
    reload() {
      cancelDraftTimer();
      snapshot = read();
      emit();
    },
  };
}

/** Проверка, что строка — JSON-значение ответа; нужна тестам и отладке формы хранения. */
export type WireResponse = ReturnType<typeof toWire> & {citations: JsonValue[]};
