import assert from 'node:assert/strict';

import { test } from 'vitest';

import { matchesVoiceHotkey, parseVoiceHotkey, voiceHotkeyLabel } from '@/shared/utils';

const key = (code: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => ({
  code,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

test('the default ⌥ Space matches only Alt + Space', () => {
  const chord = parseVoiceHotkey('Alt+Space');
  assert.deepEqual(chord, { alt: true, ctrl: false, meta: false, shift: false, code: 'Space' });
  assert.equal(matchesVoiceHotkey(key('Space', { altKey: true }), chord), true);
  assert.equal(matchesVoiceHotkey(key('Space'), chord), false, 'plain Space is typing');
  assert.equal(matchesVoiceHotkey(key('Space', { altKey: true, shiftKey: true }), chord), false, 'an extra modifier is another shortcut');
});

test('letters and digits from the settings recorder become key codes', () => {
  assert.equal(parseVoiceHotkey('Control+Shift+V').code, 'KeyV');
  assert.equal(parseVoiceHotkey('Meta+1').code, 'Digit1');
  assert.equal(parseVoiceHotkey('Alt+F2').code, 'F2');
  const chord = parseVoiceHotkey('Control+Shift+V');
  assert.equal(matchesVoiceHotkey(key('KeyV', { ctrlKey: true, shiftKey: true }), chord), true);
  assert.equal(matchesVoiceHotkey(key('KeyV', { ctrlKey: true }), chord), false);
});

test('hints write the combination with key glyphs', () => {
  assert.equal(voiceHotkeyLabel('Alt+Space'), '⌥ Пробел');
  assert.equal(voiceHotkeyLabel('Control+Shift+V'), '⌃ ⇧ V');
  assert.equal(voiceHotkeyLabel('Meta+Backquote'), '⌘ BACKQUOTE');
});
