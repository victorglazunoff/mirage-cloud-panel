import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { isNumericCell } from '@/modules/chat/utils/numericCell';

describe('isNumericCell', () => {
  it('marks ИНН, ОГРН, phones and sums', () => {
    expect(isNumericCell('7713018420')).toBe(true);
    expect(isNumericCell('1027739862831')).toBe(true);
    expect(isNumericCell('+7 (495) 123-45-67')).toBe(true);
    expect(isNumericCell('1 250 000,50')).toBe(true);
    expect(isNumericCell(<strong>7713018420</strong>)).toBe(true);
  });

  it('leaves words, empty cells and long digit runs alone', () => {
    expect(isNumericCell('ИНН 7713018420')).toBe(false);
    expect(isNumericCell('sapsan.ru')).toBe(false);
    expect(isNumericCell('')).toBe(false);
    expect(isNumericCell('—')).toBe(false);
    expect(isNumericCell('1'.repeat(41))).toBe(false);
  });

  it('puts data-num on numeric table cells only', () => {
    const { container } = render(
      <Markdown>{'| Компания | ИНН |\n|---|---|\n| ГК «Сапсан» | **7713018420** |'}</Markdown>,
    );
    const cells = container.querySelectorAll('td');
    expect(cells[0].hasAttribute('data-num')).toBe(false);
    expect(cells[1].hasAttribute('data-num')).toBe(true);
  });
});
