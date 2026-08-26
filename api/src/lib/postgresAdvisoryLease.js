const LOCK_SQL = `
  SELECT pg_try_advisory_lock(
    hashtext(current_database()),
    hashtext($1::text)
  ) AS acquired
`

const UNLOCK_SQL = `
  SELECT pg_advisory_unlock(
    hashtext(current_database()),
    hashtext($1::text)
  ) AS released
`

function normalizeLockName(value) {
  const name = String(value || '').normalize('NFKC').trim()
  if (!name || name.length > 240 || /[\u0000-\u001F\u007F]/.test(name)) {
    throw new TypeError('PostgreSQL advisory lease name is invalid')
  }
  return name
}

export async function tryAcquirePostgresAdvisoryLease({
  poolInstance,
  name,
  onLost = null
}) {
  if (!poolInstance?.connect) throw new TypeError('PostgreSQL pool is required')
  const lockName = normalizeLockName(name)
  const client = await poolInstance.connect()
  let released = false
  let acquired = false

  const removeListeners = () => {
    client.off?.('error', handleConnectionLoss)
    client.off?.('end', handleConnectionLoss)
  }

  const handleConnectionLoss = (error) => {
    if (released) return
    released = true
    removeListeners()
    try { client.release?.(error instanceof Error ? error : new Error('PostgreSQL advisory lease connection ended')) } catch {}
    try { onLost?.(error) } catch {}
  }

  try {
    const result = await client.query(LOCK_SQL, [lockName])
    acquired = result.rows[0]?.acquired === true
    if (!acquired) {
      client.release()
      return null
    }
    client.on?.('error', handleConnectionLoss)
    client.on?.('end', handleConnectionLoss)
  } catch (error) {
    try { client.release(error) } catch {}
    throw error
  }

  return {
    name: lockName,
    get active() {
      return acquired && !released
    },
    async release() {
      if (released) return
      released = true
      removeListeners()
      let releaseError = null
      try {
        await client.query(UNLOCK_SQL, [lockName])
      } catch (error) {
        releaseError = error
      } finally {
        try { client.release(releaseError || undefined) } catch {}
      }
      if (releaseError) throw releaseError
    }
  }
}
