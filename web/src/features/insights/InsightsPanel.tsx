import type {GraphIndex} from '../../data/graph';
import {formatInt} from '../../data/format';
import {generalLimitations, honestCheck, parseSections, readInsights, type InsightSection} from './model';

export interface InsightsPanelProps {
  index: GraphIndex;
  /** Открыть счёт. gid всегда строка из цифр — ровно как в analysis.json. */
  onSelect: (gid: string) => void;
}

/** «Честная проверка»: наивное правило против ролей и границы выборки; числа считаются по файлу. */
function HonestCheckBlock({index}: {index: GraphIndex}) {
  const c = honestCheck(index);
  return (
    <section className="wb-insights__check" aria-label="Честная проверка">
      <h3 className="wb-insights__check-title">Честная проверка</h3>
      <dl className="wb-insights__check-rows">
        <div><dt>Правило «нет исходящих — конечный получатель»</dt><dd>{formatInt(c.naive)}</dd></div>
        <div><dt>из них на границе выборки, где исходящие не выгружены</dt><dd>{formatInt(c.naiveAtBoundary)}</dd></div>
        <div><dt>Роль «конечный получатель» по правилам анализа</dt><dd>{formatInt(c.terminal)}</dd></div>
        <div><dt>Всего счетов на границе выборки</dt><dd>{formatInt(c.boundary)}</dd></div>
        {c.reach5 && (
          <div className="wb-insights__check-reach">
            <dt>Счета, связанные с ≥5 известными клиентами: без учёта дат → по возрастающим датам → в тот же день</dt>
            <dd>{formatInt(c.reach5.static)} → {formatInt(c.reach5.strict)} → {formatInt(c.reach5.same_day)}</dd>
          </div>
        )}
      </dl>
      <p className="wb-insights__small">
        Отсутствие исходящих в выгрузке не значит, что деньги остались на счёте: у счетов на границе выборки
        исходящие переводы просто не наблюдаются. Учёт дат показывает, сколько связей возможны во времени.
      </p>
    </section>
  );
}

function InsightCard({section, onSelect}: {section: InsightSection; onSelect: (gid: string) => void}) {
  return (
    <article className="wb-insights__card" data-section={section.key}>
      <h3 className="wb-insights__title">{section.title}</h3>
      {section.headline && (
        <p className="wb-insights__headline">
          <span className="wb-insights__number">{section.headline.value}</span>{' '}
          <span className="wb-insights__unit">{section.headline.label}</span>
        </p>
      )}
      {section.meaning && <p className="wb-insights__meaning">{section.meaning}</p>}
      {section.parameters.length > 0 && (
        <ul className="wb-insights__params">
          {section.parameters.map(p => <li key={p.name}>{p.value}{p.unit ? ` ${p.unit}` : ''}</li>)}
        </ul>
      )}
      {section.limitations.map(text => <p key={text} className="wb-insights__limit">{text}</p>)}
      {section.exampleGids.length > 0 && (
        <div className="wb-insights__examples" aria-label="Примеры счетов">
          {section.exampleGids.map(gid => (
            <button key={gid} type="button" className="wb-insights__gid" onClick={() => onSelect(gid)}>{gid}</button>
          ))}
        </div>
      )}
    </article>
  );
}

/** Панель «Наблюдения»: честная проверка сверху, затем по карточке на раздел finance-insights/v1. */
export function InsightsPanel({index, onSelect}: InsightsPanelProps) {
  const sections = parseSections(index);
  const general = generalLimitations(index);
  return (
    <div className="wb-insights" aria-label="Наблюдения">
      <HonestCheckBlock index={index} />
      {readInsights(index) === null
        ? <p className="wb-insights__small">В этом файле анализа нет раздела наблюдений.</p>
        : sections.map(s => <InsightCard key={s.key} section={s} onSelect={onSelect} />)}
      {general.length > 0 && (
        <section className="wb-insights__general" aria-label="Общие ограничения">
          {general.map(text => <p key={text} className="wb-insights__limit">{text}</p>)}
        </section>
      )}
    </div>
  );
}
