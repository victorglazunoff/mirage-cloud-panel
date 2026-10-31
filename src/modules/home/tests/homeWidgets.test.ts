import { describe, expect, it } from 'vitest';

import { layoutHomeWidgets } from '@/modules/home/utils/homeWidgets';

describe('layoutHomeWidgets (DarkSettings 03 on the home screen)', () => {
  it('leaves the limits block out, numbers closing up, when the counter is off', () => {
    const desktop = layoutHomeWidgets(null, false, false);
    expect(desktop.aside).toEqual([{ id: 'cal', index: '04' }]);
    const phone = layoutHomeWidgets([
      { id: 'lim', enabled: true },
      { id: 'cal', enabled: true },
      { id: 'fav', enabled: true },
    ], true, false);
    expect(phone.column).toEqual([{ id: 'cal', index: '01' }, { id: 'fav', index: '02' }]);
  });

  it('keeps the mock-up layout for the default settings', () => {
    const layout = layoutHomeWidgets(null, false);
    expect(layout.main).toEqual([{ id: 'fav', index: '01' }, { id: 'work', index: '02' }]);
    expect(layout.logIndex).toBe('03');
    expect(layout.aside).toEqual([{ id: 'cal', index: '04' }, { id: 'lim', index: '05' }]);
  });

  it('follows the saved order and drops disabled and not-yet-drawn widgets', () => {
    const layout = layoutHomeWidgets([
      { id: 'lim', enabled: true },
      { id: 'leads', enabled: true },
      { id: 'work', enabled: true },
      { id: 'cal', enabled: true },
      { id: 'fav', enabled: false },
      { id: 'server', enabled: false },
      { id: 'deploy', enabled: false },
    ], false);
    expect(layout.main.map((slot) => slot.id)).toEqual(['work']);
    expect(layout.aside.map((slot) => slot.id)).toEqual(['lim', 'cal']);
    expect(layout.main[0].index).toBe('01');
    expect(layout.logIndex).toBe('02');
    expect(layout.aside.map((slot) => slot.index)).toEqual(['03', '04']);
  });

  it('on the phone keeps «ждёт тебя» first and numbers the rest in the saved order', () => {
    const layout = layoutHomeWidgets([
      { id: 'lim', enabled: true },
      { id: 'cal', enabled: true },
      { id: 'work', enabled: true },
      { id: 'fav', enabled: true },
    ], true);
    expect(layout.column).toEqual([
      { id: 'work', index: '' },
      { id: 'lim', index: '01' },
      { id: 'cal', index: '02' },
      { id: 'fav', index: '03' },
    ]);
  });

  it('hides «ждёт тебя» on the phone when «В работе» is off', () => {
    const layout = layoutHomeWidgets([
      { id: 'work', enabled: false },
      { id: 'cal', enabled: true },
    ], true);
    expect(layout.column).toEqual([{ id: 'cal', index: '01' }]);
  });
});
