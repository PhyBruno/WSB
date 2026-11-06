import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { BufferJSON } from 'baileys'
import {
  eventName,
  eventSlug,
  computeBackoff,
  classifyResult,
  buildEnvelope,
  buildHeaders,
  signJwtHS256,
  buildWebhookJwt,
  redactUrl,
  formatError,
  createDispatcher
} from '../webhookDispatcher.js'
import { prepareMessage } from '../inbound.js'
import { createGroupMetadataCache } from '../groupMetadata.js'

const RETRY = { initialDelayMs: 5000, maxDelayMs: 300_000 }

// ---------------- nomes de evento ----------------

test('eventName e eventSlug seguem a Evolution', () => {
  assert.equal(eventName('MESSAGES_UPSERT'), 'messages.upsert')
  assert.equal(eventName('SEND_MESSAGE'), 'send.message')
  assert.equal(eventName('QRCODE_UPDATED'), 'qrcode.updated')
  assert.equal(eventSlug('MESSAGES_UPSERT'), 'messages-upsert')
  assert.equal(eventSlug('CONNECTION_UPDATE'), 'connection-update')
})

// ---------------- (a) computeBackoff ----------------

test('computeBackoff é exponencial com teto, sem jitter quando random = 0.5', () => {
  const noJitter = () => 0.5
  assert.equal(computeBackoff(1, RETRY, noJitter), 5000)
  assert.equal(computeBackoff(2, RETRY, noJitter), 10_000)
  assert.equal(computeBackoff(3, RETRY, noJitter), 20_000)
  assert.equal(computeBackoff(7, RETRY, noJitter), 300_000)
  assert.equal(computeBackoff(14, RETRY, noJitter), 300_000)
})

test('computeBackoff aplica jitter de ±20% e nunca fica abaixo do atraso inicial', () => {
  assert.equal(computeBackoff(3, RETRY, () => 0), 16_000)
  assert.equal(computeBackoff(3, RETRY, () => 1), 24_000)
  assert.equal(computeBackoff(1, RETRY, () => 0), 5000, 'nunca abaixo do inicial')
  assert.ok(computeBackoff(14, RETRY, () => 1) <= 300_000, 'nunca acima do teto')
})

test('com os defaults (15 tentativas), a janela de retentativa passa de 30 min (SC-003)', () => {
  let total = 0
  for (let attempt = 1; attempt < 15; attempt++) total += computeBackoff(attempt, RETRY, () => 0.5)
  assert.ok(total >= 30 * 60_000, `janela de ${total}ms`)
  assert.equal(total, 2_715_000)
})

// ---------------- (b) classifyResult ----------------

test('classifyResult', () => {
  for (const code of [200, 201, 204, 299]) assert.equal(classifyResult({ statusCode: code }), 'delivered', String(code))
  for (const code of [400, 401, 403, 404, 422]) assert.equal(classifyResult({ statusCode: code }), 'failed', String(code))
  for (const code of [408, 429, 500, 502, 503, 504]) assert.equal(classifyResult({ statusCode: code }), 'retry', String(code))
  for (const code of [301, 302, 307, 308]) assert.equal(classifyResult({ statusCode: code }), 'failed', `${code}: redirect não é seguido`)
  assert.equal(classifyResult({ statusCode: null, error: new Error('ECONNREFUSED') }), 'retry')
})

// ---------------- (c) buildEnvelope ----------------

const NOW = new Date('2026-10-23T10:15:30.123Z')

test('buildEnvelope monta o envelope da Evolution', () => {
  const { url, body } = buildEnvelope({
    event: 'MESSAGES_UPSERT',
    instance: '5511900000001',
    data: { a: 1 },
    url: 'https://texteaseai.example/webhooks/wsb',
    byEvents: false,
    sender: '5511900000001:7@s.whatsapp.net',
    serverUrl: null,
    now: NOW,
    tzOffsetMinutes: 0
  })
  assert.equal(url, 'https://texteaseai.example/webhooks/wsb')
  assert.deepEqual(body, {
    event: 'messages.upsert',
    instance: '5511900000001',
    data: { a: 1 },
    destination: 'https://texteaseai.example/webhooks/wsb',
    date_time: '2026-10-23T10:15:30.123Z',
    sender: '5511900000001@s.whatsapp.net',
    server_url: null,
    apikey: null
  })
})

test('buildEnvelope: date_time no horário local (cálculo da Evolution), sender null sem conexão', () => {
  const { body } = buildEnvelope({ event: 'CONNECTION_UPDATE', instance: '1', data: {}, url: 'https://x.example', now: NOW, tzOffsetMinutes: 180 })
  assert.equal(body.date_time, '2026-10-23T07:15:30.123Z')
  assert.equal(body.sender, null)
  assert.equal(body.event, 'connection.update')
})

