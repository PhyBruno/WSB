import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryMonitor, explainMemory, formatMemoryLine, readContainerMemoryLimit } from '../memoryMonitor.js'

const MB = 1024 * 1024

function fakeEventLoop() {
  return { count: 1, percentile: () => 12e6, reset() {}, enable() {}, disable() {} }
}

function harness({ used = 100, limit = 1000, spaces = {}, external = 10, buffers = 5, app = {}, rss, container = null } = {}) {
  const state = { used, limit, spaces, external, buffers, app, rss }
  const lines = { log: [], warn: [], error: [] }
  const timers = []
  const monitor = createMemoryMonitor({
    intervalMs: 60_000,
    alertIntervalMs: 10_000,
    warnRatio: 0.7,
    getAppStats: () => state.app,
    log: {
      log: (m) => lines.log.push(m),
      warn: (m) => lines.warn.push(m),
      error: (m) => lines.error.push(m)
    },
    containerLimitBytes: container == null ? null : container * MB,
    memoryUsage: () => ({ rss: (state.rss ?? state.used + 50) * MB, heapUsed: state.used * MB, external: state.external * MB, arrayBuffers: state.buffers * MB }),
    heapStatistics: () => ({ used_heap_size: state.used * MB, heap_size_limit: state.limit * MB }),
    heapSpaceStatistics: () =>
      Object.entries({ old_space: state.used, ...state.spaces }).map(([space_name, mbs]) => ({ space_name, space_used_size: mbs * MB })),
    eventLoop: fakeEventLoop(),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), { unref() {} }),
    clearTimer() {}
  })
  return { monitor, state, lines, timers }
}

test('abaixo do limite: uma linha normal com uso, heap e atividade', () => {
  const { monitor, lines } = harness({ used: 300, app: { sessions: { connected: 2 }, sentMessages: 7 } })
  monitor.count('5511', 'upsert', { messages: 3 })
  monitor.report()
  assert.equal(lines.warn.length, 0)
  assert.equal(lines.log.length, 1)
  assert.match(lines.log[0], /^memória: rss=350MB heap=300\/1000MB \(30%\)/)
  assert.match(lines.log[0], /sessões=\{connected=2\}/)
  assert.match(lines.log[0], /enviadas-em-cache=7/)
  assert.match(lines.log[0], /recebidas=3/)
})

test('Δheap é a diferença pra leitura anterior e a atividade zera a cada leitura', () => {
  const { monitor, state, lines } = harness({ used: 100 })
  monitor.count('5511', 'history', { messages: 50, chats: 2, contacts: 1 })
  monitor.report()
  state.used = 250
  monitor.report()
  assert.match(lines.log[0], /Δheap=\+0MB/)
  assert.match(lines.log[0], /histórico=\{mensagens=50,conversas=2,contatos=1\}/)
  assert.match(lines.log[1], /Δheap=\+150MB/)
  assert.doesNotMatch(lines.log[1], /histórico=/)
})

test('acima de MEMORY_WARN_RATIO vira ALERTA com suspeitos', () => {
  const { monitor, lines } = harness({
    used: 800,
    spaces: { large_object_space: 400 },
    app: { media: { cacheBytes: 90 * MB, cacheEntries: 4, active: 3, waiting: 2 } }
  })
  monitor.report()
  assert.equal(lines.log.length, 0)
  assert.match(lines.warn[0], /ALERTA heap acima de 70% do limite do V8 — rss=850MB heap=800\/1000MB \(80%\)/)
  const text = lines.warn.slice(1).join('\n')
  assert.match(text, /suspeito: objetos grandes = 400MB/)
  assert.match(text, /cache de mídia = 90MB em 4 item/)
  assert.match(text, /3 em andamento, 2 na fila/)
})

