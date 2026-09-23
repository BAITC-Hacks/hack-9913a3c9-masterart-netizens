import {describe, expect, it} from 'vitest';
import {
  IMPORT_URL, ImportError, MAX_FILE_BYTES, MAX_TOTAL_BYTES, REQUIRED_FILES,
  parseImportResponse, selectFiles, toBase64, uploadDataset,
} from './api';

const SHA = 'a'.repeat(64);
const DATASET = {
  input_sha256: SHA, n_nodes: 2248, n_edges: 3119, n_transactions: 4840, n_seed: 81, n_clusters: 92,
  period_start: '2026-07-01', period_end: '2026-07-31', pipeline_seconds: 0.85, imported_at_utc: '2026-09-23T11:03:15+00:00',
};

const picked = (name: string, size = 10) => ({name, size});
const three = () => REQUIRED_FILES.map((name) => picked(name));

describe('IMPORT-SELECT выбор трёх файлов', () => {
  it('[IMPORT-SELECT] принимает ровно nodes, edges и transactions', () => {
    const result = selectFiles(three());
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.files).sort()).toEqual([...REQUIRED_FILES].sort());
  });

  it('[IMPORT-SELECT] отклоняет чужое имя, повтор и нехватку', () => {
    const result = selectFiles([picked('nodes.parquet'), picked('nodes.parquet'), picked('../edges.parquet')]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('«../edges.parquet» не поддерживается');
      expect(result.errors.join('\n')).toContain('nodes.parquet выбран дважды');
      expect(result.errors.join('\n')).toContain('Не хватает файлов: edges.parquet, transactions.parquet');
      expect(result.found['nodes.parquet']).toBeDefined();
    }
  });

  it('[IMPORT-SELECT] отклоняет пустой, слишком большой файл и превышение общего предела', () => {
    const empty = selectFiles([picked('nodes.parquet', 0), picked('edges.parquet'), picked('transactions.parquet')]);
    expect(!empty.ok && empty.errors).toEqual(['Файл nodes.parquet пуст.']);
    const big = selectFiles([picked('nodes.parquet', MAX_FILE_BYTES + 1), picked('edges.parquet'), picked('transactions.parquet')]);
    expect(!big.ok && big.errors[0]).toContain('больше 4 МиБ');
    const total = selectFiles(REQUIRED_FILES.map((name) => picked(name, Math.floor(MAX_TOTAL_BYTES / 3) + 1)));
    expect(!total.ok && total.errors).toEqual(['Три файла вместе больше 8 МиБ.']);
  });
});

describe('IMPORT-UPLOAD отправка и разбор ответа', () => {
  it('[IMPORT-UPLOAD] base64 совпадает с эталонным кодированием, включая большие файлы', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('[IMPORT-UPLOAD] отправляет три файла JSON-запросом и возвращает сведения о наборе', async () => {
    const files = Object.fromEntries(REQUIRED_FILES.map((name, i) => [name, new Blob([new Uint8Array([80, 65, 82, 49, i])])])) as Record<(typeof REQUIRED_FILES)[number], Blob>;
    let sent: {url: string; init: RequestInit} | null = null;
    const dataset = await uploadDataset(files, async (url, init) => {
      sent = {url, init};
      return new Response(JSON.stringify({ok: true, dataset: {...DATASET, files: {}, outputs: []}}), {status: 200});
    });
    expect(dataset.n_nodes).toBe(2248);
    expect(dataset.input_sha256).toBe(SHA);
    expect(sent!.url).toBe(IMPORT_URL);
    expect(sent!.init.method).toBe('POST');
    const body = JSON.parse(String(sent!.init.body));
    expect(Object.keys(body.files)).toEqual([...REQUIRED_FILES]);
    expect(Buffer.from(body.files['edges.parquet'], 'base64')).toEqual(Buffer.from([80, 65, 82, 49, 1]));
  });

  it('[IMPORT-UPLOAD] показывает русское сообщение сервера и отклоняет неизвестный формат', () => {
    expect(() => parseImportResponse(422, {ok: false, error: 'Ошибка входных данных: нет столбцов. Прежние результаты не изменены.'}))
      .toThrow('Прежние результаты не изменены');
    expect(() => parseImportResponse(404, null)).toThrow('./run.sh');
    expect(() => parseImportResponse(500, null)).toThrow(ImportError);
    expect(() => parseImportResponse(200, {ok: true, dataset: {...DATASET, n_nodes: '2248'}})).toThrow('неизвестном формате');
    expect(() => parseImportResponse(200, {ok: true, dataset: {...DATASET, input_sha256: 'x'}})).toThrow('неизвестном формате');
  });

  it('[IMPORT-UPLOAD] недоступный сервер даёт понятную ошибку', async () => {
    const files = Object.fromEntries(REQUIRED_FILES.map((name) => [name, new Blob(['x'])])) as Record<(typeof REQUIRED_FILES)[number], Blob>;
    await expect(uploadDataset(files, async () => { throw new TypeError('network'); })).rejects.toThrow('Локальный сервер не ответил');
  });
});

describe('IMPORT-CSV файлы CSV той же схемы', () => {
  it('[IMPORT-CSV] nodes.csv, edges.csv и transactions.csv занимают слоты таблиц, форматы можно смешивать', () => {
    const result = selectFiles([picked('nodes.csv'), picked('edges.parquet'), picked('transactions.csv')]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files['nodes.parquet'].name).toBe('nodes.csv');
      expect(result.files['transactions.parquet'].name).toBe('transactions.csv');
    }
  });

  it('[IMPORT-CSV] два формата одной таблицы и чужое расширение отклоняются', () => {
    const result = selectFiles([picked('nodes.csv'), picked('nodes.parquet'), picked('edges.xlsx'), picked('transactions.csv')]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('Для nodes выбрано два файла: nodes.csv и nodes.parquet');
      expect(result.errors.join('\n')).toContain('«edges.xlsx» не поддерживается');
    }
  });

  it('[IMPORT-CSV] запрос передаёт серверу настоящее имя файла, чтобы он прочитал CSV', async () => {
    let sent = '';
    const files = {
      'nodes.parquet': new File(['gid,depth,is_seed\n1,0,True\n'], 'nodes.csv'),
      'edges.parquet': new File(['x'], 'edges.parquet'),
      'transactions.parquet': new File(['src,dst,date,sum_kzt\n'], 'transactions.csv'),
    };
    await uploadDataset(files, async (_url, init) => {
      sent = String(init.body);
      return new Response(JSON.stringify({ok: true, dataset: DATASET}), {status: 200});
    });
    expect(Object.keys(JSON.parse(sent).files).sort()).toEqual(['edges.parquet', 'nodes.csv', 'transactions.csv']);
  });
});
