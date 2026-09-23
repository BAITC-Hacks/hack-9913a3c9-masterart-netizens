import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseAssistantResponse} from './api';
import {AssistantLauncher, AssistantWorkspace} from './AssistantWorkspace';
import {CONVERSATIONS_KEY, createConversationStore, type ConversationStorage} from './conversationStore';

class MemoryStorage implements ConversationStorage {
  readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
}

const SCOPE = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);
const GID = '900719925474099312';
const answer = parseAssistantResponse({
  answer_md: '## Роль\nГипотеза: **распределитель**.', nodes: [GID], intent: 'explain_node', args: {gid: GID}, parser: 'rules',
  warnings: [], citations: [{label: 'Метрики счёта', gid: GID}], tool_trace: [],
});
const render = (storage: ConversationStorage | null, selection: string[] = []) => renderToStaticMarkup(
  <AssistantWorkspace scope={SCOPE} selection={selection} onSelectNode={() => {}} open={false} onClose={() => {}} storage={storage} />);

describe('Рабочая область разговоров — интерфейс', () => {
  it('[CHAT-UI] пустая область: подсказки, поле вопроса внизу, честная подпись о модели и контексте', () => {
    const html = render(new MemoryStorage(), [GID]);
    expect(html).toContain('<dialog');
    expect(html).toContain('Спросите о графе переводов');
    expect(html).toContain('Объяснить роль');
    expect(html).toContain('Цепочки по датам');
    expect(html).toContain('Вопрос о счёте');
    expect(html).toContain('Модель выбирает сервер');
    expect(html).toContain('прежние ответы в запрос не передаются');
    expect(html).toContain('aria-label="Отправить вопрос"');
    expect(html).toContain('Здесь появятся разговоры по этому набору данных');
  });

  it('[CHAT-UI] сохранённый разговор открывается с вопросом, ответом и основаниями; чужой набор помечен', () => {
    const mem = new MemoryStorage();
    const foreign = createConversationStore({scope: OTHER, storage: mem});
    const f = foreign.create(null);
    foreign.ask(f, 'Вопрос по старому файлу', []);
    const store = createConversationStore({scope: SCOPE, storage: mem});
    const id = store.create(GID);
    const turn = store.ask(id, 'Объясни роль счёта', [GID])!;
    store.answer(id, turn, answer);
    const html = render(mem);
    expect(html).toContain('Объясни роль счёта');
    expect(html).toContain('распределитель');
    expect(html).toContain('Локальный разбор · без модели');
    expect(html).toContain('Основания ответа · 1');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain(`Начат со счёта <span class="fa-gid" dir="ltr">${GID}</span>`);
    expect(html).toContain('Другие наборы данных · 1');
    expect(html).toContain('Продолжить их можно, только открыв тот файл');
    expect(html).toContain(`sha256 ${OTHER.slice(0, 12)}`);
    expect(html).toContain('Переименовать');
    expect(html).toContain('Удалить');
  });

  it('[CHAT-UI] повреждённое хранилище и недоступный браузер показаны сообщением', () => {
    const mem = new MemoryStorage();
    mem.setItem(CONVERSATIONS_KEY, '{не json');
    expect(render(mem)).toContain('Сохранённые разговоры не удалось прочитать');
    expect(render(null)).toContain('Разговоры действуют до перезагрузки страницы');
  });

  it('[CHAT-UI] значок в шапке открывает диалог и доступен по имени', () => {
    const html = renderToStaticMarkup(<AssistantLauncher scope={SCOPE} selection={[]} onSelectNode={() => {}} storage={new MemoryStorage()} />);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="Разговоры с помощником"');
    expect(html).toContain('aria-expanded="false"');
  });
});
