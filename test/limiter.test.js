import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createConcurrencyLimiter, createUploadGate, LimiterTimeoutError } from '../limiter.js'

const tick = () => new Promise((r) => setImmediate(r))

test('createConcurrencyLimiter: libera em ordem de chegada e nunca passa do máximo', async () => {
  const limiter = createConcurrencyLimiter({ max: 2 })
  let running = 0
  let peak = 0
  const order = []
  const job = (id) =>
    limiter.run(async () => {
      running++
      peak = Math.max(peak, running)
      order.push(id)
      await tick()
      running--
    })
  await Promise.all([1, 2, 3, 4, 5].map(job))
  assert.equal(peak, 2)
  assert.deepEqual(order, [1, 2, 3, 4, 5])
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0, max: 2 })
})

test('createConcurrencyLimiter: release é idempotente', async () => {
  const limiter = createConcurrencyLimiter({ max: 1 })
  const release = await limiter.acquire()
  release()
  release()
  assert.equal(limiter.stats().active, 0)
  const again = await limiter.acquire()
  assert.equal(limiter.stats().active, 1)
  again()
})

test('createConcurrencyLimiter: timeout tira da fila com LimiterTimeoutError', async () => {
  const limiter = createConcurrencyLimiter({ max: 1 })
  const release = await limiter.acquire()
  await assert.rejects(limiter.acquire({ timeoutMs: 20 }), LimiterTimeoutError)
  assert.equal(limiter.stats().waiting, 0)
  release()
  assert.equal(limiter.stats().active, 0)
})

test('createConcurrencyLimiter: abort tira da fila e não consome a vaga', async () => {
  const limiter = createConcurrencyLimiter({ max: 1 })
  const release = await limiter.acquire()
  const controller = new AbortController()
  const waiting = limiter.acquire({ signal: controller.signal })
  assert.equal(limiter.stats().waiting, 1)
  controller.abort(new Error('cliente foi embora'))
  await assert.rejects(waiting, /cliente foi embora/)
  release()
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0, max: 1 })
})

test('createConcurrencyLimiter: max inválido é recusado', () => {
  assert.throws(() => createConcurrencyLimiter({ max: 0 }))
})

// Express real com o gate na frente do parser grande, como no server.js.
async function gatedServer({ max, timeoutMs, hold }) {
  const limiter = createConcurrencyLimiter({ max })
  const gate = createUploadGate({ limiter, timeoutMs, smallBodyBytes: 1024, retryAfterSeconds: 7 })
  const app = express()
  let peak = 0
  app.post('/m', gate, express.json({ limit: '5mb' }), async (req, res) => {
    peak = Math.max(peak, limiter.stats().active)
    await hold(req)
    res.json({ size: req.body.data.length })
  })
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const url = `http://127.0.0.1:${server.address().port}/m`
  return { limiter, url, peak: () => peak, close: () => new Promise((r) => server.close(r)) }
}

const post = (url, size) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(size) }) })

test('createUploadGate: corpo grande ocupa vaga; o excedente espera e é atendido', async () => {
  let open
  const gateOpen = new Promise((r) => (open = r))
  const srv = await gatedServer({ max: 2, timeoutMs: 5_000, hold: () => gateOpen })
  try {
    const requests = [1, 2, 3, 4].map(() => post(srv.url, 100_000))
    while (srv.limiter.stats().waiting < 2) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(srv.limiter.stats(), { active: 2, waiting: 2, max: 2 })
    open()
    const responses = await Promise.all(requests)
    assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200])
    assert.equal(srv.peak(), 2)
    // A vaga volta quando a resposta termina.
    while (srv.limiter.stats().active > 0) await new Promise((r) => setTimeout(r, 10))
  } finally {
    await srv.close()
  }
})

test('createUploadGate: sem vaga dentro do timeout responde 503 com Retry-After, sem ler o corpo', async () => {
  let open
  const gateOpen = new Promise((r) => (open = r))
  const srv = await gatedServer({ max: 1, timeoutMs: 50, hold: () => gateOpen })
  try {
    const first = post(srv.url, 100_000)
    while (srv.limiter.stats().active < 1) await new Promise((r) => setTimeout(r, 10))
    const second = await post(srv.url, 100_000)
    assert.equal(second.status, 503)
    assert.equal(second.headers.get('retry-after'), '7')
    assert.match((await second.json()).error, /máximo 1 ao mesmo tempo/)
    open()
    assert.equal((await first).status, 200)
  } finally {
    await srv.close()
  }
})

test('createUploadGate: corpo pequeno (texto) não ocupa vaga', async () => {
  let open
  const gateOpen = new Promise((r) => (open = r))
  const srv = await gatedServer({ max: 1, timeoutMs: 50, hold: (req) => (req.body.data.length > 1000 ? gateOpen : undefined) })
  try {
    const big = post(srv.url, 100_000)
    while (srv.limiter.stats().active < 1) await new Promise((r) => setTimeout(r, 10))
    const small = await post(srv.url, 10)
    assert.equal(small.status, 200)
    open()
    assert.equal((await big).status, 200)
  } finally {
    await srv.close()
  }
})

test('createUploadGate: cliente que desiste na fila libera o lugar', async () => {
  let open
  const gateOpen = new Promise((r) => (open = r))
  const srv = await gatedServer({ max: 1, timeoutMs: 5_000, hold: () => gateOpen })
  try {
    const first = post(srv.url, 100_000)
    while (srv.limiter.stats().active < 1) await new Promise((r) => setTimeout(r, 10))
    const controller = new AbortController()
    const quitter = fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(100_000) }),
      signal: controller.signal
    }).catch(() => 'abortado')
    while (srv.limiter.stats().waiting < 1) await new Promise((r) => setTimeout(r, 10))
    controller.abort()
    assert.equal(await quitter, 'abortado')
    while (srv.limiter.stats().waiting > 0) await new Promise((r) => setTimeout(r, 10))
    open()
    assert.equal((await first).status, 200)
    while (srv.limiter.stats().active > 0) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(srv.limiter.stats(), { active: 0, waiting: 0, max: 1 })
  } finally {
    await srv.close()
  }
})
