import type {ComponentType} from 'react';
import type {GraphIndex} from '../data/graph';
import type {Mode} from '../data/schema';

/**
 * Место для аналитического помощника. Панель помощника живёт в src/features/assistant/index.tsx
 * (отдельная часть проекта) и экспортирует AssistantPanel с этими свойствами. Пока файла нет,
 * слот пуст: основной ручной сценарий от помощника не зависит.
 */
export interface AssistantPanelProps {
  /** Проверенный индекс файла анализа: только чтение. */
  index: GraphIndex;
  /** Выбранный счёт — строка цифр — или null. */
  focusGid: string | null;
  /** Выбранный режим учёта дат. */
  mode: Mode;
  /** Открыть счёт на карте; принимает только gid из индекса. */
  onSelectGid: (gid: string) => void;
}

const modules = import.meta.glob<{AssistantPanel?: ComponentType<AssistantPanelProps>}>('../features/assistant/index.tsx', {eager: true});
const Panel = Object.values(modules)[0]?.AssistantPanel;

export function AssistantSlot(props: AssistantPanelProps) {
  return Panel ? <Panel {...props} /> : null;
}
