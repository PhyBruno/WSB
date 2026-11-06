// Diagnóstico de memória: responde "o que estava segurando memória" ANTES de o
// processo morrer. Um estouro de heap do V8 (FatalProcessOutOfMemory) aborta o
// Node sem passar por nenhum handler de JS, então o único jeito de investigar
// depois é ter deixado rastro nos logs antes.
//
// A cada MEMORY_LOG_INTERVAL_MS sai uma linha com o uso do processo, o
// detalhamento do heap, os contadores da aplicação (caches, sessões, downloads
// de mídia) e a atividade desde a linha anterior (mensagens recebidas, histórico
// sincronizado, por sessão). Acima de MEMORY_WARN_RATIO do limite do heap a
// linha vira ALERTA, sai com mais frequência e vem com os suspeitos prováveis.
//
// Tudo é injetável pra dar pra testar sem esperar o V8 de verdade.
import v8 from 'node:v8'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const MB = 1024 * 1024
const mb = (bytes) => Math.round((bytes ?? 0) / MB)
const signed = (value) => `${value >= 0 ? '+' : ''}${value}`

// Heurísticas de "quem está segurando memória", ditas em português na linha de
// ALERTA. Cada uma só aparece com evidência nos números; nenhuma é afirmação
// definitiva — apontam onde olhar primeiro.
const LARGE_OBJECT_SHARE = 0.3
const BUFFER_SHARE = 0.3
const HISTORY_MESSAGES_THRESHOLD = 1000
const GROUP_PARTICIPANTS_THRESHOLD = 20_000

/**
 * Lista os suspeitos prováveis a partir de um retrato (ver sample()). Pura.
 */
export function explainMemory(snapshot) {
  const suspects = []
  const { heap, rssBytes, externalBytes, arrayBuffersBytes, app = {}, activity = {} } = snapshot

  if (heap.usedBytes > 0 && heap.largeObjectBytes / heap.usedBytes >= LARGE_OBJECT_SHARE) {
    suspects.push(
      `objetos grandes = ${mb(heap.largeObjectBytes)}MB (${Math.round((heap.largeObjectBytes / heap.usedBytes) * 100)}% do heap): ` +
        'strings/arrays enormes, típico de mídia em base64 ou do JSON de um webhook com mídia'
    )
  }
  if (rssBytes > 0 && (externalBytes + arrayBuffersBytes) / rssBytes >= BUFFER_SHARE) {
    suspects.push(
      `memória fora do heap = ${mb(Math.max(externalBytes, arrayBuffersBytes))}MB: ` +
        'Buffers de mídia sendo baixada/decifrada ou cache de mídia'
    )
  }
  if (app.media) {
    if (app.media.cacheBytes > 0) {
      suspects.push(`cache de mídia = ${mb(app.media.cacheBytes)}MB em ${app.media.cacheEntries} item(ns)`)
    }
    if (app.media.active > 0 || app.media.waiting > 0) {
      suspects.push(`downloads de mídia: ${app.media.active} em andamento, ${app.media.waiting} na fila`)
    }
  }
  const history = activity.history
  if (history && history.messages >= HISTORY_MESSAGES_THRESHOLD) {
    const sessions = Object.entries(history.bySession ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, n]) => `${id}=${n}`)
      .join(', ')
    suspects.push(
      `sincronização de histórico: ${history.messages} mensagem(ns) e ${history.chats} conversa(s) desde a última leitura` +
        (sessions ? ` (${sessions})` : '') +
        ' — comum logo depois de parear um número novo'
    )
  }
  if (app.groups && app.groups.participants >= GROUP_PARTICIPANTS_THRESHOLD) {
    suspects.push(
      `metadata de grupos em cache = ${app.groups.withMetadata} grupo(s) / ${app.groups.participants} participante(s)`
    )
  }
  if (app.sessions) {
    const total = Object.values(app.sessions).reduce((sum, n) => sum + n, 0)
    if (total >= 5) suspects.push(`${total} sessões no mesmo processo`)
  }
  if (!suspects.length) {
    suspects.push(
      'nenhum contador da aplicação explica o uso: provável retenção dentro do Baileys (estado de sessão, ' +
        'sincronização) ou do driver do Postgres. Veja "Diagnóstico de memória" no README para tirar um heap snapshot'
    )
  }
  return suspects
}

function formatObject(object) {
  const entries = Object.entries(object ?? {})
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(',') : '0'
}

