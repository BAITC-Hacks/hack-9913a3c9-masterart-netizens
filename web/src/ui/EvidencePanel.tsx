import {useMemo, useState} from 'react';
import type {GraphIndex} from '../data/graph';
import type {AccountNode, Mode, Witness} from '../data/schema';
import type {Neighborhood} from '../data/neighborhood';
import {buildReviewBrief, briefFileName} from '../data/brief';
import {MODE_HINT, MODE_LABEL, REACH_CAVEAT, ROLE_HINT, countLabel, formatDate, formatInt, formatKzt, formatScore, roleLabel} from '../data/format';
import {Gid} from './Gid';
import {RoleGlyph, RoleTag} from './RoleGlyph';
import {Icon} from '../map/icons';
import {AssistantSlot} from '../app/AssistantSlot';

/**
 * Основания по выбранному счёту. Сначала — счёт, гипотеза роли, альтернатива и справка; затем
 * приоритет, потоки, границы наблюдения и пути по датам. Правило с порогами, все кандидаты,
 * состав приоритета и общие ограничения раскрываются по запросу. Всё — из файла анализа.
 */
const MODES: Mode[] = ['structural', 'strict', 'same_day'];
const MODE_SHORT: Record<Mode, string> = {structural: 'Без дат', strict: 'Позже по датам', same_day: 'В тот же день'};
const FAMILY_LABEL: Record<string, string> = {
  role_signal: 'Опора роли', flow: 'Оборот', seed_links: 'Связи с исходными клиентами', chronology: 'Хронология путей', breadth: 'Охват',
};

