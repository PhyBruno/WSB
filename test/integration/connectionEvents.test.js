import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { lockDatabase } from './dbLock.js'

// wa_connection_events + logout contra um Postgres de teste, como os outros
// arquivos de integração:
//   TEST_DATABASE_URL=postgres://user:senha@localhost:5432/wsb_test npm test
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const skip = TEST_DATABASE_URL ? false : 'defina TEST_DATABASE_URL para rodar o teste de integração de eventos de conexão'

const SESSION = '5511900000097'
const silent = { error() {}, warn() {} }

let db, authState, events, logoutModule, unlockDatabase

before(async () => {
  if (skip) return
  process.env.DATABASE_URL = TEST_DATABASE_URL
  db = await import('../../db.js')
  authState = await import('../../postgresAuthState.js')
  const eventsModule = await import('../../connectionEvents.js')
  logoutModule = await import('../../sessionLogout.js')
  unlockDatabase = await lockDatabase(db.pool)
  await db.migrate()
  await db.pool.query('DELETE FROM wa_sessions WHERE id = $1', [SESSION])
  await db.pool.query(`INSERT INTO wa_sessions (id, status) VALUES ($1, 'connected')`, [SESSION])
  events = eventsModule.createConnectionEventStore({ pool: db.pool, log: silent })
})

after(async () => {
  if (skip) return
  await db.pool.query('DELETE FROM wa_sessions WHERE id = $1', [SESSION])
  await unlockDatabase()
  await db.pool.end()
})

test('grava e lista eventos de conexão, mais recentes primeiro', { skip }, async () => {
  await events.record(SESSION, 'open')
  await events.record(SESSION, 'close', {
    statusCode: 428,
    reason: 'connectionClosed',
    message: 'Connection Terminated',
    detail: '{"tag":"stream:error"}',
    uptimeMs: 3_000_000
  })

  const list = await events.list(SESSION, 10)
  assert.equal(list.length, 2)
  assert.equal(list[0].event, 'close')
  assert.equal(list[0].statusCode, 428)
  assert.equal(list[0].reason, 'connectionClosed')
  assert.equal(list[0].uptimeMs, 3_000_000)
  assert.ok(list[0].createdAt instanceof Date)
  assert.equal(list[1].event, 'open')
  assert.equal((await events.list(SESSION, 1)).length, 1)
})

test('limpeza apaga só eventos mais velhos que a retenção', { skip }, async () => {
  await db.pool.query(
    `INSERT INTO wa_connection_events (session_id, event, created_at) VALUES ($1, 'close', now() - interval '40 days')`,
    [SESSION]
  )
  const before = (await events.list(SESSION, 100)).length
  const removed = await events.purgeOlderThan(30)
  assert.equal(removed, 1)
  assert.equal((await events.list(SESSION, 100)).length, before - 1)
})

test('logout apaga as credenciais mas mantém sessão, eventos e webhooks', { skip }, async () => {
  await db.pool.query(
    `INSERT INTO wa_auth_state (session_id, key, value) VALUES ($1, 'creds', '{}'), ($1, 'pre-key-1', '{}')`,
    [SESSION]
  )
  await db.pool.query(
    `INSERT INTO wa_webhooks (session_id, url, events) VALUES ($1, 'https://receptor.example/hook', '{MESSAGES_UPSERT}')`,
    [SESSION]
  )

  const logout = logoutModule.createSessionLogout({
    sessions: new Map(),
    sessionExists: async (id) => (await db.pool.query('SELECT 1 FROM wa_sessions WHERE id = $1', [id])).rowCount > 0,
    wipeAuthState: authState.wipeAuthState,
    setSessionStatus: (id, status) => db.pool.query('UPDATE wa_sessions SET status = $2 WHERE id = $1', [id, status]),
    clearSessionTimers: () => {},
    log: silent
  })

  assert.deepEqual(await logout(SESSION), { id: SESSION, status: 'logged_out', remoteLogout: false })

  const count = async (table) =>
    Number((await db.pool.query(`SELECT count(*) FROM ${table} WHERE session_id = $1`, [SESSION])).rows[0].count)
  assert.equal(await count('wa_auth_state'), 0)
  assert.equal(await count('wa_webhooks'), 1)
  assert.ok((await count('wa_connection_events')) > 0)
  const { rows } = await db.pool.query('SELECT status FROM wa_sessions WHERE id = $1', [SESSION])
  assert.equal(rows[0].status, 'logged_out')

  assert.equal(await logout('5511900000000'), null)
})

test('DELETE da sessão leva os eventos junto (cascade)', { skip }, async () => {
  await db.pool.query('DELETE FROM wa_sessions WHERE id = $1', [SESSION])
  assert.deepEqual(await events.list(SESSION, 10), [])
})
