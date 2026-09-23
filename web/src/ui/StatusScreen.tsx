import type {AnalysisState} from '../app/useAnalysis';
import {ANALYSIS_URL} from '../app/useAnalysis';

/** Загрузка, отсутствующий или неверный файл анализа. Ничего не подставляется вместо данных. */
export function StatusScreen({state}: {state: Exclude<AnalysisState, {status: 'ready'}>}) {
  return <main className="wb-status" aria-live="polite">
    <div className="wb-status__card">
      <p className="wb-eyebrow">Граф денег · рабочее место проверки</p>
      {state.status === 'loading' && <>
        <h1 className="wb-status__title">Загружаем анализ</h1>
        <p className="wb-status__text">Читаем <code>{ANALYSIS_URL}</code> с локального сервера.</p>
        <div className="wb-status__bar" aria-hidden="true"><i /></div>
      </>}
      {state.status === 'missing' && <>
        <h1 className="wb-status__title">Файл анализа не найден</h1>
        <p className="wb-status__text">{state.detail} Просмотрщик показывает только вычисленные факты, поэтому без файла <code>{ANALYSIS_URL}</code> он пуст.</p>
        <p className="wb-status__text">Запустите конвейер из корня проекта:</p>
        <pre className="wb-status__code">./run.sh --data data/</pre>
        <p className="wb-status__hint">Команда пересчитает анализ, запишет <code>out/analysis.json</code> и откроет этот экран.</p>
      </>}
      {state.status === 'invalid' && <>
        <h1 className="wb-status__title">Файл анализа не прошёл проверку</h1>
        <p className="wb-status__text">Интерфейс не показывает данные с неточными или неполными полями. Что именно не так:</p>
        <ul className="wb-status__errors">{state.errors.map(error => <li key={error}>{error}</li>)}</ul>
        <p className="wb-status__hint">Пересоздайте файл командой <code>./run.sh --data data/</code>.</p>
      </>}
    </div>
  </main>;
}
