import {AssistantError} from './api';
import type {AssistantNavigation, AssistantResponse} from './types';

/** Вызывается только после нового запроса, никогда при чтении сохранённого разговора. */
export function dispatchNavigation(
  response: AssistantResponse,
  fingerprint: string | undefined,
  onSelectNode: (gid: string) => void,
  onNavigate?: (navigation: AssistantNavigation) => void,
): boolean {
  const navigation = response.navigation;
  if (!navigation) return false;
  if (!fingerprint || response.dataset_fingerprint !== fingerprint) {
    throw new AssistantError('Данные изменились. Переход отменён; откройте разговор для текущего набора.');
  }
  if (onNavigate) {
    onNavigate(navigation);
    return true;
  }
  if (navigation.view === 'account' && navigation.gid) {
    onSelectNode(navigation.gid);
    return true;
  }
  return false;
}
