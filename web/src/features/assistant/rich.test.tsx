import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseAssistantResponse} from './api';
import {AnswerCard} from './AnswerCard';
import {parseFlow, SafeAnswer} from './SafeAnswer';

const A = '100000005382566100';
const B = '100000003684369100';
const C = '999000001834368100';
// Та же форма, что строит assistant/presentation.py: table() и diagram().
const table = `| Счёт | Роль | Приоритет |\n| --- | --- | --- |\n| [${A}](?gid=${A}) | Координатор | 0,89 |\n| [${C}](?gid=${C}) | Транзит | 0,81 |`;
const flow = ['```mermaid', 'flowchart TD', `  n0["${A}"]`, `  n1["${B}"]`, `  n2["${C}"]`,
  '  n0 -->|"2026-07-02 · 50 000 ₸"| n1', '  n1 -->|"2026-07-03 · 49 500 ₸"| n2', '```'].join('\n');

describe('Таблицы и схема пути в ответе', () => {
  it('[CHAT-RICH] таблица GFM: заголовки, строки, кнопка счёта только для счетов из ответа', () => {
    const html = renderToStaticMarkup(<SafeAnswer text={`Итог:\n\n${table}`} gids={[A]} onSelectNode={() => {}} />);
    expect(html).toContain('<table class="fa-table">');
    expect(html.match(/<th scope="col">/g)).toHaveLength(3);
    expect(html.match(/<tr>/g)).toHaveLength(3);
    expect(html).toContain(`aria-label="Открыть счёт ${A} на карте"`);
    expect(html).not.toContain(`aria-label="Открыть счёт ${C} на карте"`);
    expect(html).not.toContain('href=');
  });

  it('[CHAT-RICH] схема пути из грамматики сервера: счета по порядку, подписи ровно как в источнике', () => {
    const html = renderToStaticMarkup(<SafeAnswer text={flow} gids={[A, B, C]} onSelectNode={() => {}} />);
    expect(html).toContain('aria-label="Схема пути"');
    expect(html).toContain('2026-07-02 · 50 000 ₸');
    expect(html).toContain('2026-07-03 · 49 500 ₸');
    expect(html.indexOf(A)).toBeLessThan(html.indexOf(B));
    expect(html.indexOf(B)).toBeLessThan(html.indexOf(C));
    expect(html).not.toContain('flowchart');
    expect(parseFlow(['flowchart TD', `n0["${A}"]`, `n1["${B}"]`, 'n0 -->|"x"| n1'])).toEqual([{src: A, dst: B, label: 'x'}]);
  });

  it.each([
    ['директива Mermaid', `%%{init: {"securityLevel": "loose"}}%%`],
    ['click со ссылкой', 'click n0 "https://example.com"'],
    ['HTML в подписи', 'n0 -->|"<img src=x onerror=alert(1)>"| n1'],
    ['узел не из цифр', 'n2["javascript:alert(1)"]'],
    ['ребро к необъявленному узлу', 'n0 -->|"x"| n9'],
  ])('[CHAT-RICH] схема отклоняется: %s', (_name, bad) => {
    const source = ['```mermaid', 'flowchart TD', `  n0["${A}"]`, `  n1["${B}"]`, bad, '```'].join('\n');
    const html = renderToStaticMarkup(<SafeAnswer text={source} gids={[A, B]} onSelectNode={() => {}} />);
    expect(html).toContain('Схема не показана');
    expect(html).not.toContain('fa-flow');
    expect(html).not.toMatch(/<img|href=|onerror/);
  });

  it('[CHAT-RICH] ссылка на счёт внутри полужирного становится кнопкой, а не текстом разметки', () => {
    const html = renderToStaticMarkup(<SafeAnswer text={`**Один проверенный путь к [${A}](?gid=${A}).**`} gids={[A]} onSelectNode={() => {}} />);
    expect(html).toContain(`aria-label="Открыть счёт ${A} на карте"`);
    expect(html).not.toContain('](?gid=');
    expect(html).toMatch(/<strong>Один проверенный путь к <button/);
  });

  it('[CHAT-RICH] строка с «|» без линейки — обычный текст, разбор не зацикливается', () => {
    const html = renderToStaticMarkup(<SafeAnswer text={'| не таблица |\nпросто текст'} gids={[]} />);
    expect(html).toContain('| не таблица |');
    expect(html).not.toContain('<table');
  });

  it('[CHAT-RICH] карточка ответа берёт answer_rich_md, а без него — answer_md', () => {
    const base = {answer_md: 'Обычный ответ', nodes: [A], intent: 'rank', args: {}, parser: 'rules', warnings: [], citations: [], tool_trace: []};
    const rich = renderToStaticMarkup(<AnswerCard response={parseAssistantResponse({...base, answer_rich_md: table})} onSelectNode={() => {}} />);
    expect(rich).toContain('<table class="fa-table">');
    expect(rich).not.toContain('Обычный ответ');
    const plain = renderToStaticMarkup(<AnswerCard response={parseAssistantResponse(base)} onSelectNode={() => {}} />);
    expect(plain).toContain('Обычный ответ');
  });
});
