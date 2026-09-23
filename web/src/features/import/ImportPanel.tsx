import {useId, useState, type ChangeEvent} from 'react';
import {
  FILE_COLUMNS, ImportError, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MIB, REQUIRED_FILES,
  selectFiles, slotOf, uploadDataset, type ImportedDataset, type PickedFile, type RequiredFile, type Selection,
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

/** Выбранный файл каждой строки: nodes, edges, transactions. */
export type Rows<T extends PickedFile> = Partial<Record<RequiredFile, T>>;

const MISSING = 'Не хватает файлов';
const number = (value: number) => value.toLocaleString('ru-RU');
const tableOf = (row: RequiredFile) => row.replace('.parquet', '');

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} Б` : bytes < MIB ? `${Math.ceil(bytes / 1024)} КБ` : `${(bytes / MIB).toFixed(1)} МБ`;
}

function shown(name: string): string {
  return name.length > 60 ? `${name.slice(0, 60)}…` : name;
}

/** Файл для одной строки: подходит только та же таблица, nodes.parquet или nodes.csv. Другие строки не меняются. */
export function placeInRow<T extends PickedFile>(rows: Rows<T>, row: RequiredFile, file: T): {rows: Rows<T>; error: string | null} {
  if (slotOf(file.name) !== row) {
    const table = tableOf(row);
    return {rows, error: `Строка ${table}: нужен файл ${table}.parquet или ${table}.csv, а выбран «${shown(file.name)}».`};
  }
  return {rows: {...rows, [row]: file}, error: null};
}

/** Несколько файлов сразу: каждый встаёт в строку своей таблицы, невыбранные строки сохраняются. */
export function placeMany<T extends PickedFile>(rows: Rows<T>, files: readonly T[]): {rows: Rows<T>; errors: string[]} {
  const picked = selectFiles(files);
  const found = picked.ok ? picked.files : picked.found;
  // Нехватка файлов считается по всем строкам вместе, поэтому здесь её не повторяем.
  const errors = picked.ok ? [] : picked.errors.filter((error) => !error.startsWith(MISSING));
  return {rows: {...rows, ...found}, errors};
}

/** Все выбранные строки проверяются теми же правилами, что и раньше: имена, размеры, нехватка файлов. */
export function readiness<T extends PickedFile>(rows: Rows<T>): Selection<T> {
  return selectFiles(REQUIRED_FILES.flatMap((row) => {
    const file = rows[row];
    return file ? [file] : [];
  }));
}

/** Загрузка нового набора данных по схеме кейса: три файла parquet или CSV → проверка → новый анализ. */
export function ImportPanel({onImported, onReload, className}: ImportPanelProps) {
  const inputId = useId();
  const [rows, setRows] = useState<Rows<File>>({});
  const [pickErrors, setPickErrors] = useState<string[]>([]);
  const [state, setState] = useState<State>({status: 'idle'});
  const busy = state.status === 'uploading';
  const ready = readiness(rows);
  const anyChosen = REQUIRED_FILES.some((row) => rows[row]);

  function chooseRow(row: RequiredFile, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Сброс позволяет выбрать тот же файл повторно после его правки.
    event.target.value = '';
    if (!file) return;
    const placed = placeInRow(rows, row, file);
    setRows(placed.rows);
    setPickErrors(placed.error ? [placed.error] : []);
    setState({status: 'idle'});
  }

  function chooseMany(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    const placed = placeMany(rows, files);
    setRows(placed.rows);
    setPickErrors(placed.errors);
    setState({status: 'idle'});
  }

  async function submit() {
    if (!ready.ok || busy) return;
    setState({status: 'uploading'});
    try {
      const dataset = await uploadDataset(ready.files);
      setState({status: 'done', dataset});
      onImported?.(dataset);
    } catch (error) {
      setState({status: 'error', errors: [error instanceof ImportError ? error.message : 'Импорт не выполнен.']});
    }
  }

  const errors = state.status === 'error'
    ? state.errors
    : [...new Set([...pickErrors, ...(anyChosen && !ready.ok ? ready.errors : [])])];

  return <section className={['fi-panel', className].filter(Boolean).join(' ')} aria-label="Импорт данных">
    <h2 className="fi-title">Новые данные</h2>
    <p className="fi-note">
      Три файла той же схемы, что и данные кейса, — в формате parquet или CSV с именами столбцов в
      первой строке. Идентификаторы — целые числа int64, суммы в тенге, даты в формате ГГГГ-ММ-ДД.
      До {MAX_FILE_BYTES / MIB} МиБ на файл и {MAX_TOTAL_BYTES / MIB} МиБ всего. После проверки сервер
      заново строит роли, кластеры, приоритеты и три выгрузки.
    </p>
    <ul className="fi-files">
      {REQUIRED_FILES.map((row) => {
        const file = rows[row];
        const table = tableOf(row);
        const rowId = `${inputId}-${table}`;
        const action = file ? 'Заменить' : 'Загрузить';
        return <li key={row} className={file ? 'is-chosen' : undefined}>
          <span className="fi-name">{file ? file.name : row.replace('.parquet', '.parquet / .csv')}</span>
          <span className="fi-columns">{FILE_COLUMNS[row]}</span>
          <span className="fi-state">{file ? sizeText(file.size) : 'не выбран'}</span>
          <label className="wb-button fi-choose fi-row-button" htmlFor={rowId}>{action}</label>
          <input id={rowId} className="fi-input" type="file" accept=".parquet,.csv" disabled={busy}
            aria-label={`${action} файл ${table}`} onChange={(event) => chooseRow(row, event)} />
        </li>;
      })}
    </ul>
    <div className="fi-actions">
      <label className="wb-button fi-choose" htmlFor={inputId}>Выбрать три файла</label>
      <input id={inputId} className="fi-input" type="file" accept=".parquet,.csv" multiple disabled={busy} onChange={chooseMany} />
      <button type="button" className="wb-button wb-button--primary" disabled={!ready.ok || busy} onClick={submit}>
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
