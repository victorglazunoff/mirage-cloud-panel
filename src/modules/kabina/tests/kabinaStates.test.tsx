import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { SubscriptionLimits } from '@/shared/types';

const limitsBox: { current: SubscriptionLimits | null } = { current: null };
const sizeBox: { bytes: number | null } = { bytes: null };

vi.mock('@/shared/hooks/useSubscriptionLimits', () => ({
  useSubscriptionLimits: () => limitsBox.current,
}));

vi.mock('@/shared/api', () => ({
  api: {
    contextSize: vi.fn(async (sessionId: string) => new Response(JSON.stringify({ data: { sessionId, bytes: sizeBox.bytes, modifiedAt: null } }))),
  },
  readApiJson: async (response: Response) => response.json(),
}));

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 26, 9, 32);

function limits(patch: Partial<SubscriptionLimits>): SubscriptionLimits {
  return {
    status: 'ok',
    reason: null,
    plan: 'MAX 20×',
    fetchedAt: new Date(NOW).toISOString(),
    session: { percent: 20, resetsAt: new Date(NOW + 3 * HOUR).toISOString() },
    weekly: { percent: 30, resetsAt: new Date(NOW + 4 * 24 * HOUR).toISOString() },
    weeklyByModel: [],
    credits: null,
    ...patch,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  limitsBox.current = null;
  sizeBox.bytes = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('limit rules: quiet when fine, L1 at 80 % and again at 90 %, never for the 5-hour window, L3 for burning credits', async () => {
  const { computeLimitWarnings } = await import('@/modules/kabina/utils/limitWarnings');
  assert.deepEqual(computeLimitWarnings(limits({}), NOW), []);
  assert.deepEqual(computeLimitWarnings(null, NOW), []);
  assert.deepEqual(computeLimitWarnings(limits({ status: 'unavailable', weekly: { percent: 95, resetsAt: null } }), NOW), []);

  const week80 = computeLimitWarnings(limits({ weekly: { percent: 80, resetsAt: new Date(NOW + (2 * 24 + 14) * HOUR).toISOString() } }), NOW);
  assert.equal(week80.length, 1);
  assert.equal(week80[0].code, 'L1');
  assert.equal(week80[0].title, 'Израсходовано 80 % недели');
  assert.match(week80[0].meta, /через 2\u00a0дн 14\u00a0ч$/, 'numbers keep their units on a narrow card');
  assert.match(week80[0].text, /^Прошло 63 % недели — темп выше обычного/);
  const week92 = computeLimitWarnings(limits({ weekly: { percent: 92, resetsAt: new Date(NOW + (2 * 24 + 14) * HOUR).toISOString() } }), NOW);
  assert.notEqual(week92[0].key, week80[0].key, '90 % is a new warning');
  // The usage API drifts the sub-second part of the same reset between reads: still one warning.
  const drift = (resetsAt: string) => computeLimitWarnings(limits({ weekly: { percent: 92, resetsAt } }), NOW)[0].key;
  assert.equal(drift('2026-10-29T00:00:00.027840+00:00'), drift('2026-10-29T00:00:00.591007+00:00'));
  assert.equal(drift('2026-10-29T00:00:00.027840+00:00'), drift('2026-10-28T23:59:58.100000+00:00'));

  // The plan has no 5-hour window any more: a full `session` from the server warns about nothing.
  assert.deepEqual(computeLimitWarnings(limits({ session: { percent: 100, resetsAt: new Date(NOW + 72 * 60_000).toISOString() } }), NOW), []);
  const weekFull = computeLimitWarnings(limits({ weekly: { percent: 100, resetsAt: new Date(NOW + 72 * 60_000).toISOString() } }), NOW);
  assert.equal(weekFull[0].code, 'L1');
  assert.equal(weekFull[0].tone, 'stop');
  assert.match(weekFull[0].meta, /через 1\u00a0ч 12\u00a0мин$/);

  const burning = { percent: 19, resetsAt: new Date(NOW + 46 * HOUR).toISOString(), limitDollars: 250, remainingDollars: 202 };
  const credits = computeLimitWarnings(limits({ credits: burning }), NOW);
  assert.equal(credits[0].code, 'L3');
  assert.equal(credits[0].title, '$202 сгорят через 2 дня');
  assert.equal(credits[0].value, '$48');
  assert.deepEqual(computeLimitWarnings(limits({ credits: { ...burning, resetsAt: new Date(NOW + 60 * HOUR).toISOString() } }), NOW), [], 'more than 48 h left');
  assert.deepEqual(computeLimitWarnings(limits({ credits: { ...burning, remainingDollars: 30 } }), NOW), [], 'almost all spent');
});

test('line diff numbers deletions by the old file and the rest by the new one; tool input maps to the diff', async () => {
  const { computeLineDiff, permissionDiffFromToolInput } = await import('@/modules/kabina/utils/permissionDiff');
  const rows = computeLineDiff({
    filePath: 'a.ts',
    oldText: "function f() {\n  return 0;\n}\n",
    newText: "function f() {\n  if (!x) return 1;\n  return 0;\n}\n",
    startLine: 12,
  });
  assert.deepEqual(rows.map((row) => `${row.number}${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}`), ['12 ', '13+', '14 ', '15 ']);

  const replaced = computeLineDiff({ filePath: 'a.ts', oldText: 'a\nb\nc', newText: 'a\nB\nc' });
  assert.deepEqual(replaced.map((row) => [row.kind, row.number]), [['context', 1], ['del', 2], ['add', 2], ['context', 3]]);

  assert.deepEqual(permissionDiffFromToolInput('Write', { file_path: '/p/x.md', content: 'hi' }), { filePath: '/p/x.md', oldText: '', newText: 'hi' });
  assert.equal(permissionDiffFromToolInput('Edit', { file_path: '/p/x.md', old_string: 'a', new_string: 'b' })?.newText, 'b');
  assert.equal(permissionDiffFromToolInput('MultiEdit', { file_path: '/p/x.md', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })?.oldText, 'a\nc');
  assert.equal(permissionDiffFromToolInput('Bash', { command: 'ls' }), null);
});

test('permission card: diff with counts and numbers, folding past 12 lines, answers turn into a result line', async () => {
  const { PermissionRequestCard } = await import('@/modules/kabina/ui/PermissionRequestCard');
  const onAllowOnce = vi.fn();
  const onDeny = vi.fn();
  const longNew = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
  const { container, rerender } = render(
    <PermissionRequestCard
      toolName="Write"
      reason="Новый файл"
      waitingSince={Date.now() - 40_000}
      diff={{ filePath: 'src/new.ts', oldText: '', newText: longNew }}
      onAllowOnce={onAllowOnce}
      onAllowSession={() => undefined}
      onDeny={onDeny}
    />,
  );
  assert.ok(screen.getByRole('region', { name: 'Запрос разрешения: правка файла' }));
  assert.ok(screen.getByText('НУЖНО ТВОЁ РЕШЕНИЕ'));
  assert.ok(screen.getByText('ждёт 40 с'));
  assert.ok(screen.getByText('+20'));
  assert.ok(screen.getByText('−0'));
  assert.equal(container.querySelectorAll('.kb-perm-line').length, 12, 'folded to 12 lines');
  fireEvent.click(screen.getByRole('button', { name: 'ещё 8 строк' }));
  assert.equal(container.querySelectorAll('.kb-perm-line').length, 20);

  fireEvent.click(screen.getByRole('button', { name: 'Разрешить один раз' }));
  assert.equal(onAllowOnce.mock.calls.length, 1);
  assert.match(screen.getByRole('status').textContent ?? '', /^Разрешено один раз · \d+:\d\d · шаг продолжается$/);

  rerender(
    <PermissionRequestCard toolName="Bash" command="bash deploy.sh --prod" onAllowOnce={onAllowOnce} onDeny={onDeny} decision={null} hotkeys />,
  );
  assert.ok(screen.getByText('bash deploy.sh --prod'));
  assert.equal(screen.queryByRole('button', { name: 'В этой сессии' }), null, 'no session button without a handler');
  fireEvent.keyDown(window, { key: '3' });
  assert.equal(onDeny.mock.calls.length, 1, 'digit 3 denies');
});

test('empty state: mock-up texts per variant and exactly one next step', async () => {
  const { EmptyState } = await import('@/modules/kabina/ui/EmptyState');
  const onAction = vi.fn();
  const { rerender } = render(<EmptyState variant="projects" onAction={onAction} />);
  assert.ok(screen.getByRole('heading', { name: 'Проектов пока нет' }));
  assert.ok(screen.getByText('например ~/projects/demo-site'));
  fireEvent.click(screen.getByRole('button', { name: 'Добавить проект' }));
  assert.equal(onAction.mock.calls.length, 1);

  rerender(<EmptyState variant="agents" text="Последний закончил в 13:58." />);
  assert.ok(screen.getByRole('heading', { name: 'Все агенты отдыхают' }));
  assert.ok(screen.getByText('Последний закончил в 13:58.'));
  assert.equal(screen.queryByRole('button'), null, 'no handler, no button');
});

test('limit plaques hide by key and remember it; a throwing storage only stops remembering', async () => {
  const { LimitWarnings } = await import('@/modules/kabina/ui/LimitWarningCard');
  const full = limits({ weekly: { percent: 100, resetsAt: new Date(NOW + HOUR).toISOString() } });
  const { unmount } = render(<LimitWarnings limits={full} now={new Date(NOW)} />);
  assert.ok(screen.getByText('Недельный лимит исчерпан'));
  fireEvent.click(screen.getByRole('button', { name: 'Понятно' }));
  assert.equal(screen.queryByText('Недельный лимит исчерпан'), null);
  unmount();
  render(<LimitWarnings limits={full} now={new Date(NOW)} />);
  assert.equal(screen.queryByText('Недельный лимит исчерпан'), null, 'still hidden after a remount');

  window.localStorage.clear();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  const second = render(<LimitWarnings limits={full} now={new Date(NOW)} />);
  assert.ok(second.getByText('Недельный лимит исчерпан'));
  fireEvent.click(second.getByRole('button', { name: 'Понятно' }));
  assert.equal(second.queryByText('Недельный лимит исчерпан'), null);
});

test('limits warnings are toasted once per key across the Kabina screens', async () => {
  const { KabinaToastProvider, useKabinaToasts } = await import('@/modules/kabina/context/KabinaToastContext');
  const { useLimitWarningToasts } = await import('@/modules/kabina/hooks/useLimitWarningToasts');
  limitsBox.current = limits({ weekly: { percent: 81, resetsAt: new Date(Date.now() + 2 * 24 * HOUR).toISOString() } });
  const seen: string[][] = [];
  function Probe() {
    useLimitWarningToasts();
    const { items } = useKabinaToasts();
    seen.push(items.map((item) => `${item.kind}:${item.title}`));
    return null;
  }
  const wrapper = (
    <MemoryRouter>
      <KabinaToastProvider><Probe /></KabinaToastProvider>
    </MemoryRouter>
  );
  const first = render(wrapper);
  assert.deepEqual(seen[seen.length - 1], ['warn:Израсходовано 81 % недели']);
  first.unmount();
  seen.length = 0;
  // The centre keeps its list across reloads; the point is that no second entry is raised.
  window.localStorage.removeItem('kabina.notifications.v1');
  render(wrapper);
  assert.deepEqual(seen[seen.length - 1], [], 'the same warning is not toasted twice');
});

test('big session: scale cells and threshold, outcomes; the hook shows it over 250 МБ until «Остаться»', async () => {
  const { BigSessionNotice } = await import('@/modules/kabina/ui/BigSessionNotice');
  const onStay = vi.fn();
  const { container, rerender } = render(
    <BigSessionNotice sizeBytes={340 * MB} sessionTitle="Выкладка цен" loadSeconds={9} onNewWithSummary={() => undefined} onStay={onStay} />,
  );
  assert.ok(screen.getByText('340'));
  assert.ok(screen.getByText('МБ · лента грузится 9 с'));
  assert.equal(container.querySelectorAll('[data-state="over"]').length, 5, '260–340 МБ past the threshold');
  assert.equal(container.querySelectorAll('[data-state="under"]').length, 12);
  fireEvent.click(screen.getByRole('button', { name: 'Остаться здесь' }));
  assert.equal(onStay.mock.calls.length, 1);
  rerender(<BigSessionNotice sizeBytes={340 * MB} outcome="stay" onNewWithSummary={() => undefined} onStay={onStay} />);
  assert.ok(screen.getByText('остаёмся · напомню на 400 МБ'));

  const { useBigSessionNotice } = await import('@/modules/kabina/hooks/useBigSessionNotice');
  sizeBox.bytes = 300 * MB;
  const hook = renderHook(() => useBigSessionNotice('s-1'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(hook.result.current.visible, true);
  act(() => hook.result.current.stay());
  assert.equal(hook.result.current.visible, false);
  assert.equal(hook.result.current.stayed, true);
  assert.equal(window.localStorage.getItem('kb-big-session-stay:s-1'), String(400 * MB));
});

test('Claude error card counts down to the retry and folds the raw response', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const { ClaudeErrorCard } = await import('@/modules/kabina/ui/ClaudeErrorCard');
  const onRetryNow = vi.fn();
  render(<ClaudeErrorCard kind={529} savedStep={14} retryAt={NOW + 20_000} attempt={2} maxAttempts={3} onRetryNow={onRetryNow} details="raw log" />);
  assert.ok(screen.getByText('API 529 · перегружен'));
  assert.ok(screen.getByText('20 с'));
  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  assert.ok(screen.getByText('15 с'));
  fireEvent.click(screen.getByRole('button', { name: 'Подробности' }));
  assert.ok(screen.getByText('raw log'));
  fireEvent.click(screen.getByRole('button', { name: 'Повторить сейчас' }));
  assert.equal(onRetryNow.mock.calls.length, 1);
});

test('the /states address opens the showcase', async () => {
  const { matchKabinaRoute } = await import('@/modules/kabina/utils/kabinaRoutes');
  assert.deepEqual(matchKabinaRoute('/states'), { screen: 'states' });
});

test('permission card: a request time that came over JSON still reads as «ждёт N с»', async () => {
  const { PermissionRequestCard } = await import('@/modules/kabina/ui/PermissionRequestCard');
  render(
    <PermissionRequestCard
      toolName="Bash"
      command="./wait.sh"
      waitingSince={new Date(Date.now() - 30_000).toISOString()}
      onAllowOnce={() => undefined}
      onDeny={() => undefined}
    />,
  );
  assert.ok(screen.getByText('ждёт 30 с'));
  assert.equal(screen.queryByText(/NaN/), null);
});
