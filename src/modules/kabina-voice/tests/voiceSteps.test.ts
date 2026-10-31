import assert from 'node:assert/strict';

import { test } from 'vitest';

import { dialStateOf } from '@/modules/kabina-voice/VoiceDial';
import { desktopVoiceSteps, phoneVoiceSteps } from '@/modules/kabina-voice/utils/voiceSteps';

const brief = (tabs: Array<{ id: string; state: string; disabled: boolean }>) =>
  tabs.map((tab) => `${tab.id}:${tab.state}${tab.disabled ? ':off' : ''}`);

test('desktop: while listening with nothing parsed, 02 and 03 are both ahead and locked (no jump to 03)', () => {
  const tabs = desktopVoiceSteps({ view: 'listen', hasIntent: false, done: false, executing: false });
  assert.deepEqual(brief(tabs), ['listen:current', 'parsed:ahead:off', 'dest:ahead:off']);
});

test('desktop: on «Понял» the recording step is passed and «Куда отправить» is the reachable next step', () => {
  const tabs = desktopVoiceSteps({ view: 'parsed', hasIntent: true, done: false, executing: false });
  assert.deepEqual(brief(tabs), ['listen:passed', 'parsed:current', 'dest:ahead']);
  assert.deepEqual(tabs.map((tab) => tab.n), ['01', '02', '03']);
});

test('desktop: on «Куда отправить» both earlier steps are passed', () => {
  const tabs = desktopVoiceSteps({ view: 'dest', hasIntent: true, done: false, executing: false });
  assert.deepEqual(brief(tabs), ['listen:passed', 'parsed:passed', 'dest:current']);
});

test('desktop: «КОМУ» opened during the recording shows 03 current but 02 stays unreached', () => {
  const tabs = desktopVoiceSteps({ view: 'dest', hasIntent: false, done: false, executing: false });
  assert.deepEqual(brief(tabs), ['listen:passed', 'parsed:ahead:off', 'dest:current']);
});

test('desktop: re-recording after a parse keeps «Понял» reachable', () => {
  const tabs = desktopVoiceSteps({ view: 'listen', hasIntent: true, done: false, executing: false });
  assert.deepEqual(brief(tabs), ['listen:current', 'parsed:ahead', 'dest:ahead']);
});

test('desktop: while running and after «Сделано» the addressee can no longer change', () => {
  assert.deepEqual(
    brief(desktopVoiceSteps({ view: 'parsed', hasIntent: true, done: false, executing: true })),
    ['listen:passed:off', 'parsed:current', 'dest:ahead:off'],
  );
  assert.deepEqual(
    brief(desktopVoiceSteps({ view: 'parsed', hasIntent: true, done: true, executing: false })),
    ['listen:passed', 'parsed:current', 'dest:ahead:off'],
  );
});

test('phone: the current step is not a tap target, unreached steps are locked', () => {
  assert.deepEqual(brief(phoneVoiceSteps({ step: 'listen', hasIntent: false, executing: false })), ['listen:current:off', 'got:ahead:off', 'done:ahead:off']);
  assert.deepEqual(brief(phoneVoiceSteps({ step: 'got', hasIntent: true, executing: false })), ['listen:passed', 'got:current:off', 'done:ahead:off']);
});

test('phone: after «Готово» both earlier steps read as passed, only «Слушаю» starts over', () => {
  assert.deepEqual(brief(phoneVoiceSteps({ step: 'done', hasIntent: true, executing: false })), ['listen:passed', 'got:passed:off', 'done:current:off']);
});

test('the dial says «НЕ ВЫШЛО» on a failure, never a calm «ЖДУ»', () => {
  assert.equal(dialStateOf('error', false), 'error');
  assert.equal(dialStateOf('error', true), 'error');
  assert.equal(dialStateOf('listening', false), 'live');
  assert.equal(dialStateOf('parsing', false), 'busy');
  assert.equal(dialStateOf('ready', true), 'ready');
  assert.equal(dialStateOf('ready', false), 'idle');
});