test('histórico grande é apontado como suspeito, com as sessões que mais mandaram', () => {
  const suspects = explainMemory({
    rssBytes: 500 * MB,
    externalBytes: 0,
    arrayBuffersBytes: 0,
    heap: { usedBytes: 400 * MB, largeObjectBytes: 0 },
    app: {},
    activity: { history: { messages: 52_000, chats: 900, contacts: 10, bySession: { 5566996004490: 50_000, 5511: 2_000 } } }
  })
  assert.equal(suspects.length, 1)
  assert.match(suspects[0], /52000 mensagem\(ns\) e 900 conversa\(s\)/)
  assert.match(suspects[0], /5566996004490=50000, 5511=2000/)
  assert.match(suspects[0], /parear um número novo/)
})

test('buffers fora do heap viram suspeito', () => {
  const suspects = explainMemory({
    rssBytes: 1000 * MB,
    externalBytes: 500 * MB,
    arrayBuffersBytes: 480 * MB,
    heap: { usedBytes: 100 * MB, largeObjectBytes: 0 },
    app: {},
    activity: {}
  })
  assert.match(suspects[0], /memória fora do heap = 500MB/)
})

test('sem nada que explique, aponta o Baileys/Postgres e o heap snapshot', () => {
  const suspects = explainMemory({
    rssBytes: 900 * MB,
    externalBytes: 10 * MB,
    arrayBuffersBytes: 10 * MB,
    heap: { usedBytes: 800 * MB, largeObjectBytes: 10 * MB },
    app: { sessions: { connected: 1 } },
    activity: {}
  })
  assert.equal(suspects.length, 1)
  assert.match(suspects[0], /nenhum contador da aplicação explica/)
  assert.match(suspects[0], /heap snapshot/)
})

test('o intervalo encurta quando o heap passa do limite de alerta', () => {
  const { monitor, state, timers } = harness({ used: 100 })
  monitor.start()
  assert.equal(timers.at(-1).ms, 60_000)
  state.used = 900
  timers.at(-1).fn()
  assert.equal(timers.at(-1).ms, 10_000)
  state.used = 100
  timers.at(-1).fn()
  assert.equal(timers.at(-1).ms, 60_000)
})

test('start loga o limite do heap e é desligado com intervalo 0', () => {
  const { monitor, lines } = harness({ limit: 1536 })
  monitor.start()
  assert.match(lines.log[0], /limite do heap do V8 = 1536MB/)

  const off = createMemoryMonitor({ intervalMs: 0, containerLimitBytes: null, log: { log: () => assert.fail('não deveria logar') } })
  off.start()
})

test('falha nos contadores da aplicação não impede a leitura', () => {
  const { monitor, lines } = harness({ app: undefined })
  const broken = createMemoryMonitor({
    getAppStats: () => {
      throw new Error('boom')
    },
    log: { log: (m) => lines.log.push(m), warn() {}, error: (m) => lines.error.push(m) },
    memoryUsage: () => ({ rss: MB, heapUsed: MB, external: 0, arrayBuffers: 0 }),
    heapStatistics: () => ({ used_heap_size: MB, heap_size_limit: 100 * MB }),
    heapSpaceStatistics: () => [],
    eventLoop: fakeEventLoop(),
    containerLimitBytes: null
  })
  broken.report()
  assert.match(lines.error[0], /falha ao coletar contadores da aplicação: boom/)
  assert.match(lines.log.at(-1), /^memória: rss=1MB/)
  assert.ok(monitor)
})

test('formatMemoryLine mostra mídia, grupos e webhooks', () => {
  const line = formatMemoryLine({
    rssBytes: 100 * MB,
    externalBytes: 0,
    arrayBuffersBytes: 0,
    heapDeltaBytes: -5 * MB,
    eventLoopP99Ms: null,
    heap: { usedBytes: 10 * MB, limitBytes: 100 * MB, ratio: 0.1, oldBytes: 0, newBytes: 0, largeObjectBytes: 0 },
    app: {
      media: { cacheBytes: 3 * MB, cacheEntries: 2, active: 1, waiting: 0 },
      groups: { groups: 5, withMetadata: 2, participants: 40 },
      dispatcher: { inFlight: 4 }
    },
    activity: {}
  })
  assert.match(line, /Δheap=-5MB/)
  assert.match(line, /mídia=\{cache=3MB\/2,downloads=1\+0\}/)
  assert.match(line, /grupos=\{cache=5,metadata=2,participantes=40\}/)
  assert.match(line, /webhooks-em-voo=4/)
  assert.doesNotMatch(line, /eventLoop/)
})

