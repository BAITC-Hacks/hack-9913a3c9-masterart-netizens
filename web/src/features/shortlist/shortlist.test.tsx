import {describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {incrementDecimal, loadFixture} from '../../../tests/helpers';
import {roleLabel} from '../../data/format';
import {createShortlistStore, shortlistKey, SHORTLIST_KEY_PREFIX, type ShortlistStorage, type ShortlistStore} from './store';
import {fetchReport, filenameFromDisposition, reportBody, REPORT_MAX_ACCOUNTS, ReportError, type ReportFetcher} from './report';
import {SaveAccountButton} from './SaveAccountButton';
import {ShortlistPanel, issueText} from './ShortlistPanel';
import {ShortlistProvider, type ShortlistController} from './useShortlist';
import {createReportSession} from './reportSession';
import {AccountReportButton, ReportDialog} from './ReportDialog';

/** Хранилище в памяти с подсчётом записей: как localStorage, но видно, что и сколько раз записано. */
class MemoryStorage implements ShortlistStorage {
  readonly map = new Map<string, string>();
  writes = 0;
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes++; this.map.set(key, String(value)); }
}

const {index} = loadFixture();
const SCOPE = index.analysis.summary.input_sha256;
const [A, B, C] = index.gids as [string, string, string];
const KEY = shortlistKey(SCOPE);
const known = (gid: string) => index.byGid.has(gid);
const open = (storage: ShortlistStorage | null, scope = SCOPE, isKnown = known) => createShortlistStore({scope, isKnown, storage});

/** Тот же объект, что собирает useShortlist: снимок и действия. */
const controllerOf = (store: ShortlistStore): ShortlistController => ({
  ...store.getSnapshot(), has: store.has, save: store.save, remove: store.remove, toggle: store.toggle,
  undoRemove: store.undoRemove, setSelected: store.setSelected, selectAll: store.selectAll, selectNone: store.selectNone,
  dismissIssues: store.dismissIssues, selectedGids: store.selectedGids,
});

// Два соседних 18-значных gid, которые как числа JavaScript совпадают.
const X = '900719925474099312';
const Y = incrementDecimal(X);

