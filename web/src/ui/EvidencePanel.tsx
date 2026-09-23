import {useEffect, useMemo, useState} from 'react';
import type {GraphIndex} from '../data/graph';
import type {AccountNode, Mode, Witness} from '../data/schema';
import type {Neighborhood} from '../data/neighborhood';
import {buildReviewBrief, briefFileName} from '../data/brief';
import {roleAlternatives, roleFacts} from '../data/roleFacts';
import {MODE_HINT, MODE_LABEL, REACH_CAVEAT, ROLE_HINT, countLabel, formatDate, formatInt, formatKzt, formatScore, roleLabel} from '../data/format';
import {Gid} from './Gid';
import {RoleGlyph, RoleTag} from './RoleGlyph';
import {Icon} from '../map/icons';
import {AssistantSlot} from '../app/AssistantSlot';
import {CopyGid} from './CopyGid';
import {SaveAccountButton, useReportSession} from '../features/shortlist';
import {AccountInsights} from '../features/insights';
import {CompactKzt} from './Amount';

/**
 * Основания по выбранному счёту — от главного к подробностям: роль, два-три факта с порогами,
 * сравнение с ближайшей альтернативой, потоки, датированный путь, пробелы и следующий запрос.
 * Текст основания, правило с порогами, все кандидаты и состав приоритета — под раскрытием.
 * Опора роли и приоритет показаны раздельно: это разные величины, и ни одна не вероятность.
 */
const MODES: Mode[] = ['structural', 'strict', 'same_day'];
const MODE_SHORT: Record<Mode, string> = {structural: 'Без дат', strict: 'Позже по датам', same_day: 'В тот же день'};
const FAMILY_LABEL: Record<string, string> = {
  role_signal: 'Опора роли', flow: 'Оборот', seed_links: 'Связи с исходными клиентами', chronology: 'Хронология путей', breadth: 'Охват',
};