test('buildEnvelope com byEvents acrescenta o evento em kebab no path, preservando a query', () => {
  const build = (url) => buildEnvelope({ event: 'MESSAGES_UPSERT', instance: '1', data: {}, url, byEvents: true, now: NOW }).url
  assert.equal(build('https://x.example/hook'), 'https://x.example/hook/messages-upsert')
  assert.equal(build('https://x.example/hook/'), 'https://x.example/hook/messages-upsert')
  assert.equal(build('https://x.example/hook?token=1'), 'https://x.example/hook/messages-upsert?token=1')
  const { body } = buildEnvelope({ event: 'MESSAGES_UPSERT', instance: '1', data: {}, url: 'https://x.example/hook', byEvents: true, now: NOW })
  assert.equal(body.destination, 'https://x.example/hook', 'destination é a URL cadastrada')
})

// ---------------- (d) buildHeaders ----------------

test('buildHeaders monta os cabeçalhos da Evolution + X-Delivery-ID', () => {
  const headers = buildHeaders({ instance: '5511900000001', event: 'MESSAGES_UPSERT', deliveryId: 4821, headers: { 'X-Cliente': 'loja' }, nowMs: 1792750000000 })
  assert.deepEqual(headers, {
    'X-Cliente': 'loja',
    'Content-Type': 'application/json',
    'User-Agent': 'WSB-Webhook/1.0',
    'X-Instance-ID': '5511900000001',
    'X-Instance-Name': '5511900000001',
    'X-Event-Type': 'messages.upsert',
    'X-Timestamp': '1792750000000',
    'X-Delivery-ID': '4821'
  })
})

test('buildHeaders: jwt_key vira Authorization Bearer e não é repassado', () => {
  const headers = buildHeaders({ instance: '1', event: 'MESSAGES_UPSERT', deliveryId: 1, headers: { jwt_key: 'segredo', Authorization: 'x' }, nowMs: 1792750000000 })
  assert.equal('jwt_key' in headers, false)
  const [, token] = headers.Authorization.split(' ')
  assert.match(headers.Authorization, /^Bearer /)
  const [h, p, s] = token.split('.')
  const expected = crypto.createHmac('sha256', 'segredo').update(`${h}.${p}`).digest('base64url')
  assert.equal(s, expected)
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
  assert.deepEqual(payload, { iat: 1792750000, exp: 1792750600, app: 'evolution', action: 'webhook' })
})

test('buildHeaders: personalizado não sobrescreve os fixos, nem com outra caixa', () => {
  const headers = buildHeaders({
    instance: '1',
    event: 'MESSAGES_UPSERT',
    deliveryId: 7,
    headers: { 'x-delivery-id': 'spoof', 'user-agent': 'outro', 'CONTENT-TYPE': 'text/plain', 'X-Ok': 'sim' },
    nowMs: 1
  })
  const lower = Object.keys(headers).map((name) => name.toLowerCase())
  assert.equal(new Set(lower).size, lower.length, 'nenhum nome repetido com caixa diferente')
  assert.equal(headers['X-Delivery-ID'], '7')
  assert.equal(headers['User-Agent'], 'WSB-Webhook/1.0')
  assert.equal(headers['X-Ok'], 'sim')
})

// ---------------- (e) JWT HS256 ----------------

test('signJwtHS256 bate com o vetor conhecido do jwt.io', () => {
  const token = signJwtHS256({ sub: '1234567890', name: 'John Doe', iat: 1516239022 }, 'your-256-bit-secret')
  assert.equal(
    token,
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  )
})

test('buildWebhookJwt usa exp de 10 min e o payload da Evolution', () => {
  const token = buildWebhookJwt('s', 1000)
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  assert.deepEqual(payload, { iat: 1000, exp: 1600, app: 'evolution', action: 'webhook' })
})

// ---------------- (f) contrato (SC-005) ----------------

const load = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf-8'), BufferJSON.reviver)

// Tipo "JSON" de um valor; null e ausente contam como o mesmo (a Evolution omite
// contextInfo vazio, o WSB manda null — ver test/fixtures/evolution/README.md).
const typeOf = (value) => (value === null || value === undefined ? 'empty' : Array.isArray(value) ? 'array' : typeof value)
const shape = (obj) =>
  Object.fromEntries(
    Object.entries(obj)
      .filter(([, v]) => typeOf(v) !== 'empty')
      .map(([k, v]) => [k, typeOf(v)])
      .sort(([a], [b]) => a.localeCompare(b))
  )