describe('Сохранённые счета — хранилище', () => {
  it('[SHORTLIST-SAVE] сохраняет точный gid, повтор ничего не меняет и не пишет', () => {
    expect(A).toMatch(/^\d{18}$/);
    const mem = new MemoryStorage();
    const store = open(mem);
    expect(store.save(A)).toBe('saved');
    const writes = mem.writes;
    expect(store.save(A)).toBe('already');
    expect(mem.writes).toBe(writes);
    expect(store.getSnapshot().gids).toEqual([A]);
    expect(store.has(A)).toBe(true);
    expect(mem.getItem(KEY)).toBe(`{"v":1,"gids":["${A}"]}`);
    expect(store.save(B)).toBe('saved');
    expect(store.getSnapshot().gids).toEqual([B, A]);
  });

  it('[SHORTLIST-REMOVE] убирает счёт и возвращает его на прежнее место', () => {
    const mem = new MemoryStorage();
    const store = open(mem);
    store.save(A); store.save(B); store.save(C);
    expect(store.remove(B)).toBe(true);
    expect(store.getSnapshot().gids).toEqual([C, A]);
    expect(store.getSnapshot().selected.has(B)).toBe(false);
    expect(store.getSnapshot().lastRemoved).toEqual({gid: B, position: 1});
    expect(open(mem).getSnapshot().gids).toEqual([C, A]);
    expect(store.remove(B)).toBe(false);
    expect(store.undoRemove()).toBe(true);
    expect(store.getSnapshot().gids).toEqual([C, B, A]);
    expect(store.getSnapshot().selected.has(B)).toBe(true);
    expect(store.getSnapshot().lastRemoved).toBeNull();
    expect(store.undoRemove()).toBe(false);
    expect(open(mem).getSnapshot().gids).toEqual([C, B, A]);
    expect(store.toggle(C)).toBe('removed');
    expect(store.toggle(C)).toBe('saved');
  });

  it('[SHORTLIST-RELOAD] список переживает перезагрузку и изменения из другой вкладки', () => {
    const mem = new MemoryStorage();
    open(mem).save(A);
    const reloaded = open(mem);
    expect(reloaded.getSnapshot()).toMatchObject({gids: [A], persistent: true, issues: []});
    expect(reloaded.selectedGids()).toEqual([A]);
    const listener = vi.fn();
    reloaded.subscribe(listener);
    open(mem).save(B);
    reloaded.reload();
    expect(listener).toHaveBeenCalled();
    expect(reloaded.getSnapshot().gids).toEqual([B, A]);
    expect(reloaded.selectedGids()).toEqual([B, A]);
  });

  it('[SHORTLIST-DATASET] у другого набора данных свой список, прежний не тронут', () => {
    const mem = new MemoryStorage();
    mem.setItem('чужой-ключ', 'значение');
    open(mem).save(A);
    const before = mem.getItem(KEY);
    const other = open(mem, 'f'.repeat(64), gid => gid === B);
    expect(other.getSnapshot().gids).toEqual([]);
    other.save(B);
    expect(mem.getItem(KEY)).toBe(before);
    expect(mem.getItem('чужой-ключ')).toBe('значение');
    expect(open(mem).getSnapshot().gids).toEqual([A]);
    expect(open(mem, 'f'.repeat(64), gid => gid === B).getSnapshot().gids).toEqual([B]);
  });

  it.each(['{не json', '{"v":2,"gids":[]}', '[]', '"строка"', 'null'])('[SHORTLIST-CORRUPT] нечитаемое значение %s — новый список и честное сообщение', raw => {
    const mem = new MemoryStorage();
    mem.setItem(KEY, raw);
    const store = open(mem);
    expect(store.getSnapshot()).toMatchObject({gids: [], issues: [{kind: 'reset'}], persistent: true});
    expect(mem.getItem(KEY)).toBe('{"v":1,"gids":[]}');
    expect(issueText({kind: 'reset'})).toContain('начат новый');
  });

  it('[SHORTLIST-CORRUPT] неточные записи отбрасываются, число не превращается в строку', () => {
    const mem = new MemoryStorage();
    // 18-значное число в JSON уже округлено при разборе: его нельзя «восстановить» в строку.
    mem.setItem(KEY, `{"v":1,"gids":["${A}",${X},"12e3","-1"," ${B}","${A}","${C}"]}`);
    const store = open(mem);
    expect(store.getSnapshot().gids).toEqual([A, C]);
    expect(store.getSnapshot().issues).toEqual([{kind: 'recovered', dropped: 4}]);
    expect(mem.getItem(KEY)).toBe(`{"v":1,"gids":["${A}","${C}"]}`);
    expect(issueText({kind: 'recovered', dropped: 4})).toBe('Сохранённый список был повреждён: 4 счёта без точного gid пропущены, остальные на месте.');
    store.dismissIssues();
    expect(store.getSnapshot().issues).toEqual([]);
    expect(open(mem).getSnapshot().issues).toEqual([]);
  });

  it('[SHORTLIST-UNKNOWN] счёт не из текущего анализа не сохраняется и скрывается из старого списка', () => {
    const ghost = incrementDecimal(index.gids.at(-1)!);
    expect(known(ghost)).toBe(false);
    const mem = new MemoryStorage();
    const store = open(mem);
    expect(store.save(ghost)).toBe('unknown');
    expect(store.save('12345678901234567x')).toBe('unknown');
    expect(mem.getItem(KEY)).toBeNull();
    mem.setItem(KEY, `{"v":1,"gids":["${ghost}","${A}"]}`);
    const reloaded = open(mem);
    expect(reloaded.getSnapshot().gids).toEqual([A]);
    expect(reloaded.getSnapshot().issues).toEqual([{kind: 'unknown', hidden: 1}]);
    expect(mem.getItem(KEY)).toBe(`{"v":1,"gids":["${A}"]}`);
    expect(issueText({kind: 'unknown', hidden: 1})).toBe('1 счёт из сохранённых нет в текущем анализе — он скрыт.');
  });

  it('[SHORTLIST-EXACT18] соседние 18-значные gid различаются, хотя как числа совпадают', () => {
    expect(Y).toBe('900719925474099313');
    expect(Number(X)).toBe(Number(Y));
    const mem = new MemoryStorage();
    const store = open(mem, SCOPE, gid => gid === X || gid === Y);
    store.save(Y);
    expect(store.has(X)).toBe(false);
    store.save(X);
    expect(store.getSnapshot().gids).toEqual([X, Y]);
    expect(mem.getItem(KEY)).toBe(`{"v":1,"gids":["${X}","${Y}"]}`);
    expect(open(mem, SCOPE, gid => gid === X || gid === Y).getSnapshot().gids).toEqual([X, Y]);
    expect(reportBody({gids: store.selectedGids(), mode: 'strict'})).toBe(`{"gids":["${X}","${Y}"],"mode":"strict"}`);
  });

  it('[SHORTLIST-OFFLINE] без доступа к хранилищу список работает в памяти и говорит об этом', () => {
    const none = open(null);
    expect(none.getSnapshot()).toMatchObject({persistent: false, issues: [{kind: 'unavailable'}]});
    expect(none.save(A)).toBe('saved');
    expect(none.getSnapshot().gids).toEqual([A]);
    const denied = open({getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); }});
    expect(denied.getSnapshot().issues).toEqual([{kind: 'unavailable'}]);

    const full = new MemoryStorage();
    const realSet = full.setItem.bind(full);
    full.setItem = () => { throw new DOMException('Переполнено', 'QuotaExceededError'); };
    const store = open(full);
    expect(store.save(A)).toBe('saved');
    expect(store.getSnapshot()).toMatchObject({gids: [A], persistent: false, issues: [{kind: 'write_failed'}]});
    full.setItem = realSet;
    store.save(B);
    expect(store.getSnapshot()).toMatchObject({gids: [B, A], persistent: true, issues: []});
    expect(full.getItem(KEY)).toBe(`{"v":1,"gids":["${B}","${A}"]}`);
  });

  it('[SHORTLIST-SELECT] выбор для отчёта: все по умолчанию, часть, ничего; новый счёт выбран сразу', () => {
    const store = open(new MemoryStorage());
    store.save(A); store.save(B);
    expect(store.selectedGids()).toEqual([B, A]);
    store.setSelected(B, false);
    expect(store.selectedGids()).toEqual([A]);
    store.save(C);
    expect(store.selectedGids()).toEqual([C, A]);
    store.selectNone();
    expect(store.selectedGids()).toEqual([]);
    store.setSelected(incrementDecimal(index.gids.at(-1)!), true);
    expect(store.selectedGids()).toEqual([]);
    store.selectAll();
    expect(store.selectedGids()).toEqual([C, B, A]);
  });

  it('[SHORTLIST-PRIVACY] в хранилище только список gid под ключом набора данных', () => {
    const mem = new MemoryStorage();
    const store = open(mem);
    for (const gid of index.gids.slice(0, 10)) store.save(gid);
    expect([...mem.map.keys()]).toEqual([KEY]);
    expect(KEY).toBe(`${SHORTLIST_KEY_PREFIX}${SCOPE}`);
    const value = JSON.parse(mem.getItem(KEY)!) as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(['gids', 'v']);
    expect(mem.getItem(KEY)!.length).toBeLessThan(10 * 21 + 20);
  });
});

