/**
 * Импорт нового набора данных: ровно три parquet-файла по схеме кейса.
 * Пределы совпадают с серверными (imports/ingest.py); сервер всё равно проверяет всё заново.
 */
export const REQUIRED_FILES = ['nodes.parquet', 'edges.parquet', 'transactions.parquet'] as const;
export type RequiredFile = (typeof REQUIRED_FILES)[number];

export const IMPORT_URL = '/api/import';
export const MIB = 1024 * 1024;
export const MAX_FILE_BYTES = 4 * MIB;
export const MAX_TOTAL_BYTES = 8 * MIB;
export const REQUEST_TIMEOUT_MS = 120_000;

/** Столбцы, которые читает загрузчик; остальные столбцы файла игнорируются. */
export const FILE_COLUMNS: Record<RequiredFile, string> = {
  'nodes.parquet': 'gid, depth, is_seed',
  'edges.parquet': 'src, dst, sum_kzt, n_tx, depth',
  'transactions.parquet': 'src, dst, date, sum_kzt',
};

export class ImportError extends Error {
  constructor(message: string) { super(message); this.name = 'ImportError'; }
}

export interface PickedFile { name: string; size: number }

export type Selection<T extends PickedFile> =
  | {ok: true; files: Record<RequiredFile, T>}
  | {ok: false; errors: string[]; found: Partial<Record<RequiredFile, T>>};

function isRequired(name: string): name is RequiredFile {
  return (REQUIRED_FILES as readonly string[]).includes(name);
}

function shown(name: string): string {
  return name.length > 60 ? `${name.slice(0, 60)}…` : name;
}

/** Сопоставляет выбранные файлы с тремя обязательными именами; ошибки — на русском, для показа как есть. */
export function selectFiles<T extends PickedFile>(picked: readonly T[]): Selection<T> {
  const errors: string[] = [];
  const found: Partial<Record<RequiredFile, T>> = {};
  let total = 0;
  for (const file of picked) {
    if (!isRequired(file.name)) {
      errors.push(`Файл «${shown(file.name)}» не поддерживается: нужны ровно ${REQUIRED_FILES.join(', ')}.`);
      continue;
    }
    if (found[file.name]) {
      errors.push(`Файл ${file.name} выбран дважды.`);
      continue;
    }
    if (file.size === 0) errors.push(`Файл ${file.name} пуст.`);
    else if (file.size > MAX_FILE_BYTES) errors.push(`Файл ${file.name} больше ${MAX_FILE_BYTES / MIB} МиБ.`);
    found[file.name] = file;
    total += file.size;
  }
  const missing = REQUIRED_FILES.filter((name) => !found[name]);
  if (missing.length) errors.push(`Не хватает файлов: ${missing.join(', ')}.`);
  if (total > MAX_TOTAL_BYTES) errors.push(`Три файла вместе больше ${MAX_TOTAL_BYTES / MIB} МиБ.`);
  if (errors.length || missing.length) return {ok: false, errors, found};
  return {ok: true, files: found as Record<RequiredFile, T>};
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Кусками, чтобы не превысить предел числа аргументов функции.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export interface ImportedDataset {
  /** Контрольная сумма содержимого — та же, что печатает командная строка. */
  input_sha256: string;
  n_nodes: number;
  n_edges: number;
  n_transactions: number;
  n_seed: number;
  n_clusters: number;
  period_start: string | null;
  period_end: string | null;
  pipeline_seconds: number;
  imported_at_utc: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const COUNTS = ['n_nodes', 'n_edges', 'n_transactions', 'n_seed', 'n_clusters'] as const;

/** Ответ сервера → сведения о новом наборе; сообщение об ошибке сервера показывается как есть. */
export function parseImportResponse(status: number, raw: unknown): ImportedDataset {
  if (status !== 200) {
    const message = object(raw) && typeof raw.error === 'string' && raw.error ? raw.error : null;
    if (message) throw new ImportError(message);
    if (status === 404 || status === 405) throw new ImportError('Сервер не поддерживает импорт: запустите приложение через ./run.sh.');
    throw new ImportError(`Сервер отклонил импорт (код ${status}).`);
  }
  const dataset = object(raw) && raw.ok === true && object(raw.dataset) ? raw.dataset : null;
  const valid = dataset
    && typeof dataset.input_sha256 === 'string' && /^[0-9a-f]{64}$/.test(dataset.input_sha256)
    && COUNTS.every((key) => Number.isSafeInteger(dataset[key]) && (dataset[key] as number) >= 0)
    && [dataset.period_start, dataset.period_end].every((d) => d === null || (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))
    && typeof dataset.pipeline_seconds === 'number' && typeof dataset.imported_at_utc === 'string';
  if (!valid) throw new ImportError('Сервер вернул ответ в неизвестном формате.');
  return {
    input_sha256: dataset.input_sha256 as string,
    n_nodes: dataset.n_nodes as number,
    n_edges: dataset.n_edges as number,
    n_transactions: dataset.n_transactions as number,
    n_seed: dataset.n_seed as number,
    n_clusters: dataset.n_clusters as number,
    period_start: dataset.period_start as string | null,
    period_end: dataset.period_end as string | null,
    pipeline_seconds: dataset.pipeline_seconds as number,
    imported_at_utc: dataset.imported_at_utc as string,
  };
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Читает три файла, отправляет их JSON-запросом с base64 и возвращает сведения о новом наборе. */
export async function uploadDataset(
  files: Record<RequiredFile, Blob>,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ImportedDataset> {
  const encoded: Record<string, string> = {};
  for (const name of REQUIRED_FILES) encoded[name] = toBase64(new Uint8Array(await files[name].arrayBuffer()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(IMPORT_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({files: encoded}),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch {
    throw new ImportError(controller.signal.aborted
      ? 'Сервер не ответил вовремя. Прежние результаты не изменены, если импорт не завершился.'
      : 'Локальный сервер не ответил.');
  } finally {
    clearTimeout(timer);
  }
  let raw: unknown = null;
  try {
    raw = await response.json();
  } catch {
    raw = null;
  }
  return parseImportResponse(response.status, raw);
}
