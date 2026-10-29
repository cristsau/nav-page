const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' })
export const countryName = code => names.of(code)
export const countryCodes = Array.from({length:676},(_,i)=>String.fromCharCode(65+Math.floor(i/26),65+i%26)).filter(code=> !['ZZ','XA','XB','EU','EZ','UN','QO'].includes(code)&&new Intl.Locale(`und-${code}`).region===code&&names.of(code)!==code).sort((a,b)=>names.of(a).localeCompare(names.of(b),'zh-CN'))
