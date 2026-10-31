import type {
  CliFileSystem,
  CliOutput,
  PasswordResetCommandRequest,
  PasswordResetCommandService,
} from '@/shared/types.js';
import { terminalTextStyles } from '@/shared/utils.js';

import { CLI_COMMAND } from '../../../shared/brand.js';

// Same rules as the password change in the settings screen (auth-security.service):
// at least 12 characters, at most 72 bytes (bcrypt ignores everything after that).
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 72;

type PasswordResetUser = { id: number; username: string };

/** Database side of the reset, opened only after the database file is known to exist. */
type PasswordResetStore = {
  listActiveUsers(): PasswordResetUser[];
  /**
   * Stores the new hash, voids every issued token and sign-in, and clears the
   * failed-login lock of this username — in one transaction.
   */
  resetPassword(user: PasswordResetUser, passwordHash: string, nowMs: number): { revokedSessions: number };
  close(): void;
};

type PasswordResetDependencies = {
  fileSystem: CliFileSystem;
  output: CliOutput;
  /** True when stdin is a terminal, so the password can be asked with hidden input. */
  isInteractive: boolean;
  readHiddenLine(prompt: string): Promise<string>;
  readStdin(): Promise<string>;
  hashPassword(password: string): Promise<string>;
  openStore(databasePath: string): Promise<PasswordResetStore>;
  now(): number;
};

function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Пароль слишком короткий: нужно не меньше ${MIN_PASSWORD_LENGTH} символов.`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `Пароль слишком длинный: не больше ${MAX_PASSWORD_BYTES} байт (≈36 русских или 72 латинских символа).`;
  }
  return null;
}

/**
 * Creates the `mirage passwd` command: sets a new password for the panel owner
 * straight in the database, for when the password is forgotten. Used only by the
 * CLI composition root; the database, bcrypt and terminal input are injected so
 * the tests never touch a real database or terminal.
 */
export function createPasswordResetService(dependencies: PasswordResetDependencies): PasswordResetCommandService {
  const { output } = dependencies;
  const fail = (message: string): number => {
    output.error(`${terminalTextStyles.error('[ERROR]')} ${message}`);
    return 1;
  };

  const readNewPassword = async (passwordFromStdin: boolean): Promise<string | { error: string }> => {
    if (passwordFromStdin) {
      // Only the first line counts, so `echo "…" | mirage passwd --password-stdin` works.
      const [firstLine = ''] = (await dependencies.readStdin()).split(/\r?\n/);
      return firstLine;
    }
    if (!dependencies.isInteractive) {
      return { error: `Нет терминала для ввода пароля. Запустите в терминале или передайте пароль: ${CLI_COMMAND} passwd --password-stdin` };
    }
    const password = await dependencies.readHiddenLine('Новый пароль: ');
    const invalid = validatePassword(password);
    if (invalid) {
      return { error: invalid };
    }
    const repeated = await dependencies.readHiddenLine('Ещё раз: ');
    if (repeated !== password) {
      return { error: 'Пароли не совпали — ничего не изменено.' };
    }
    return password;
  };

  return {
    async execute(request: PasswordResetCommandRequest): Promise<number> {
      if (!dependencies.fileSystem.pathExists(request.databasePath)) {
        return fail(
          `База панели не найдена: ${request.databasePath}\n`
          + '        Панель ещё не запускалась или данные лежат в другом месте — '
          + `укажите DATABASE_PATH или ${CLI_COMMAND} passwd --database-path <файл>.`,
        );
      }

      const store = await dependencies.openStore(request.databasePath);
      try {
        const users = store.listActiveUsers();
        if (users.length === 0) {
          return fail('В панели ещё нет владельца. Откройте панель в браузере и зарегистрируйтесь.');
        }

        let user: PasswordResetUser | undefined;
        if (request.username) {
          user = users.find((candidate) => candidate.username === request.username);
          if (!user) {
            return fail(`Пользователя «${request.username}» нет. Есть: ${users.map((candidate) => candidate.username).join(', ')}.`);
          }
        } else if (users.length === 1) {
          [user] = users;
        } else {
          return fail(
            `В панели несколько пользователей: ${users.map((candidate) => candidate.username).join(', ')}. `
            + `Укажите, кому менять пароль: ${CLI_COMMAND} passwd <имя>.`,
          );
        }

        output.log(`Пароль для «${user.username}» (база ${request.databasePath}).`);
        const passwordOrError = await readNewPassword(request.passwordFromStdin);
        if (typeof passwordOrError !== 'string') {
          return fail(passwordOrError.error);
        }
        const invalid = validatePassword(passwordOrError);
        if (invalid) {
          return fail(invalid);
        }

        const passwordHash = await dependencies.hashPassword(passwordOrError);
        const { revokedSessions } = store.resetPassword(user, passwordHash, dependencies.now());
        output.log(`${terminalTextStyles.ok('[OK]')} Пароль изменён. Все входы завершены (${revokedSessions}), блокировка после неудачных попыток снята.`);
        output.log('     Двухфакторная защита, если была включена, осталась: войти можно кодом из приложения или резервным кодом.');
        return 0;
      } finally {
        store.close();
      }
    },
  };
}
