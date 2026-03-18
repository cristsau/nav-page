/**
 * 简单的加密工具
 * 使用 Web Crypto API 实现 AES-GCM 加密
 */

// 生成密钥
async function deriveKey(password, salt) {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * 加密文本
 * @param {string} text - 要加密的文本
 * @param {string} password - 加密密码
 * @returns {Promise<string>} - 加密后的文本（base64）
 */
export async function encrypt(text, password) {
  const encoder = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const key = await deriveKey(password, salt)

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(text)
  )

  // 合并 salt + iv + encrypted
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength)
  combined.set(salt, 0)
  combined.set(iv, salt.length)
  combined.set(new Uint8Array(encrypted), salt.length + iv.length)

  // 转为 base64
  return btoa(String.fromCharCode(...combined))
}

/**
 * 解密文本
 * @param {string} encryptedText - 加密后的文本（base64）
 * @param {string} password - 解密密码
 * @returns {Promise<string|null>} - 解密后的文本，失败返回 null
 */
export async function decrypt(encryptedText, password) {
  try {
    const combined = Uint8Array.from(atob(encryptedText), c => c.charCodeAt(0))

    const salt = combined.slice(0, 16)
    const iv = combined.slice(16, 28)
    const encrypted = combined.slice(28)

    const key = await deriveKey(password, salt)

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encrypted
    )

    return new TextDecoder().decode(decrypted)
  } catch (e) {
    return null
  }
}

/**
 * 生成密码哈希（用于验证）
 * @param {string} password - 密码
 * @returns {Promise<string>} - 哈希值
 */
export async function hashPassword(password) {
  const encoder = new TextEncoder()
  const data = encoder.encode(password + 'nav-salt')
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
}

/**
 * 验证密码
 * @param {string} password - 密码
 * @param {string} hash - 哈希值
 * @returns {Promise<boolean>} - 是否匹配
 */
export async function verifyPassword(password, hash) {
  const newHash = await hashPassword(password)
  return newHash === hash
}

/**
 * 简单的混淆（用于前端显示）
 * @param {string} text - 文本
 * @returns {string} - 混淆后的文本
 */
export function obfuscate(text) {
  if (!text) return ''
  const len = Math.min(text.length, 20)
  return text.slice(0, 3) + '•'.repeat(len - 6) + text.slice(-3)
}

export default {
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword,
  obfuscate
}
