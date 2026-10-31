import { Fragment, useState } from 'react';
import type { FormEvent } from 'react';

import { Toggle, toPanelWall, usePanelTimeZone } from '@/modules/kabina';
import { useAuth } from '@/modules/auth';
import { api, readApiJson } from '@/shared/api';
import type { AuthSessionView, AuthTrustedDeviceView, AuthTwoFactorStatus } from '@/shared/types';
import { SettingsBlock, SettingsTag } from '@/modules/kabina-settings/SettingsParts';
import TwoFactorPanel from '@/modules/kabina-settings/TwoFactorPanel';
import { describeSessionDevice, describeSessionPlace } from '@/modules/kabina-settings/utils/sessionDevice';
import type { SessionDeviceKind } from '@/modules/kabina-settings/utils/sessionDevice';

type AccountSectionProps = {
  twoFactor: AuthTwoFactorStatus | null;
  sessions: AuthSessionView[] | null;
  devices: AuthTrustedDeviceView[] | null;
  refresh: () => Promise<void>;
  /** «Как тебя называть» from the panel settings; null while they load. */
  displayName: string | null;
  onDisplayNameChange: (name: string) => void;
};

const MIN_PASSWORD = 12;
/** Script sign-ins shown before «Ещё N скриптов». */
const SCRIPTS_FOLDED = 2;

/** «1 скрипт», «3 скрипта», «7 скриптов». */
function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** «сейчас», «2 ч назад», «6 дн. назад». */
function ago(iso: string): string {
  const time = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 3) return 'сейчас';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн. назад`;
}

const pad = (value: number) => String(value).padStart(2, '0');
const shortDate = (iso: string) => {
  const date = toPanelWall(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}`;
};

function DeviceIcon({ kind }: { kind: SessionDeviceKind }) {
  const common = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 } as const;
  if (kind === 'phone') return <svg {...common}><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></svg>;
  if (kind === 'tablet') return <svg {...common}><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M11 18h2" /></svg>;
  if (kind === 'script') return <svg {...common} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" /></svg>;
  return <svg {...common}><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></svg>;
}

/**
 * DarkSettings 05 «Аккаунт»: password change (the server re-issues this
 * device's token and ends the others), the TOTP second factor with backup codes,
 * live sign-ins and remembered devices. Rendered by KabinaSettingsScreen.
 */
