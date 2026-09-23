import {describe, expect, it} from 'vitest';
import {parseAssistantResponse} from './api';
import {CONVERSATIONS_KEY, MAX_CONVERSATIONS, createConversationStore, parseStoredConversations, toWire, type ConversationStorage} from './conversationStore';

class MemoryStorage implements ConversationStorage {
  readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
}

const SCOPE = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const GID = '900719925474099312';
const NEXT = '900719925474099313';
let ids = 0;
const open = (storage: ConversationStorage | null, scope = SCOPE) => createConversationStore({
  scope, storage, draftDelayMs: 0, newId: () => `id-${++ids}`,
  now: (() => { let t = Date.parse('2026-09-23T11:00:00Z'); return () => new Date(t += 1000); })(),
});
const serverAnswer = (extra: Record<string, unknown> = {}) => parseAssistantResponse({
  answer_md: '## Роль\nГипотеза: **транзит**.', nodes: [GID, NEXT], intent: 'explain_node', args: {gid: NEXT}, parser: 'rules',
  warnings: ['Исходящие на границе не наблюдаются.'],
  citations: [{label: 'Метрики счёта', gid: NEXT, source: 'analysis.json', fields: ['metrics.in_degree']}, `Счёт ${GID}`],
  tool_trace: [{tool: 'explain_node', args: {gid: NEXT}, result: {gid: NEXT, in_degree: 7}}], ...extra,
});

