/**
 * Brings a Russian person name from an oblique case ("Ивану", "с Ольгой", "Марии")
 * back to the nominative ("Иван", "Ольга", "Мария"). Pure string rules: a dictionary of
 * common first names with generated case forms, plus conservative suffix rules for unknown
 * capitalised words. When unsure the word is returned unchanged rather than distorted.
 */

const VOWELS = 'аеёиоуыэюя';

/** Case form -> nominative; keys are lowercase with «ё» folded to «е». */
const FORMS = new Map<string, string>();

function fold(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е');
}

function addForms(nominative: string, forms: string[]): void {
  FORMS.set(fold(nominative), nominative);
  for (const form of forms) FORMS.set(fold(form), nominative);
}

// Masculine, consonant-final: Иван -> Ивана, Ивану, Иваном, Иване.
for (const name of ['Иван', 'Максим', 'Михаил', 'Александр', 'Денис', 'Егор', 'Виктор', 'Владимир', 'Олег', 'Борис',
  'Антон', 'Роман', 'Кирилл', 'Вадим', 'Руслан', 'Тимур', 'Глеб', 'Марк', 'Станислав', 'Константин', 'Ярослав',
  'Вячеслав', 'Леонид', 'Артём', 'Фёдор', 'Семён']) {
  addForms(name, ['а', 'у', 'ом', 'е'].map((end) => name + end));
}
// Masculine ending in «й»: Андрей -> Андрея, Андрею, Андреем, Андрее.
for (const name of ['Андрей', 'Сергей', 'Дмитрий', 'Алексей', 'Николай', 'Юрий', 'Евгений', 'Василий', 'Григорий',
  'Анатолий', 'Валерий', 'Геннадий', 'Аркадий', 'Арсений', 'Виталий', 'Георгий']) {
  const stem = name.slice(0, -1);
  addForms(name, ['я', 'ю', 'ем', name.endsWith('ий') ? 'и' : 'е'].map((end) => stem + end));
}
// Masculine ending in «ь».
addForms('Игорь', ['Игоря', 'Игорю', 'Игорем', 'Игоре']);
// Irregular stems («Петр» without «ё» is normalised too).
addForms('Пётр', ['Петра', 'Петру', 'Петром', 'Петре', 'Петр']);
addForms('Лев', ['Льва', 'Льву', 'Львом', 'Льве']);
addForms('Павел', ['Павла', 'Павлу', 'Павлом', 'Павле']);
// Masculine ending in «а»: Никита -> Никиты, Никите, Никиту, Никитой.
for (const name of ['Никита', 'Данила', 'Лука', 'Кузьма', 'Фома', 'Савва']) {
  const stem = name.slice(0, -1);
  addForms(name, [`${stem}ы`, `${stem}и`, `${stem}е`, `${stem}у`, `${stem}ой`]);
}
addForms('Илья', ['Ильи', 'Илье', 'Илью', 'Ильёй', 'Ильей']);
// Feminine ending in «а»: Ольга -> Ольги, Ольге, Ольгу, Ольгой.
for (const name of ['Ольга', 'Ирина', 'Анна', 'Елена', 'Светлана', 'Татьяна', 'Екатерина', 'Оксана', 'Галина',
  'Людмила', 'Надежда', 'Вера', 'Марина', 'Алина', 'Диана', 'Полина', 'Алла', 'Лариса', 'Инна', 'Тамара',
  'Валентина', 'Нина', 'Маша', 'Даша', 'Злата']) {
  const stem = name.slice(0, -1);
  addForms(name, [`${stem}ы`, `${stem}и`, `${stem}е`, `${stem}у`, `${stem}ой`]);
}
// Feminine ending in «я» (Юля) and «ия» (Мария).
for (const name of ['Юля', 'Таня', 'Катя', 'Настя', 'Оля', 'Соня', 'Аня', 'Надя', 'Валя', 'Галя']) {
  const stem = name.slice(0, -1);
  addForms(name, [`${stem}и`, `${stem}е`, `${stem}ю`, `${stem}ей`]);
}
for (const name of ['Мария', 'Юлия', 'Анастасия', 'Ксения', 'Виктория', 'Лидия', 'София']) {
  const stem = name.slice(0, -1);
  addForms(name, [`${stem}и`, `${stem}ю`, `${stem}ей`]);
}
// Feminine ending in «ья».
for (const name of ['Наталья', 'Дарья']) {
  const stem = name.slice(0, -1);
  addForms(name, [`${stem}и`, `${stem}е`, `${stem}ю`, `${stem}ей`]);
}
addForms('Любовь', ['Любови', 'Любовью']);

