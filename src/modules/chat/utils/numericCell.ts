import React from 'react';

/** The plain text of a markdown table cell's rendered children (strings, numbers, nested elements). */
export function cellText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(cellText).join('');
  if (React.isValidElement(node)) return cellText((node.props as { children?: React.ReactNode }).children);
  return '';
}

// Digits plus the punctuation numbers come with: spaces, signs, dashes, brackets, separators, №, %.
const NUMBER_CHARS = '\\s\\d+\\-\\u2010-\\u2015\\u2212()\\u00a0.,:/№%#';
const NUMERIC_CELL = new RegExp(`^[${NUMBER_CHARS}]*\\d[${NUMBER_CHARS}]*$`);

/**
 * True when a table cell holds a number and nothing else (ИНН, ОГРН, a phone, a sum):
 * there are no words to wrap at, so the chat keeps it on one line in tabular digits.
 */
export function isNumericCell(children: React.ReactNode): boolean {
  const text = cellText(children).trim();
  return text.length > 0 && text.length <= 40 && NUMERIC_CELL.test(text);
}