export function EvidencePanel({index, hood, mode, onMode, onSelect, onOpenCluster, openCluster = null}: {
  index: GraphIndex; hood: Neighborhood; mode: Mode; onMode: (mode: Mode) => void; onSelect: (gid: string) => void; onOpenCluster: (id: number) => void;
  /** Кластер, открытый в центре; если выбранный счёт из другого кластера, это сказано явно. */
  openCluster?: number | null;
}) {
  const node = hood.focus;
  const {policy} = index.analysis;
  const m = node.metrics;
  const t = node.temporal;
  const alternatives = useMemo(() => roleAlternatives(node), [node]);
  const alt = alternatives[0];
  const rule = policy.rules.find(r => r.role === node.role);
  // Число разных контрагентов считает конвейер; окрестность — запасной путь для первой версии.
  const counterparties = typeof m.counterparties === 'number' ? m.counterparties : hood.payers.length + hood.recipients.length + hood.mutual.length;
  const transitRule = useMemo(() => index.analysis.policy.rules.find(r => r.role === 'transit'), [index]);
  const facts = useMemo(() => roleFacts(node, rule, counterparties, transitRule), [node, rule, counterparties, transitRule]);
  const rank = index.topRank.get(node.gid);
  const cluster = index.clusters.get(node.cluster_id);
  const families = extraNumbers(node, 'priority_families');
  const [status, setStatus] = useState<string | null>(null);
  const reportSession = useReportSession();
  // Панель больше не пересоздаётся при смене счёта, поэтому сообщение сбрасывается явно.
  useEffect(() => { setStatus(null); }, [node.gid]);

  const download = () => {
    const brief = buildReviewBrief(index, node.gid, mode, new Date().toLocaleString('ru-RU'));
    if (!brief) return;
    const url = URL.createObjectURL(new Blob([brief], {type: 'text/markdown;charset=utf-8'}));
    const a = document.createElement('a');
    a.href = url; a.download = briefFileName(node.gid);
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Справка сохранена: ${briefFileName(node.gid)}`);
  };

  const counts: Record<Mode, number> = {structural: t.static_seed_count, strict: t.strict_seed_count, same_day: t.same_day_seed_count};
  const witness = mode === 'strict' ? t.strict_witness : mode === 'same_day' ? t.same_day_witness : null;
  // Предупреждение о границе выгрузки уже приходит из конвейера; своё добавляется, только если его там нет.
  const hasBoundary = node.observation.warnings.some(w => w.includes('не собирались'));
  const limits = [...(node.observation.outgoing_censored && !hasBoundary ? ['Исходящие не наблюдаются из-за границы сбора. Это не доказывает, что деньги остались на счёте.'] : []), ...node.observation.warnings];
  const extra = m as unknown as Record<string, unknown>;
  const lastIn = typeof extra.last_in_date === 'string' ? extra.last_in_date : null;

  return <aside className="wb-inspector" aria-label="Основания по счёту">
    {openCluster !== null && openCluster !== node.cluster_id && <p className="wb-context" role="note">
      <Icon name="link" size={15} />
      <span>Здесь по-прежнему счёт из кластера {node.cluster_id}. В центре открыт кластер {openCluster}: выберите его участника на карте или в списке.</span>
    </p>}
    <header className="wb-account">
      <p className="wb-account__kind">{node.is_seed ? 'Исходный клиент' : 'Счёт'} · {countLabel(node.depth, 'шаг', 'шага', 'шагов')} от исходных</p>
      <h2 className="wb-account__gid"><Gid gid={node.gid} /></h2>
      <CopyGid gid={node.gid} />
      <div className="wb-account__priority" title={policy.priority_description}>
        <span className="wb-account__label">Приоритет</span>
        <strong>{formatScore(node.priority_score)}</strong>
        <span className="wb-meter" role="img" aria-label={`Приоритет ${formatScore(node.priority_score)} из 1`}><i style={{transform: `scaleX(${clamp01(node.priority_score)})`}} /></span>
        <span className="wb-account__rank">{rank ? `№ ${rank} в очереди` : 'вне очереди'}</span>
      </div>
    </header>

    <section className={`wb-role wb-role--${node.role}`} aria-label="Гипотеза роли">
      <div className="wb-role__line">
        <RoleGlyph role={node.role} size={26} />
        <p className="wb-role__name">{roleLabel(node.role)}</p>
      </div>
      <ul className="wb-facts" aria-label="На чём держится гипотеза">
        {facts.map(fact => <li key={fact.label} className={[fact.value.length > 8 ? 'is-wide' : '', fact.met === false ? 'is-below' : ''].filter(Boolean).join(' ') || undefined}>
          <strong>{fact.value}</strong>
          <span>{fact.label}</span>
          {fact.threshold && <small>{fact.threshold}</small>}
        </li>)}
      </ul>
      <div className="wb-compare" role="group" aria-label="Опора основной роли и ближайшей альтернативы">
        <CompareRow role={node.role} score={node.role_score} primary />
        {alt && <CompareRow role={alt.role} score={alt.score} reason={alt.reason} />}
      </div>
      <p className="wb-compare__note">Опора правила: эвристика от 0 до 1, не вероятность. Приоритет считается отдельно.</p>
      <div className="wb-actions">
        {/* Главное действие — PDF-справка в окне просмотра; сохранение счёта — отдельной кнопкой рядом. */}
        <button type="button" className="wb-button wb-button--primary wb-brief" onClick={() => void reportSession.request([node.gid], mode)}><Icon name="download" size={15} />Справка для проверки</button>
        <SaveAccountButton gid={node.gid} />
        <button type="button" className="wb-button wb-button--quiet" onClick={download}>Текст .md</button>
      </div>
      <p className="wb-live" role="status" aria-live="polite">{status}</p>
      <details className="wb-disclosure">
        <summary>Основание и правило</summary>
        <p className="wb-evidence">{node.evidence}</p>
        {ROLE_HINT[node.role] && <p className="wb-role__hint">{roleLabel(node.role)}: {ROLE_HINT[node.role]}.</p>}
        {rule ? <div className="wb-rule">
          <p className="wb-rule__text">{rule.description}</p>
          <Thresholds value={rule.thresholds} />
        </div> : <p className="wb-muted">Правило для этой роли в файле не описано.</p>}
        <p className="wb-footnote">{policy.score_description}</p>
      </details>
      {alternatives.length > 0 && <details className="wb-disclosure">
        <summary>Все кандидаты роли · {alternatives.length + 1}</summary>
        <ul className="wb-candidates">{alternatives.map(c => <li key={c.role}><RoleTag role={c.role} score={formatScore(c.score)} /><span>{c.reason}</span></li>)}</ul>
      </details>}
      <AccountInsights index={index} gid={node.gid} />
    </section>

    <section className="wb-section" aria-labelledby="wb-flow-title">
      <h3 id="wb-flow-title" className="wb-section__title">Наблюдаемые потоки</h3>
      <dl className="wb-flows">
        <div><dt><Icon name="arrow-down" size={13} />Входящие</dt><dd><strong>{formatKzt(m.in_kzt)}</strong><span>{countLabel(m.in_degree, 'плательщик', 'плательщика', 'плательщиков')} · {countLabel(m.in_tx, 'перевод', 'перевода', 'переводов')}</span></dd></div>
        <div><dt><Icon name="arrow-up" size={13} />Исходящие</dt>{node.observation.outgoing_censored && m.out_degree === 0
          ? <dd className="is-unobserved"><strong>не наблюдаются</strong><span>граница сбора данных — это не ноль</span></dd>
          : <dd><strong>{formatKzt(m.out_kzt)}</strong><span>{countLabel(m.out_degree, 'получатель', 'получателя', 'получателей')} · {countLabel(m.out_tx, 'перевод', 'перевода', 'переводов')}</span></dd>}</div>
      </dl>
      <p className="wb-flows__meta">
        <span>Отдано / получено <span className="wb-mono">{m.pass_through === null ? '—' : formatScore(m.pass_through)}</span></span>
        <span>Связи с исходными клиентами: от них <span className="wb-mono">{formatInt(m.seed_in_count)}</span>, к ним <span className="wb-mono">{formatInt(m.seed_out_count)}</span></span>
        {lastIn && <span>Последнее поступление {formatDate(lastIn)}</span>}
      </p>
    </section>

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

    <section className={`wb-section${limits.length ? ' wb-section--attention' : ''}`} aria-labelledby="wb-gaps-title">
      <h3 id="wb-gaps-title" className="wb-section__title">Пробелы и следующий запрос</h3>
      {limits.map(limit => <p key={limit} className="wb-limit"><Icon name="alert" size={15} />{limit}</p>)}
      <p className="wb-next"><Icon name="chevron" size={14} />{node.next_request}</p>
    </section>

    {cluster && <section className="wb-section" aria-labelledby="wb-cluster-title">
      <h3 id="wb-cluster-title" className="wb-section__title">Кластер {cluster.cluster_id}</h3>
      <p className="wb-cluster-line">{countLabel(cluster.n_nodes, 'счёт', 'счёта', 'счетов')} · исходных {formatInt(cluster.n_seed)} · внутри <CompactKzt value={cluster.sum_kzt_internal} /></p>
      <details className="wb-disclosure"><summary>О кластере</summary><p className="wb-hypothesis">{cluster.hypothesis}</p></details>
      <button type="button" className="wb-button wb-button--quiet" onClick={() => onOpenCluster(cluster.cluster_id)}>Открыть кластер<Icon name="chevron" size={14} /></button>
    </section>}

    <AssistantSlot focusGid={node.gid} onSelectGid={onSelect} />

    <div className="wb-section wb-more-details">
      <details className="wb-disclosure">
        <summary>Из чего складывается приоритет</summary>
        {families.length > 0 && <dl className="wb-families">{families.map(([key, value]) => <div key={key}>
          <dt>{FAMILY_LABEL[key] ?? key}</dt>
          <dd><span className="wb-meter wb-meter--small"><i style={{transform: `scaleX(${clamp01(value)})`}} /></span><span className="wb-mono">{formatScore(value)}</span></dd>
        </div>)}</dl>}
        <p className="wb-footnote">{policy.priority_description}</p>
      </details>
      {policy.limitations.length > 0 && <details className="wb-disclosure">
        <summary>Ограничения данных · {policy.limitations.length}</summary>
        <ul className="wb-limitations">{policy.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
      </details>}
    </div>
  </aside>;
}

/** Строка сравнения: знак и роль, полоса длиной ровно в опору, число. Равные опоры выглядят равными. */
function CompareRow({role, score, reason, primary = false}: {role: string; score: number; reason?: string; primary?: boolean}) {
  return <div className={`wb-compare__row${primary ? ' is-primary' : ''}`} title={reason}>
    <span className="wb-compare__who">{primary ? 'Гипотеза' : 'Альтернатива'}</span>
    <RoleTag role={role} />
    <span className={`wb-bar wb-role--${role}`} aria-hidden="true"><i style={{transform: `scaleX(${clamp01(score)})`}} /></span>
    <span className="wb-compare__score">{formatScore(score)}</span>
  </div>;
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
