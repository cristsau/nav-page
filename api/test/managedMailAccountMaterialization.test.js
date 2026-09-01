import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertManagedMailOwnerExists,
  MANAGED_MAIL_MATERIALIZATION_WARNING,
  materializeManagedMailAccount,
  materializeManagedMailAccountBestEffort,
  reconcileManagedMailRuntimeAccounts,
  restoreManagedMailAccountRows,
  snapshotManagedMailAccountRows
} from '../src/lib/managedMailAccountMaterialization.js'

test('a new managed mailbox rejects an unknown NAV owner before configuration is written', async () => {
  await assert.rejects(
    assertManagedMailOwnerExists('missing-owner', {
      queryFn: async (sql, values) => {
        assert.match(sql, /FROM users WHERE username = \$1 AND status = 'approved'/)
        assert.deepEqual(values, ['missing-owner'])
        return { rows: [] }
      }
    }),
    /归属用户不存在/
  )
})

test('managed mailbox materialization makes SMTP-only accounts immediately selectable', async () => {
  let captured
  const row = await materializeManagedMailAccount({
    sourceKey: 'managed.0123456789abcdef01234567',
    label: '工作邮箱',
    config: {
      ownerUsername: 'owner-a',
      deliveryEnabled: true,
      ingestEnabled: false
    }
  }, {
    queryFn: async (sql, values) => {
      captured = { sql, values }
      return {
        rows: [{
          id: '11111111-1111-4111-8111-111111111111',
          user_id: '22222222-2222-4222-8222-222222222222',
          source_key: values[0],
          label: values[1],
          enabled: values[2]
        }]
      }
    }
  })
  assert.match(captured.sql, /INSERT INTO email_accounts/)
  assert.match(captured.sql, /ON CONFLICT \(user_id, source_key\) DO UPDATE/)
  assert.deepEqual(captured.values, [
    'managed.0123456789abcdef01234567',
    '工作邮箱',
    true,
    'owner-a'
  ])
  assert.equal(row.enabled, true)
})

test('disabled managed accounts remain visible but cannot be used for delivery', async () => {
  let values
  await materializeManagedMailAccount({
    sourceKey: 'managed.0123456789abcdef01234567',
    label: '待验证邮箱',
    config: { ownerUsername: 'owner-a', deliveryEnabled: false, ingestEnabled: false }
  }, {
    queryFn: async (_sql, params) => {
      values = params
      return { rows: [{ id: 'id', enabled: params[2] }] }
    }
  })
  assert.equal(values[2], false)
})

test('a transient database failure never misreports an already-saved integration as unsaved', async () => {
  const internal = await materializeManagedMailAccountBestEffort({
    sourceKey: 'managed.0123456789abcdef01234567',
    label: '工作邮箱',
    config: { ownerUsername: 'owner-a' }
  }, {
    materializeFn: async () => {
      const error = new Error('connection string contained a private credential')
      error.code = '57P01'
      throw error
    }
  })
  assert.deepEqual(internal, {
    saved: true,
    materialized: false,
    warning: MANAGED_MAIL_MATERIALIZATION_WARNING,
    errorCode: '57P01'
  })
  assert.equal(JSON.stringify(internal).includes('private credential'), false)
})

