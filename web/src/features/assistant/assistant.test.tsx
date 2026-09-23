import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { askAssistant, exactSelection, isGid, parseAssistantResponse, parserLabel } from './api';
import { AnswerCard, NodeLink } from './AnswerCard';
import { AssistantPanel } from './AssistantPanel';
import { SafeAnswer } from './SafeAnswer';

const FIRST = '9007199254740992';
const NEXT = '9007199254740993';
const fixture = (extra: Record<string, unknown> = {}) => ({
  answer_md: '## Основание\nВходящий поток наблюдается. **Роль — гипотеза.**',
  nodes: [FIRST, NEXT], intent: 'explain_node', args: { gid: NEXT }, parser: 'rules',
  warnings: ['Исходящие на границе не наблюдаются.'],
  citations: [{ label: 'Метрики счёта', gid: NEXT, source: 'analysis.json', fields: ['metrics.in_degree'] }],
  tool_trace: [{ tool: 'explain_node', args: { gid: NEXT }, result: { gid: NEXT, in_degree: 7 } }],
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe('ASSIST — точные идентификаторы и происхождение ответа', () => {
  it('ASSIST-01 сохраняет соседние идентификаторы за пределами точности Number', () => {
    const response = parseAssistantResponse(fixture());
    expect(response.nodes).toEqual([FIRST, NEXT]);
    expect(response.citations[0]?.gids).toEqual([NEXT]);
    const select = vi.fn();
    NodeLink({ gid: NEXT, onSelectNode: select }).props.onClick();
    expect(select).toHaveBeenCalledExactlyOnceWith(NEXT);
    expect(exactSelection([FIRST, NEXT, NEXT])).toEqual([FIRST, NEXT]);
  });
  it.each([9007199254740992, { gid: 9007199254740992 }, '9.007199254740993e15', '9223372036854775808', '-0'])
    ('ASSIST-02 отвергает повреждённый идентификатор %j', (gid) => {
      expect(() => parseAssistantResponse(fixture({ nodes: [gid] }))).toThrow();
    });
  it('ASSIST-03 принимает границы int64 без округления', () => {
    expect(isGid('-9223372036854775808')).toBe(true);
    expect(isGid('9223372036854775807')).toBe(true);
    expect(isGid('-9223372036854775809')).toBe(false);
  });
  it('ASSIST-04 отвергает числовые ссылки и числовой gid внутри журнала', () => {
    expect(() => parseAssistantResponse(fixture({ citations: [{ gid: 12 }] }))).toThrow();
    expect(() => parseAssistantResponse(fixture({ tool_trace: [{ result: { gid: 12 } }] }))).toThrow();
    expect(() => parseAssistantResponse(fixture({ args: { gid: 12 } }))).toThrow();
  });
  it('ASSIST-05 статус OpenAI появляется только при parser=openai', () => {
    expect(parserLabel(parseAssistantResponse(fixture({ parser: 'rules', model: 'gpt-example' })))).toBe('Локальный разбор · без модели');
    expect(parserLabel(parseAssistantResponse(fixture({ parser: 'openai', model: 'gpt-example' })))).toBe('Разбор запроса: OpenAI · gpt-example');
    expect(parserLabel(parseAssistantResponse(fixture({ parser: 'none' })))).toBe('Запрос не распознан');
    expect(() => parseAssistantResponse(fixture({ parser: 'unknown' }))).toThrow();
    expect(() => parseAssistantResponse(fixture({ parser: ['openai'] }))).toThrow();
  });
  it('ASSIST-06 сохраняет локальный ответ без ключа и ограничение сервера', () => {
    const html = renderToStaticMarkup(<AnswerCard response={parseAssistantResponse(fixture({ warnings: ['Модель не настроена. Выполнен локальный разбор.'] }))} onSelectNode={() => {}} />);
    expect(html).toContain('Локальный разбор · без модели');
    expect(html).toContain('Модель не настроена. Выполнен локальный разбор.');
    expect(html).not.toContain('Разбор запроса: OpenAI');
  });
});

describe('ASSIST — запросы и безопасный показ', () => {
  it('ASSIST-07 отправляет только вопрос и строковый снимок выбора в локальный API', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture()), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const signal = new AbortController().signal;
    const response = await askAssistant({ question: '  Объясни роль  ', selection: [FIRST, NEXT] }, signal);
    const options = fetcher.mock.calls[0]?.[1];
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/assistant');
    expect(options?.signal).toBe(signal);
    expect(JSON.parse(options?.body)).toEqual({ question: 'Объясни роль', selection: [FIRST, NEXT] });
    expect(options?.headers.Authorization).toBeUndefined();
    expect(response.nodes[1]).toBe(NEXT);
  });
  it('ASSIST-08 не отправляет пустые и слишком длинные вопросы', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(askAssistant({ question: ' ', selection: [] }, new AbortController().signal)).rejects.toThrow();
    await expect(askAssistant({ question: 'а'.repeat(2001), selection: [] }, new AbortController().signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([404, 405, 401, 403, 429, 500])('ASSIST-09 объясняет HTTP %s без показа тела ошибки сервера', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_SERVER_DETAIL', { status })));
    await expect(askAssistant({ question: 'Вопрос', selection: [] }, new AbortController().signal)).rejects.not.toThrow('PRIVATE_SERVER_DETAIL');
  });
  it('ASSIST-10 объясняет отсутствие сети и неправильный JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(askAssistant({ question: 'Вопрос', selection: [] }, new AbortController().signal)).rejects.toThrow('Нет связи');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>')));
    await expect(askAssistant({ question: 'Вопрос', selection: [] }, new AbortController().signal)).rejects.toThrow('неизвестном формате');
  });
  it('ASSIST-11 передаёт отмену без превращения в сетевую ошибку', async () => {
    const controller = new AbortController(); controller.abort();
    const aborted = new DOMException('Остановлено', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));
    await expect(askAssistant({ question: 'Вопрос', selection: [] }, controller.signal)).rejects.toBe(aborted);
  });
  it('ASSIST-12 показывает HTML и опасные ссылки только текстом', () => {
    const html = renderToStaticMarkup(<SafeAnswer text={'# Ответ\n<img src=x onerror=alert(1)>\n[ссылка](javascript:alert(1))\n![картинка](https://example.test/x)\n\n- **Гипотеза**\n- `9007199254740993`'} />);
    expect(html).not.toMatch(/<(img|script|a)\s/);
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>Гипотеза</strong>');
    expect(html).toContain('<code>9007199254740993</code>');
  });
  it('ASSIST-13 показывает понятные основания и условия без стены JSON', () => {
    const html = renderToStaticMarkup(<AnswerCard response={parseAssistantResponse(fixture())} onSelectNode={() => {}} />);
    expect(html).toContain(`Открыть счёт ${NEXT} на карте`);
    expect(html).toContain('Основания ответа · 1');
    expect(html).toContain('analysis.json');
    expect(html).toContain('Карточка счёта');
    expect(html).toContain('Проверенные операции · 1');
    expect(html).not.toContain('<pre');
    expect(html).not.toContain('explain_node');
    expect(html).not.toContain('in_degree');
    expect(html).toContain('Исходящие на границе не наблюдаются.');
  });
  it('ASSIST-20 сохраняет доказательства в данных, но не показывает сырые результаты', () => {
    const response = parseAssistantResponse(fixture({tool_trace: [{name: 'get_node', result: {note: 'ONLY_API_DETAIL'}}]}));
    const html = renderToStaticMarkup(<AnswerCard response={response} onSelectNode={() => {}} />);
    expect(html).not.toContain('ONLY_API_DETAIL');
    expect(html).not.toContain('<pre');
    expect(JSON.stringify(response.tool_trace)).toContain('ONLY_API_DETAIL');
    expect(html).toContain('Карточка счёта');
  });
  it('ASSIST-14 не теряет скрытые счета и не выполняет запрос при рендере', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const html = renderToStaticMarkup(<AssistantPanel selection={['1', '2', '3', '4', FIRST, NEXT]} onSelectNode={() => {}} />);
    expect(html).toContain('Ещё счетов: 2');
    expect(html).toContain(FIRST); expect(html).toContain(NEXT);
    expect(html).toContain('role="status"'); expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Вопрос к данным');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('ASSIST-15 открывает только точные ссылки из результата прямо в ответе', () => {
    const html = renderToStaticMarkup(<AnswerCard response={parseAssistantResponse(fixture({
      answer_md: `[${NEXT}](?gid=${NEXT}) — priority\\_score; &lt;script&gt; &amp; &quot;факт&quot;`,
    }))} onSelectNode={() => {}} />);
    expect(html).not.toContain(`](?gid=${NEXT})`);
    expect(html).toContain(`Открыть счёт ${NEXT} на карте`);
    expect(html).toContain('priority_score');
    expect(html).not.toContain('priority\\_score');
    expect(html).toContain('&lt;script&gt; &amp; &quot;факт&quot;');
    expect(html).not.toContain('<script>');
  });
  it('ASSIST-16 не превращает посторонний или подменённый gid в действие', () => {
    const html = renderToStaticMarkup(<AnswerCard response={parseAssistantResponse(fixture({
      answer_md: `[${FIRST}](?gid=${NEXT}) [12](?gid=12) [опасно](https://example.test)`,
      nodes: [], citations: [],
    }))} onSelectNode={() => {}} />);
    expect(html).not.toMatch(/<(button|a)\s/);
    expect(html).toContain(`[${FIRST}](?gid=${NEXT})`);
  });
});
