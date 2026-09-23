import { Fragment, type ReactNode } from 'react';
import { isGid } from './api';
import { NodeLink } from './NodeLink';

function plain(text: string): string {
  const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };
  return text.replace(/&amp;|&lt;|&gt;|&quot;|&#x27;/g, (match) => entities[match] ?? match);
}

/** Малый набор Markdown: разметка не создаёт HTML, внешние ссылки и загрузки. */
function inline(text: string, gids: readonly string[], onSelectNode?: (gid: string) => void): ReactNode[] {
  return text.split(/(\\[\\`*_\[\]|#]|\[[^\]\n]+\]\(\?gid=-?\d+\)|\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, index) => {
    if (part.startsWith('\\')) return <Fragment key={index}>{plain(part.slice(1))}</Fragment>;
    const link = /^\[(-?\d+)\]\(\?gid=(-?\d+)\)$/.exec(part);
    // Ссылка — только действие над точным счётом из проверенного результата, никогда произвольный URL.
    if (link && link[1] === link[2] && isGid(link[1]) && gids.includes(link[1]) && onSelectNode) {
      return <NodeLink key={index} gid={link[1]} onSelectNode={onSelectNode} />;
    }
    // Внутри полужирного тоже могут быть ссылки на счета: разбираем его содержимое тем же правилом.
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{inline(part.slice(2, -2), gids, onSelectNode)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{plain(part.slice(1, -1))}</code>;
    return <Fragment key={index}>{plain(part)}</Fragment>;
  });
}

/** Ячейки строки таблицы GFM: разделитель — неэкранированная черта. */
function cells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
}

const TABLE_RULE = /^\|(\s*:?-{3,}:?\s*\|)+\s*$/;

export interface FlowEdge { src: string; dst: string; label: string }

/**
 * Схема пути строится только из узкой грамматики, которую выдаёт сервер (assistant/presentation.py: diagram):
 * «flowchart TD», узлы nK["gid"], рёбра nA -->|"дата · сумма"| nB. Любая другая строка — схема не показывается:
 * ни директив Mermaid, ни ссылок, ни HTML. Подпись ребра выводится как текст, ровно как в источнике.
 */
export function parseFlow(source: readonly string[]): FlowEdge[] | null {
  if (!/^flowchart (TD|LR)$/.test((source[0] ?? '').trim())) return null;
  const nodes = new Map<string, string>();
  const edges: FlowEdge[] = [];
  for (const raw of source.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const node = /^(n\d{1,4})\["(-?\d{1,19})"\]$/.exec(line);
    if (node) { if (!isGid(node[2])) return null; nodes.set(node[1]!, node[2]!); continue; }
    const edge = /^(n\d{1,4}) -->\|"([^"<>\n]{1,80})"\| (n\d{1,4})$/.exec(line);
    if (!edge) return null;
    const src = nodes.get(edge[1]!), dst = nodes.get(edge[3]!);
    if (!src || !dst) return null;
    edges.push({ src, dst, label: edge[2]! });
  }
  return edges.length ? edges : null;
}

function Account({ gid, gids, onSelectNode }: { gid: string; gids: readonly string[]; onSelectNode?: (gid: string) => void }) {
  return gids.includes(gid) && onSelectNode ? <NodeLink gid={gid} onSelectNode={onSelectNode} /> : <span className="fa-gid" dir="ltr">{gid}</span>;
}

/** Путь по датам: счета сверху вниз, между ними дата и сумма перевода. */
function DatedFlow({ edges, gids, onSelectNode }: { edges: FlowEdge[]; gids: readonly string[]; onSelectNode?: (gid: string) => void }) {
  const chain = edges.every((edge, i) => i === 0 || edges[i - 1]!.dst === edge.src);
  if (chain) {
    return <ol className="fa-flow" aria-label="Схема пути">
      <li className="fa-flow-node"><Account gid={edges[0]!.src} gids={gids} onSelectNode={onSelectNode} /></li>
      {edges.map((edge, i) => <Fragment key={i}>
        <li className="fa-flow-step" aria-label={`Перевод: ${edge.label}`}><span aria-hidden="true">↓</span> {edge.label}</li>
        <li className="fa-flow-node"><Account gid={edge.dst} gids={gids} onSelectNode={onSelectNode} /></li>
      </Fragment>)}
    </ol>;
  }
  return <ul className="fa-flow" aria-label="Схема переводов">
    {edges.map((edge, i) => <li key={i} className="fa-flow-row">
      <Account gid={edge.src} gids={gids} onSelectNode={onSelectNode} /><span aria-hidden="true"> → </span>
      <Account gid={edge.dst} gids={gids} onSelectNode={onSelectNode} /><span className="fa-flow-label">{edge.label}</span>
    </li>)}
  </ul>;
}

export function SafeAnswer({ text, gids = [], onSelectNode }: { text: string; gids?: readonly string[]; onSelectNode?: (gid: string) => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }
    const key = index;
    if (/^```/.test(line.trim())) {
      const fence = line.trim().slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test((lines[index] ?? '').trim())) { body.push(lines[index] ?? ''); index += 1; }
      index += 1;
      if (fence === 'mermaid') {
        const edges = parseFlow(body);
        blocks.push(edges ? <DatedFlow key={key} edges={edges} gids={gids} onSelectNode={onSelectNode} />
          : <p key={key} className="fa-caption">Схема не показана: её формат не проверен. Факты — в таблице и основаниях.</p>);
      } else {
        blocks.push(<pre key={key} className="fa-code"><code>{body.join('\n')}</code></pre>);
      }
    } else if (/^\s*\|/.test(line) && TABLE_RULE.test((lines[index + 1] ?? '').trim())) {
      const head = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && /^\s*\|/.test(lines[index] ?? '')) { rows.push(cells(lines[index] ?? '')); index += 1; }
      blocks.push(<div key={key} className="fa-table-wrap"><table className="fa-table">
        <thead><tr>{head.map((cell, i) => <th key={i} scope="col">{inline(cell, gids, onSelectNode)}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{head.map((_, i) => <td key={i}>{inline(row[i] ?? '', gids, onSelectNode)}</td>)}</tr>)}</tbody>
      </table></div>);
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push(<p className="fa-answer-heading" key={key}>{inline(line.replace(/^#{1,6}\s+/, ''), gids, onSelectNode)}</p>);
      index += 1;
    } else if (/^\s*[-*]\s/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\s*[-*]\s/.test(lines[index] ?? '')) {
        items.push(<li key={index}>{inline((lines[index] ?? '').replace(/^\s*[-*]\s+/, ''), gids, onSelectNode)}</li>);
        index += 1;
      }
      blocks.push(<ul key={key}>{items}</ul>);
    } else {
      // Первая строка абзаца берётся всегда: строка с «|» без линейки таблицы — обычный текст, цикл не застревает.
      const paragraph: string[] = [line];
      index += 1;
      while (index < lines.length && (lines[index] ?? '').trim() && !/^#{1,6}\s|^\s*[-*]\s|^\s*```|^\s*\|/.test(lines[index] ?? '')) {
        paragraph.push(lines[index] ?? ''); index += 1;
      }
      blocks.push(<p key={key}>{inline(paragraph.join('\n'), gids, onSelectNode)}</p>);
    }
  }
  return <div className="fa-answer">{blocks}</div>;
}