/** Linha de log (uma só) a partir do retrato. Pura. */
export function formatMemoryLine(snapshot) {
  const { heap, app = {}, activity = {} } = snapshot
  const parts = [
    `rss=${mb(snapshot.rssBytes)}MB`,
    `heap=${mb(heap.usedBytes)}/${mb(heap.limitBytes)}MB (${Math.round(heap.ratio * 100)}%)`,
    `Δheap=${signed(mb(snapshot.heapDeltaBytes))}MB`,
    `old=${mb(heap.oldBytes)}MB`,
    `grandes=${mb(heap.largeObjectBytes)}MB`,
    `novos=${mb(heap.newBytes)}MB`,
    `fora-do-heap=${mb(snapshot.externalBytes)}MB`,
    `buffers=${mb(snapshot.arrayBuffersBytes)}MB`
  ]
  if (snapshot.eventLoopP99Ms != null) parts.push(`eventLoopP99=${snapshot.eventLoopP99Ms}ms`)
  if (app.sessions) parts.push(`sessões={${formatObject(app.sessions)}}`)
  if (app.sentMessages != null) parts.push(`enviadas-em-cache=${app.sentMessages}`)
  if (app.media) {
    parts.push(
      `mídia={cache=${mb(app.media.cacheBytes)}MB/${app.media.cacheEntries},downloads=${app.media.active}+${app.media.waiting}}`
    )
  }
  if (app.groups) {
    parts.push(
      `grupos={cache=${app.groups.groups},metadata=${app.groups.withMetadata},participantes=${app.groups.participants}}`
    )
  }
  if (app.dispatcher) parts.push(`webhooks-em-voo=${app.dispatcher.inFlight}`)
  if (activity.upsert) parts.push(`recebidas=${activity.upsert.messages}`)
  if (activity.history) {
    parts.push(`histórico={mensagens=${activity.history.messages},conversas=${activity.history.chats},contatos=${activity.history.contacts}}`)
  }
  return parts.join(' ')
}

export function createMemoryMonitor({
  intervalMs = 60_000,
  alertIntervalMs = 10_000,
  warnRatio = 0.7,
  getAppStats = () => ({}),
  log = console,
  memoryUsage = () => process.memoryUsage(),
  heapStatistics = () => v8.getHeapStatistics(),
  heapSpaceStatistics = () => v8.getHeapSpaceStatistics(),
  eventLoop = monitorEventLoopDelay({ resolution: 20 }),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let timer = null
  let previousHeapUsed = null
  let lastRatio = 0
  // Atividade desde a última leitura: kind -> { messages, chats, contacts, bySession }
  let activity = {}

  /**
   * Chamado pelos listeners da aplicação. `kind` é 'upsert' ou 'history';
   * `amounts` soma em messages/chats/contacts. Nunca lança.
   */
  function count(sessionId, kind, amounts = {}) {
    const bucket = (activity[kind] ??= { messages: 0, chats: 0, contacts: 0, bySession: {} })
    bucket.messages += amounts.messages ?? 0
    bucket.chats += amounts.chats ?? 0
    bucket.contacts += amounts.contacts ?? 0
    bucket.bySession[sessionId] = (bucket.bySession[sessionId] ?? 0) + (amounts.messages ?? 0)
  }

  function sample() {
    const usage = memoryUsage()
    const stats = heapStatistics()
    const spaces = Object.fromEntries(heapSpaceStatistics().map((space) => [space.space_name, space.space_used_size]))

    const usedBytes = stats.used_heap_size ?? usage.heapUsed
    const limitBytes = stats.heap_size_limit
    let appStats = {}
    try {
      appStats = getAppStats() ?? {}
    } catch (err) {
      appStats = {}
      log.error?.(`memória: falha ao coletar contadores da aplicação: ${err.message}`)
    }

    const p99 = eventLoop.count > 0 ? Math.round(eventLoop.percentile(99) / 1e6) : null
    eventLoop.reset()

    const snapshot = {
      rssBytes: usage.rss,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers,
      heapDeltaBytes: previousHeapUsed == null ? 0 : usedBytes - previousHeapUsed,
      eventLoopP99Ms: p99,
      heap: {
        usedBytes,
        limitBytes,
        ratio: limitBytes > 0 ? usedBytes / limitBytes : 0,
        oldBytes: spaces.old_space ?? 0,
        newBytes: spaces.new_space ?? 0,
        largeObjectBytes: (spaces.large_object_space ?? 0) + (spaces.new_large_object_space ?? 0)
      },
      app: appStats,
      activity
    }
    previousHeapUsed = usedBytes
    lastRatio = snapshot.heap.ratio
    activity = {}
    return snapshot
  }

  /** Lê, loga e devolve o retrato. */
  function report() {
    const snapshot = sample()
    const line = formatMemoryLine(snapshot)
    if (snapshot.heap.ratio >= warnRatio) {
      log.warn(`memória: ALERTA heap acima de ${Math.round(warnRatio * 100)}% do limite — ${line}`)
      for (const suspect of explainMemory(snapshot)) log.warn(`memória: suspeito: ${suspect}`)
    } else {
      log.log(`memória: ${line}`)
    }
    return snapshot
  }

  function scheduleNext() {
    const delay = lastRatio >= warnRatio ? alertIntervalMs : intervalMs
    timer = setTimer(tick, delay)
    timer?.unref?.()
  }

  function tick() {
    try {
      report()
    } catch (err) {
      log.error?.(`memória: falha na leitura: ${err.message}`)
    }
    scheduleNext()
  }

  return {
    count,
    sample,
    report,

    start() {
      if (timer || intervalMs <= 0) return
      eventLoop.enable()
      const stats = heapStatistics()
      log.log(
        `memória: monitor ativo — limite do heap do V8 = ${mb(stats.heap_size_limit)}MB, ` +
          `leitura a cada ${Math.round(intervalMs / 1000)}s (a cada ${Math.round(alertIntervalMs / 1000)}s acima de ${Math.round(warnRatio * 100)}%)`
      )
      // Uma leitura imediata dá a linha de base logo após o boot.
      tick()
    },

    stop() {
      if (timer) clearTimer(timer)
      timer = null
      eventLoop.disable()
    }
  }
}