export function EvidencePanel({index, hood, mode, onMode, onSelect, onOpenCluster}: {
  index: GraphIndex; hood: Neighborhood; mode: Mode; onMode: (mode: Mode) => void; onSelect: (gid: string) => void; onOpenCluster: (id: number) => void;
}) {
  const node = hood.focus;
  const {policy} = index.analysis;
  const m = node.metrics;
  const t = node.temporal;
  const alternatives = useMemo(() => [...node.role_alternatives].filter(a => a.role !== node.role).sort((a, b) => b.score - a.score), [node]);
  const alt = alternatives[0];
  const rule = policy.rules.find(r => r.role === node.role);
  const rank = index.topRank.get(node.gid);
  const cluster = index.clusters.get(node.cluster_id);
  const families = extraNumbers(node, 'priority_families');
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); window.setTimeout(() => setCopied(null), 1600); }
    catch { setCopied('Копирование недоступно в этом браузере'); }
  };
  const download = () => {
    const brief = buildReviewBrief(index, node.gid, mode, new Date().toLocaleString('ru-RU'));
    if (!brief) return;
    const url = URL.createObjectURL(new Blob([brief], {type: 'text/markdown;charset=utf-8'}));
    const a = document.createElement('a');
    a.href = url; a.download = briefFileName(node.gid);
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setCopied(`Справка сохранена: ${briefFileName(node.gid)}`);
  };

  const counts: Record<Mode, number> = {structural: t.static_seed_count, strict: t.strict_seed_count, same_day: t.same_day_seed_count};
  const witness = mode === 'strict' ? t.strict_witness : mode === 'same_day' ? t.same_day_witness : null;
  const limits = [...(node.observation.outgoing_censored ? ['Исходящие не наблюдаются из-за границы сбора. Это не доказывает, что деньги остались на счёте.'] : []), ...node.observation.warnings];
  const extra = m as unknown as Record<string, unknown>;
  const lastIn = typeof extra.last_in_date === 'string' ? extra.last_in_date : null;
  const margin = typeof extra.observation_margin_days === 'number' ? extra.observation_margin_days : null;

  return <aside className="wb-inspector" aria-label="Основания по счёту">
    <header className="wb-account">
      <p className="wb-account__kind">{node.is_seed ? 'Исходный клиент' : 'Счёт'} · {countLabel(node.depth, 'шаг', 'шага', 'шагов')} от исходных</p>
      <h2 className="wb-account__gid"><Gid gid={node.gid} /></h2>
      <button type="button" className="wb-iconbutton" onClick={() => copy(node.gid, 'gid скопирован')} aria-label="Копировать gid" title="Копировать gid"><Icon name="copy" size={16} /></button>
    </header>

    <section className={`wb-role wb-role--${node.role}`} aria-label="Гипотеза роли">
      <div className="wb-role__line">
        <RoleGlyph role={node.role} size={26} />
        <p className="wb-role__name">{roleLabel(node.role)}</p>
        <p className="wb-role__score" title={policy.score_description}><strong>{formatScore(node.role_score)}</strong><span>опора</span></p>
      </div>
      {ROLE_HINT[node.role] && <p className="wb-role__hint">Гипотеза: {ROLE_HINT[node.role]}</p>}
      <p className="wb-evidence">{node.evidence}</p>
      {alt && <p className="wb-alt"><span className="wb-alt__label">Альтернатива</span><RoleTag role={alt.role} score={formatScore(alt.score)} /><span className="wb-alt__reason">{alt.reason}</span></p>}
      <button type="button" className="wb-button wb-button--primary wb-brief" onClick={download}><Icon name="download" size={15} />Справка для проверки</button>
      <p className="wb-live" role="status" aria-live="polite">{copied}</p>
      <details className="wb-disclosure">
        <summary>Правило и пороги</summary>
        {rule ? <div className="wb-rule">
          <p className="wb-rule__text">{rule.description}</p>
          <Thresholds value={rule.thresholds} />
        </div> : <p className="wb-muted">Правило для этой роли в файле не описано.</p>}
        <p className="wb-footnote">{policy.score_description}</p>
      </details>
      {alternatives.length > 1 && <details className="wb-disclosure">
        <summary>Все кандидаты роли · {alternatives.length + 1}</summary>
        <ul className="wb-candidates">{alternatives.map(c => <li key={c.role}><RoleTag role={c.role} score={formatScore(c.score)} /><span>{c.reason}</span></li>)}</ul>
      </details>}
    </section>

    <section className="wb-section" aria-labelledby="wb-priority-title">
      <h3 id="wb-priority-title" className="wb-section__title">Приоритет проверки</h3>
      <div className="wb-priority">
        <p className="wb-priority__value">{formatScore(node.priority_score)}</p>
        <div className="wb-meter" role="img" aria-label={`Приоритет ${formatScore(node.priority_score)} из 1`}><i style={{transform: `scaleX(${clamp01(node.priority_score)})`}} /></div>
        <p className="wb-priority__rank">{rank ? `№ ${rank} в очереди проверки` : 'Вне списка очереди'}</p>
      </div>
      <details className="wb-disclosure">
        <summary>Из чего складывается</summary>
        {families.length > 0 && <dl className="wb-families">{families.map(([key, value]) => <div key={key}>
          <dt>{FAMILY_LABEL[key] ?? key}</dt>
          <dd><span className="wb-meter wb-meter--small"><i style={{transform: `scaleX(${clamp01(value)})`}} /></span><span className="wb-mono">{formatScore(value)}</span></dd>
        </div>)}</dl>}
        <p className="wb-footnote">{policy.priority_description}</p>
      </details>
    </section>

    <section className="wb-section" aria-labelledby="wb-flow-title">
      <h3 id="wb-flow-title" className="wb-section__title">Наблюдаемые потоки</h3>
      <dl className="wb-flows">
        <div><dt><Icon name="arrow-down" size={13} />Входящие</dt><dd><strong>{formatKzt(m.in_kzt)}</strong><span>{countLabel(m.in_degree, 'плательщик', 'плательщика', 'плательщиков')} · {countLabel(m.in_tx, 'перевод', 'перевода', 'переводов')}</span></dd></div>
        <div><dt><Icon name="arrow-up" size={13} />Исходящие</dt><dd><strong>{formatKzt(m.out_kzt)}</strong><span>{countLabel(m.out_degree, 'получатель', 'получателя', 'получателей')} · {countLabel(m.out_tx, 'перевод', 'перевода', 'переводов')}</span></dd></div>
      </dl>
      <p className="wb-flows__meta">
        <span>Исходящие к входящим: <span className="wb-mono">{m.pass_through === null ? 'не определено' : formatScore(m.pass_through)}</span></span>
        <span>Связей с исходными клиентами: <span className="wb-mono">{formatInt(m.seed_in_count)} вх. · {formatInt(m.seed_out_count)} исх.</span></span>
        {lastIn && <span>Последнее поступление {formatDate(lastIn)}{margin !== null && `, до конца периода ${countLabel(margin, 'день', 'дня', 'дней')}`}</span>}
      </p>
    </section>

    {limits.length > 0 && <section className="wb-section wb-section--attention" aria-labelledby="wb-limits-title">
      <h3 id="wb-limits-title" className="wb-section__title">Границы наблюдения</h3>
      {limits.map(limit => <p key={limit} className="wb-limit"><Icon name="alert" size={15} />{limit}</p>)}
    </section>}

    <section className="wb-section" aria-labelledby="wb-paths-title">
      <h3 id="wb-paths-title" className="wb-section__title">Пути от исходных клиентов</h3>
      <div className="wb-modes" role="radiogroup" aria-label="Режим учёта дат">
        {MODES.map(value => <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? 'is-active' : undefined}
          title={MODE_LABEL[value]} onClick={() => onMode(value)}>
          <span className="wb-modes__count">{formatInt(counts[value])}</span>
          <span className="wb-modes__label">{MODE_SHORT[value]}</span>
        </button>)}
      </div>
      <p className="wb-modes__hint">{countLabel(counts[mode], 'исходный клиент', 'исходных клиента', 'исходных клиентов')}: {MODE_HINT[mode]}.</p>
      {mode === 'structural'
        ? <p className="wb-muted">Без учёта дат пример пути не хранится. Выберите режим с датами, чтобы увидеть цепочку переводов.</p>
        : <WitnessPath witness={witness} index={index} focus={node.gid} onSelect={onSelect} />}
      <p className="wb-caveat">{REACH_CAVEAT}</p>
    </section>

    <section className="wb-section" aria-labelledby="wb-next-title">
      <h3 id="wb-next-title" className="wb-section__title">Следующий запрос данных</h3>
      <p className="wb-next">{node.next_request}</p>
    </section>

    {cluster && <section className="wb-section" aria-labelledby="wb-cluster-title">
      <h3 id="wb-cluster-title" className="wb-section__title">Кластер {cluster.cluster_id}</h3>
      <p className="wb-cluster-line">{countLabel(cluster.n_nodes, 'счёт', 'счёта', 'счетов')} · исходных {formatInt(cluster.n_seed)} · внутри {formatKzt(cluster.sum_kzt_internal)}</p>
      <p className="wb-hypothesis">{cluster.hypothesis}</p>
      <button type="button" className="wb-button wb-button--quiet" onClick={() => onOpenCluster(cluster.cluster_id)}>Открыть кластер<Icon name="chevron" size={14} /></button>
    </section>}

    <AssistantSlot focusGid={node.gid} onSelectGid={onSelect} />

    {policy.limitations.length > 0 && <details className="wb-disclosure wb-section">
      <summary>Ограничения данных · {policy.limitations.length}</summary>
      <ul className="wb-limitations">{policy.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
    </details>}
  </aside>;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Числовые поля-расширения узла (например, priority_families), если конвейер их записал. */
function extraNumbers(node: AccountNode, key: string): [string, number][] {
  const value = (node as unknown as Record<string, unknown>)[key];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
}

function WitnessPath({witness, index, focus, onSelect}: {witness: Witness | null; index: GraphIndex; focus: string; onSelect: (gid: string) => void}) {
  if (!witness) return <p className="wb-muted">В этом режиме путь от исходных клиентов не найден.</p>;
  const stops = [witness.seed_gid, ...witness.hops.map(hop => hop.dst)];
  return <ol className="wb-witness" aria-label="Пример пути по датам">
    {stops.map((gid, i) => {
      const node = index.byGid.get(gid);
      const hop = witness.hops[i];
      return <li key={`${gid}-${i}`} className={gid === focus ? 'is-focus' : undefined}>
        <span className="wb-witness__dot" aria-hidden="true" />
        <div className="wb-witness__stop">
          <span className="wb-witness__who">{i === 0 ? 'исходный клиент' : gid === focus ? 'этот счёт' : node ? roleLabel(node.role).toLowerCase() : 'счёт'}</span>
          {gid === focus ? <Gid gid={gid} /> : <button type="button" className="wb-linklike" onClick={() => onSelect(gid)} aria-label={`Открыть счёт ${gid}`}><Gid gid={gid} /></button>}
        </div>
        {hop && <p className="wb-witness__hop"><span>{formatDate(hop.date)}</span><span>{formatKzt(hop.sum_kzt)}</span></p>}
      </li>;
    })}
  </ol>;
}

/**
 * Пороги правила. Конвейер пишет их как {ключ: {value, unit, rationale}}; показываем значение с
 * единицей, ниже — обоснование, а технический ключ — мелко. Другие формы выводятся как текст.
 */
function Thresholds({value}: {value: unknown}) {
  if (!value || typeof value !== 'object') return value === null || value === undefined || value === '' ? null : <p className="wb-rule__text">Порог: {String(value)}</p>;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v] as const) : Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <p className="wb-muted">Отдельных порогов нет: роль назначается, когда других признаков не найдено.</p>;
  return <ul className="wb-thresholds">{entries.map(([key, raw]) => {
    const item: Record<string, unknown> = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {value: raw};
    const shown = item.value ?? item.min ?? item.max;
    return <li key={key}>
      <p className="wb-thresholds__value"><span className="wb-mono">{typeof shown === 'number' ? formatScoreOrInt(shown) : String(shown ?? '—')}</span>
        {typeof item.unit === 'string' && <span>{item.unit}</span>}</p>
      {typeof item.rationale === 'string' && <p className="wb-thresholds__why">{item.rationale}</p>}
      <p className="wb-thresholds__key">{key}</p>
    </li>;
  })}</ul>;
}
const formatScoreOrInt = (n: number) => (Number.isInteger(n) ? formatInt(n) : formatScore(n));
