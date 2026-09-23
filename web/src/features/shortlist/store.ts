/**
 * Сохранённые счета: хранилище и контроллер без React.
 *
 * В localStorage лежит только список строк gid под ключом, привязанным к sha256 входных данных
 * (summary.input_sha256). У другого набора данных свой список, чужие списки не читаются и не
 * перезаписываются. Анализ, суммы и любые ключи доступа в хранилище не попадают.
 *
 * gid — строка из цифр. 18-значные номера больше Number.MAX_SAFE_INTEGER, поэтому число в сохранённом
 * списке означает, что точность уже потеряна: такая запись отбрасывается, а не превращается в строку.
 */

export const SHORTLIST_KEY_PREFIX = 'finance-workbench:shortlist:v1:';

/** То же правило, что у схемы analysis.json: строка из цифр, без знака и экспоненты. */
const GID = /^\d{1,40}$/;

export const isExactGid = (value: unknown): value is string => typeof value === 'string' && GID.test(value);
export const shortlistKey = (scope: string) => SHORTLIST_KEY_PREFIX + scope;

/** Хранилище сводится к двум методам, чтобы тесты и приватный режим браузера подставляли своё. */
export type ShortlistStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Что пошло не так с сохранённым списком. Интерфейс показывает каждое честно и по-русски.
 * - unavailable: браузер не даёт доступа к хранилищу, список живёт до перезагрузки страницы;
 * - write_failed: запись не удалась (переполнение или отозванный доступ), изменения только в памяти;
 * - reset: сохранённое значение не читается, начат новый список;
 * - recovered: часть записей не была точным gid и пропущена;
 * - unknown: сохранённых счетов нет в текущем анализе, они скрыты.
 */
export type ShortlistIssue =
  | {kind: 'unavailable'}
  | {kind: 'write_failed'}
  | {kind: 'reset'}
  | {kind: 'recovered'; dropped: number}
  | {kind: 'unknown'; hidden: number};

export interface ShortlistSnapshot {
  /** input_sha256 набора данных, к которому привязан список. */
  readonly scope: string;
  /** Сохранённые счета из текущего анализа, последние сохранённые — первыми. */
  readonly gids: readonly string[];
  /** Выбранные для отчёта; всегда подмножество gids. */
  readonly selected: ReadonlySet<string>;
  /** false, если список не удаётся записать и он действует только до перезагрузки. */
  readonly persistent: boolean;
  readonly issues: readonly ShortlistIssue[];
  /** Последний убранный счёт и его место — для «Вернуть». */
  readonly lastRemoved: {readonly gid: string; readonly position: number} | null;
}

export type SaveResult = 'saved' | 'already' | 'unknown';

export interface ShortlistActions {
  has(gid: string): boolean;
  /** Сохраняет точный gid текущего анализа; повтор и неизвестный gid список не меняют. */
  save(gid: string): SaveResult;
  remove(gid: string): boolean;
  toggle(gid: string): SaveResult | 'removed';
  undoRemove(): boolean;
  setSelected(gid: string, on: boolean): void;
  selectAll(): void;
  selectNone(): void;
  dismissIssues(): void;
  /** Выбранные для отчёта gid в порядке списка. */
  selectedGids(): string[];
}

export interface ShortlistStore extends ShortlistActions {
  getSnapshot(): ShortlistSnapshot;
  subscribe(listener: () => void): () => void;
  /** Перечитывает хранилище: изменение из другой вкладки или «перезагрузка» в тестах. */
  reload(): void;
}

export interface ShortlistStoreOptions {
  scope: string;
  /** Есть ли счёт в текущем анализе (обычно index.byGid.has). */
  isKnown: (gid: string) => boolean;
  /** null — хранилище недоступно, список живёт в памяти. */
  storage: ShortlistStorage | null;
}

export interface ParsedShortlist {
  gids: string[];
  issues: ShortlistIssue[];
  /** Сохранённое значение нужно переписать очищенным. */
  dirty: boolean;
}

/** Разбирает сохранённое значение. Ничего не «чинит» догадкой: неточные записи отбрасываются и считаются. */
export function parseStoredShortlist(raw: string | null, isKnown: (gid: string) => boolean): ParsedShortlist {
  if (raw === null) return {gids: [], issues: [], dirty: false};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return {gids: [], issues: [{kind: 'reset'}], dirty: true}; }
  const list = typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as {v?: unknown}).v === 1 && Array.isArray((value as {gids?: unknown}).gids)
    ? (value as {gids: unknown[]}).gids : null;
  if (!list) return {gids: [], issues: [{kind: 'reset'}], dirty: true};

  const gids: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let hidden = 0;
  let duplicates = 0;
  for (const item of list) {
    if (!isExactGid(item)) { dropped++; continue; }
    if (seen.has(item)) { duplicates++; continue; }
    seen.add(item);
    if (!isKnown(item)) { hidden++; continue; }
    gids.push(item);
  }
  const issues: ShortlistIssue[] = [];
  if (dropped) issues.push({kind: 'recovered', dropped});
  if (hidden) issues.push({kind: 'unknown', hidden});
  return {gids, issues, dirty: dropped + hidden + duplicates > 0};
}

