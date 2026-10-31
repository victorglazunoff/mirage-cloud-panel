import { useEffect, useState } from 'react';

/** The width below which «Файлы» stacks its columns and shows the preview as a bottom sheet. */
export const FILES_PHONE_QUERY = '(max-width: 720px)';

/** Used by FilesScreen: whether the phone layout of «Файлы» is on, following window resizes. */
export function usePhoneLayout(): boolean {
  const [isPhone, setIsPhone] = useState(() => window.matchMedia?.(FILES_PHONE_QUERY).matches ?? false);

  useEffect(() => {
    const query = window.matchMedia?.(FILES_PHONE_QUERY);
    if (!query) return undefined;
    const update = () => setIsPhone(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  return isPhone;
}
