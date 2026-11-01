import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

// Immutable upstream revision; update only after reviewing source and license.
const revision = 'a7d06bb1c321e669943b6841570d9da6dad8ce2b';
const repository = 'https://github.com/fwwdn/sensitive-stop-words';
const base = `https://raw.githubusercontent.com/fwwdn/sensitive-stop-words/${revision}/`;
const sources = [
  { path: '政治类.txt', category: 'politics' },
  { path: '色情类.txt', category: 'pornography' },
  { path: '涉枪涉爆违法信息关键词.txt', category: 'weapons' },
  { path: '广告.txt', category: 'advertising' }
];
async function download(path) {
  const response = await fetch(base + encodeURIComponent(path), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Upstream download failed: ${path} (${response.status})`);
  return response.text();
}
const downloads = await Promise.all(sources.map(async source => ({ ...source, text: await download(source.path) })));
const license = await download('LICENSE');
if (!license.includes('Apache License') || !license.includes('Version 2.0')) throw new Error('Review upstream license before import');
const entries = [];
const seen = new Set();
for (const { text, category } of downloads) {
  for (const raw of text.split(/[,，\r\n]+/u)) {
    const word = raw.replace(/^\uFEFF/, '').trim();
    const key = `${category}:${word}`;
    if (word && [...word].length <= 128 && !seen.has(key)) {
      seen.add(key);
      entries.push({ word, category });
    }
  }
}
// Additional explicit illegal-sale/abuse phrases authored for this service.
const local = {
  gambling: ['网络赌场', '赌博下注'],
  drugs: ['冰毒', '海洛因', '出售毒品'],
  controlled_items: ['出售管制刀具', '出售三棱刀'],
  fraud: ['代办假证', '出售银行卡'],
  terrorism: ['制作恐怖袭击炸弹', '招募恐怖分子'],
  prohibited_goods: ['出售窃听器', '出售假币'],
  custom: ['AZUREKILN_MODERATION_TEST_BLOCK']
};
for (const [category, words] of Object.entries(local)) {
  for (const word of words) entries.push({ word, category });
}
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/seed-keywords.json', import.meta.url), JSON.stringify(entries, null, 2) + '\n');
writeFileSync(new URL('../data/LICENSE-sensitive-stop-words.txt', import.meta.url), license);
writeFileSync(new URL('../data/upstream.json', import.meta.url), JSON.stringify({
  repository, revision, license: 'Apache-2.0', modification: 'Split CSV/lines, trimmed, categorized, deduplicated, added local phrases',
  sources: downloads.map(({ path, category, text }) => ({ path, category, sha256: createHash('sha256').update(text).digest('hex') })),
  entries: entries.length
}, null, 2) + '\n');
console.info(`Imported ${entries.length} seed entries at ${revision}`);
