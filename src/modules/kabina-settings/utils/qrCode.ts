/**
 * A small QR Code encoder (ISO/IEC 18004): byte mode, error correction level M,
 * versions 1–15 — enough for an `otpauth://` URI. Runs in the browser, so the
 * 2FA secret never leaves the page for an outside QR service.
 */

type BlockSpec = { ec: number; groups: Array<[count: number, dataPerBlock: number]> };

// Level M block structure per version (index = version).
const M_BLOCKS: BlockSpec[] = [
  { ec: 0, groups: [] },
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
  { ec: 30, groups: [[1, 50], [4, 51]] },
  { ec: 22, groups: [[6, 36], [2, 37]] },
  { ec: 22, groups: [[8, 37], [1, 38]] },
  { ec: 24, groups: [[4, 40], [5, 41]] },
  { ec: 24, groups: [[5, 41], [5, 42]] },
];

const ALIGNMENT: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
];

// ---- GF(256) arithmetic for Reed–Solomon (primitive polynomial 0x11D)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];
}

const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    poly.forEach((coefficient, position) => {
      next[position] ^= coefficient;
      next[position + 1] ^= gfMul(coefficient, EXP[index]);
    });
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], degree: number): number[] {
  const generator = rsGenerator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    for (let index = 0; index < degree; index += 1) {
      remainder[index] ^= gfMul(generator[index + 1], factor);
    }
  }
  return remainder;
}

const dataCapacity = (version: number) =>
  M_BLOCKS[version].groups.reduce((sum, [count, perBlock]) => sum + count * perBlock, 0);

/** Splits into blocks, adds EC words and interleaves them in the order the symbol stores them. */
function buildCodewords(bytes: Uint8Array, version: number): number[] {
  const countBits = version <= 9 ? 8 : 16;
  const capacity = dataCapacity(version);
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let bit = length - 1; bit >= 0; bit -= 1) bits.push((value >>> bit) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits);
  bytes.forEach((byte) => push(byte, 8));
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    data.push(bits.slice(index, index + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0; data.length < capacity; pad += 1) data.push(pad % 2 === 0 ? 0xec : 0x11);

  const { ec, groups } = M_BLOCKS[version];
  const dataBlocks: number[][] = [];
  let offset = 0;
  groups.forEach(([count, perBlock]) => {
    for (let index = 0; index < count; index += 1) {
      dataBlocks.push(data.slice(offset, offset + perBlock));
      offset += perBlock;
    }
  });
  const ecBlocks = dataBlocks.map((block) => rsRemainder(block, ec));
  const result: number[] = [];
  const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let index = 0; index < longest; index += 1) {
    dataBlocks.forEach((block) => {
      if (index < block.length) result.push(block[index]);
    });
  }
  for (let index = 0; index < ec; index += 1) ecBlocks.forEach((block) => result.push(block[index]));
  return result;
}

function bchFormat(mask: number): number {
  // Level M = 00.
  const data = (0b00 << 3) | mask;
  let value = data << 10;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if (value & (1 << bit)) value ^= 0x537 << (bit - 10);
  }
  return ((data << 10) | value) ^ 0x5412;
}

function bchVersion(version: number): number {
  let value = version << 12;
  for (let bit = 17; bit >= 12; bit -= 1) {
    if (value & (1 << bit)) value ^= 0x1f25 << (bit - 12);
  }
  return (version << 12) | value;
}

const MASKS: Array<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

type Grid = { modules: boolean[][]; reserved: boolean[][] };