describe('Разговоры с помощником — хранилище', () => {
  it('[CHAT-SAVE] вопрос и ответ переживают перезагрузку, gid остаются точными строками', () => {
    const mem = new MemoryStorage();
    const store = open(mem);
    const id = store.create(GID);
    const turn = store.ask(id, '  Объясни роль счёта  ', [NEXT, NEXT])!;
    store.answer(id, turn, serverAnswer());
    const reloaded = open(mem).getSnapshot();
    expect(reloaded.activeId).toBe(id);
    const saved = reloaded.conversations[0]!;
    expect(saved).toMatchObject({id, scope: SCOPE, startGid: GID, title: 'Объясни роль счёта'});
    expect(saved.turns[0]).toMatchObject({question: 'Объясни роль счёта', selection: [NEXT]});
    expect(saved.turns[0]!.response).toEqual(serverAnswer());
    expect(mem.getItem(CONVERSATIONS_KEY)).toContain(`"${NEXT}"`);
    expect(mem.getItem(CONVERSATIONS_KEY)).not.toMatch(/:\s*9007199254740993\d*/);
  });

  it('[CHAT-SAVE] сохранённый ответ повторно разбирается без искажения оснований', () => {
    const answer = serverAnswer();
    expect(parseAssistantResponse(JSON.parse(JSON.stringify(toWire(answer))))).toEqual(answer);
  });

  it('[CHAT-SCOPE] разговор другого набора данных виден отдельно и не открывается', () => {
    const mem = new MemoryStorage();
    const first = open(mem);
    const foreignId = first.create(GID);
    first.ask(foreignId, 'Вопрос о старом файле', []);
    const current = open(mem, OTHER);
    expect(current.getSnapshot().conversations).toEqual([]);
    expect(current.getSnapshot().foreign.map(c => c.id)).toEqual([foreignId]);
    expect(current.getSnapshot().activeId).toBeNull();
    current.open(foreignId);
    expect(current.getSnapshot().activeId).toBeNull();
    expect(current.ask(foreignId, 'Продолжить', [])).toBeNull();
    const own = current.create(null);
    expect(open(mem, OTHER).getSnapshot().conversations.map(c => c.id)).toEqual([own]);
    expect(open(mem).getSnapshot().conversations.map(c => c.id)).toEqual([foreignId]);
  });

  it('[CHAT-MANAGE] переименование, удаление с возвратом, открытие другого разговора', () => {
    const mem = new MemoryStorage();
    const store = open(mem);
    const a = store.create(null);
    store.ask(a, 'Первый вопрос', []);
    const b = store.create(GID);
    store.rename(a, '   Проверка   транзита  ');
    expect(store.getSnapshot().conversations.find(c => c.id === a)!.title).toBe('Проверка транзита');
    store.rename(a, '   ');
    expect(store.getSnapshot().conversations.find(c => c.id === a)!.title).toBe('Проверка транзита');
    store.open(a);
    expect(store.getSnapshot().activeId).toBe(a);
    store.remove(a);
    expect(store.getSnapshot().activeId).toBeNull();
    expect(store.getSnapshot().conversations.map(c => c.id)).toEqual([b]);
    expect(open(mem).getSnapshot().conversations.map(c => c.id)).toEqual([b]);
    store.undoRemove();
    expect(store.getSnapshot().activeId).toBe(a);
    expect(open(mem).getSnapshot().conversations.map(c => c.id).sort()).toEqual([a, b].sort());
  });

  it('[CHAT-DRAFT] черновик сохраняется и очищается после отправки', () => {
    const mem = new MemoryStorage();
    const store = open(mem);
    const id = store.create(null);
    store.setDraft(id, 'Какие счета');
    store.flush();
    expect(open(mem).getSnapshot().conversations[0]!.draft).toBe('Какие счета');
    store.ask(id, 'Какие счета проверить первыми?', []);
    expect(open(mem).getSnapshot().conversations[0]!.draft).toBe('');
  });

  it('[CHAT-RECOVER] прерванный запрос и испорченный ответ показаны честно', () => {
    const mem = new MemoryStorage();
    const store = open(mem);
    const id = store.create(null);
    store.ask(id, 'Вопрос без ответа', []);
    const t2 = store.ask(id, 'Вопрос с ответом', [])!;
    store.answer(id, t2, serverAnswer());
    const raw = JSON.parse(mem.getItem(CONVERSATIONS_KEY)!);
    raw.conversations[0].turns[1].response.nodes = [9007199254740993];
    mem.setItem(CONVERSATIONS_KEY, JSON.stringify(raw));
    const turns = open(mem).getSnapshot().conversations[0]!.turns;
    expect(turns[0]!.error).toContain('перезагружена во время запроса');
    expect(turns[1]!.response).toBeUndefined();
    expect(turns[1]!.error).toContain('Сохранённый ответ повреждён');
  });

  it.each(['{не json', '{"v":2,"conversations":[]}', '[]'])('[CHAT-RECOVER] нечитаемое значение %s — пустой список и сообщение', raw => {
    const mem = new MemoryStorage();
    mem.setItem(CONVERSATIONS_KEY, raw);
    expect(open(mem).getSnapshot()).toMatchObject({conversations: [], issues: [{kind: 'reset'}]});
    expect(JSON.parse(mem.getItem(CONVERSATIONS_KEY)!)).toMatchObject({v: 1, conversations: []});
  });

  it('[CHAT-RECOVER] разговор с числовым gid или без scope отбрасывается и считается', () => {
    const parsed = parseStoredConversations(JSON.stringify({v: 1, conversations: [
      {id: 'x', scope: SCOPE, startGid: 9007199254740993, title: '', createdAt: 'a', updatedAt: 'a', turns: []},
      {id: 'y', scope: '', startGid: null, title: '', createdAt: 'a', updatedAt: 'a', turns: []},
      {id: 'z', scope: SCOPE, startGid: GID, title: 'ок', createdAt: 'a', updatedAt: 'a', turns: [{id: 't', question: 'q', selection: [12], askedAt: 'a'}]},
    ]}));
    expect(parsed.conversations.map(c => c.id)).toEqual(['z']);
    expect(parsed.conversations[0]!.turns).toEqual([]);
    expect(parsed.issues).toEqual([{kind: 'recovered', dropped: 3}]);
  });

  it('[CHAT-OFFLINE] без хранилища разговор идёт в памяти и сообщает об этом; переполнение отмечено', () => {
    const none = open(null);
    expect(none.getSnapshot()).toMatchObject({persistent: false, issues: [{kind: 'unavailable'}]});
    const id = none.create(null);
    expect(none.ask(id, 'Вопрос', [])).not.toBeNull();
    const full = new MemoryStorage();
    const realSet = full.setItem.bind(full);
    full.setItem = () => { throw new DOMException('Переполнено', 'QuotaExceededError'); };
    const store = open(full);
    store.create(null);
    expect(store.getSnapshot()).toMatchObject({persistent: false, issues: [{kind: 'write_failed'}]});
    full.setItem = realSet;
    store.create(null);
    expect(store.getSnapshot()).toMatchObject({persistent: true, issues: []});
  });

  it('[CHAT-LIMIT] хранится не больше MAX_CONVERSATIONS разговоров, вытесняются старые', () => {
    const mem = new MemoryStorage();
    const store = open(mem);
    const created = Array.from({length: MAX_CONVERSATIONS + 3}, () => store.create(null));
    const kept = open(mem).getSnapshot().conversations.map(c => c.id);
    expect(kept).toHaveLength(MAX_CONVERSATIONS);
    expect(kept).not.toContain(created[0]);
    expect(kept).toContain(created.at(-1));
  });

  it('[CHAT-SETTINGS] запрошенные модель и усилие хранятся при вопросе и переживают перезагрузку', () => {
    const mem = new MemoryStorage();
    const store = open(mem);
    const id = store.create(null);
    store.ask(id, 'Вопрос', [], {model: 'gpt-6-luna', effort: 'none'});
    expect(open(mem).getSnapshot().conversations[0]!.turns[0]).toMatchObject({model: 'gpt-6-luna', effort: 'none'});
  });

  it('[CHAT-SETTINGS] выбор модели и усилия сохраняется только как идентификаторы', () => {
    const mem = new MemoryStorage();
    open(mem).setSettings({model: 'gpt-example', effort: 'low'});
    expect(open(mem).getSnapshot().settings).toEqual({model: 'gpt-example', effort: 'low'});
    expect(Object.keys(JSON.parse(mem.getItem(CONVERSATIONS_KEY)!)).sort()).toEqual(['activeId', 'conversations', 'settings', 'v']);
  });
});
