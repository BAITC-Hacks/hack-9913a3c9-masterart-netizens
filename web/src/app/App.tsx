import {useAnalysis} from './useAnalysis';
import {StatusScreen} from '../ui/StatusScreen';
import {Workbench} from './Workbench';

/** Корень: пока файл анализа не готов, показывается честное состояние загрузки или ошибки. */
export function App() {
  const state = useAnalysis();
  if (state.status !== 'ready') return <StatusScreen state={state} />;
  return <Workbench index={state.index} warnings={state.warnings} />;
}
