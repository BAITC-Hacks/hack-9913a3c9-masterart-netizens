import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {Outline} from '../src/ui/Outline';
import {compileNeighborhood} from '../src/data/neighborhood';
import {loadFixture} from './helpers';

const {index} = loadFixture();
const render = (hood: NonNullable<ReturnType<typeof compileNeighborhood>>) =>
  renderToStaticMarkup(createElement(Outline, {index, hood, onSelect: () => undefined}));

describe('[WEB-LIST] список связей', () => {
  const withMutual = index.gids.map(gid => compileNeighborhood(index, gid)!).find(hood => hood.mutual.length > 0)!;

  it('[WEB-LIST] встречный поток: пустой раздел получателей не говорит, что исходящих нет', () => {
    const html = render({...withMutual, recipients: [], payers: []});
    expect(html).toContain('Других получателей нет: исходящие переводы показаны во встречных потоках выше.');
    expect(html).toContain('Других плательщиков нет: входящие переводы показаны во встречных потоках ниже.');
    expect(html).not.toContain('Исходящих переводов в выборке нет.');
  });
  it('[WEB-LIST] переводы пары раскрываются строкой во всю ширину, свёрнутой по умолчанию', () => {
    const html = render(withMutual);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<tr class="wb-tx-row" id="[^"]+" hidden=""><td colSpan="5">/);
    expect(html).not.toContain('<details');
  });
});
