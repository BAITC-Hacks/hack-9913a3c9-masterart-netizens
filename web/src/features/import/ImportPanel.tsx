import {useId, useState, type ChangeEvent} from 'react';
import {
  FILE_COLUMNS, ImportError, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MIB, REQUIRED_FILES,
  selectFiles, uploadDataset, type ImportedDataset, type Selection,
} from './api';
import './import.css';

export interface ImportPanelProps {
  /** Вызывается сразу после успешного импорта со сведениями о новом наборе. */
  onImported?: (dataset: ImportedDataset) => void;
  /** Открыть новый анализ. По умолчанию страница перезагружается и читает новый out/analysis.json. */
  onReload?: () => void;
  className?: string;
}

type State =
  | {status: 'idle'}
  | {status: 'uploading'}
  | {status: 'done'; dataset: ImportedDataset}
  | {status: 'error'; errors: string[]};

const number = (value: number) => value.toLocaleString('ru-RU');

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} Б` : bytes < MIB ? `${Math.ceil(bytes / 1024)} КБ` : `${(bytes / MIB).toFixed(1)} МБ`;
}

/** Загрузка нового набора данных по схеме кейса: три файла parquet или CSV → проверка → новый анализ. */
export function ImportPanel({onImported, onReload, className}: ImportPanelProps) {
  const inputId = useId();
  const [selection, setSelection] = useState<Selection<File> | null>(null);
  const [state, setState] = useState<State>({status: 'idle'});
  const busy = state.status === 'uploading';

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    setSelection(picked.length ? selectFiles(picked) : null);
    setState({status: 'idle'});
  }

  async function submit() {
    if (!selection?.ok || busy) return;
    setState({status: 'uploading'});
    try {
      const dataset = await uploadDataset(selection.files);
      setState({status: 'done', dataset});
      onImported?.(dataset);
    } catch (error) {
      setState({status: 'error', errors: [error instanceof ImportError ? error.message : 'Импорт не выполнен.']});
    }
  }

  const found = selection ? (selection.ok ? selection.files : selection.found) : {};
  const errors = state.status === 'error' ? state.errors : selection && !selection.ok ? selection.errors : [];

  return <section className={['fi-panel', className].filter(Boolean).join(' ')} aria-label="Импорт данных">
    <h2 className="fi-title">Новые данные</h2>
    <p className="fi-note">
      Три файла той же схемы, что и данные кейса, — в формате parquet или CSV с именами столбцов в
      первой строке. Идентификаторы — целые числа int64, суммы в тенге, даты в формате ГГГГ-ММ-ДД.
      До {MAX_FILE_BYTES / MIB} МиБ на файл и {MAX_TOTAL_BYTES / MIB} МиБ всего. После проверки сервер
      заново строит роли, кластеры, приоритеты и три выгрузки.
    </p>
    <ul className="fi-files">
      {REQUIRED_FILES.map((name) => {
        const file = found[name];
        return <li key={name} className={file ? 'is-chosen' : undefined}>
          <span className="fi-name">{file ? file.name : name.replace('.parquet', '.parquet / .csv')}</span>
          <span className="fi-columns">{FILE_COLUMNS[name]}</span>
          <span className="fi-state">{file ? sizeText(file.size) : 'не выбран'}</span>
        </li>;
      })}
    </ul>
    <div className="fi-actions">
      <label className="wb-button fi-choose" htmlFor={inputId}>Выбрать три файла</label>
      <input id={inputId} className="fi-input" type="file" accept=".parquet,.csv" multiple disabled={busy} onChange={choose} />
      <button type="button" className="wb-button wb-button--primary" disabled={!selection?.ok || busy} onClick={submit}>
        Проверить и проанализировать
      </button>
    </div>
    <div aria-live="polite">
      {busy && <p className="fi-progress">Проверяем файлы и строим анализ…</p>}
      {state.status === 'done' && <div className="fi-done">
        <p>
          Готово: {number(state.dataset.n_nodes)} счетов, {number(state.dataset.n_edges)} рёбер,{' '}
          {number(state.dataset.n_transactions)} транзакций
          {state.dataset.period_start && state.dataset.period_end
            ? `, период ${state.dataset.period_start} — ${state.dataset.period_end}` : ''}.
          Отпечаток содержимого <code>{state.dataset.input_sha256.slice(0, 12)}</code>.
        </p>
        <button type="button" className="wb-button wb-button--primary" onClick={onReload ?? (() => window.location.reload())}>
          Открыть новый анализ
        </button>
      </div>}
    </div>
    {errors.length > 0 && <ul className="fi-errors" role="alert">
      {errors.map((error) => <li key={error}>{error}</li>)}
    </ul>}
  </section>;
}
