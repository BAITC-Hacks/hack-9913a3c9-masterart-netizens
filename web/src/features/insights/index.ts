/**
 * Наблюдения (analysis.json['insights'], finance-insights/v1). Подключение: InsightsPanel — вкладка рейла,
 * AccountInsights — в карточке счёта. Оба принимают GraphIndex; gid передаются строками.
 */
import './insights.css';

export {InsightsPanel, type InsightsPanelProps} from './InsightsPanel';
export {AccountInsights, type AccountInsightsProps} from './AccountInsights';
export {
  parseSections, accountLines, honestCheck, generalLimitations, readInsights, isGid, MAX_EXAMPLE_GIDS,
  type InsightSection, type InsightParameter, type AccountLine, type HonestCheck,
} from './model';
