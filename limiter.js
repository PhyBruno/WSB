// Limite de trabalho pesado em memória rodando ao mesmo tempo. Existe porque o
// teste de estresse mostrou que mídia é o que derruba a bridge: cada webhook
// com mídia de 20MB segura ~100MB (Buffer + base64 + JSON + corpo do POST), e
// cada POST /messages com mídia de 14MB ~35MB (corpo + string + Buffer). Sem
// teto, uma rajada leva o processo além do limite do container.

/** A vaga não abriu dentro do tempo de espera. */
export class LimiterTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`nenhuma vaga livre em ${timeoutMs}ms`)
    this.name = 'LimiterTimeoutError'
  }
}

/**
 * Semáforo com fila FIFO. acquire() resolve com uma função release
 * (idempotente) quando há vaga; com timeoutMs rejeita com LimiterTimeoutError,
 * e com signal abortado sai da fila e rejeita com o motivo do abort.
 */
export function createConcurrencyLimiter({ max }) {
  if (!Number.isInteger(max) || max < 1) throw new Error('createConcurrencyLimiter: max precisa ser um inteiro >= 1')
  let active = 0
  const queue = []

  function grant() {
    active++
    let released = false
    return () => {
      if (released) return
      released = true
      active--
      const next = queue.shift()
      if (next) next.resolve(grant())
    }
  }

  return {
    acquire({ timeoutMs, signal } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason)
      if (active < max) return Promise.resolve(grant())

      return new Promise((resolve, reject) => {
        const waiter = { resolve: null }
        const cleanup = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }
        const leave = (err) => {
          const index = queue.indexOf(waiter)
          if (index !== -1) queue.splice(index, 1)
          cleanup()
          reject(err)
        }
        const onAbort = () => leave(signal.reason)
        waiter.resolve = (release) => {
          cleanup()
          resolve(release)
        }
        const timer = timeoutMs > 0 ? setTimeout(() => leave(new LimiterTimeoutError(timeoutMs)), timeoutMs) : null
        signal?.addEventListener('abort', onAbort, { once: true })
        queue.push(waiter)
      })
    },

    /** Roda fn() dentro de uma vaga. */
    async run(fn, options) {
      const release = await this.acquire(options)
      try {
        return await fn()
      } finally {
        release()
      }
    },

    stats() {
      return { active, waiting: queue.length, max }
    }
  }
}

/**
 * Ocupa uma vaga do limiter que dura até a resposta HTTP terminar (ou o
 * cliente desistir). Sem vaga dentro de timeoutMs, responde 503 com
 * Retry-After. Retorna true com a vaga ocupada; false quando a resposta já foi
 * tratada (503) ou o cliente foi embora enquanto esperava.
 */
export async function holdSlotForResponse({ limiter, res, timeoutMs, retryAfterSeconds = 5, label = 'envios com mídia' }) {
  // Cliente que desiste enquanto espera sai da fila (res 'close' sem resposta).
  const gone = new AbortController()
  const onClose = () => gone.abort()
  res.once('close', onClose)

  let release
  try {
    release = await limiter.acquire({ timeoutMs, signal: gone.signal })
  } catch (err) {
    res.off('close', onClose)
    if (gone.signal.aborted) return false
    if (!(err instanceof LimiterTimeoutError)) throw err
    const { max } = limiter.stats()
    res.set('Retry-After', String(retryAfterSeconds))
    res.status(503).json({
      error: `muitos ${label} em andamento (máximo ${max} ao mesmo tempo); tente de novo em ${retryAfterSeconds}s`
    })
    return false
  }
  res.off('close', onClose)
  // O cliente pode ter ido embora no mesmo tick em que a vaga abriu.
  if (gone.signal.aborted) {
    release()
    return false
  }
  res.once('close', release)
  return true
}

/**
 * Middleware das rotas que recebem mídia em base64. Ocupa uma vaga ANTES de o
 * corpo ser lido (é a leitura e o parse que alocam a memória) e devolve a vaga
 * quando a resposta termina ou o cliente desiste. Corpo pequeno (texto, até
 * smallBodyBytes pelo Content-Length) não ocupa vaga. Sem vaga dentro de
 * timeoutMs, responde 503 com Retry-After: o corpo nem chega a ser lido.
 */
export function createUploadGate({ limiter, timeoutMs, smallBodyBytes, retryAfterSeconds = 5 }) {
  return async function uploadGate(req, res, next) {
    const length = Number(req.get('content-length'))
    if (Number.isFinite(length) && length <= smallBodyBytes) return next()
    try {
      if (await holdSlotForResponse({ limiter, res, timeoutMs, retryAfterSeconds })) next()
    } catch (err) {
      next(err)
    }
  }
}
