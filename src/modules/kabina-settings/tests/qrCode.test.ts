import { describe, expect, it } from 'vitest';

import { encodeQr } from '@/modules/kabina-settings/utils/qrCode';

/** The 7×7 finder: dark ring, light ring, dark 3×3 core. */
function hasFinder(matrix: boolean[][], row: number, col: number): boolean {
  for (let dr = 0; dr < 7; dr += 1) {
    for (let dc = 0; dc < 7; dc += 1) {
      const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      if (matrix[row + dr][col + dc] !== (ring || core)) return false;
    }
  }
  return true;
}

describe('encodeQr', () => {
  it('picks the smallest version that fits and draws the three finders', () => {
    const small = encodeQr('hello');
    expect(small).toHaveLength(21);
    const size = small.length;
    expect(hasFinder(small, 0, 0)).toBe(true);
    expect(hasFinder(small, 0, size - 7)).toBe(true);
    expect(hasFinder(small, size - 7, 0)).toBe(true);
    // The always-dark module next to the lower-left finder.
    expect(small[size - 8][8]).toBe(true);
  });

  it('fits a real otpauth URI (version 9, level M)', () => {
    const uri = 'otpauth://totp/%D0%9C%D0%B8%D1%80%D0%B0%D0%B6%3Aalicework?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=%D0%9C%D0%B8%D1%80%D0%B0%D0%B6&algorithm=SHA1&digits=6&period=30';
    expect(encodeQr(uri)).toHaveLength(53);
  });

  it('draws timing patterns between the finders', () => {
    const matrix = encodeQr('x'.repeat(120));
    for (let index = 8; index < matrix.length - 8; index += 1) {
      expect(matrix[6][index]).toBe(index % 2 === 0);
      expect(matrix[index][6]).toBe(index % 2 === 0);
    }
  });

  it('refuses text longer than version 15 holds', () => {
    expect(() => encodeQr('z'.repeat(500))).toThrow();
  });
});
