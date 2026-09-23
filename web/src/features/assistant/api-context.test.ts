import { afterEach, expect, it, vi } from 'vitest';
import { askAssistant, loadAssistantOptions } from './api';

afterEach(() => vi.unstubAllGlobals());

const options = {
  dataset_fingerprint: 'a'.repeat(64),
  models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['low', 'medium'], default_effort: 'medium' }],
  defaults: { model: 'gpt-6-astra', effort: 'medium' },
  history_limits: { turns: 6, question_chars: 1000, gids: 100 },
};

it('ASSIST-17 читает возможности сервера и отвергает несовместимый уровень', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(options))));
  expect(await loadAssistantOptions()).toEqual(options);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...options, defaults: { model: 'gpt-6-astra', effort: 'none' } }))));
  await expect(loadAssistantOptions()).rejects.toThrow('неизвестном формате');
});

it('ASSIST-18 передаёт точный контекст, модель и отпечаток без прозы прежнего ответа', async () => {
  const response = { answer_md: 'Факты', answer_rich_md: '| Счёт |\n| --- |\n| 9007199254740993 |', nodes: ['9007199254740993'], intent: 'node', args: {}, parser: 'openai',
    warnings: [], citations: [], tool_trace: [], model: 'gpt-6-astra', effort: 'low',
    dataset_fingerprint: options.dataset_fingerprint, history_turns_used: 1 };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
  vi.stubGlobal('fetch', fetcher);
  const history = [{ question: 'топ 2', selection: [], result_gids: ['9007199254740993', '9007199254740995'] }];
  const request = { question: 'Почему второй?', selection: ['81'], history,
    model: 'gpt-6-astra', effort: 'low', dataset_fingerprint: options.dataset_fingerprint };
  const actual = await askAssistant(request, new AbortController().signal);
  expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual(request);
  expect(actual.history_turns_used).toBe(1);
  expect(actual.effort).toBe('low');
  expect(actual.answer_rich_md).toBe(response.answer_rich_md);
  expect(actual.dataset_fingerprint).toBe(options.dataset_fingerprint);
});
