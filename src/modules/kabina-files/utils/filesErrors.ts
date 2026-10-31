import { ApiRequestError } from '@/shared/api';

/*
 * The authors' file-tree API answers in English («Folder already exists», «Permission denied»).
 * Its machine codes are stable, so «Файлы» says the same in Russian instead of patching the
 * server messages (every such edit would conflict with upstream updates).
 */
const TEXT_BY_CODE: Record<string, string> = {
  PATH_OUTSIDE_PROJECT: 'путь выходит за папку проекта',
  INVALID_WORKSPACE_PATH: 'путь вне рабочей папки панели',
  PROJECT_NOT_FOUND: 'проект не найден',
  PROJECT_PATH_NOT_FOUND: 'папки проекта нет на сервере',
  NOT_A_DIRECTORY: 'это файл, а не папка',
  DIRECTORY_NOT_ACCESSIBLE: 'папка недоступна',
  PARENT_DIRECTORY_NOT_FOUND: 'нет папки, в которой это создаётся',
  FOLDER_ALREADY_EXISTS: 'такая папка уже есть',
  EEXIST: 'такая папка уже есть',
  FILE_TREE_ENTRY_EXISTS: 'здесь уже есть файл или папка с таким именем',
  FILE_NOT_FOUND: 'файл не найден — возможно, его уже убрали',
  FILE_TREE_ENTRY_NOT_FOUND: 'файл или папка не найдены — возможно, их уже убрали',
  ENOENT: 'файл или папка не найдены — возможно, их уже убрали',
  PROJECT_ROOT_DELETE_FORBIDDEN: 'корневую папку проекта удалить нельзя',
  UPLOAD_FILES_REQUIRED: 'не выбрано ни одного файла',
  EACCES: 'нет прав на эту папку',
  EISDIR: 'это папка, а не файл',
  EXDEV: 'между разными дисками так не перенести',
  ENOTEMPTY: 'папка не пустая',
};

/* The file-tree routes answer `{ error: message }` without the code, so the texts are matched too. */
const TEXT_BY_MESSAGE: Record<string, string> = {
  'Filename cannot be empty': 'имя не может быть пустым',
  'Filename contains invalid characters': 'в имени есть недопустимые символы',
  'Filename is a reserved name': 'это имя занято системой',
  'Filename cannot be only dots': 'имя не может состоять из одних точек',
  'Path must be under project root': TEXT_BY_CODE.PATH_OUTSIDE_PROJECT,
  'Path is outside the workspace root': TEXT_BY_CODE.INVALID_WORKSPACE_PATH,
  'Project not found': TEXT_BY_CODE.PROJECT_NOT_FOUND,
  'Path is not a directory': TEXT_BY_CODE.NOT_A_DIRECTORY,
  'Directory not accessible': TEXT_BY_CODE.DIRECTORY_NOT_ACCESSIBLE,
  'Parent directory does not exist': TEXT_BY_CODE.PARENT_DIRECTORY_NOT_FOUND,
  'Parent directory not found': TEXT_BY_CODE.PARENT_DIRECTORY_NOT_FOUND,
  'Folder already exists': TEXT_BY_CODE.FOLDER_ALREADY_EXISTS,
  'Directory already exists': TEXT_BY_CODE.FOLDER_ALREADY_EXISTS,
  'File already exists': 'такой файл уже есть',
  'A file or directory with this name already exists': TEXT_BY_CODE.FILE_TREE_ENTRY_EXISTS,
  'File not found': TEXT_BY_CODE.FILE_NOT_FOUND,
  'File or directory not found': TEXT_BY_CODE.FILE_TREE_ENTRY_NOT_FOUND,
  'Permission denied': TEXT_BY_CODE.EACCES,
  'Path is a directory, not a file': TEXT_BY_CODE.EISDIR,
  'Cannot move across different filesystems': TEXT_BY_CODE.EXDEV,
  'Directory is not empty': TEXT_BY_CODE.ENOTEMPTY,
  'Cannot delete project root directory': TEXT_BY_CODE.PROJECT_ROOT_DELETE_FORBIDDEN,
  'No files provided': TEXT_BY_CODE.UPLOAD_FILES_REQUIRED,
  'Name and type are required': 'нужно имя',
  'oldPath and newName are required': 'нужно новое имя',
};

const HAS_CYRILLIC = /[а-яё]/i;

/**
 * Used by «Файлы» (the screen, its folder pages and the preview): the reason of a failed file
 * request in Russian — the server's message when it is Russian already, else by its code or
 * known text, else `fallback` (an English server text is never shown as is).
 */
export function filesErrorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  // Our own routes (and the path validator) already explain in Russian, more precisely than a code.
  if (HAS_CYRILLIC.test(error.message)) return error.message;
  if (error instanceof ApiRequestError && error.code && TEXT_BY_CODE[error.code]) return TEXT_BY_CODE[error.code];
  if (TEXT_BY_MESSAGE[error.message]) return TEXT_BY_MESSAGE[error.message];
  return error.message.startsWith('Project path not found') ? TEXT_BY_CODE.PROJECT_PATH_NOT_FOUND : fallback;
}

/** Used by the folder pages and the preview, where the reason stands alone: the same text as a sentence. */
export function filesErrorSentence(error: unknown, fallback: string): string {
  const text = filesErrorText(error, fallback);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
