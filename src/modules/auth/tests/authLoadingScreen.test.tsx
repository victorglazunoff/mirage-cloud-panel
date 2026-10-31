import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';

it('the auth check waits in the Kabina frame and speaks Russian', () => {
  render(<AuthLoadingScreen />);
  const status = screen.getByRole('status');
  expect(status.textContent).toContain('КАБИНА · ПРОВЕРЯЮ ВХОД');
  expect(document.body.textContent).not.toContain('Loading authentication state');
});