test('RSS perto do limite do container dispara ALERTA mesmo com o heap baixo (mídia fora do heap)', () => {
  const { monitor, lines } = harness({
    used: 300,
    rss: 1500,
    external: 900,
    buffers: 600,
    container: 2048,
    app: { dispatcher: { inFlight: 10, media: { active: 3, waiting: 7 } } }
  })
  monitor.report()
  assert.equal(lines.log.length, 0)
  assert.match(lines.warn[0], /ALERTA processo acima de 70% da memória do container — rss=1500\/2048MB \(73%\) heap=300\/1000MB \(30%\)/)
  const text = lines.warn.slice(1).join('\n')
  assert.match(text, /memória fora do heap = 900MB/)
  assert.match(text, /webhooks com mídia: 3 montando\/enviando, 7 na fila/)
})

test('heap e container altos ao mesmo tempo: o ALERTA cita os dois', () => {
  const { monitor, lines } = harness({ used: 800, rss: 1900, container: 2048 })
  monitor.report()
  assert.match(lines.warn[0], /ALERTA heap acima de 70% do limite do V8 e processo acima de 70% da memória do container/)
})

test('o intervalo encurta quando o RSS passa do limite de alerta do container', () => {
  const { monitor, state, timers } = harness({ used: 100, rss: 200, container: 1000 })
  monitor.start()
  assert.equal(timers.at(-1).ms, 60_000)
  state.rss = 800
  timers.at(-1).fn()
  assert.equal(timers.at(-1).ms, 10_000)
})

test('start informa o limite do container', () => {
  const { monitor, lines } = harness({ container: 2048 })
  monitor.start()
  assert.match(lines.log[0], /limite do container = 2048MB/)
})

test('envios com mídia pela API aparecem na linha e como suspeito', () => {
  const app = { uploads: { active: 5, waiting: 2, max: 5 } }
  const { monitor, lines } = harness({ used: 900, app })
  monitor.report()
  assert.match(lines.warn[0], /envios-mídia=5\+2/)
  assert.match(lines.warn.join('\n'), /envios com mídia pela API: 5 em andamento, 2 na fila/)
})

test('readContainerMemoryLimit: cgroup v2, v1, "max" e sem cgroup', () => {
  const files = (map) => (file) => {
    if (file in map) return map[file]
    throw new Error('ENOENT')
  }
  const total = 16 * 1024 * MB
  assert.equal(readContainerMemoryLimit({ readFile: files({ '/sys/fs/cgroup/memory.max': '2147483648\n' }), totalMemory: total }), 2048 * MB)
  assert.equal(readContainerMemoryLimit({ readFile: files({ '/sys/fs/cgroup/memory.max': 'max\n' }), totalMemory: total }), null)
  assert.equal(
    readContainerMemoryLimit({ readFile: files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '536870912' }), totalMemory: total }),
    512 * MB
  )
  // v1 sem limite: valor gigante (maior que a máquina)
  assert.equal(
    readContainerMemoryLimit({ readFile: files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }), totalMemory: total }),
    null
  )
  assert.equal(readContainerMemoryLimit({ readFile: files({}), totalMemory: total }), null)
})

test('pedidos de base64 pela API aparecem na linha e como suspeito', () => {
  const { monitor, lines } = harness({ used: 900, app: { base64: { active: 3, waiting: 4, max: 3 } } })
  monitor.report()
  assert.match(lines.warn[0], /base64-mídia=3\+4/)
  assert.match(lines.warn.join('\n'), /pedidos de mídia em base64 pela API: 3 em andamento, 4 na fila/)
})