const pdf = (headers: Record<string, string> = {}) => new Response('%PDF-1.7\n%âã\n1 0 obj', {status: 200, headers: {'content-type': 'application/pdf', ...headers}});

describe('Сохранённые счета — PDF-отчёт', () => {
  it('[SHORTLIST-REPORT] отправляет точные gid и режим, принимает только настоящий PDF', async () => {
    const fetcher = vi.fn<ReportFetcher>(async () => pdf({'content-disposition': 'attachment; filename="spravka-2-schetov.pdf"'}));
    const file = await fetchReport({gids: [X, Y], mode: 'same_day'}, {fetcher});
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/report');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(`{"gids":["${X}","${Y}"],"mode":"same_day"}`);
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(file).toMatchObject({filename: 'spravka-2-schetov.pdf', count: 2});
    expect(await file.blob.text()).toMatch(/^%PDF-/);
    const single = await fetchReport({gids: [A], mode: 'structural'}, {fetcher: async () => pdf()});
    expect(single.filename).toBe(`spravka-${A}.pdf`);
  });

  const refusal = (status: number, body: string, type: string) => async () => new Response(body, {status, headers: {'content-type': type}});
  it.each([
    ['страница HTML с ответом 200', refusal(200, '<!doctype html><title>Ошибка</title>', 'text/html; charset=utf-8'), 'not_pdf', 'text/html'],
    ['JSON с ответом 200', refusal(200, '{"ok":true}', 'application/json'), 'not_pdf', 'application/json'],
    ['HTML под видом PDF', refusal(200, '<html>не PDF</html>', 'application/pdf'), 'not_pdf', 'не является файлом PDF'],
    ['ошибка проверки 400', refusal(400, '{"error":"Неизвестный режим дат"}', 'application/json'), 'rejected', 'Неизвестный режим дат'],
    ['неизвестный счёт 404', refusal(404, '{"error":"Счёт не найден в анализе"}', 'application/json'), 'rejected', 'Счёт не найден в анализе'],
    ['нет адреса 404', refusal(404, '<html><body>Not Found</body></html>', 'text/html'), 'unavailable', 'не подключён (ответ 404).'],
    ['не реализовано 501', refusal(501, '', 'text/plain'), 'unavailable', 'не подключён (ответ 501)'],
    ['временно недоступен 503', refusal(503, '{"error":"Модуль отчётов не установлен"}', 'application/json'), 'unavailable', 'Модуль отчётов не установлен'],
    ['слишком много 413', refusal(413, '{"error":"Не больше 25 счетов"}', 'application/json'), 'rejected', 'Не больше 25 счетов'],
  ])('[SHORTLIST-REPORT-REJECT] %s — файл не сохраняется', async (_name, fetcher, kind, text) => {
    const failure = await fetchReport({gids: [A], mode: 'structural'}, {fetcher}).catch(error => error);
    expect(failure).toBeInstanceOf(ReportError);
    expect(failure.kind).toBe(kind);
    expect(failure.message).toContain(text);
    expect(failure.message).not.toMatch(/<[a-z!]/i);
  });

  it('[SHORTLIST-REPORT-REJECT] сеть, пустой выбор, предел, неточный gid и тайм-аут', async () => {
    const network = await fetchReport({gids: [A], mode: 'structural'}, {fetcher: async () => { throw new TypeError('Failed to fetch'); }}).catch(error => error);
    expect(network.kind).toBe('network');
    const fetcher = vi.fn<ReportFetcher>(async () => pdf());
    await expect(fetchReport({gids: [], mode: 'structural'}, {fetcher})).rejects.toMatchObject({kind: 'empty'});
    const many = index.gids.slice(0, REPORT_MAX_ACCOUNTS + 1);
    await expect(fetchReport({gids: many, mode: 'structural'}, {fetcher})).rejects.toMatchObject({kind: 'invalid'});
    await expect(fetchReport({gids: ['9.007199254740993e15'], mode: 'structural'}, {fetcher})).rejects.toMatchObject({kind: 'invalid'});
    expect(fetcher).not.toHaveBeenCalled();
    const hang: ReportFetcher = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Прервано', 'AbortError')));
    });
    await expect(fetchReport({gids: [A], mode: 'structural'}, {fetcher: hang, timeoutMs: 10})).rejects.toMatchObject({kind: 'timeout'});
  });

  it('[SHORTLIST-REPORT] имя файла из заголовка — только безопасное .pdf', () => {
    expect(filenameFromDisposition('attachment; filename="spravka-3-schetov.pdf"')).toBe('spravka-3-schetov.pdf');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''spravka-1.pdf")).toBe('spravka-1.pdf');
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd.pdf"')).toBeNull();
    expect(filenameFromDisposition('attachment; filename="report.html"')).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
  });
});