export default function AccountSection({ twoFactor, sessions, devices, refresh, displayName, onDisplayNameChange }: AccountSectionProps) {
  usePanelTimeZone();
  const { adoptToken, logout, user } = useAuth();
  // The name field is edited locally and saved on blur / Enter, not on every keystroke.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const nameValue = nameDraft ?? displayName ?? '';
  const commitName = () => {
    if (nameDraft === null) return;
    const next = nameDraft.replace(/\s+/g, ' ').trim();
    setNameDraft(null);
    if (next !== (displayName ?? '')) onDisplayNameChange(next);
  };
  const [fields, setFields] = useState({ current: '', next: '', repeat: '' });
  // Result line under «Сменить пароль»: the hint, an error or the success note.
  const [pwNote, setPwNote] = useState<{ tone: 'mute' | 'ok' | 'error'; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  // Which 2FA flow is unfolded under the row.
  const [panel, setPanel] = useState<'enable' | 'disable' | 'codes' | null>(null);
  // Error of a «Выйти» / «Забыть» action.
  const [listError, setListError] = useState<string | null>(null);
  // «Ещё N скриптов» unfolded.
  const [scriptsOpen, setScriptsOpen] = useState(false);

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!fields.current || !fields.next) {
      setPwNote({ tone: 'error', text: 'Введи текущий и новый пароль.' });
      return;
    }
    if (fields.next.length < MIN_PASSWORD) {
      setPwNote({ tone: 'error', text: `Новый пароль — от ${MIN_PASSWORD} символов.` });
      return;
    }
    if (fields.next !== fields.repeat) {
      setPwNote({ tone: 'error', text: 'Новый пароль и повтор не совпадают.' });
      return;
    }
    setPwBusy(true);
    try {
      const result = await readApiJson<{ token: string; revokedSessions: number }>(await api.auth.changePassword(fields.current, fields.next));
      adoptToken(result.token);
      setFields({ current: '', next: '', repeat: '' });
      setPwNote({ tone: 'ok', text: 'Пароль сменён. Другие входы завершены — там нужно войти заново.' });
      await refresh();
    } catch (error) {
      setPwNote({ tone: 'error', text: error instanceof Error ? error.message : 'Не получилось сменить пароль.' });
    } finally {
      setPwBusy(false);
    }
  };

  const act = async (operation: () => Promise<Response>, onToken = false) => {
    setListError(null);
    try {
      const result = await readApiJson<{ token?: string }>(await operation());
      if (onToken && result.token) adoptToken(result.token);
      await refresh();
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Не получилось');
    }
  };

  const tfaOn = Boolean(twoFactor?.enabled);
  const others = (sessions ?? []).filter((session) => !session.current);
  const ordered = [...(sessions ?? [])].sort((a, b) => Number(b.current) - Number(a.current));
  // Sign-ins made by programs (curl, Python…) pile up quickly: they go under their own cap, folded.
  const browsers = ordered.filter((session) => session.current || describeSessionDevice(session.userAgent, session.deviceLabel).kind !== 'script');
  const scripts = ordered.filter((session) => !browsers.includes(session));
  const shownScripts = scriptsOpen ? scripts : scripts.slice(0, SCRIPTS_FOLDED);
  const hiddenScripts = scripts.length - shownScripts.length;

  const renderSession = (session: AuthSessionView) => {
    const device = describeSessionDevice(session.userAgent, session.deviceLabel);
    const place = describeSessionPlace(session.ipAddress);
    const meta = [place, session.current ? 'сейчас' : ago(session.lastSeenAt), `вход ${shortDate(session.createdAt)}`].filter(Boolean) as string[];
    return (
      <div key={session.id} className="kb-set-row kb-set-sess" data-hover="">
        <span aria-hidden="true" className="kb-set-sess-icon" data-current={session.current ? '' : undefined}>
          <DeviceIcon kind={device.kind} />
        </span>
        <div className="kb-set-sess-text">
          <span className="kb-set-sess-name" title={session.userAgent ?? undefined}>
            {device.label}
            {session.current && (
              <span className="kb-m kb-set-here" data-inline="">
                <span className="kb-led kb-led-ok" />
                ЭТО УСТРОЙСТВО
              </span>
            )}
          </span>
          <span className="kb-m kb-set-sess-meta" title={session.ipAddress ?? undefined}>
            {/* Each part keeps its words together; a narrow row breaks only between parts, after the dot. */}
            {meta.map((part, index) => (
              <Fragment key={part}>
                <span style={{ whiteSpace: 'nowrap' }}>{index < meta.length - 1 ? `${part} ·` : part}</span>
                {index < meta.length - 1 ? ' ' : null}
              </Fragment>
            ))}
          </span>
        </div>
        {session.current ? (
          <span className="kb-set-sess-side">
            <span className="kb-m kb-set-here" data-side="">
              <span className="kb-led kb-led-ok" />
              ЭТО УСТРОЙСТВО
            </span>
            <button type="button" className="kb-btn kb-ghost kb-danger" onClick={logout}>Выйти</button>
          </span>
        ) : (
          <button type="button" className="kb-btn kb-ghost kb-danger" onClick={() => void act(() => api.auth.revokeSession(session.id))}>Выйти</button>
        )}
      </div>
    );
  };
  const noteColor = pwNote?.tone === 'ok' ? '#9CC49A' : pwNote?.tone === 'error' ? '#FF8A55' : '#948C7E';

  return (
    <div className="kb-set-group">
      <SettingsBlock id="h-name" index="05.1" title="КАК ТЕБЯ НАЗЫВАТЬ" major delay={1}>
        <div className="kb-bz kb-set-plate" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '10px 16px', padding: 18 }}>
          <label className="kb-m kb-set-fieldlabel" style={{ flex: '0 1 320px' }}>
            ИМЯ В ПРИВЕТСТВИИ
            <input
              className="kb-set-field"
              type="text"
              maxLength={40}
              autoComplete="given-name"
              placeholder="например, Иван"
              value={nameValue}
              disabled={displayName === null}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitName();
                }
              }}
            />
          </label>
          <span style={{ flex: '1 1 260px', fontSize: 13, lineHeight: 1.5, color: '#948C7E', textWrap: 'pretty', paddingBottom: 12 }}>
            {`Главный экран скажет «Добрый день, ${nameValue.trim() || 'Имя'}». Пусто — имя из логина${user?.username ? ` «${user.username}»` : ''}, если оно русское, иначе без имени.`}
          </span>
        </div>
      </SettingsBlock>

      <SettingsBlock id="h-pw" index="05.2" title="ПАРОЛЬ" major delay={2}>
        <form className="kb-bz kb-set-plate" onSubmit={changePassword} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 18 }}>
          {/* Hidden username so password managers attach the new password to the right account. */}
          <input type="text" name="username" autoComplete="username" hidden readOnly />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            <label className="kb-m kb-set-fieldlabel">
              ТЕКУЩИЙ ПАРОЛЬ
              <input className="kb-set-field" type="password" autoComplete="current-password" value={fields.current} onChange={(event) => setFields({ ...fields, current: event.target.value })} disabled={pwBusy} />
            </label>
            <label className="kb-m kb-set-fieldlabel">
              НОВЫЙ ПАРОЛЬ
              <input className="kb-set-field" type="password" autoComplete="new-password" placeholder={`от ${MIN_PASSWORD} символов`} value={fields.next} onChange={(event) => setFields({ ...fields, next: event.target.value })} disabled={pwBusy} aria-invalid={Boolean(fields.next) && fields.next.length < MIN_PASSWORD} />
            </label>
            <label className="kb-m kb-set-fieldlabel">
              ПОВТОРИ НОВЫЙ
              <input className="kb-set-field" type="password" autoComplete="new-password" value={fields.repeat} onChange={(event) => setFields({ ...fields, repeat: event.target.value })} disabled={pwBusy} aria-invalid={Boolean(fields.repeat) && fields.repeat !== fields.next} />
            </label>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px' }}>
            <button type="submit" className="kb-btn kb-pri" disabled={pwBusy} style={{ minHeight: 44, padding: '0 18px', fontSize: 14, borderRadius: 6 }}>
              {pwBusy ? 'Меняю…' : 'Сменить пароль'}
            </button>
            <span role={pwNote?.tone === 'error' ? 'alert' : 'status'} style={{ flex: '1 1 280px', fontSize: 13, lineHeight: 1.5, color: noteColor, textWrap: 'pretty' }}>
              {pwNote?.text ?? 'Пароль — единственное, что нужно подтвердить кнопкой. После смены все другие входы завершатся.'}
            </span>
          </div>
        </form>
      </SettingsBlock>

      <SettingsBlock id="h-2fa" index="05.3" title="ВТОРОЙ ФАКТОР" delay={2}>
        <div className="kb-set-plate" data-clip="">
          <div className="kb-set-row" data-hover="" data-tight="">
            <div className="kb-set-text">
              <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                <span className="kb-set-name">Код из приложения при входе</span>
                {twoFactor && <SettingsTag tone={tfaOn ? 'sage' : 'sand'}>{tfaOn ? 'ВКЛЮЧЁН' : 'РЕКОМЕНДУЕМ'}</SettingsTag>}
              </span>
              <span className="kb-set-desc">Google Authenticator, 1Password и любые TOTP. Спросим только на новом устройстве.</span>
            </div>
            <Toggle
              checked={tfaOn}
              ariaLabel="Второй фактор"
              disabled={!twoFactor}
              onChange={() => setPanel((current) => (current ? null : tfaOn ? 'disable' : 'enable'))}
            />
          </div>
          {tfaOn && (
            <div className="kb-set-row" data-hover="" data-tight="">
              <div className="kb-set-text">
                <span className="kb-set-name">Резервные коды</span>
                <span className="kb-set-desc">
                  Осталось {twoFactor?.backupCodesLeft ?? 0} из 10 — каждый срабатывает один раз, если телефона нет под рукой.
                </span>
              </div>
              <button type="button" className="kb-btn kb-ghost" onClick={() => setPanel('codes')}>Новые коды</button>
            </div>
          )}
          {panel && (
            <TwoFactorPanel
              key={panel}
              mode={panel}
              onClose={() => setPanel(null)}
              onChanged={() => void refresh()}
            />
          )}
        </div>
      </SettingsBlock>

      <SettingsBlock
        id="h-sess"
        index="05.4"
        title={`АКТИВНЫЕ ВХОДЫ · ${sessions?.length ?? '…'}`}
        delay={3}
        aside={others.length > 0 ? (
          <button type="button" className="kb-btn kb-ghost kb-danger" data-size="sm" onClick={() => void act(() => api.auth.revokeOtherSessions(), true)}>
            Выйти везде, кроме этого
          </button>
        ) : undefined}
      >
        {listError && <span role="alert" style={{ fontSize: 13, color: '#FF8A55' }}>{listError}</span>}
        <div className="kb-set-plate" data-clip="">
          {browsers.map(renderSession)}
          {scripts.length > 0 && (
            <div className="kb-set-sessgroup">
              <span className="kb-m">СКРИПТЫ И ПРОГРАММЫ · {scripts.length}</span>
              <span className="kb-set-sessgroup-note">curl, Python, Node — входы по API, не браузеры</span>
            </div>
          )}
          {shownScripts.map(renderSession)}
          {hiddenScripts > 0 && (
            <div className="kb-set-row kb-set-sessmore">
              <button type="button" className="kb-btn kb-ghost" aria-expanded={false} onClick={() => setScriptsOpen(true)}>
                Ещё {hiddenScripts} {plural(hiddenScripts, 'скрипт', 'скрипта', 'скриптов')}
              </button>
            </div>
          )}
          {scriptsOpen && scripts.length > SCRIPTS_FOLDED && (
            <div className="kb-set-row kb-set-sessmore">
              <button type="button" className="kb-btn kb-ghost" aria-expanded onClick={() => setScriptsOpen(false)}>Свернуть скрипты</button>
            </div>
          )}
          {sessions === null && <div className="kb-set-row"><span className="kb-set-hint">Загружаю входы…</span></div>}
        </div>
      </SettingsBlock>

      {(tfaOn || (devices?.length ?? 0) > 0) && (
        <SettingsBlock id="h-trust" index="05.5" title={`ДОВЕРЕННЫЕ УСТРОЙСТВА · ${devices?.length ?? 0}`} delay={4}>
          <span className="kb-set-hint">Здесь код при входе не спрашивают 30 дней. Забыл устройство — там снова спросим код.</span>
          <div className="kb-set-plate" data-clip="">
            {(devices ?? []).map((device) => (
              <div key={device.id} className="kb-set-row" data-hover="" style={{ flexWrap: 'nowrap', gap: 14, minHeight: 56, padding: '8px 18px' }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 14.5, fontWeight: 500 }}>{device.label ?? 'Устройство'}</span>
                  <span className="kb-m" style={{ fontSize: 10.5, color: '#948C7E' }}>
                    до {shortDate(device.expiresAt)}{device.lastUsedAt ? ` · вход ${ago(device.lastUsedAt)}` : ''}
                  </span>
                </div>
                <button type="button" className="kb-btn kb-ghost kb-danger" onClick={() => void act(() => api.auth.removeTrustedDevice(device.id))}>Забыть</button>
              </div>
            ))}
            {devices !== null && devices.length === 0 && (
              <div className="kb-set-row"><span className="kb-set-hint">Пока ни одного — отметь «Запомнить устройство» при входе с кодом.</span></div>
            )}
          </div>
        </SettingsBlock>
      )}
    </div>
  );
}
