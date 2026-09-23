import { Fragment, type ReactNode } from 'react';

/** Малый набор Markdown: разметка не создаёт HTML, внешние ссылки и загрузки. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function SafeAnswer({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }
    const key = index;
    if (/^#{1,6}\s/.test(line)) {
      blocks.push(<p className="fa-answer-heading" key={key}>{inline(line.replace(/^#{1,6}\s+/, ''))}</p>);
      index += 1;
    } else if (/^\s*[-*]\s/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\s*[-*]\s/.test(lines[index] ?? '')) {
        items.push(<li key={index}>{inline((lines[index] ?? '').replace(/^\s*[-*]\s+/, ''))}</li>);
        index += 1;
      }
      blocks.push(<ul key={key}>{items}</ul>);
    } else {
      const paragraph: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim() && !/^#{1,6}\s|^\s*[-*]\s/.test(lines[index] ?? '')) {
        paragraph.push(lines[index] ?? ''); index += 1;
      }
      blocks.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
    }
  }
  return <div className="fa-answer">{blocks}</div>;
}
