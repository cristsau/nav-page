import { isIP } from 'node:net'
import { deny } from './dropboxFiles.js'

export const NODE_ONLINE_MS = 45000
export const validNodeId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)
export function nodeSettings(data) {
  const node = data.node === undefined ? { id: null, name: '', address: '', preparing: false } : data.node
  if (!node || (node.id !== null && !validNodeId(node.id)) || typeof node.preparing !== 'boolean'
    || typeof node.name !== 'string' || node.name.length > 64 || typeof node.address !== 'string' || node.address.length > 253) deny('OFFLINE_STATE_INVALID', 503)
  return node
}
export function nodeProfile(input) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const address = typeof input.address === 'string' ? input.address.trim().toLowerCase() : ''
  if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) deny('INVALID_NODE_PROFILE')
  // Inventory only. Never resolve or connect to an administrator-entered address.
  if (address.length > 253 || (address && !isIP(address)
    && !address.split('.').every(label => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)))) deny('INVALID_NODE_PROFILE')
  return { name, address }
}
export function migrationBlockers(data) {
  return {
    unfinished: data.jobs.filter(job => !['complete', 'cancelled'].includes(job.state)).length,
    cleanup: data.jobs.filter(job => ['complete', 'cancelled'].includes(job.state) && !job.cleaned).length
  }
}
