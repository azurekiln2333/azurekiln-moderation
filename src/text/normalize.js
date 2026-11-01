import { Converter } from 'opencc-js';

const simplify = Converter({ from: 'tw', to: 'cn' });

export function normalizeText(text) {
  // Strip inserted separators before conversion so phrase conversions still match.
  const compact = text.normalize('NFKC').toLowerCase().replace(/[\p{Z}\p{P}\p{S}\p{M}\p{C}\s]/gu, '');
  return simplify(compact).normalize('NFKC').toLowerCase();
}
