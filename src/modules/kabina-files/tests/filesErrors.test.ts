import assert from 'node:assert/strict';

import { test } from 'vitest';

import { filesErrorSentence, filesErrorText } from '@/modules/kabina-files/utils/filesErrors';
import { ApiRequestError } from '@/shared/api';

test('English file-tree errors are said in Russian by code or text; Russian ones pass as is', () => {
  const exists = new ApiRequestError('A file or directory with this name already exists', { code: 'FILE_TREE_ENTRY_EXISTS', status: 409 });
  assert.equal(filesErrorText(exists, 'сервер не ответил'), 'здесь уже есть файл или папка с таким именем');
  assert.equal(filesErrorText(new ApiRequestError('Filename contains invalid characters', { code: 'INVALID_FILENAME', status: 400 }), '—'), 'в имени есть недопустимые символы');
  assert.equal(filesErrorText(new Error('Это файл, а не папка'), '—'), 'Это файл, а не папка');
  assert.equal(filesErrorText(new Error('Something odd happened'), 'ошибка на сервере'), 'ошибка на сервере');
  // The routes drop the code: `{ error: 'Directory already exists' }`.
  assert.equal(filesErrorText(new ApiRequestError('Directory already exists', { status: 409 }), '—'), 'такая папка уже есть');
  assert.equal(filesErrorSentence(new ApiRequestError('Permission denied', { code: 'EACCES', status: 403 }), '—'), 'Нет прав на эту папку');
});
