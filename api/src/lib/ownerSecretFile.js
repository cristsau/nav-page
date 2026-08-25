import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

function normalizeLabel(value) {
  return String(value || 'Secret').replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 80) || 'Secret'
}

export function validateOwnerSecretStat(
  fileStat,
  { label = 'Secret', maxBytes = 4096, platform = process.platform } = {}
) {
  const safeLabel = normalizeLabel(label)
  if (!fileStat?.isFile?.()) throw new Error(`${safeLabel} must be a regular file`)
  if (!Number.isSafeInteger(fileStat.size) || fileStat.size <= 0) {
    throw new Error(`${safeLabel} is empty`)
  }
  if (fileStat.size > maxBytes) throw new Error(`${safeLabel} is too large`)

  if (platform !== 'win32') {
    const permissions = Number(fileStat.mode) & 0o777
    if ((permissions & 0o400) === 0 || (permissions & 0o177) !== 0) {
      throw new Error(`${safeLabel} must use owner-only permissions`)
    }
  }
}

export async function readOwnerSecretFile(
  filePath,
  {
    label = 'Secret',
    maxBytes = 4096,
    allowWhitespace = false,
    lstatImpl = fs.lstat,
    openImpl = fs.open,
    platform = process.platform
  } = {}
) {
  const safeLabel = normalizeLabel(label)
  const normalizedPath = String(filePath || '').trim()
  if (!normalizedPath) throw new Error(`${safeLabel} file is not configured`)
  if (!path.isAbsolute(normalizedPath)) throw new Error(`${safeLabel} file must use an absolute path`)

  const linkStat = await lstatImpl(normalizedPath)
  if (linkStat?.isSymbolicLink?.()) throw new Error(`${safeLabel} cannot be a symbolic link`)
  validateOwnerSecretStat(linkStat, { label: safeLabel, maxBytes, platform })

  const noFollowFlag = platform === 'win32' ? 0 : Number(fsConstants.O_NOFOLLOW || 0)
  const handle = await openImpl(normalizedPath, fsConstants.O_RDONLY | noFollowFlag)
  let bytes
  try {
    const openedStat = await handle.stat()
    validateOwnerSecretStat(openedStat, { label: safeLabel, maxBytes, platform })
    if (
      linkStat?.dev !== undefined
      && openedStat?.dev !== undefined
      && (String(linkStat.dev) !== String(openedStat.dev) || String(linkStat.ino) !== String(openedStat.ino))
    ) {
      throw new Error(`${safeLabel} changed while opening`)
    }

    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxBytes) throw new Error(`${safeLabel} is too large`)
    bytes = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }

  const secret = bytes.toString('utf8').trim()
  if (!secret) throw new Error(`${safeLabel} is empty`)
  if (!allowWhitespace && (/\r|\n/.test(secret) || CONTROL_PATTERN.test(secret))) {
    throw new Error(`${safeLabel} has an invalid format`)
  }
  return secret
}