const get = (obj, path) => path.split('.').reduce((acc, part) => acc?.[part], obj)

const CONTRACT_CASES = {
  conversation: 'message.conversation',
  image: 'message.imageMessage.mimetype',
  reaction: 'message.reactionMessage.text',
  listResponse: 'message.listResponseMessage.singleSelectReply.selectedRowId',
  interactiveResponse: 'message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson'
}

for (const [name, contentPath] of Object.entries(CONTRACT_CASES)) {
  test(`contrato com a Evolution 2.4.0-rc2: ${name}`, () => {
    const evolution = load(`./fixtures/evolution/${name}.json`)
    const received = load(`./fixtures/messages/${name}.json`)
    const data = prepareMessage(received, { instanceId: '5511900000001', key: received.key })
    const { body } = buildEnvelope({
      event: 'MESSAGES_UPSERT',
      instance: '5511900000001',
      data,
      url: 'https://texteaseai.example/webhooks/wsb',
      sender: '5511900000001@s.whatsapp.net',
      serverUrl: 'https://wsb.example',
      now: NOW
    })

    // Divergência 2 (documentada): apikey é sempre null no WSB.
    const envelopeShape = shape({ ...body, apikey: 'omitida' })
    assert.deepEqual(envelopeShape, shape({ ...evolution, apikey: 'omitida' }), 'envelope')
    assert.equal(body.apikey, null)
    assert.deepEqual(shape(body.data), shape(evolution.data), 'data')
    assert.deepEqual(shape(body.data.key), shape(evolution.data.key), 'data.key')
    assert.equal(body.data.messageType, evolution.data.messageType)
    assert.equal(get(body.data, contentPath), get(evolution.data, contentPath), contentPath)
  })
}

// ---------------- (g) segredos fora de log ----------------

test('redactUrl deixa só protocolo e host (path, query e credenciais podem ter token)', () => {
  assert.equal(redactUrl('https://user:senha@x.example/hook?token=abc#frag'), 'https://x.example')
  assert.equal(redactUrl('https://hooks.slack.example/services/T0/B0/SEGREDO'), 'https://hooks.slack.example')
  assert.equal(redactUrl('http://texteaseai:8080/webhooks/wsb'), 'http://texteaseai:8080')
  assert.equal(redactUrl('não é url'), '[url inválida]')
})

test('formatError descreve timeout e rede sem cabeçalhos nem URL', () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  assert.equal(formatError(timeout, { timeoutMs: 10_000 }), 'timeout após 10000ms')
  const network = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  assert.equal(formatError(network, { timeoutMs: 10_000 }), 'erro de rede: ECONNREFUSED')
  assert.equal(formatError(null, { statusCode: 503 }), 'HTTP 503')
  const withHeaders = Object.assign(new Error('falhou'), { headers: { Authorization: 'Bearer segredo' } })
  assert.equal(formatError(withHeaders, {}).includes('segredo'), false)
  // Erro real do Node: a mensagem repete a URL inteira.
  const withUrl = new TypeError('Request cannot be constructed from a URL that includes credentials: https://u:s3cret@x.example/h?token=ABC')
  const text = formatError(withUrl, {})
  assert.equal(/s3cret|token=ABC|x\.example/.test(text), false, text)
})

// ---------------- (h) data.groupSubject no envio ----------------

const GROUP = '120363000000000000@g.us'
const silentLog = { info() {}, warn() {}, debug() {}, error() {} }

// Outbox em memória: entende só as consultas de claim e de resultado do createDispatcher.
function fakeOutbox(deliveries) {
  const updates = []
  return {
    updates,
    async query(sql, params) {
      if (sql.includes('SELECT x.webhook_id')) {
        const ids = [...new Set(deliveries.filter((d) => d.status === 'pending').map((d) => d.webhook_id))]
        return { rows: ids.map((webhook_id) => ({ webhook_id })) }
      }
      if (sql.includes('WITH claimed')) {
        const [limit, , webhookId] = params
        const rows = deliveries.filter((d) => d.status === 'pending' && d.webhook_id === webhookId).slice(0, limit)
        for (const d of rows) {
          d.status = 'delivering'
          d.attempts++
        }
        return {
          rows: rows.map((d) => ({ ...d, url: 'https://receptor.example/hook', base64: false, by_events: false, headers: {}, session_jid: null }))
        }
      }
      if (sql.includes('UPDATE wa_webhook_deliveries')) {
        updates.push(params)
        deliveries.find((d) => d.id === params[0]).status = sql.match(/status = '(\w+)'/)[1]
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`consulta inesperada: ${sql}`)
    }
  }
}

