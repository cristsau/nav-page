// A private NAV deep link, never a Dropbox public/share/token URL.
export function noteFileReference(item, origin) {
  if (item?.type !== 'file' || typeof item.id !== 'string' || !/^id:[A-Za-z0-9_-]{1,150}$/.test(item.id)
    || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255 || /[\x00-\x1f\x7f]/.test(item.name)) throw Error('INVALID_FILE_REFERENCE')
  const base = new URL(origin)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw Error('INVALID_ORIGIN')
  const url = new URL('/files', base.origin); url.searchParams.set('item', item.id)
  return { text: item.name, href: url.href }
}
