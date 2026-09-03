'use strict';

// Shared DTO: the admin form and public site read the same content.
function bannerContent(row) {
  if (row.content) {
    try {
      const content = JSON.parse(row.content);
      if (content && typeof content === 'object' && !Array.isArray(content)) {
        return { ...content, isActive: Boolean(row.active) };
      }
    } catch { /* Old rows use the flat columns below. */ }
  }
  return {
    title: row.title || '', image: row.image || '',
    ...(row.url ? { buttonAction: 'url', buttonValue: row.url } : {}),
    isActive: Boolean(row.active)
  };
}

function publicBanner(row) {
  return { ...bannerContent(row), id: `banner-${row.id}` };
}

module.exports = { bannerContent, publicBanner };