function baseGrid(version: number): Grid {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (row: number, col: number, dark: boolean) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    modules[row][col] = dark;
    reserved[row][col] = true;
  };

  const finder = (row: number, col: number) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        set(row + dr, col + dc, dark);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let index = 8; index < size - 8; index += 1) {
    set(6, index, index % 2 === 0);
    set(index, 6, index % 2 === 0);
  }

  const centers = ALIGNMENT[version];
  const last = centers.length - 1;
  centers.forEach((row, rowIndex) => {
    centers.forEach((col, colIndex) => {
      // Only the three finder corners are skipped; patterns on the timing lines are drawn over them.
      const atFinder = (rowIndex === 0 && colIndex === 0) || (rowIndex === 0 && colIndex === last) || (rowIndex === last && colIndex === 0);
      if (atFinder) return;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    });
  });

  // Format areas (filled per mask later) and the dark module.
  for (let index = 0; index < 9; index += 1) {
    if (!reserved[8][index]) set(8, index, false);
    if (!reserved[index][8]) set(index, 8, false);
  }
  for (let index = 0; index < 8; index += 1) {
    set(8, size - 1 - index, false);
    set(size - 1 - index, 8, false);
  }
  set(size - 8, 8, true);

  if (version >= 7) {
    const bits = bchVersion(version);
    for (let index = 0; index < 18; index += 1) {
      const dark = ((bits >>> index) & 1) === 1;
      const a = size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  return { modules, reserved };
}

function placeData(grid: Grid, codewords: number[]): void {
  const size = grid.modules.length;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        if (grid.reserved[row][col]) continue;
        const dark = bitIndex < totalBits && ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
        grid.modules[row][col] = dark;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function applyMask(grid: Grid, mask: number): boolean[][] {
  const size = grid.modules.length;
  const result = grid.modules.map((row, r) => row.map((dark, c) => (grid.reserved[r][c] ? dark : dark !== MASKS[mask](r, c))));
  const format = bchFormat(mask);
  const bit = (index: number) => ((format >>> index) & 1) === 1;
  // Copy 1: around the top-left finder (result[row][col]).
  for (let index = 0; index <= 5; index += 1) result[index][8] = bit(index);
  result[7][8] = bit(6);
  result[8][8] = bit(7);
  result[8][7] = bit(8);
  for (let index = 9; index < 15; index += 1) result[8][14 - index] = bit(index);
  // Copy 2: split between the other two finders.
  for (let index = 0; index < 8; index += 1) result[8][size - 1 - index] = bit(index);
  for (let index = 8; index < 15; index += 1) result[size - 15 + index][8] = bit(index);
  result[size - 8][8] = true;
  return result;
}

function penalty(matrix: boolean[][]): number {
  const size = matrix.length;
  let score = 0;
  const lineScore = (line: boolean[]) => {
    let total = 0;
    let run = 1;
    for (let index = 1; index <= line.length; index += 1) {
      if (index < line.length && line[index] === line[index - 1]) {
        run += 1;
      } else {
        if (run >= 5) total += run - 2;
        run = 1;
      }
    }
    const text = line.map((dark) => (dark ? '1' : '0')).join('');
    let found = text.indexOf('1011101');
    while (found !== -1) {
      const before = text.slice(Math.max(0, found - 4), found);
      const after = text.slice(found + 7, found + 11);
      if ((before.length === 4 && before === '0000') || (after.length === 4 && after === '0000')) total += 40;
      found = text.indexOf('1011101', found + 1);
    }
    return total;
  };
  for (let index = 0; index < size; index += 1) {
    score += lineScore(matrix[index]);
    score += lineScore(matrix.map((row) => row[index]));
  }
  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (matrix[row][col]) dark += 1;
      if (row < size - 1 && col < size - 1) {
        const value = matrix[row][col];
        if (value === matrix[row][col + 1] && value === matrix[row + 1][col] && value === matrix[row + 1][col + 1]) score += 3;
      }
    }
  }
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * Encodes text as a QR matrix (true = dark module), picking the smallest
 * version that fits and the mask with the lowest penalty. Used by the
 * kabina-settings 2FA setup to draw the otpauth QR code.
 */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= 15) {
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCapacity(version) * 8) break;
    version += 1;
  }
  if (version > 15) throw new Error('Text is too long for the QR encoder');
  const grid = baseGrid(version);
  placeData(grid, buildCodewords(bytes, version));
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(grid, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best!;
}
