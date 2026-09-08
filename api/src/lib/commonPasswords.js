// Offline denylist of common long passwords and obvious variants. No external password query.
// This is deliberately not advertised as a complete breached-password corpus.
const commonBases=['password','123456','123456789','qwerty','qwertyuiop','letmein','welcome','iloveyou','admin','administrator','changeme','domonav']
const common=new Set(['123456789012345','1234567890123456','12345678901234567890','qwertyuiopasdfgh','qwertyuiopasdfghjkl','correcthorsebatterystaple','passwordpassword','passwordpassword123'])
for(const base of commonBases) {
  for(const suffix of ['','123','123456','123456789','2026','2026!','!','!!']) {
    common.add(base+base+suffix)
    common.add(base+suffix)
  }
}
export function isCommonPassword(value) {return common.has(String(value).toLowerCase())}
