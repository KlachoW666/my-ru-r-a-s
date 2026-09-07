'use strict';

const defaults = [
  {key: 'telegram', name: 'Telegram', url: 'https://t.me/bearztop'},
  {key: 'vk', name: 'VK', url: 'https://vk.com/bearztop'}
];
const legacy = new Map([
  ['https://t.me/kabangg', defaults[0].url],
  ['https://t.me/satchel_top', defaults[0].url],
  ['https://vk.com/kabangg', defaults[1].url]
]);

// Compatibility for copied seed rows; explicit custom admin accounts stay intact.
// Return key as well as name: the compiled footer uses key to render icons.
function publicSocials(rows) {
  if (!rows.length) return defaults.map(link => ({...link}));
  return rows.filter(row => row.url).flatMap(row => {
    const raw = String(row.url).trim();
    const normalized = raw.toLowerCase().replace(/\/+$/, '');
    if (normalized === 'https://discord.gg/kaban') return [];
    const key = String(row.key || row.id || row.name || '').toLowerCase();
    return [{key, name: row.name || key, url: legacy.get(normalized) || raw}];
  });
}

module.exports = {publicSocials};