describe('Сохранённые счета — интерфейс', () => {
  it('[SHORTLIST-UI] кнопка показывает состояние; через ShortlistProvider видит сохранённое', () => {
    const store = open(new MemoryStorage());
    const unsaved = renderToStaticMarkup(<SaveAccountButton gid={A} controller={controllerOf(store)} />);
    expect(unsaved).toContain('Сохранить');
    expect(unsaved).not.toContain('data-saved');
    store.save(A);
    const saved = renderToStaticMarkup(<SaveAccountButton gid={A} controller={controllerOf(store)} />);
    expect(saved).toContain('Сохранён');
    expect(saved).toContain('data-saved="true"');
    const compact = renderToStaticMarkup(<SaveAccountButton gid={B} controller={controllerOf(store)} compact />);
    expect(compact).toContain('aria-label="Сохранить счёт в список"');

    const mem = new MemoryStorage();
    mem.setItem(KEY, `{"v":1,"gids":["${B}"]}`);
    const viaProvider = renderToStaticMarkup(<ShortlistProvider index={index} storage={mem}>
      <SaveAccountButton gid={B} /><SaveAccountButton gid={A} />
    </ShortlistProvider>);
    expect(viaProvider.match(/data-saved="true"/g)).toHaveLength(1);
    expect(() => renderToStaticMarkup(<SaveAccountButton gid={A} />)).toThrow(/ShortlistProvider/);
  });

  it('[SHORTLIST-UI] отдельный вид: пустое состояние, список, открытый счёт, выбор и отчёт', () => {
    const store = open(new MemoryStorage());
    const report = createReportSession({fetcher: async () => pdf()});
    const render = (current: string | null = null) => renderToStaticMarkup(
      <ShortlistPanel index={index} mode="strict" current={current} onOpen={() => {}} controller={controllerOf(store)} report={report} />);

    const empty = render();
    expect(empty).toContain('Сохранённых счетов пока нет');
    expect(empty).not.toContain('Показать отчёт');

    store.save(A); store.save(B);
    const list = render(A);
    expect(list).toContain(`Включить счёт ${A} в отчёт`);
    expect(list).toContain(`Включить счёт ${B} в отчёт`);
    expect(list).toContain(roleLabel(index.byGid.get(A)!.role));
    expect(list.match(/aria-current="true"/g)).toHaveLength(1);
    expect(list).toContain('Показать отчёт PDF · 2');
    expect(list).toContain('Режим дат в отчёте: позже по датам.');
    expect(list.match(/checked=""/g)).toHaveLength(2);

    store.setSelected(B, false);
    expect(render()).toContain('В отчёт: 1 из 2');
    store.selectNone();
    const none = render();
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>.*Показать отчёт PDF · 0/);
    expect(none).toContain('Отметьте счета галочками');

    store.remove(A);
    expect(render()).toContain('Вернуть');
  });

  it('[SHORTLIST-UI] сообщения о повреждении и предел отчёта видны в панели', () => {
    const mem = new MemoryStorage();
    mem.setItem(KEY, `{"v":1,"gids":[${X},"${A}"]}`);
    const damaged = open(mem);
    const report = createReportSession();
    const html = renderToStaticMarkup(<ShortlistPanel index={index} mode="structural" onOpen={() => {}} controller={controllerOf(damaged)} report={report} />);
    expect(html).toContain('1 счёт без точного gid пропущен');
    expect(html).toContain('Скрыть сообщение');

    const big = open(new MemoryStorage());
    for (const gid of index.gids.slice(0, REPORT_MAX_ACCOUNTS + 1)) big.save(gid);
    const over = renderToStaticMarkup(<ShortlistPanel index={index} mode="structural" onOpen={() => {}} controller={controllerOf(big)} report={report} />);
    expect(over).toContain(`не больше ${REPORT_MAX_ACCOUNTS}`);
    expect(over).toMatch(/<button[^>]*disabled=""[^>]*>.*Показать отчёт PDF · 26/);
  });
});

