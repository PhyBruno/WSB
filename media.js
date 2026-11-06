import pino from 'pino'
import { downloadMediaMessage } from 'baileys'

// Mídia das mensagens recebidas, baixada SOB DEMANDA do CDN do WhatsApp (no
// envio de um webhook com base64: true, ou pela rota
// getBase64FromMediaMessage). Nada é guardado em disco nem no banco: o
// outbox fica só com o "data", e o arquivo vive no máximo 60s num cache em
// memória com teto de tamanho (research R6).

const logger = pino({ level: 'silent' })

export class MediaError extends Error {
  // code: 'too_large' | 'download_failed' (os mesmos valores de base64Error)
  constructor(code, message) {
    super(message ?? code)
    this.code = code
  }
}

const EXTENSIONS = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt'
}

/** Extensão de arquivo pelo mimetype (ignora parâmetros, ex: "; codecs=opus"). */
export function extensionFor(mimetype) {
  if (typeof mimetype !== 'string') return 'bin'
  return EXTENSIONS[mimetype.split(';')[0].trim().toLowerCase()] ?? 'bin'
}

function mediaContent(data) {
  return data?.message?.[data?.messageType] ?? null
}

/**
 * Já dá pra saber, antes de baixar, se o arquivo passa do teto? Usa o
 * fileLength informado pelo remetente (número, string ou Long já convertido).
 */
export function exceedsMaxBytes(data, maxBytes) {
  const length = Number(mediaContent(data)?.fileLength)
  return Number.isFinite(length) && length > maxBytes
}

// Campos do proto que são bytes. serializeBinary (inbound.js) os grava como
// base64; pra baixar a mídia, o Baileys precisa deles como Buffer de novo.
const BINARY_FIELDS = new Set([
  'mediaKey',
  'fileSha256',
  'fileEncSha256',
  'jpegThumbnail',
  'thumbnailSha256',
  'thumbnailEncSha256',
  'streamingSidecar',
  'waveform',
  'midQualityFileSha256',
  'midQualityFileEncSha256',
  'firstFrameSidecar',
  'messageSecret',
  'encPayload',
  'encIv'
])

// Formato da Evolution: Uint8Array serializado como objeto indexado
// {"0":12,"1":34,...}. Aceito na rota getBase64FromMediaMessage.
function isIndexedBytes(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every((k, i) => k === String(i) && Number.isInteger(value[k]) && value[k] >= 0 && value[k] <= 255)
}

// Host fixo do CDN de mídia do WhatsApp. Ver safeMediaMessage.
const MEDIA_HOST = 'mmg.whatsapp.net'
const SAFE_DIRECT_PATH = /^\/[A-Za-z0-9._~\-/%?=&+]+$/

/**
 * A mensagem vem de um remetente qualquer, e url/directPath são campos que
 * ele controla. O Baileys baixa de `url` diretamente quando não há
 * directPath (e usa o host de `url` quando há): uma imageMessage forjada com
 * url "http://servico-interno:8080/..." faria a bridge buscar um endereço da
 * rede interna — SSRF disparado por quem manda mensagem, sem API key.
 * Por isso só baixamos pelo directPath, validado, no host oficial do CDN.
 * Retorna a mensagem ajustada, ou null se não houver directPath confiável.
 */
export function safeMediaMessage(message, messageType) {
  const content = message?.[messageType]
  const directPath = content?.directPath
  if (
    typeof directPath !== 'string' ||
    !SAFE_DIRECT_PATH.test(directPath) ||
    directPath.includes('..') ||
    directPath.includes('//')
  ) {
    return null
  }
  return { ...message, [messageType]: { ...content, url: `https://${MEDIA_HOST}${directPath}` } }
}

/** Inverso de serializeBinary nos campos binários conhecidos. Não altera a entrada. */
export function deserializeBinary(value, field) {
  if (BINARY_FIELDS.has(field)) {
    if (typeof value === 'string') return Buffer.from(value, 'base64')
    if (isIndexedBytes(value)) return Buffer.from(Object.values(value))
  }
  if (Array.isArray(value)) return value.map((item) => deserializeBinary(item))
  if (typeof value === 'object' && value !== null && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deserializeBinary(v, k)]))
  }
  return value
}

/** Corpo de resposta do getBase64FromMediaMessage (formato da Evolution). */
export function buildBase64Response(data, buffer) {
  const content = mediaContent(data) ?? {}
  const fileLength = Number(content.fileLength)
  return {
    mediaType: data.messageType,
    fileName: content.fileName || `${data.key.id}.${extensionFor(content.mimetype)}`,
    caption: content.caption ?? null,
    size: {
      fileLength: Number.isFinite(fileLength) ? fileLength : buffer.length,
      height: content.height ?? null,
      width: content.width ?? null
    },
    mimetype: content.mimetype ?? null,
    base64: buffer.toString('base64')
  }
}

/**
 * Cache em memória dos downloads, por chave (sessão + key.id). Guarda a
 * Promise, então N webhooks/retentativas da mesma mídia ao mesmo tempo viram
 * um download só. TTL curto e teto pela soma dos tamanhos, descartando os
 * mais antigos: é só pra cobrir a rajada de envios da mesma mensagem.
 */
