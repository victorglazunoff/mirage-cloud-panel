import assert from 'node:assert/strict';

import { afterEach, test } from 'vitest';

import { browserTimeZone, fromPanelWall, getPanelTimeZone, panelTimezoneOffset, panelZoneLabel, setPanelTimeZone, toPanelWall } from '@/modules/kabina/ui/panelTime';

const ORIGINAL_ZONE = getPanelTimeZone();

afterEach(() => setPanelTimeZone(ORIGINAL_ZONE, null));

test('toPanelWall shows the wall clock of the panel zone whatever the process zone is', () => {
  const wall = toPanelWall('2026-10-26T10:05:00Z', 'Asia/Yekaterinburg');
  assert.equal(wall.getHours(), 15);
  assert.equal(wall.getMinutes(), 5);
  assert.equal(wall.getDate(), 26);
  assert.equal(wall.getMonth(), 9);
  assert.equal(wall.getFullYear(), 2026);
});

test('toPanelWall rolls the date over past midnight', () => {
  const wall = toPanelWall(Date.parse('2026-10-26T20:30:00Z'), 'Asia/Yekaterinburg');
  assert.equal(wall.getDate(), 27);
  assert.equal(wall.getHours(), 1);
});

test('panelTimezoneOffset is getTimezoneOffset of the panel zone, not of the device', () => {
  const instant = new Date('2026-10-26T10:05:00Z');
  assert.equal(panelTimezoneOffset(instant, 'Asia/Yekaterinburg'), -300);
  assert.equal(panelTimezoneOffset(instant, 'Europe/Moscow'), -180);
  assert.equal(panelTimezoneOffset(instant, 'UTC'), 0);
  assert.equal(panelTimezoneOffset(new Date('2026-07-01T12:00:00Z'), 'America/New_York'), 240);
  setPanelTimeZone('Asia/Omsk');
  assert.equal(panelTimezoneOffset(instant), -360);
});

test('fromPanelWall is the inverse of toPanelWall', () => {
  const instant = Date.parse('2026-10-26T10:05:00Z');
  assert.equal(fromPanelWall(toPanelWall(instant, 'Asia/Yekaterinburg'), 'Asia/Yekaterinburg').getTime(), instant);
  assert.equal(fromPanelWall(new Date(2026, 9, 26, 15, 5), 'Asia/Yekaterinburg').toISOString(), '2026-10-26T10:05:00.000Z');
});

test('before the server answers the panel zone is the browser zone', () => {
  assert.equal(ORIGINAL_ZONE, browserTimeZone());
});

test('panelZoneLabel: the server caption for the panel zone, the UTC offset otherwise', () => {
  const at = new Date('2026-10-26T10:05:00Z');
  setPanelTimeZone('Asia/Yekaterinburg');
  assert.equal(panelZoneLabel('Asia/Yekaterinburg', at), 'UTC+5');
  setPanelTimeZone('Asia/Yekaterinburg', '  ЕКБ ');
  assert.equal(panelZoneLabel(undefined, at), 'ЕКБ');
  assert.equal(panelZoneLabel('Asia/Tokyo', at), 'UTC+9');
  assert.equal(panelZoneLabel('Asia/Kolkata', at), 'UTC+5:30');
  assert.equal(panelZoneLabel('America/New_York', at), 'UTC−4');
  setPanelTimeZone('Asia/Yekaterinburg', '');
  assert.equal(panelZoneLabel(undefined, at), 'UTC+5');
});

test('setPanelTimeZone ignores invalid zones and switches the zone', () => {
  setPanelTimeZone('Not/AZone');
  assert.equal(getPanelTimeZone(), ORIGINAL_ZONE);
  setPanelTimeZone('Asia/Tokyo');
  assert.equal(toPanelWall('2026-10-26T10:05:00Z').getHours(), 19);
});
