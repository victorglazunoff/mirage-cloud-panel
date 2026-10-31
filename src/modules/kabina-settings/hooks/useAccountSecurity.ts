import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { AuthSessionView, AuthTrustedDeviceView, AuthTwoFactorStatus } from '@/shared/types';

/**
 * The account half of the settings screen: 2FA status, live sign-ins and
 * remembered devices, re-read after every change. Used by KabinaSettingsScreen
 * (nav summary «3 входа · 2FA вкл») and its Account section.
 */
export function useAccountSecurity() {
  // `GET /api/auth/2fa/status`; null until it arrives (or when the server has no 2FA).
  const [twoFactor, setTwoFactor] = useState<AuthTwoFactorStatus | null>(null);
  const [sessions, setSessions] = useState<AuthSessionView[] | null>(null);
  const [devices, setDevices] = useState<AuthTrustedDeviceView[] | null>(null);

  const refresh = useCallback(async () => {
    const [status, sessionList, deviceList] = await Promise.allSettled([
      api.auth.twoFactorStatus().then((response) => readApiJson<AuthTwoFactorStatus>(response)),
      api.auth.sessions().then((response) => readApiJson<{ sessions: AuthSessionView[] }>(response)),
      api.auth.trustedDevices().then((response) => readApiJson<{ devices: AuthTrustedDeviceView[] }>(response)),
    ]);
    if (status.status === 'fulfilled') setTwoFactor(status.value);
    if (sessionList.status === 'fulfilled') setSessions(sessionList.value.sessions);
    if (deviceList.status === 'fulfilled') setDevices(deviceList.value.devices);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { twoFactor, sessions, devices, refresh };
}
