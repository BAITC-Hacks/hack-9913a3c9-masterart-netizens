import {useMemo, useState} from 'react';
import type {GraphIndex} from '../data/graph';
import type {Mode, Witness} from '../data/schema';
import type {Neighborhood} from '../data/neighborhood';
import {buildReviewBrief, briefFileName} from '../data/brief';
import {MODE_HINT, MODE_LABEL, REACH_CAVEAT, ROLE_HINT, countLabel, formatDate, formatInt, formatKzt, formatScore, roleLabel} from '../data/format';
import {Gid} from './Gid';
import {RoleGlyph, RoleTag} from './RoleGlyph';
import {Icon} from '../map/icons';
import {AssistantSlot} from '../app/AssistantSlot';

/**
 * Основания по выбранному счёту: гипотеза роли и ближайшая альтернатива, приоритет, наблюдаемые
 * потоки, границы наблюдения, датированные пути и следующий запрос данных. Всё — из файла анализа.
 */
const MODES: Mode[] = ['structural', 'strict', 'same_day'];

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
  };

  const counts: Record<Mode, number> = {structural: t.static_seed_count, strict: t.strict_seed_count, same_day: t.same_day_seed_count};
  const witness = mode === 'strict' ? t.strict_witness : mode === 'same_day' ? t.same_day_witness : null;
  const warnings = node.observation.warnings;

  return <aside className="wb-inspector" aria-label="Основания по счёту">
    <header className="wb-inspector__head">
      <p className="wb-eyebrow">
        Счёт{node.is_seed && <em className="wb-flag">исходный клиент</em>}
        <span>шагов от исходных: {node.depth}</span>
      </p>
      <h2 className="wb-inspector__gid"><Gid gid={node.gid} /></h2>
      <div className="wb-inspector__actions">
        <button type="button" className="wb-button wb-button--quiet" onClick={() => copy(node.gid, 'gid скопирован')}><Icon name="copy" size={15} />Копировать gid</button>
        <button type="button" className="wb-button wb-button--primary" onClick={download}><Icon name="download" size={15} />Справка для проверки</button>
      </div>
      <p className="wb-live" role="status" aria-live="polite">{copied}</p>
    </header>

    <section className="wb-section" aria-labelledby="wb-role-title">
      <h3 id="wb-role-title" className="wb-section__title">Гипотеза роли</h3>
      <div className={`wb-role wb-role--${node.role}`}>
        <RoleGlyph role={node.role} size={30} />
        <div>
          <p className="wb-role__name">{roleLabel(node.role)}</p>
          {ROLE_HINT[node.role] && <p className="wb-role__hint">{ROLE_HINT[node.role]}</p>}
        </div>
        <p className="wb-role__score" title={policy.score_description}><span>опора правила</span><strong>{formatScore(node.role_score)}</strong></p>
      </div>
      <p className="wb-evidence">{node.evidence}</p>
      {rule && <div className="wb-rule">
        <p><span className="wb-rule__label">Правило</span>{rule.description}</p>
        <Thresholds value={rule.thresholds} />
      </div>}
      {alt ? <div className="wb-alt">
        <p className="wb-alt__label">Ближайшая альтернатива</p>
        <p className="wb-alt__head"><RoleTag role={alt.role} score={formatScore(alt.score)} /></p>
        <p className="wb-alt__reason">{alt.reason}</p>
      </div> : <p className="wb-muted">Альтернативная роль в файле не указана.</p>}
      {alternatives.length > 1 && <details className="wb-details">
        <summary>Все кандидаты · {alternatives.length + 1}</summary>
        <ul className="wb-candidates">{[{role: node.role, score: node.role_score, reason: 'Основная гипотеза'}, ...alternatives].map(c =>
          <li key={c.role}><RoleTag role={c.role} score={formatScore(c.score)} /><span>{c.reason}</span></li>)}</ul>
      </details>}
      <p className="wb-footnote">{policy.score_description}</p>
    </section>

    <section className="wb-section" aria-labelledby="wb-priority-title">
      <h3 id="wb-priority-title" className="wb-section__title">Приоритет проверки</h3>
      <div className="wb-priority">
        <p className="wb-priority__value">{formatScore(node.priority_score)}</p>
        <div className="wb-meter" role="img" aria-label={`Приоритет ${formatScore(node.priority_score)} из 1`}><i style={{transform: `scaleX(${Math.max(0, Math.min(1, node.priority_score))})`}} /></div>
        <p className="wb-priority__rank">{rank ? `№ ${rank} в очереди проверки` : 'вне топ-списка очереди'}</p>
      </div>
      <p className="wb-footnote">{policy.priority_description}</p>
    </section>

    <section className="wb-section" aria-labelledby="wb-flow-title">
      <h3 id="wb-flow-title" className="wb-section__title">Наблюдаемые потоки</h3>
      <table className="wb-flows">
        <thead><tr><th scope="col"><span className="wb-visually-hidden">Показатель</span></th><th scope="col"><Icon name="arrow-down" size={13} />Входящие</th><th scope="col"><Icon name="arrow-up" size={13} />Исходящие</th></tr></thead>
        <tbody>
          <tr><th scope="row">Контрагентов</th><td>{formatInt(m.in_degree)}</td><td>{formatInt(m.out_degree)}</td></tr>
          <tr><th scope="row">Переводов</th><td>{formatInt(m.in_tx)}</td><td>{formatInt(m.out_tx)}</td></tr>
          <tr><th scope="row">Сумма</th><td>{formatKzt(m.in_kzt)}</td><td>{formatKzt(m.out_kzt)}</td></tr>
          <tr><th scope="row">Исходных клиентов</th><td>{formatInt(m.seed_in_count)}</td><td>{formatInt(m.seed_out_count)}</td></tr>
        </tbody>
      </table>
      <p className="wb-flows__ratio">Исходящие / входящие: <strong>{m.pass_through === null ? 'не определено' : formatScore(m.pass_through)}</strong>
        {m.pass_through === null && <span className="wb-muted"> — {node.is_seed ? 'у исходного клиента неполные входящие' : 'нет входящих в выборке'}</span>}</p>
    </section>

    <section className={`wb-section${node.observation.outgoing_censored || warnings.length ? ' is-attention' : ''}`} aria-labelledby="wb-limits-title">
      <h3 id="wb-limits-title" className="wb-section__title">Границы наблюдения</h3>
      {node.observation.outgoing_censored && <p className="wb-limit"><Icon name="alert" size={15} />Исходящие не наблюдаются из-за границы сбора. Это не доказывает, что деньги остались на счёте.</p>}
      {warnings.map(warning => <p key={warning} className="wb-limit"><Icon name="alert" size={15} />{warning}</p>)}
      {!node.observation.outgoing_censored && !warnings.length && <p className="wb-muted">Особых ограничений для этого счёта не отмечено. Общие ограничения данных — ниже.</p>}
    </section>

    <section className="wb-section" aria-labelledby="wb-paths-title">
      <h3 id="wb-paths-title" className="wb-section__title">Пути от исходных клиентов</h3>
      <div className="wb-modes" role="radiogroup" aria-label="Режим учёта дат">
        {MODES.map(value => <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? 'is-active' : undefined} onClick={() => onMode(value)}>
          <span className="wb-modes__count">{formatInt(counts[value])}</span>
          <span className="wb-modes__label">{MODE_LABEL[value]}</span>
        </button>)}
      </div>
      <p className="wb-modes__hint">{countLabel(counts[mode], 'исходный клиент', 'исходных клиента', 'исходных клиентов')} · {MODE_HINT[mode]}.</p>
      {mode === 'structural'
        ? <p className="wb-muted">Для режима без дат пример пути не хранится: он лишь показывает, что связи существуют. Выберите режим с датами, чтобы увидеть конкретную цепочку.</p>
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

    <AssistantSlot index={index} focusGid={node.gid} mode={mode} onSelectGid={onSelect} />

    {policy.limitations.length > 0 && <details className="wb-details wb-section">
      <summary>Ограничения данных · {policy.limitations.length}</summary>
      <ul className="wb-limitations">{policy.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
    </details>}
  </aside>;
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

function Thresholds({value}: {value: unknown}) {
  const entries: [string, string][] = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) entries.push([key, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
  } else if (Array.isArray(value)) value.forEach((v, i) => entries.push([String(i + 1), typeof v === 'object' ? JSON.stringify(v) : String(v)]));
  else if (value !== null && value !== undefined && value !== '') entries.push(['порог', String(value)]);
  if (!entries.length) return null;
  return <dl className="wb-thresholds">{entries.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