const delivery = (id, event, remoteJid) => ({
  id,
  webhook_id: 'w1',
  session_id: '5511900000001',
  event,
  status: 'pending',
  attempts: 0,
  payload: { key: { remoteJid, fromMe: false, id: `K${id}` }, message: { conversation: 'oi' }, messageType: 'conversation' }
})

// fetch substituído: guarda o corpo de cada POST e responde o status de responder(n).
async function withFetch(responder, fn) {
  const original = globalThis.fetch
  const posts = []
  globalThis.fetch = async (url, options) => {
    posts.push(JSON.parse(options.body))
    return { status: responder(posts.length), body: null }
  }
  try {
    return await fn(posts)
  } finally {
    globalThis.fetch = original
  }
}

const DISPATCHER_CONFIG = {
  timeoutMs: 1000,
  concurrency: 5,
  concurrencyPerWebhook: 5,
  retryMaxAttempts: 15,
  retryInitialDelayMs: 5000,
  retryMaxDelayMs: 300_000,
  mediaTimeoutMs: 1000
}
const noCipher = { decryptHeaders: () => ({}) }

const dispatcherWith = (deliveries, groups) => {
  const pool = fakeOutbox(deliveries)
  return { pool, dispatcher: createDispatcher({ pool, cipher: noCipher, config: DISPATCHER_CONFIG, groups, log: silentLog }) }
}

// Cache de grupos real (groupMetadata.js) sobre um wa_groups vazio e um
// socket cujo groupMetadata responde answer(jid).
const groupCache = (calls, answer) =>
  createGroupMetadataCache({
    pool: { query: async () => ({ rows: [] }) },
    getSocket: () => ({
      groupMetadata: async (jid) => {
        calls.push(jid)
        return answer(jid)
      }
    }),
    config: { timeoutMs: 50 },
    log: silentLog
  })

test('messages.upsert e send.message de grupo ganham data.groupSubject; individual não', async () => {
  const calls = []
  const groups = groupCache(calls, (jid) => ({ id: jid, subject: 'Grupo Exemplo' }))
  const deliveries = [
    delivery(1, 'MESSAGES_UPSERT', GROUP),
    delivery(2, 'SEND_MESSAGE', GROUP),
    delivery(3, 'MESSAGES_UPSERT', '5511988887777@s.whatsapp.net')
  ]
  const { pool, dispatcher } = dispatcherWith(deliveries, groups)
  await withFetch(
    () => 200,
    async (posts) => {
      await dispatcher.processBatch()
      const byKey = Object.fromEntries(posts.map((body) => [body.data.key.id, body.data]))
      assert.equal(byKey.K1.groupSubject, 'Grupo Exemplo')
      assert.equal(byKey.K2.groupSubject, 'Grupo Exemplo')
      assert.equal('groupSubject' in byKey.K3, false, 'conversa individual não ganha o campo')
    }
  )
  assert.equal(calls.length, 1, 'um grupo, uma consulta')
  assert.ok(deliveries.every((d) => d.status === 'delivered'))
  for (const d of deliveries) assert.equal('groupSubject' in d.payload, false, 'o payload do outbox não muda')
  assert.equal(JSON.stringify(pool.updates).includes('groupSubject'), false, 'nenhuma gravação leva o nome')
})

test('consulta do nome falhando: groupSubject null e a entrega acontece', async () => {
  const groups = groupCache([], () => {
    throw new Error('rate-overlimit')
  })
  const deliveries = [delivery(1, 'MESSAGES_UPSERT', GROUP)]
  const { dispatcher } = dispatcherWith(deliveries, groups)
  await withFetch(
    () => 200,
    async (posts) => {
      await dispatcher.processBatch()
      assert.equal(posts.length, 1)
      assert.equal(posts[0].data.groupSubject, null)
    }
  )
  assert.equal(deliveries[0].status, 'delivered')
})

test('consulta do nome sem resposta não segura a entrega além do timeout', async () => {
  const groups = groupCache([], () => new Promise(() => {}))
  const deliveries = [delivery(1, 'MESSAGES_UPSERT', GROUP)]
  const { dispatcher } = dispatcherWith(deliveries, groups)
  const started = Date.now()
  await withFetch(
    () => 200,
    async (posts) => {
      await dispatcher.processBatch()
      assert.equal(posts[0].data.groupSubject, null)
    }
  )
  assert.ok(Date.now() - started < 500)
  assert.equal(deliveries[0].status, 'delivered')
})