describe('Сохранённые счета — просмотр PDF', () => {
  it('[SHORTLIST-PREVIEW] ссылка на файл создаётся для настоящего PDF и освобождается при новом запросе и закрытии', async () => {
    const revoked: string[] = [];
    let n = 0;
    const session = createReportSession({fetcher: async () => pdf(), createUrl: () => `blob:test-${++n}`, revokeUrl: url => { revoked.push(url); }});
    const phases: string[] = [];
    session.subscribe(() => phases.push(session.getState().phase));
    await session.request([A], 'strict');
    expect(session.getState()).toMatchObject({phase: 'ready', url: 'blob:test-1', gids: [A], mode: 'strict'});
    expect(phases).toEqual(['loading', 'ready']);
    await session.request([A, B], 'strict');
    expect(revoked).toEqual(['blob:test-1']);
    expect(session.getState()).toMatchObject({phase: 'ready', url: 'blob:test-2'});
    session.close();
    expect(revoked).toEqual(['blob:test-1', 'blob:test-2']);
    expect(session.getState()).toEqual({phase: 'idle'});
    session.close();
    expect(revoked).toHaveLength(2);
  });

  it('[SHORTLIST-PREVIEW] ошибка не создаёт ссылку, «Повторить» запрашивает снова, закрытие во время загрузки отбрасывает ответ', async () => {
    let calls = 0;
    const createUrl = vi.fn(() => 'blob:x');
    const session = createReportSession({
      fetcher: async () => (++calls === 1 ? new Response('<html></html>', {status: 200, headers: {'content-type': 'text/html'}}) : pdf()),
      createUrl, revokeUrl: () => {},
    });
    await session.request([A], 'structural');
    const failed = session.getState();
    expect(failed.phase).toBe('error');
    expect(failed.phase === 'error' && failed.message).toContain('вместо PDF');
    expect(createUrl).not.toHaveBeenCalled();
    await session.retry();
    expect(session.getState()).toMatchObject({phase: 'ready', url: 'blob:x'});

    let release!: (response: Response) => void;
    const slow = createReportSession({fetcher: () => new Promise<Response>(resolve => { release = resolve; }), createUrl, revokeUrl: () => {}});
    const pending = slow.request([A], 'structural');
    expect(slow.getState().phase).toBe('loading');
    slow.close();
    release(pdf());
    await pending;
    expect(slow.getState()).toEqual({phase: 'idle'});
    expect(createUrl).toHaveBeenCalledTimes(1);
  });

  it('[SHORTLIST-PREVIEW] окно просмотра: встроенный PDF, «Открыть» и «Скачать», загрузка и ошибка видны', async () => {
    const session = createReportSession({fetcher: async () => pdf(), createUrl: () => 'blob:test-view', revokeUrl: () => {}});
    await session.request([A, B], 'strict');
    const ready = renderToStaticMarkup(<ReportDialog session={session} />);
    expect(ready).toContain('Отчёт PDF по 2 счетам');
    expect(ready).toContain('data="blob:test-view"');
    expect(ready).toContain('type="application/pdf"');
    expect(ready).toContain('download="spravka-2-schetov.pdf"');
    expect(ready).toContain('Открыть в новой вкладке');
    expect(ready).toContain('не показывает PDF внутри страницы');

    const waiting = createReportSession({fetcher: () => new Promise<Response>(() => {}), createUrl: () => 'blob:never', revokeUrl: () => {}});
    void waiting.request([A], 'strict');
    const loading = renderToStaticMarkup(<ReportDialog session={waiting} />);
    expect(loading).toContain('Справка PDF по счёту');
    expect(loading).toContain('Готовим PDF по 1 счёту');
    expect(loading).not.toContain('blob:');
    const button = renderToStaticMarkup(<AccountReportButton gid={A} mode="strict" report={waiting} />);
    expect(button).toContain('Готовим PDF…');
    expect(button).toContain('disabled=""');
    expect(renderToStaticMarkup(<AccountReportButton gid={B} mode="strict" report={waiting} />)).toContain('Справка PDF');

    const broken = createReportSession({fetcher: async () => new Response('{"error":"Модуль отчётов не установлен"}', {status: 503, headers: {'content-type': 'application/json'}})});
    await broken.request([A], 'strict');
    const error = renderToStaticMarkup(<ReportDialog session={broken} />);
    expect(error).toContain('Модуль отчётов не установлен');
    expect(error).toContain('Повторить');
  });
});
