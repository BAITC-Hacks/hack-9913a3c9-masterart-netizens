import type {ComponentType} from 'react';

/**
 * Место для аналитического помощника. Панель живёт в src/features/assistant/index.tsx (отдельная
 * часть проекта) и экспортирует AssistantPanel с общим контрактом ниже. Пока файла нет, слот пуст:
 * основной ручной сценарий от помощника не зависит. Выбор счёта из ответа помощника проходит через
 * ту же проверку, что и поиск: неизвестный gid не открывается.
 */
export interface AssistantPanelProps {
  /** Выбранные счета — строки цифр; сейчас это один выбранный счёт или пустой список. */
  selection: string[];
  /** Открыть счёт на карте. */
  onSelectNode: (gid: string) => void;
  className?: string;
}

const modules = import.meta.glob<{AssistantPanel?: ComponentType<AssistantPanelProps>}>('../features/assistant/index.tsx', {eager: true});
const Panel = Object.values(modules)[0]?.AssistantPanel;

export function AssistantSlot({focusGid, onSelectGid}: {focusGid: string | null; onSelectGid: (gid: string) => void}) {
  if (!Panel) return null;
  return <section className="wb-section wb-assistant-slot" aria-label="Помощник">
    <Panel selection={focusGid ? [focusGid] : []} onSelectNode={onSelectGid} className="wb-assistant" />
  </section>;
}
