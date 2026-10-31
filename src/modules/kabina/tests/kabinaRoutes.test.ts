import assert from 'node:assert/strict';

import { test } from 'vitest';

import { kabinaChatPath, matchKabinaRoute } from '@/modules/kabina/utils/kabinaRoutes';

test('every address of ПЛАН-КАБИНА decodes to its screen', () => {
  assert.deepEqual(matchKabinaRoute('/'), { screen: 'home' });
  assert.deepEqual(matchKabinaRoute('/projects'), { screen: 'projects' });
  assert.deepEqual(matchKabinaRoute('/agents/'), { screen: 'agents' });
  assert.deepEqual(matchKabinaRoute('/calendar'), { screen: 'calendar' });
  assert.deepEqual(matchKabinaRoute('/files', '?project=p-1'), { screen: 'files', projectId: 'p-1' });
  assert.deepEqual(matchKabinaRoute('/files'), { screen: 'files', projectId: null });
  assert.deepEqual(matchKabinaRoute('/settings'), { screen: 'settings', section: null });
  assert.deepEqual(matchKabinaRoute('/settings/voice'), { screen: 'settings', section: 'voice' });
});

test('chat addresses carry project and session, the legacy /session/:id too', () => {
  assert.deepEqual(matchKabinaRoute('/p/abc'), { screen: 'chat', projectId: 'abc', sessionId: null });
  assert.deepEqual(matchKabinaRoute('/p/abc/s/s-1'), { screen: 'chat', projectId: 'abc', sessionId: 's-1' });
  assert.deepEqual(matchKabinaRoute('/session/s-9'), { screen: 'chat', projectId: null, sessionId: 's-9' });
  assert.deepEqual(matchKabinaRoute('/p/%D0%BC%D0%B8%D1%80%D0%B0%D0%B6'), { screen: 'chat', projectId: 'мираж', sessionId: null });
});

test('anything else is unknown (the app sends it home)', () => {
  assert.deepEqual(matchKabinaRoute('/nope'), { screen: 'unknown' });
  assert.deepEqual(matchKabinaRoute('/p'), { screen: 'unknown' });
});

test('chat paths are encoded and round-trip', () => {
  assert.equal(kabinaChatPath('p 1'), '/p/p%201');
  assert.equal(kabinaChatPath('p', 's/1'), '/p/p/s/s%2F1');
  assert.deepEqual(matchKabinaRoute(kabinaChatPath('p 1', 's 2')), { screen: 'chat', projectId: 'p 1', sessionId: 's 2' });
});
