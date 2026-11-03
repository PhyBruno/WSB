import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Boom } from '@hapi/boom'
import {
  describeDisconnect,
  formatCloseLog,
  createConnectionEventStore,
  silenceSignalSessionDumps
} from '../connectionEvents.js'

const closeWith = (statusCode, message = 'falhou', data) => ({
  error: new Boom(message, { statusCode, data })
})

test('describeDisconnect traduz o código do baileys para o nome do DisconnectReason', () => {
  assert.deepEqual(describeDisconnect(closeWith(428, 'Connection Terminated')), {
    statusCode: 428,
    reason: 'connectionClosed',
    message: 'Connection Terminated',
    detail: null
  })
  assert.equal(describeDisconnect(closeWith(440)).reason, 'connectionReplaced')
  assert.equal(describeDisconnect(closeWith(401)).reason, 'loggedOut')
  assert.equal(describeDisconnect(closeWith(515)).reason, 'restartRequired')
})

test('describeDisconnect junta os nomes quando o código é compartilhado (408)', () => {
  assert.equal(describeDisconnect(closeWith(408)).reason, 'connectionLost/timedOut')
})

test('describeDisconnect marca código fora do enum como unknown', () => {
  assert.equal(describeDisconnect(closeWith(499)).reason, 'unknown')
})

test('describeDisconnect sem erro (close sem lastDisconnect) devolve tudo nulo', () => {
  assert.deepEqual(describeDisconnect(undefined), { statusCode: null, reason: null, message: null, detail: null })
  assert.deepEqual(describeDisconnect({}), { statusCode: null, reason: null, message: null, detail: null })
})

test('describeDisconnect serializa Boom.data (stream:error) sem despejar bytes crus', () => {
  const node = { tag: 'stream:error', attrs: { code: '503' }, content: Buffer.from('abcdef') }
  const { detail } = describeDisconnect(closeWith(503, 'Stream Errored', node))
  assert.match(detail, /"tag":"stream:error"/)
  assert.match(detail, /"code":"503"/)
  assert.match(detail, /<Buffer 6 bytes>/)
})

test('describeDisconnect trunca mensagem e detalhe longos', () => {
  const info = describeDisconnect(closeWith(500, 'x'.repeat(2000), { big: 'y'.repeat(5000) }))
  assert.equal(info.message.length, 501)
  assert.ok(info.message.endsWith('…'))
  assert.equal(info.detail.length, 1001)
})

test('formatCloseLog inclui código, motivo, mensagem e uptime legível', () => {
  const line = formatCloseLog('5511999999999', describeDisconnect(closeWith(428, 'Connection Terminated')), 3_125_000)
  assert.equal(
    line,
    '[5511999999999] conexão fechou: code=428 reason=connectionClosed message="Connection Terminated" uptime=52m05s'
  )
  const semCodigo = formatCloseLog('5511999999999', describeDisconnect(undefined), undefined)
  assert.equal(semCodigo, '[5511999999999] conexão fechou: code=n/a reason=n/a message=""')
  assert.match(formatCloseLog('1', describeDisconnect(closeWith(408)), 7_260_000), /uptime=2h01m/)
})

test('store.record grava os campos e nunca lança quando o banco falha', async () => {
  const calls = []
  const pool = { query: async (sql, params) => (calls.push({ sql, params }), { rowCount: 1 }) }
  const store = createConnectionEventStore({ pool })
  await store.record('5511999999999', 'close', {
    statusCode: 428,
    reason: 'connectionClosed',
    message: 'Connection Terminated',
    detail: null,
    uptimeMs: 1234.6
  })
  assert.match(calls[0].sql, /INSERT INTO wa_connection_events/)
  assert.deepEqual(calls[0].params, ['5511999999999', 'close', 428, 'connectionClosed', 'Connection Terminated', null, 1235])

  const errors = []
  const failing = createConnectionEventStore({
    pool: { query: async () => { throw new Error('banco fora') } },
    log: { error: (msg) => errors.push(msg) }
  })
  await failing.record('5511999999999', 'open')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /banco fora/)
})

test('silenceSignalSessionDumps descarta só os dumps de sessão do libsignal', () => {
  const printed = []
  const fakeConsole = { info: (...args) => printed.push(args) }
  const restore = silenceSignalSessionDumps(fakeConsole)

  fakeConsole.info('Closing session:', { privKey: Buffer.from('segredo') })
  fakeConsole.info('Opening session:', {})
  fakeConsole.info('Removing old closed session:', {})
  fakeConsole.info('Migrating session to:', 2)
  fakeConsole.info('outra coisa', 1)
  fakeConsole.info({ objeto: true })

  assert.deepEqual(printed, [['outra coisa', 1], [{ objeto: true }]])
  restore()
  fakeConsole.info('Closing session:', 'depois de restaurar')
  assert.equal(printed.length, 3)
})
