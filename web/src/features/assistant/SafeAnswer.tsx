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
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{plain(part.slice(2, -2))}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{plain(part.slice(1, -1))}</code>;
    return <Fragment key={index}>{plain(part)}</Fragment>;
  });
}

export function SafeAnswer({ text, gids = [], onSelectNode }: { text: string; gids?: readonly string[]; onSelectNode?: (gid: string) => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }
    const key = index;
    if (/^#{1,6}\s/.test(line)) {
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
      const paragraph: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim() && !/^#{1,6}\s|^\s*[-*]\s/.test(lines[index] ?? '')) {
        paragraph.push(lines[index] ?? ''); index += 1;
      }
      blocks.push(<p key={key}>{inline(paragraph.join('\n'), gids, onSelectNode)}</p>);
    }
  }
  return <div className="fa-answer">{blocks}</div>;
}