const MALE_A_NAMES = new Set(['никита', 'данила', 'лука', 'кузьма', 'фома', 'савва', 'илья']);

function isConsonant(char: string | undefined): boolean {
  return !!char && /[а-яё]/.test(char) && !VOWELS.includes(char) && char !== 'й';
}

/** Suffix rules for an unknown capitalised word; the word is returned unchanged when no rule fits. */
function applySuffixRules(word: string): string {
  const lower = word.toLowerCase();
  const swap = (cut: number, add: string): string => word.slice(0, word.length - cut) + add;
  const before = (cut: number): string | undefined => lower[lower.length - cut - 1];
  if (lower.length < 4) return word;
  if (lower.endsWith('ией')) return swap(3, 'ия');
  if (lower.endsWith('ии')) return swap(2, 'ия');
  if (lower.endsWith('ьей')) return swap(3, 'ья');
  if (lower.endsWith('ье')) return swap(2, 'ья');
  if (lower.endsWith('еем')) return swap(3, 'ей');
  if (lower.endsWith('аем')) return swap(3, 'ай');
  if (lower.endsWith('ием')) return swap(3, 'ий');
  if (lower.endsWith('ем') && isConsonant(before(2))) return swap(2, 'ь');
  if (lower.endsWith('ом') && isConsonant(before(2))) return swap(2, '');
  if (lower.endsWith('ой') && isConsonant(before(2))) return swap(2, 'а');
  if (lower.endsWith('ею')) return swap(2, 'ей');
  if (lower.endsWith('аю')) return swap(2, 'ай');
  if (lower.endsWith('ю') && isConsonant(before(1))) return swap(1, 'ь');
  if (lower.endsWith('у') && isConsonant(before(1))) return swap(1, '');
  if (lower.endsWith('е') && isConsonant(before(1))) return swap(1, 'а');
  if (/[гкх]и$/.test(lower) && isConsonant(before(2))) return swap(1, 'а');
  if (lower.endsWith('ы') && isConsonant(before(1))) return swap(1, 'а');
  return word;
}

/**
 * Nominative form of one first name. Only capitalised Cyrillic words are changed; lowercase
 * words ("клиенту"), Latin words and words with digits are returned as they are.
 */
export function toNominativeName(word: string): string {
  if (!/^[А-ЯЁ][а-яё]*$/.test(word)) return word;
  return FORMS.get(fold(word)) ?? applySuffixRules(word);
}

function isFeminineName(nominative: string): boolean {
  const lower = nominative.toLowerCase();
  return (/[ая]$/.test(lower) && !MALE_A_NAMES.has(lower)) || lower === 'любовь';
}

/** Surname in an oblique case to the nominative, following the gender of the first name. */
function surnameToNominative(word: string, feminine: boolean): string {
  if (!/^[А-ЯЁ][а-яё]+$/.test(word)) return word;
  const lower = word.toLowerCase();
  const swap = (cut: number, add: string): string => word.slice(0, word.length - cut) + add;
  if (feminine) {
    if (/(ов|ев|ёв|ин|ын)ой$/.test(lower)) return swap(2, 'а');
    if (/(ов|ев|ёв|ин|ын)у$/.test(lower)) return swap(1, 'а');
    if (/ск(ой|ую)$/.test(lower)) return swap(2, 'ая');
    return word;
  }
  if (/(ов|ев|ёв|ин|ын)ым$/.test(lower)) return swap(2, '');
  if (/(ов|ев|ёв|ин|ын)[ау]$/.test(lower)) return swap(1, '');
  if (/ск(ого|ому|им)$/.test(lower)) return word.replace(/ск(ого|ому|им)$/i, 'ский');
  return word;
}

/**
 * Nominative form of a name of one or two words ("Ивану Петрову" -> "Иван Петров",
 * "Ольгой" -> "Ольга"). The first word is the first name, the second is read as a surname.
 */
export function toNominativeFullName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length > 2) return name;
  const first = parts[0].split('-').map(toNominativeName).join('-');
  if (parts.length === 1) return first;
  return `${first} ${surnameToNominative(parts[1], isFeminineName(first))}`;
}
