import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpeechKitService, readSpeechKitApiKey } from '@/modules/voice/speechkit.service.js';

test('SpeechKit is off without a key: no default file is read', async () => {
  const reads: string[] = [];
  const readText = async (filePath: string) => {
    reads.push(filePath);
    return 'key-from-file\n';
  };
  assert.equal(await readSpeechKitApiKey({}, readText), null);
  assert.deepEqual(reads, [], 'nothing is looked up in the home folder');

  assert.equal(await readSpeechKitApiKey({ YANDEX_SPEECHKIT_API_KEY: ' env-key ' }, readText), 'env-key');
  assert.equal(await readSpeechKitApiKey({ YANDEX_SPEECHKIT_API_KEY_FILE: '/srv/speechkit.key' }, readText), 'key-from-file');
  assert.deepEqual(reads, ['/srv/speechkit.key']);
  assert.equal(await readSpeechKitApiKey({ YANDEX_SPEECHKIT_API_KEY_FILE: '/missing' }, async () => { throw new Error('ENOENT'); }), null);
});

test('without a key every transcription answers VOICE_NOT_CONFIGURED and names the settings', async () => {
  const service = createSpeechKitService({
    loadApiKey: () => readSpeechKitApiKey({}),
    convertToPcm: async () => Buffer.alloc(0),
    fetchBackend: async () => { throw new Error('must not be called'); },
  });
  assert.equal(await service.isConfigured(), false);
  const result = await service.transcribe({ buffer: Buffer.from('x'), mimeType: 'audio/webm', originalName: 'a.webm' } as never);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'VOICE_NOT_CONFIGURED');
    assert.match(result.error, /YANDEX_SPEECHKIT_API_KEY/);
  }
});
