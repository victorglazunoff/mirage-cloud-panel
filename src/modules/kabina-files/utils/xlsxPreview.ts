/**
 * Reads the first rows of an .xlsx for the «Файлы» preview (DarkFiles «лист
 * «Октябрь» · 1 из 4»): sheet names and a small grid of the first sheet.
 * jszip is already a dependency; it is loaded only when a spreadsheet is opened.
 */

export type SheetPreview = {
  sheetNames: string[];
  /** First rows of the first sheet, each trimmed to the same column count; row 0 is treated as the header. */
  rows: string[][];
  totalRows: number;
};

const MAX_ROWS = 8;
const MAX_COLUMNS = 5;

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? 'A';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function textOf(node: Element | null): string {
  return node?.textContent ?? '';
}

/** Formats numbers the Russian way (comma decimals, at most two places) and leaves text as is. */
function displayValue(raw: string): string {
  if (!/^-?\d+(\.\d+)?(E-?\d+)?$/i.test(raw)) return raw;
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace('.', ',');
}

export async function readSheetPreview(blob: Blob): Promise<SheetPreview> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const parser = new DOMParser();
  const readXml = async (name: string) => {
    const file = zip.file(name);
    return file ? parser.parseFromString(await file.async('string'), 'application/xml') : null;
  };

  const workbook = await readXml('xl/workbook.xml');
  const sheetNames = Array.from(workbook?.getElementsByTagName('sheet') ?? []).map((sheet) => sheet.getAttribute('name') ?? '');

  // The first sheet's file comes from the workbook relationships; sheet1.xml is the usual fallback.
  let firstSheetFile = 'xl/worksheets/sheet1.xml';
  const firstSheetRelation = workbook?.getElementsByTagName('sheet')[0]?.getAttribute('r:id');
  const relations = await readXml('xl/_rels/workbook.xml.rels');
  if (firstSheetRelation && relations) {
    const target = Array.from(relations.getElementsByTagName('Relationship'))
      .find((relation) => relation.getAttribute('Id') === firstSheetRelation)
      ?.getAttribute('Target');
    if (target) firstSheetFile = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }

  const sharedXml = await readXml('xl/sharedStrings.xml');
  const shared = Array.from(sharedXml?.getElementsByTagName('si') ?? []).map((item) =>
    Array.from(item.getElementsByTagName('t')).map((node) => node.textContent ?? '').join(''));

  const sheet = await readXml(firstSheetFile);
  const rowNodes = Array.from(sheet?.getElementsByTagName('row') ?? []);
  const rows: string[][] = [];
  let width = 0;
  for (const rowNode of rowNodes.slice(0, MAX_ROWS)) {
    const row: string[] = [];
    for (const cell of Array.from(rowNode.getElementsByTagName('c'))) {
      const index = columnIndex(cell.getAttribute('r') ?? '');
      if (index >= MAX_COLUMNS) continue;
      const type = cell.getAttribute('t');
      const raw = type === 'inlineStr' ? textOf(cell.getElementsByTagName('t')[0] ?? null) : textOf(cell.getElementsByTagName('v')[0] ?? null);
      row[index] = type === 's' ? shared[Number(raw)] ?? '' : type === 'str' || type === 'inlineStr' ? raw : displayValue(raw);
    }
    width = Math.max(width, row.length);
    rows.push(row);
  }
  const grid = rows
    .map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''))
    .filter((row) => row.some((value) => value !== ''));
  return { sheetNames, rows: grid, totalRows: rowNodes.length };
}
