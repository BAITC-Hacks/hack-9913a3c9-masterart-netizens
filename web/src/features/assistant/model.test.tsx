import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseAssistantResponse} from './api';
import type {StoredTurn} from './conversationStore';
import {buildHistory, resolveSettings, switchModel} from './modelSettings';
import {EffortSlider, ModelEffortMenu, ModelEffortPanel} from './ModelEffortMenu';
import {turnMeta} from './AssistantWorkspace';
import type {AssistantOptions} from './types';

// Та же форма, что отдаёт живой GET /api/assistant/options (проверено curl 16:49).
export const OPTIONS: AssistantOptions = {
  dataset_fingerprint: 'c'.repeat(64),
  models: [
    {id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium'},
    {id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium'},
    {id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium'},
  ],
  defaults: {model: 'gpt-6-astra', effort: 'medium'},
  history_limits: {turns: 6, question_chars: 1000, gids: 100},
};
const X = '900719925474099312';
const Y = '900719925474099313';
const answer = (nodes: string[], extra: Record<string, unknown> = {}) => parseAssistantResponse({
  answer_md: 'Ответ', nodes, intent: 'explain_node', args: {}, parser: 'rules', warnings: [], citations: [], tool_trace: [], ...extra,
});
const turn = (i: number, extra: Partial<StoredTurn> = {}): StoredTurn => ({id: `t${i}`, question: `Вопрос ${i}`, selection: [X], askedAt: 'a', response: answer([Y]), ...extra});

describe('Модель, усилие и контекст разговора', () => {
  it('[CHAT-MODEL] сохранённый выбор проверяется по списку сервера', () => {
    expect(resolveSettings(OPTIONS, {})).toEqual({model: 'gpt-6-astra', effort: 'medium'});
    expect(resolveSettings(OPTIONS, {model: 'gpt-6-luna', effort: 'none'})).toEqual({model: 'gpt-6-luna', effort: 'none'});
    expect(resolveSettings(OPTIONS, {model: 'gpt-6-astra', effort: 'none'})).toEqual({model: 'gpt-6-astra', effort: 'medium'});
    expect(resolveSettings(OPTIONS, {model: 'удалённая-модель', effort: 'high'})).toEqual({model: 'gpt-6-astra', effort: 'high'});
    expect(switchModel(OPTIONS, {model: 'gpt-6-sol', effort: 'none'}, 'gpt-6-astra')).toEqual({model: 'gpt-6-astra', effort: 'medium'});
    expect(switchModel(OPTIONS, {model: 'gpt-6-sol', effort: 'xhigh'}, 'gpt-6-astra')).toEqual({model: 'gpt-6-astra', effort: 'xhigh'});
    expect(switchModel(OPTIONS, {model: 'gpt-6-sol', effort: 'low'}, 'нет-такой')).toEqual({model: 'gpt-6-sol', effort: 'low'});
  });

  it('[CHAT-HISTORY] контекст: 6 последних завершённых вопросов, вопрос до 1000 знаков, счета до 100', () => {
    const long = 'я'.repeat(1500);
    const many = Array.from({length: 150}, (_, i) => `9${String(i).padStart(17, '0')}`);
    const turns = [
      ...Array.from({length: 7}, (_, i) => turn(i)),
      turn(7, {question: long, selection: many, response: answer(many)}),
      turn(8, {response: undefined, error: 'Запрос остановлен.'}),
    ];
    const history = buildHistory(turns, OPTIONS.history_limits);
    expect(history).toHaveLength(6);
    expect(history[0]!.question).toBe('Вопрос 2');
    expect(history.at(-1)!.question).toHaveLength(1000);
    expect(turns[7]!.question).toHaveLength(1500);
    expect(history.at(-1)!.selection).toHaveLength(100);
    expect(history.at(-1)!.result_gids).toEqual(many.slice(0, 100));
    expect(history[0]).toEqual({question: 'Вопрос 2', selection: [X], result_gids: [Y]});
    expect(JSON.stringify(history)).not.toContain('Ответ');
    expect(buildHistory([], OPTIONS.history_limits)).toEqual([]);
  });

  it('[CHAT-MODEL] ползунок усилия: ступени ровно из списка выбранной модели', () => {
    const astra = renderToStaticMarkup(<EffortSlider efforts={OPTIONS.models[0]!.efforts} effort="medium" onChange={() => {}} />);
    expect(astra).toContain('type="range"');
    expect(astra).toContain('max="4"');
    expect(astra).toContain('value="1"');
    expect(astra).toContain('aria-valuetext="Среднее · сбалансированно"');
    expect(astra.match(/role="radio"/g)).toHaveLength(5);
    expect(astra).not.toContain('>Нет<');
    const sol = renderToStaticMarkup(<EffortSlider efforts={OPTIONS.models[1]!.efforts} effort="none" onChange={() => {}} />);
    expect(sol.match(/role="radio"/g)).toHaveLength(6);
    expect(sol).toContain('>Нет<');
    expect(sol).toContain('value="0"');
    expect(sol).not.toMatch(/ultra|Ultra/);
  });

  it('[CHAT-MODEL] меню: строки моделей как radio, выбранная отмечена; кнопка называет модель и усилие', () => {
    const panel = renderToStaticMarkup(<ModelEffortPanel options={OPTIONS} settings={{model: 'gpt-6-luna', effort: 'low'}} onChange={() => {}} />);
    expect(panel.match(/role="radio" aria-checked="true"/g)).toHaveLength(2);
    expect(panel).toContain('GPT-6 Luna');
    expect(panel).toContain('gpt-6-sol');
    const trigger = renderToStaticMarkup(<ModelEffortMenu options={OPTIONS} settings={{model: 'gpt-6-astra', effort: 'high'}} onChange={() => {}} />);
    expect(trigger).toContain('GPT-6 Astra');
    expect(trigger).toContain('Высокое');
    expect(trigger).toContain('aria-expanded="false"');
  });

  it('[CHAT-MODEL] под ответом — чем он получен на самом деле, и честный запасной путь', () => {
    const viaModel = turnMeta(turn(1, {model: 'gpt-6-luna', effort: 'low', response: answer([Y], {parser: 'openai', model: 'gpt-6-luna', effort: 'low', history_turns_used: 2})}), OPTIONS);
    expect(viaModel).toBe('Модель GPT-6 Luna · усилие «низкое» · учтено вопросов из разговора: 2');
    const fallback = turnMeta(turn(2, {model: 'gpt-6-astra', effort: 'medium'}), OPTIONS);
    expect(fallback).toBe('Запрошена GPT-6 Astra, ответ получен без модели');
    expect(turnMeta(turn(3), OPTIONS)).toBe('');
  });
});
