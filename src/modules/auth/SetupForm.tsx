import { useState } from 'react';
import type { FormEvent } from 'react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import KabinaAuthLayout from '@/modules/auth/KabinaAuthLayout';
import { KabinaAuthAlert, KabinaPasswordField, KabinaSubmitButton } from '@/modules/auth/KabinaAuthFields';

const TITLE_ID = 'kb-setup-title';

type SetupFields = { username: string; password: string; confirmPassword: string };

/** Returns the first problem with the form, or null when it can be sent. Limits match the server's register check. */
function validateSetup(fields: SetupFields): string | null {
  if (!fields.username.trim() || !fields.password || !fields.confirmPassword) return 'Заполни логин и пароль дважды';
  if (fields.username.trim().length < 3) return 'Логин — от 3 символов';
  if (fields.password.length < 6) return 'Пароль — от 6 символов';
  if (fields.password !== fields.confirmPassword) return 'Пароли не совпадают';
  return null;
}

/**
 * First-run account setup in the «Кабина» style (the DarkLogin frame with its
 * preflight check). Rendered by the auth module's ProtectedRoute when the server
 * reports that no account exists yet. `autoComplete="new-password"` lets password
 * managers offer to save the new credentials.
 */
export default function SetupForm() {
  const { register } = useAuth();

  const [fields, setFields] = useState<SetupFields>({ username: '', password: '', confirmPassword: '' });
  // Validation or server refusal shown above the fields.
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const update = (field: keyof SetupFields) => (value: string) => setFields((previous) => ({ ...previous, [field]: value }));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = validateSetup(fields);
    if (problem) {
      setErrorMessage(problem);
      return;
    }
    setErrorMessage('');
    setIsSubmitting(true);
    const result = await register(fields.username.trim(), fields.password);
    if (!result.success) setErrorMessage(result.error);
    setIsSubmitting(false);
  };

  return (
    <KabinaAuthLayout
      titleId={TITLE_ID}
      stepCode="ПЕРВЫЙ ЗАПУСК · УСТАНОВКА"
      stepSegments={{ lit: 1 }}
      alarm={Boolean(errorMessage)}
      heroTitle="Системы в норме. Кабина ждёт пилота."
      loginLamp={{ state: 'wait', label: 'не настроен' }}
      attempts={{ used: 0, max: 5, locked: false }}
      prompt={{ text: 'жду логин и пароль для кабины', tone: 'text', cursor: true }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h1 id={TITLE_ID} className="kb-t kb-auth-title">Завести вход</h1>
        <p className="kb-auth-desc">
          Панель ещё пустая. Придумай логин и пароль — других пользователей не будет, а второй фактор включишь потом в Настройках → Аккаунт.
        </p>
      </div>

      {errorMessage && <KabinaAuthAlert title={errorMessage} />}

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }} noValidate>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="username" className="kb-label">ЛОГИН</label>
          <input
            id="username"
            className="kb-field"
            type="text"
            name="username"
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            value={fields.username}
            disabled={isSubmitting}
            onChange={(event) => update('username')(event.target.value)}
          />
        </div>
        <KabinaPasswordField id="password" label="ПАРОЛЬ" value={fields.password} onChange={update('password')} autoComplete="new-password" disabled={isSubmitting} />
        <KabinaPasswordField
          id="confirmPassword"
          label="ПАРОЛЬ ЕЩЁ РАЗ"
          value={fields.confirmPassword}
          onChange={update('confirmPassword')}
          autoComplete="new-password"
          disabled={isSubmitting}
          invalid={Boolean(fields.confirmPassword) && fields.confirmPassword !== fields.password}
        />
        <KabinaSubmitButton label="Создать и войти" busyLabel="Создаю…" busy={isSubmitting} />
      </form>

      <p style={{ margin: 0, paddingTop: 14, borderTop: '1px solid rgba(255,236,210,0.07)', fontSize: 12, lineHeight: 1.5, color: '#948C7E', textWrap: 'pretty' }}>
        Пароль потом меняется в Настройках, а если забудешь — только на самом сервере: <span className="kb-m" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>mirage passwd</span>.
      </p>
    </KabinaAuthLayout>
  );
}
