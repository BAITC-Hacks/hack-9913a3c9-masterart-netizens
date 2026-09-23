import type {GraphIndex} from '../../data/graph';
import {accountLines} from './model';

export interface AccountInsightsProps { index: GraphIndex; gid: string }

/** Строки наблюдений по одному счёту (insights.by_gid). Нет строк — ничего не выводится. */
export function AccountInsights({index, gid}: AccountInsightsProps) {
  const lines = accountLines(index, gid);
  if (lines.length === 0) return null;
  return (
    <section className="wb-insights-account" aria-label="Наблюдения по счёту">
      <h4 className="wb-insights-account__title">Наблюдения</h4>
      <ul className="wb-insights-account__list">
        {lines.map((l, i) => <li key={`${l.section}-${i}`} data-section={l.section}>{l.text}</li>)}
      </ul>
      <p className="wb-insights__small">Это структурные наблюдения по выгрузке, а не вывод о происхождении денег.</p>
    </section>
  );
}
