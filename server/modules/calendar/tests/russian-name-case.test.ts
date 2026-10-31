import assert from 'node:assert/strict';
import test from 'node:test';

import { toNominativeFullName, toNominativeName } from '../services/russian-name-case.service.js';

test('oblique cases of first names go back to the nominative', () => {
  const cases: Array<[string, string]> = [
    ['Ивану', 'Иван'], ['Андрею', 'Андрей'], ['Марии', 'Мария'], ['Ольге', 'Ольга'], ['Петру', 'Пётр'],
    ['Сергею', 'Сергей'], ['Наталье', 'Наталья'], ['Ирине', 'Ирина'], ['Никите', 'Никита'], ['Ивана', 'Иван'],
    ['Иваном', 'Иван'], ['Марией', 'Мария'], ['Ольгой', 'Ольга'], ['Андреем', 'Андрей'], ['Натальей', 'Наталья'],
    ['Льву', 'Лев'], ['Павлу', 'Павел'], ['Игорю', 'Игорь'], ['Никиту', 'Никита'], ['Ольгу', 'Ольга'],
  ];
  for (const [input, expected] of cases) assert.equal(toNominativeName(input), expected, input);
});

test('nominative names, non-names and unsupported words stay as they are', () => {
  for (const word of ['Иван', 'Мария', 'Ольга', 'Андрей', 'Никита', 'Лев', 'Claude', 'клиенту', 'Сайт клиента', 'Сбербанк']) {
    assert.equal(toNominativeName(word), word);
  }
  assert.equal(toNominativeName('Петр'), 'Пётр');
});

test('unknown capitalised names follow the suffix rules', () => {
  assert.equal(toNominativeName('Ашоту'), 'Ашот');
  assert.equal(toNominativeName('Марине'), 'Марина');
});

test('surnames follow the gender of the first name', () => {
  assert.equal(toNominativeFullName('Ивану Петрову'), 'Иван Петров');
  assert.equal(toNominativeFullName('Иваном Петровым'), 'Иван Петров');
  assert.equal(toNominativeFullName('Ольге Петровой'), 'Ольга Петрова');
  assert.equal(toNominativeFullName('Ольгу Петрову'), 'Ольга Петрова');
  assert.equal(toNominativeFullName('Иван Толстой'), 'Иван Толстой');
});