export function createMediaCache({ ttlMs = 60_000, maxBytes = 104_857_600, now = Date.now } = {}) {
  const entries = new Map() // key -> { promise, size, expiresAt }, em ordem de inserção
  let totalBytes = 0

  const drop = (key) => {
    const entry = entries.get(key)
    if (!entry) return
    totalBytes -= entry.size
    entries.delete(key)
  }

  const prune = () => {
    const current = now()
    for (const [key, entry] of entries) if (entry.expiresAt <= current) drop(key)
    for (const key of entries.keys()) {
      if (totalBytes <= maxBytes) break
      drop(key)
    }
  }

  return {
    getOrLoad(key, loader) {
      prune()
      const cached = entries.get(key)
      if (cached) return cached.promise

      const entry = { promise: null, size: 0, expiresAt: now() + ttlMs }
      entry.promise = Promise.resolve()
        .then(loader)
        .then(
          (buffer) => {
            if (entries.get(key) === entry) {
              entry.size = buffer.length
              totalBytes += entry.size
              prune()
            }
            return buffer
          },
          (err) => {
            // Falha não fica em cache: a próxima retentativa tenta de novo.
            if (entries.get(key) === entry) entries.delete(key)
            throw err
          }
        )
      entries.set(key, entry)
      return entry.promise
    },
    has(key) {
      const entry = entries.get(key)
      return Boolean(entry && entry.expiresAt > now())
    },
    get totalBytes() {
      return totalBytes
    },
    get size() {
      return entries.size
    }
  }
}

/**
 * Baixa a mídia de uma mensagem (data no formato do contrato) e devolve o
 * Buffer. Lança MediaError('too_large' | 'download_failed').
 *
 * Timeout: o Baileys 7.0.0-rc14 NÃO repassa AbortSignal pro fetch
 * (getHttpStream só usa dispatcher/headers), então o limite é aplicado aqui
 * fora: baixamos como stream e, se estourar o tempo, destruímos o stream e
 * desistimos. O mesmo laço confere o teto de bytes quando o fileLength não
 * veio (ou mentiu).
 *
 * reuploadRequest (sock.updateMediaMessage) pede ao celular pra reenviar uma
 * mídia que já expirou no CDN — só funciona com o socket conectado.
 */
export async function downloadMedia(sock, data, { maxBytes, timeoutMs }) {
  if (exceedsMaxBytes(data, maxBytes)) throw new MediaError('too_large')

  const safe = safeMediaMessage(data.message, data.messageType)
  if (!safe) throw new MediaError('download_failed', 'mensagem sem directPath válido do CDN do WhatsApp')
  const message = { key: data.key, message: deserializeBinary(safe) }
  const ctx = sock?.updateMediaMessage ? { logger, reuploadRequest: sock.updateMediaMessage } : undefined

  let stream = null
  let timedOut = false
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      stream?.destroy()
      reject(new MediaError('download_failed', `timeout após ${timeoutMs}ms`))
    }, timeoutMs)
  })

  const work = (async () => {
    stream = await downloadMediaMessage(message, 'stream', {}, ctx)
    if (timedOut) {
      stream.destroy()
      return null
    }
    const chunks = []
    let size = 0
    for await (const chunk of stream) {
      size += chunk.length
      if (size > maxBytes) {
        stream.destroy()
        throw new MediaError('too_large')
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  })()

  try {
    return await Promise.race([work, timeout])
  } catch (err) {
    if (err instanceof MediaError) throw err
    // Não repassa err.message: o erro do Baileys ("Failed to fetch stream
    // from <url>") traz a URL assinada do CDN, que iria pro log e pra resposta.
    const status = err?.output?.statusCode ?? err?.status
    throw new MediaError('download_failed', status ? `CDN respondeu HTTP ${status}` : 'falha ao baixar a mídia')
  } finally {
    clearTimeout(timer)
    work.catch(() => {}) // o download abandonado pelo timeout termina sem rejeição solta
  }
}

// Downloads de mídia simultâneos. Cada um pode segurar o arquivo (até
// WEBHOOK_MEDIA_MAX_BYTES) mais a cópia em base64 e o JSON do POST: com a
// concorrência do dispatcher (10) inteira baixando mídia de 20MB, a memória
// passaria de 700MB. Os demais esperam a vez.
export const MAX_CONCURRENT_DOWNLOADS = 3

/** downloadMedia + cache, com a configuração das envs WEBHOOK_MEDIA_*. */
export function createMediaDownloader({ maxBytes, timeoutMs, cacheMaxBytes, maxConcurrent = MAX_CONCURRENT_DOWNLOADS }) {
  const cache = createMediaCache({ ttlMs: 60_000, maxBytes: cacheMaxBytes })
  let active = 0
  const waiting = []

  async function limited(fn) {
    if (active >= maxConcurrent) await new Promise((resolve) => waiting.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      waiting.shift()?.()
    }
  }

  return {
    download(sock, sessionId, data) {
      return cache.getOrLoad(`${sessionId}:${data.key.id}`, () =>
        limited(() => downloadMedia(sock, data, { maxBytes, timeoutMs }))
      )
    },

    /** Retrato pro diagnóstico de memória (memoryMonitor.js). */
    stats() {
      return { cacheBytes: cache.totalBytes, cacheEntries: cache.size, active, waiting: waiting.length }
    }
  }
}
