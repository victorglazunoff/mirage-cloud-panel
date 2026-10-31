import assert from 'node:assert/strict';

import { test } from 'vitest';

import { describeSessionDevice, describeSessionPlace } from '@/modules/kabina-settings/utils/sessionDevice';

test('a sign-in reads as «система · браузер» with the right icon', () => {
  assert.deepEqual(
    describeSessionDevice('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', 'x'),
    { label: 'Linux · Chrome', kind: 'laptop' },
  );
  assert.deepEqual(
    describeSessionDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'x'),
    { label: 'iPhone · Safari', kind: 'phone' },
  );
  assert.deepEqual(describeSessionDevice('Python-urllib/3.12', 'x'), { label: 'Скрипт · Python', kind: 'script' });
  assert.deepEqual(describeSessionDevice('curl/8.5.0', 'x'), { label: 'Скрипт · curl', kind: 'script' });
  assert.equal(describeSessionDevice(null, 'Неизвестное устройство').label, 'Без подписи браузера');
});

test('the place is the server, the local network or the IP — never a guessed city', () => {
  assert.equal(describeSessionPlace('127.0.0.1'), 'этот сервер');
  assert.equal(describeSessionPlace('::ffff:127.0.0.1'), 'этот сервер');
  assert.equal(describeSessionPlace('192.168.1.20'), 'локальная сеть');
  assert.equal(describeSessionPlace('172.20.0.4'), 'локальная сеть');
  assert.equal(describeSessionPlace('95.31.4.2'), '95.31.4.2');
  assert.equal(describeSessionPlace(null), null);
});