export function createShortlistStore({scope, isKnown, storage}: ShortlistStoreOptions): ShortlistStore {
  const key = shortlistKey(scope);
  const listeners = new Set<() => void>();

  /** Пишет только {v, gids}. false — запись не удалась. */
  const write = (gids: readonly string[]): boolean => {
    if (!storage) return false;
    try { storage.setItem(key, JSON.stringify({v: 1, gids})); return true; } catch { return false; }
  };

  const read = (previous: ShortlistSnapshot | null): ShortlistSnapshot => {
    const offline = (): ShortlistSnapshot => ({
      scope, gids: previous?.gids ?? [], selected: previous?.selected ?? new Set(), persistent: false,
      issues: [{kind: 'unavailable'}], lastRemoved: previous?.lastRemoved ?? null,
    });
    if (!storage) return offline();
    let raw: string | null;
    try { raw = storage.getItem(key); } catch { return offline(); }
    const parsed = parseStoredShortlist(raw, isKnown);
    const issues = [...parsed.issues];
    let persistent = true;
    if (parsed.dirty && !write(parsed.gids)) { persistent = false; issues.push({kind: 'write_failed'}); }
    // После перечитывания выбор сохраняется; счета, появившиеся из другой вкладки, выбраны сразу.
    const selected = new Set(parsed.gids.filter(gid => !previous || previous.selected.has(gid) || !previous.gids.includes(gid)));
    return {scope, gids: parsed.gids, selected, persistent, issues, lastRemoved: null};
  };

  let snapshot = read(null);

  const emit = (next: ShortlistSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  /** Применяет новый список: пишет его и честно отмечает, если запись не удалась или снова работает. */
  const commit = (gids: readonly string[], selected: ReadonlySet<string>, lastRemoved: ShortlistSnapshot['lastRemoved']) => {
    let {persistent, issues} = snapshot;
    if (storage) {
      if (write(gids)) {
        persistent = true;
        if (issues.some(issue => issue.kind === 'write_failed')) issues = issues.filter(issue => issue.kind !== 'write_failed');
      } else {
        persistent = false;
        if (!issues.some(issue => issue.kind === 'write_failed')) issues = [...issues, {kind: 'write_failed'}];
      }
    }
    emit({...snapshot, gids, selected, persistent, issues, lastRemoved});
  };

  const has = (gid: string) => snapshot.gids.includes(gid);

  const save = (gid: string): SaveResult => {
    if (!isExactGid(gid) || !isKnown(gid)) return 'unknown';
    if (has(gid)) return 'already';
    const selected = new Set(snapshot.selected).add(gid);
    const lastRemoved = snapshot.lastRemoved?.gid === gid ? null : snapshot.lastRemoved;
    commit([gid, ...snapshot.gids], selected, lastRemoved);
    return 'saved';
  };

  const remove = (gid: string): boolean => {
    const position = snapshot.gids.indexOf(gid);
    if (position < 0) return false;
    const selected = new Set(snapshot.selected);
    selected.delete(gid);
    commit(snapshot.gids.filter(item => item !== gid), selected, {gid, position});
    return true;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    reload: () => emit(read(snapshot)),
    has,
    save,
    remove,
    toggle: gid => (has(gid) ? (remove(gid), 'removed') : save(gid)),
    undoRemove() {
      const last = snapshot.lastRemoved;
      if (!last || has(last.gid) || !isKnown(last.gid)) return false;
      const gids = [...snapshot.gids];
      gids.splice(Math.min(last.position, gids.length), 0, last.gid);
      commit(gids, new Set(snapshot.selected).add(last.gid), null);
      return true;
    },
    setSelected(gid, on) {
      if (!has(gid) || snapshot.selected.has(gid) === on) return;
      const selected = new Set(snapshot.selected);
      if (on) selected.add(gid); else selected.delete(gid);
      emit({...snapshot, selected});
    },
    selectAll: () => emit({...snapshot, selected: new Set(snapshot.gids)}),
    selectNone: () => emit({...snapshot, selected: new Set()}),
    dismissIssues: () => { if (snapshot.issues.length) emit({...snapshot, issues: []}); },
    selectedGids: () => snapshot.gids.filter(gid => snapshot.selected.has(gid)),
  };
}