test('retentativa recalcula o nome sem consultar o WhatsApp de novo', async () => {
  const calls = []
  const groups = groupCache(calls, (jid) => ({ id: jid, subject: 'Grupo Exemplo' }))
  const deliveries = [delivery(1, 'MESSAGES_UPSERT', GROUP)]
  const { dispatcher } = dispatcherWith(deliveries, groups)
  await withFetch(
    (n) => (n === 1 ? 503 : 200),
    async (posts) => {
      await dispatcher.processBatch()
      assert.equal(deliveries[0].status, 'pending', '503 agenda retentativa')
      await dispatcher.processBatch()
      assert.equal(deliveries[0].status, 'delivered')
      assert.deepEqual(
        posts.map((body) => body.data.groupSubject),
        ['Grupo Exemplo', 'Grupo Exemplo']
      )
    }
  )
  assert.equal(calls.length, 1)
  assert.equal('groupSubject' in deliveries[0].payload, false)
})

test('sem o cache de grupos, o data sai como antes', async () => {
  const deliveries = [delivery(1, 'MESSAGES_UPSERT', GROUP)]
  const { dispatcher } = dispatcherWith(deliveries, null)
  await withFetch(
    () => 200,
    async (posts) => {
      await dispatcher.processBatch()
      assert.deepEqual(posts[0].data, deliveries[0].payload)
    }
  )
})

test('retentativa depois de falha na consulta respeita o cache negativo', async () => {
  const calls = []
  const groups = groupCache(calls, () => {
    throw new Error('rate-overlimit')
  })
  const deliveries = [delivery(1, 'MESSAGES_UPSERT', GROUP)]
  const { dispatcher } = dispatcherWith(deliveries, groups)
  await withFetch(
    (n) => (n === 1 ? 503 : 200),
    async (posts) => {
      await dispatcher.processBatch()
      await dispatcher.processBatch()
      assert.deepEqual(
        posts.map((body) => body.data.groupSubject),
        [null, null]
      )
    }
  )
  assert.equal(calls.length, 1, 'a retentativa não consulta o WhatsApp de novo dentro do cache negativo')
  assert.equal(deliveries[0].status, 'delivered')
})

// ---------------- mídia: vagas de montagem/envio ----------------

const PEER_JID = '5511988887777@s.whatsapp.net'

test('entregas com mídia: no máximo mediaConcurrency montando/enviando; sem mídia não espera vaga', async () => {
  const deliveries = []
  for (let i = 1; i <= 6; i++) {
    deliveries.push({
      id: i,
      webhook_id: `w${i}`,
      session_id: '5511900000001',
      event: 'MESSAGES_UPSERT',
      status: 'pending',
      attempts: 0,
      payload: { key: { remoteJid: PEER_JID, fromMe: false, id: `M${i}` }, messageType: 'imageMessage', message: { imageMessage: {} } }
    })
  }
  deliveries.push(delivery(7, 'MESSAGES_UPSERT', PEER_JID))
  deliveries[6].webhook_id = 'w7'

  const pool = fakeOutbox(deliveries)
  const claim = pool.query.bind(pool)
  pool.query = async (sql, params) => {
    const result = await claim(sql, params)
    if (sql.includes('WITH claimed')) for (const row of result.rows) row.base64 = true
    return result
  }
  const media = { download: async () => Buffer.from('arquivo') }
  const dispatcher = createDispatcher({
    pool,
    cipher: noCipher,
    config: { ...DISPATCHER_CONFIG, concurrency: 10, concurrencyPerWebhook: 10, mediaConcurrency: 2 },
    media,
    log: silentLog
  })

  const original = globalThis.fetch
  let active = 0
  let peak = 0
  const release = []
  const textPosted = []
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body)
    if (!body.data.message.base64) {
      textPosted.push(body.data.key.id)
      return { status: 200, body: null }
    }
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => release.push(resolve))
    active--
    return { status: 200, body: null }
  }
  try {
    const batch = dispatcher.processBatch()
    for (let i = 0; i < 50 && release.length < 2; i++) await new Promise((r) => setImmediate(r))
    assert.equal(release.length, 2, 'só 2 entregas com mídia chegam ao POST')
    assert.deepEqual(dispatcher.stats().media, { active: 2, waiting: 4, max: 2 })
    assert.deepEqual(textPosted, ['K7'], 'a entrega sem mídia não ficou na fila')
    while (deliveries.some((d) => d.status === 'delivering')) {
      release.shift()?.()
      await new Promise((r) => setImmediate(r))
    }
    await batch
  } finally {
    globalThis.fetch = original
  }
  assert.equal(peak, 2)
  assert.ok(deliveries.every((d) => d.status === 'delivered'))
  assert.deepEqual(dispatcher.stats().media, { active: 0, waiting: 0, max: 2 })
})