test('runtime reconciliation retries every saved managed account and eventually materializes it', async () => {
  const runtimes = [
    {
      emailManagedAccount: true,
      emailSourceKey: 'mxroute',
      emailAccountLabel: '个人邮箱',
      emailOwnerUsername: 'owner-a',
      mailDeliveryEnabled: true,
      emailIngestEnabled: true
    },
    {
      emailManagedAccount: true,
      emailSourceKey: 'managed.0123456789abcdef01234567',
      emailAccountLabel: '工作邮箱',
      emailOwnerUsername: 'owner-a',
      mailDeliveryEnabled: true,
      emailIngestEnabled: false
    },
    {
      emailManagedAccount: false,
      emailSourceKey: 'environment-only'
    }
  ]
  let available = false
  const attempts = []
  const materializeFn = async (accountState) => {
    attempts.push(accountState)
    if (!available) throw Object.assign(new Error('database restarting'), { code: '57P01' })
    return { source_key: accountState.sourceKey }
  }

  const first = await reconcileManagedMailRuntimeAccounts(runtimes, { materializeFn })
  assert.deepEqual({ attempted: first.attempted, materialized: first.materialized, pending: first.pending }, {
    attempted: 2,
    materialized: 0,
    pending: 2
  })
  available = true
  const second = await reconcileManagedMailRuntimeAccounts(runtimes, { materializeFn })
  assert.deepEqual({ attempted: second.attempted, materialized: second.materialized, pending: second.pending }, {
    attempted: 2,
    materialized: 2,
    pending: 0
  })
  assert.equal(attempts.length, 4)
  assert.equal(attempts.every((account) => account.sourceKey !== 'environment-only'), true)
  assert.deepEqual(attempts.at(-1), {
    sourceKey: 'managed.0123456789abcdef01234567',
    label: '工作邮箱',
    config: {
      ownerUsername: 'owner-a',
      deliveryEnabled: true,
      ingestEnabled: false
    }
  })
})

test('managed account row snapshots are bounded to exact approved owner and source identities', async () => {
  const queries = []
  const snapshot = await snapshotManagedMailAccountRows([
    {
      emailManagedAccount: true,
      emailOwnerUsername: 'owner-a',
      emailSourceKey: 'mxroute'
    },
    {
      emailManagedAccount: true,
      emailOwnerUsername: 'owner-a',
      emailSourceKey: 'managed.0123456789abcdef01234567'
    },
    {
      emailManagedAccount: false,
      emailOwnerUsername: 'owner-a',
      emailSourceKey: 'environment-only'
    }
  ], {
    queryFn: async (sql, values) => {
      queries.push({ sql, values })
      if (values[1] !== 'mxroute') {
        return {
          rows: [{
            owner_user_id: '22222222-2222-4222-8222-222222222222',
            id: null
          }]
        }
      }
      return {
        rows: [{
          owner_user_id: '22222222-2222-4222-8222-222222222222',
          id: '11111111-1111-4111-8111-111111111111',
          user_id: '22222222-2222-4222-8222-222222222222',
          source_key: 'mxroute',
          label: '旧主邮箱',
          enabled: true,
          updated_at: '2026-09-01T00:00:00.000Z'
        }]
      }
    }
  })
  assert.equal(queries.length, 2)
  assert.equal(queries.every(({ sql }) => /owner\.status = 'approved'/.test(sql)), true)
  assert.deepEqual(queries.map(({ values }) => values), [
    ['owner-a', 'mxroute'],
    ['owner-a', 'managed.0123456789abcdef01234567']
  ])
  assert.equal(snapshot.accounts[0].row.label, '旧主邮箱')
  assert.equal(snapshot.accounts[1].row, null)
})

test('managed account row rollback restores old rows and removes only newly materialized identities', async () => {
  const calls = []
  await restoreManagedMailAccountRows({
    accounts: [
      {
        ownerUsername: 'owner-a',
        sourceKey: 'mxroute',
        row: {
          id: '11111111-1111-4111-8111-111111111111',
          userId: '22222222-2222-4222-8222-222222222222',
          sourceKey: 'mxroute',
          label: '旧主邮箱',
          enabled: true,
          updatedAt: '2026-09-01T00:00:00.000Z'
        }
      },
      {
        ownerUsername: 'owner-a',
        ownerUserId: '22222222-2222-4222-8222-222222222222',
        sourceKey: 'managed.0123456789abcdef01234567',
        row: null
      }
    ]
  }, {
    queryFn: async (sql, values) => {
      calls.push({ sql, values })
      return { rowCount: 1, rows: [] }
    }
  })
  assert.equal(calls.length, 2)
  assert.match(calls[0].sql, /UPDATE email_accounts/)
  assert.deepEqual(calls[0].values, [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'mxroute',
    '旧主邮箱',
    true,
    '2026-09-01T00:00:00.000Z'
  ])
  assert.match(calls[1].sql, /DELETE FROM email_accounts/)
  assert.deepEqual(calls[1].values, [
    '22222222-2222-4222-8222-222222222222',
    'managed.0123456789abcdef01234567'
  ])
})
