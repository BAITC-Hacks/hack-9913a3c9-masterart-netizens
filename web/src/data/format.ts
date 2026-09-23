import type {Mode, Role} from './schema';

/** Русские подписи ролей и режимов, форматирование сумм, дат и идентификаторов. Один источник для экрана и справки. */
export const ROLE_LABEL: Record<string, string> = {
  consolidator: 'Консолидатор',
  transit: 'Транзит',
  distributor: 'Распределитель',
  terminal: 'Конечный получатель',
  coordinator: 'Координатор',
  peripheral: 'Периферия',
};
export const ROLE_HINT: Record<string, string> = {
  consolidator: 'собирает переводы от нескольких участников',
  transit: 'передаёт дальше примерно то, что получил',
  distributor: 'раздаёт средства многим получателям',
  terminal: 'деньги приходят и дальше не наблюдаются',
  coordinator: 'кандидат в связующий узел между группами',
  peripheral: 'признаков роли не найдено',
};
export const roleLabel = (role: Role) => ROLE_LABEL[role] ?? role;

export const MODE_LABEL: Record<Mode, string> = {
  structural: 'Структура',
  strict: 'Позже по датам',
  same_day: 'Тот же день возможен',
};
export const MODE_HINT: Record<Mode, string> = {
  structural: 'путь по наблюдаемым переводам без учёта дат',
  strict: 'каждый следующий перевод строго позже предыдущего',
  same_day: 'переводы одного дня допускаются: порядок внутри дня неизвестен',
};
export const REACH_CAVEAT = 'Достижимость показывает, что путь возможен по наблюдаемым переводам. Она не доказывает, что двигались те же деньги.';

const kztFormat = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2, minimumFractionDigits: 0});
const intFormat = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 0});
const scoreFormat = new Intl.NumberFormat('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 2});

export const formatKzt = (value: number) => `${kztFormat.format(value)} ₸`;
export const formatInt = (value: number) => intFormat.format(value);
export const formatScore = (value: number) => scoreFormat.format(value);

/** Группы по три цифры слева направо — только для глаз; копируется всегда исходная строка. */
export function gidGroups(gid: string): string[] {
  const groups: string[] = [];
  for (let i = 0; i < gid.length; i += 3) groups.push(gid.slice(i, i + 3));
  return groups;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
/** «2026-07-05» → «5 июля»; год добавляется по запросу. Строка разбирается без Date, чтобы не зависеть от часового пояса. */
export function formatDate(date: string, withYear = false): string {
  const [year, month, day] = date.split('-').map(part => Number.parseInt(part, 10));
  if (!year || !month || !day || month > 12) return date;
  return `${day} ${MONTHS[month - 1]}${withYear ? ` ${year}` : ''}`;
}

/** Склонение: 1 перевод, 2 перевода, 5 переводов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
export const countLabel = (n: number, one: string, few: string, many: string) => `${formatInt(n)} ${plural(n, one, few, many)}`;
