import crypto from 'node:crypto'
import { isJidGroup } from 'baileys'
import { isMediaMessage } from './inbound.js'
import { MAX_CONCURRENT_DOWNLOADS } from './media.js'
import { createConcurrencyLimiter } from './limiter.js'
import { HeaderDecryptError } from './secrets.js'

// Worker do outbox de webhooks (wa_webhook_deliveries), in-process. As
// funções puras do topo montam envelope/cabeçalhos/JWT e decidem retentativa;
// createDispatcher faz o claim no banco e os POSTs.
//
// Entrega at-least-once: o receptor deduplica por data.key.id ou X-Delivery-ID.

/** MESSAGES_UPSERT → messages.upsert (campo "event" do envelope, como na Evolution). */
export function eventName(event) {
  return event.toLowerCase().replace(/_/g, '.')
}

/** MESSAGES_UPSERT → messages-upsert (sufixo da URL com byEvents). */
export function eventSlug(event) {
  return event.toLowerCase().replace(/_/g, '-')
}

/**
 * Atraso antes da próxima tentativa (attempt = tentativas já feitas, a partir
 * de 1): initial * 2^(attempt-1), com teto, e ±20% de variação aleatória pra
 * que um receptor que volta do ar não receba todas as retentativas no mesmo
 * instante. Fica sempre entre initialDelayMs e maxDelayMs.
 */
export function computeBackoff(attempt, { initialDelayMs, maxDelayMs }, random = Math.random) {
  const base = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs)
  const jittered = base * (1 + (random() * 0.4 - 0.2))
  return Math.round(Math.min(Math.max(jittered, initialDelayMs), maxDelayMs))
}

// Status que indicam erro do lado de quem configurou (URL errada, token
// inválido, payload recusado): repetir não resolve, então falha na hora.
const NON_RETRYABLE = new Set([400, 401, 403, 404, 422])

/** 'delivered' | 'failed' | 'retry' */
export function classifyResult({ statusCode, error }) {
  if (error || !statusCode) return 'retry'
  if (statusCode >= 200 && statusCode < 300) return 'delivered'
  // Redirect não é seguido (ver postJson): é configuração errada da URL,
  // e repetir daria o mesmo 3xx.
  if (statusCode >= 300 && statusCode < 400) return 'failed'
  if (NON_RETRYABLE.has(statusCode)) return 'failed'
  return 'retry' // 408, 429, 5xx e o resto
}

// Eventos de mensagem que ganham data.groupSubject quando a conversa é grupo.
const GROUP_SUBJECT_EVENTS = new Set(['MESSAGES_UPSERT', 'SEND_MESSAGE'])

// Eventos que não valem retentativa: o QR expira em ~20s e é a credencial
// de pareamento da conta — repeti-lo por 45 min só aumentaria a exposição.
const SINGLE_ATTEMPT_EVENTS = new Set(['QRCODE_UPDATED'])

// date_time igual ao da Evolution: o horário LOCAL do servidor escrito em
// ISO com "Z" (new Date(Date.now() - tzoffset).toISOString()). Não é UTC de
// verdade — é o que os receptores da Evolution já esperam.
function evolutionDateTime(now, tzOffsetMinutes) {
  return new Date(now.getTime() - tzOffsetMinutes * 60_000).toISOString()
}

function withEventSuffix(url, event) {
  const parsed = new URL(url)
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/${eventSlug(event)}`
  return parsed.toString()
}

/**
 * Envelope do webhook (webhook.controller.ts da Evolution). apikey é sempre
 * null: a bridge só tem a API key global, e mandá-la a terceiros daria
 * controle total da bridge a quem recebe o aviso.
 */
export function buildEnvelope({
  event,
  instance,
  data,
  url,
  byEvents = false,
  sender = null,
  serverUrl = null,
  now = new Date(),
  tzOffsetMinutes = now.getTimezoneOffset()
}) {
  return {
    url: byEvents ? withEventSuffix(url, event) : url,
    body: {
      event: eventName(event),
      instance,
      data,
      destination: url,
      date_time: evolutionDateTime(now, tzOffsetMinutes),
      // Sem sufixo de dispositivo, como o wuid da Evolution.
      sender: sender ? sender.replace(/:\d+@/, '@') : null,
      server_url: serverUrl || null,
      apikey: null
    }
  }
}

const base64url = (input) => Buffer.from(input).toString('base64url')

/** JWT HS256 com node:crypto (evita a dependência jsonwebtoken só pra isso). */
export function signJwtHS256(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${signature}`
}

/** Mesmo token que a Evolution gera pro cabeçalho especial jwt_key (validade de 10 min). */
export function buildWebhookJwt(secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  return signJwtHS256({ iat: nowSeconds, exp: nowSeconds + 600, app: 'evolution', action: 'webhook' }, secret)
}

const FIXED_HEADERS = new Set([
  'content-type',
  'user-agent',
  'x-instance-id',
  'x-instance-name',
  'x-event-type',
  'x-timestamp',
  'x-delivery-id'
])

/**
 * Cabeçalhos do POST: os personalizados do webhook primeiro, depois os fixos,
 * que não podem ser sobrescritos. A comparação é sem caixa: o Headers do
 * fetch junta "x-delivery-id" e "X-Delivery-ID" num valor só ("spoof, 7"),
 * o que quebraria a deduplicação do receptor. jwt_key não vai pro receptor:
 * vira Authorization: Bearer <jwt> assinado com ele (e substitui um
 * Authorization personalizado).
 */
export function buildHeaders({ instance, event, deliveryId, headers = {}, nowMs = Date.now() }) {
  const jwtKey = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'jwt_key')?.[1]
  const custom = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => {
      const lower = name.toLowerCase()
      return lower !== 'jwt_key' && !FIXED_HEADERS.has(lower) && !(jwtKey && lower === 'authorization')
    })
  )
  const out = {
    ...custom,
    'Content-Type': 'application/json',
    'User-Agent': 'WSB-Webhook/1.0',
    'X-Instance-ID': instance,
    'X-Instance-Name': instance,
    'X-Event-Type': eventName(event),
    'X-Timestamp': String(nowMs),
    'X-Delivery-ID': String(deliveryId)
  }
  if (jwtKey) out.Authorization = `Bearer ${buildWebhookJwt(jwtKey, Math.floor(nowMs / 1000))}`
  return out
}

/**
 * URL segura pra log: só protocolo e host. Query, usuário/senha e até o path
 * podem carregar o token do receptor (ex.: hooks.slack.com/services/<token>).
 */
export function redactUrl(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '[url inválida]'
  }
}

/**
 * Mensagem curta pra last_error, log e resposta do /test. Nunca usa
 * err.message cru: no Node, várias mensagens de erro do fetch repetem a URL
 * inteira (com query e credenciais). Só o código do erro de rede.
 */
export function formatError(err, { timeoutMs, statusCode } = {}) {
  if (!err) return statusCode ? `HTTP ${statusCode}` : 'erro desconhecido'
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `timeout após ${timeoutMs}ms`
  const code = err.cause?.code || err.code
  return `erro de rede: ${typeof code === 'string' ? code : err.name || 'falha na requisição'}`
}

const MAX_ERROR_LENGTH = 1000

async function postJson(url, headers, body, timeoutMs) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // Redirect não é seguido: o fetch repassaria os cabeçalhos
      // personalizados (tokens) ao destino do redirect, e um 3xx pra um
      // endereço interno viraria SSRF por tabela. 3xx conta como falha.
      redirect: 'manual'
    })
    // O corpo da resposta não interessa; descartar libera a conexão.
    await res.body?.cancel().catch(() => {})
    return { statusCode: res.status, durationMs: Date.now() - started }
  } catch (error) {
    return { statusCode: null, error, durationMs: Date.now() - started }
  }
}

// Entregas elegíveis: pendentes vencidas, ou "delivering" com lease vencido
// (processo morreu no meio). Webhook desativado pausa as pendentes.
const ELIGIBLE = `((x.status = 'pending' AND x.next_attempt_at <= now())
                OR (x.status = 'delivering' AND x.locked_until < now()))
               AND EXISTS (SELECT 1 FROM wa_webhooks w WHERE w.id = x.webhook_id AND w.enabled)`

/**
 * config: { timeoutMs, concurrency, concurrencyPerWebhook, pollIntervalMs,
 *           retryMaxAttempts, retryInitialDelayMs, retryMaxDelayMs,
 *           mediaTimeoutMs, retentionDays, serverUrl }
 * cipher: decifra os cabeçalhos gravados (secrets.js)
 * media:  { download(sock, sessionId, data) → Buffer } (opcional)
 * groups: { getSubject(sessionId, jid) → string | null, timeoutMs } (opcional, groupMetadata.js)
 */
export function createDispatcher({ pool, cipher, getSocket = () => undefined, config, media = null, groups = null, log = console }) {
  if (!cipher) throw new Error('createDispatcher: informe o cipher dos cabeçalhos (secrets.js)')
  const inFlight = new Set()
  // Entregas em andamento por webhook, neste processo. Sem esse limite, um
  // receptor lento (timeout de 10s por POST) com fila grande ocupava todas as
  // vagas globais e atrasava os webhooks de todas as outras instâncias.
  const perWebhook = new Map()
  const perWebhookLimit = Math.min(config.concurrencyPerWebhook ?? config.concurrency, config.concurrency)
  let running = false
  let pumping = false
  let pumpAgain = false
  let pollTimer = null
  let cleanupTimer = null

  // Entregas com mídia montando/enviando ao mesmo tempo. O limite de
  // downloads (media.js) não basta: depois do download, o base64, o JSON e o
  // corpo do POST (~5x o arquivo) ficavam vivos em todas as entregas do
  // dispatcher ao mesmo tempo — 10 webhooks com mídia de 20MB passavam de
  // 1,5GB no teste de estresse. A vaga vai do download até o fim do POST.
  const mediaConcurrency = config.mediaConcurrency ?? MAX_CONCURRENT_DOWNLOADS
  const mediaSlots = createConcurrencyLimiter({ max: mediaConcurrency })

  // Lease de uma entrega em "delivering": cobre a espera por uma vaga de
  // mídia (cada entrega à frente segura a vaga por até um download + um
  // POST), o próprio download, o POST e uma folga. Se o processo morrer no
  // meio, a linha volta a ser elegível quando o lease vencer (em vez de ficar
  // presa pra sempre).
  const leaseMs =
    config.timeoutMs +
    config.mediaTimeoutMs +
    (config.mediaTimeoutMs + config.timeoutMs) * Math.ceil(config.concurrency / mediaConcurrency) +
    (groups?.timeoutMs ?? 0) +
    30_000

  // Reivindica até `limit` entregas vencidas de UM webhook. FOR UPDATE SKIP
  // LOCKED deixa duas réplicas (ou dois lotes) pegarem linhas diferentes sem
  // bloquear. A tentativa já é contada aqui: um crash no meio do envio também
  // gasta tentativa, pra uma mensagem que derruba o processo não ficar em loop.
  async function claimFor(webhookId, limit) {
    const { rows } = await pool.query(
      `WITH claimed AS (
         UPDATE wa_webhook_deliveries d
            SET status = 'delivering', attempts = d.attempts + 1,
                locked_until = now() + make_interval(secs => $2::double precision / 1000)
          WHERE d.id IN (
                  SELECT id FROM wa_webhook_deliveries x
                   WHERE x.webhook_id = $3 AND ${ELIGIBLE}
                   ORDER BY x.id
                   LIMIT $1
                   FOR UPDATE SKIP LOCKED)
          RETURNING d.*)
       SELECT c.*, w.url, w.base64, w.by_events, w.headers, s.jid AS session_jid
         FROM claimed c
         JOIN wa_webhooks w ON w.id = c.webhook_id
         LEFT JOIN wa_sessions s ON s.id = c.session_id
        ORDER BY c.id`,
      [limit, leaseMs, webhookId]
    )
    return rows
  }

  // Em duas fases, porque SKIP LOCKED não combina com limite por grupo numa
  // consulta só: (1) os webhooks com entrega vencida, do que espera há mais
  // tempo pro mais novo, sem os que já estão no limite; (2) as vagas livres
  // de cada um.
  async function claim(limit) {
    const saturated = [...perWebhook].filter(([, n]) => n >= perWebhookLimit).map(([id]) => id)
    const { rows: candidates } = await pool.query(
      `SELECT x.webhook_id FROM wa_webhook_deliveries x
        WHERE ${ELIGIBLE} AND NOT (x.webhook_id = ANY($2::uuid[]))
        GROUP BY x.webhook_id
        ORDER BY min(x.id)
        LIMIT $1`,
      [limit, saturated]
    )
    const claimed = []
    for (const { webhook_id: webhookId } of candidates) {
      const free = Math.min(perWebhookLimit - (perWebhook.get(webhookId) ?? 0), limit - claimed.length)
      if (free > 0) claimed.push(...(await claimFor(webhookId, free)))
      if (claimed.length >= limit) break
    }
    return claimed
  }

  // Erro que repetir não resolve (cabeçalho que não decifra): falha na hora.
  async function failNow(row, message) {
    log.warn(`[${row.session_id}] webhook: entrega ${row.id} (${row.event}) → ${redactUrl(row.url)} falhou: ${message} — falha definitiva`)
    await pool.query(
      `UPDATE wa_webhook_deliveries SET status = 'failed', last_status_code = NULL, last_error = $2, locked_until = NULL WHERE id = $1`,
      [row.id, message.slice(0, MAX_ERROR_LENGTH)]
    )
  }

  // Mídia só entra no momento do envio (o outbox não guarda base64). Falha
  // ou arquivo grande demais não seguram o aviso: ele vai sem o arquivo e com
  // base64Error, e o receptor pode pedir depois em getBase64FromMediaMessage.
  async function withMedia(sessionId, data) {
    try {
      const buffer = await media.download(getSocket(sessionId), sessionId, data)
      return { ...data, message: { ...data.message, base64: buffer.toString('base64') } }
    } catch (err) {
      const code = err.code === 'too_large' ? 'too_large' : 'download_failed'
      log.warn(`[${sessionId}] mídia ${data.key?.id} não embutida no webhook (${code}): ${err.message}`)
      return { ...data, message: { ...data.message, base64Error: code } }
    }
  }

  async function finish(row, result) {
    const outcome = classifyResult(result)
    const error = outcome === 'delivered' ? null : formatError(result.error, { timeoutMs: config.timeoutMs, statusCode: result.statusCode })

    if (outcome === 'delivered') {
      await pool.query(
        `UPDATE wa_webhook_deliveries
            SET status = 'delivered', delivered_at = now(), last_status_code = $2, last_error = NULL, locked_until = NULL
          WHERE id = $1`,
        [row.id, result.statusCode]
      )
      return
    }

    const exhausted = row.attempts >= config.retryMaxAttempts || SINGLE_ATTEMPT_EVENTS.has(row.event)
    log.warn(
      `[${row.session_id}] webhook: entrega ${row.id} (${row.event}) → ${redactUrl(row.url)} ` +
        `falhou na tentativa ${row.attempts}: ${error}` +
        (outcome === 'failed' || exhausted ? ' — falha definitiva' : '')
    )

    if (outcome === 'failed' || exhausted) {
      await pool.query(
        `UPDATE wa_webhook_deliveries
            SET status = 'failed', last_status_code = $2, last_error = $3, locked_until = NULL
          WHERE id = $1`,
        [row.id, result.statusCode, error.slice(0, MAX_ERROR_LENGTH)]
      )
      return
    }

    const delayMs = computeBackoff(row.attempts, {
      initialDelayMs: config.retryInitialDelayMs,
      maxDelayMs: config.retryMaxDelayMs
    })
    await pool.query(
      `UPDATE wa_webhook_deliveries
          SET status = 'pending', last_status_code = $2, last_error = $3, locked_until = NULL,
              next_attempt_at = now() + make_interval(secs => $4::double precision / 1000)
        WHERE id = $1`,
      [row.id, result.statusCode, error.slice(0, MAX_ERROR_LENGTH), delayMs]
    )
  }

  async function deliver(row) {
    let customHeaders
    try {
      customHeaders = cipher.decryptHeaders(row.headers)
    } catch (err) {
      // Nunca envia sem o cabeçalho: o receptor recusaria (ou, pior, aceitaria
      // um aviso não autenticado). Sem a chave certa, repetir não adianta.
      if (err instanceof HeaderDecryptError) return failNow(row, err.message)
      throw err
    }

    let data = row.payload
    // Nome do grupo, como a mídia, só no envio: o outbox guarda o data sem
    // ele, e uma retentativa recalcula (pela memória/banco, sem consultar o
    // WhatsApp de novo). Espera limitada ao timeout; sem nome, vai null e a
    // entrega segue. Corre em paralelo ao download da mídia.
    const groupSubject =
      groups && GROUP_SUBJECT_EVENTS.has(row.event) && isJidGroup(data?.key?.remoteJid)
        ? groups.getSubject(row.session_id, data.key.remoteJid)
        : undefined
    const withFile = Boolean(row.base64 && media && isMediaMessage(data?.messageType))
    const release = withFile ? await mediaSlots.acquire() : null
    let result
    try {
      if (withFile) data = await withMedia(row.session_id, data)
      if (groupSubject !== undefined) data = { ...data, groupSubject: (await groupSubject) ?? null }

      const { url, body } = buildEnvelope({
        event: row.event,
        instance: row.session_id,
        data,
        url: row.url,
        byEvents: row.by_events,
        sender: row.session_jid,
        serverUrl: config.serverUrl
      })
      const headers = buildHeaders({ instance: row.session_id, event: row.event, deliveryId: row.id, headers: customHeaders })
      result = await postJson(url, headers, body, config.timeoutMs)
    } finally {
      release?.()
    }
    await finish(row, result)
  }

  // deliver + contagem por webhook. A contagem sobe na hora (antes do 1º
  // await), então o próximo claim do mesmo pump já vê a vaga ocupada.
  async function run(row) {
    perWebhook.set(row.webhook_id, (perWebhook.get(row.webhook_id) ?? 0) + 1)
    try {
      await deliver(row)
    } finally {
      const left = perWebhook.get(row.webhook_id) - 1
      if (left > 0) perWebhook.set(row.webhook_id, left)
      else perWebhook.delete(row.webhook_id)
    }
  }

  function track(promise) {
    inFlight.add(promise)
    promise
      .catch((err) => log.error(`webhook: erro inesperado numa entrega: ${err.message}`))
      .finally(() => {
        inFlight.delete(promise)
        if (running) pump()
      })
    return promise
  }

  // Preenche as vagas livres de concorrência com entregas vencidas. Chamadas
  // sobrepostas (wake durante um pump) viram uma volta a mais, não um pump paralelo.
  async function pump() {
    if (pumping) {
      pumpAgain = true
      return
    }
    pumping = true
    try {
      do {
        pumpAgain = false
        while (running && inFlight.size < config.concurrency) {
          const rows = await claim(config.concurrency - inFlight.size)
          if (rows.length === 0) break
          for (const row of rows) track(run(row))
        }
      } while (pumpAgain && running)
    } catch (err) {
      log.error(`webhook: falha ao buscar entregas pendentes: ${err.message}`)
    } finally {
      pumping = false
    }
  }

  // Histórico concluído e também pendências velhas: com os defaults uma
  // pendência de webhook ativo vive no máximo ~45 min, então uma com dias é de
  // webhook pausado (desativado) e não deve crescer pra sempre.
  async function cleanup() {
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM wa_webhook_deliveries
          WHERE status IN ('delivered', 'failed', 'pending') AND created_at < now() - make_interval(days => $1)`,
        [config.retentionDays]
      )
      if (rowCount) console.log(`webhook: ${rowCount} entrega(s) antiga(s) removida(s) do histórico`)
    } catch (err) {
      log.error(`webhook: falha na limpeza do histórico de entregas: ${err.message}`)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      // Polling de segurança: retentativas agendadas e sobras de um restart.
      pollTimer = setInterval(pump, config.pollIntervalMs)
      cleanupTimer = setInterval(cleanup, 60 * 60_000)
      cleanup()
      pump()
    },

    /** Para de buscar entregas e espera as requisições em andamento terminarem. */
    async stop() {
      running = false
      clearInterval(pollTimer)
      clearInterval(cleanupTimer)
      await Promise.allSettled([...inFlight])
    },

    /** Retrato pro diagnóstico de memória (memoryMonitor.js). */
    stats() {
      return { inFlight: inFlight.size, media: mediaSlots.stats() }
    },

    /** Chamado depois do COMMIT de um enqueue: entrega sem esperar o polling. */
    wake() {
      if (running) pump()
    },

    /** Um lote síncrono (usado nos testes): reivindica e entrega até `concurrency` linhas. */
    async processBatch() {
      const rows = await claim(config.concurrency)
      await Promise.allSettled(rows.map((row) => run(row)))
      return rows.length
    },

    /**
     * Evento webhook.test enviado na hora, sem outbox nem retentativa, com o
     * mesmo envelope/cabeçalhos/timeout de uma entrega real.
     * webhook = linha crua de wa_webhooks (cabeçalhos cifrados).
     */
    async sendTest(webhook, sessionId, sender) {
      let customHeaders
      try {
        customHeaders = cipher.decryptHeaders(webhook.headers)
      } catch (err) {
        if (err instanceof HeaderDecryptError) return { ok: false, statusCode: null, durationMs: 0, error: err.message }
        throw err
      }
      const { url, body } = buildEnvelope({
        event: 'WEBHOOK_TEST',
        instance: sessionId,
        data: { message: 'Teste de webhook do WSB', webhookId: webhook.id },
        url: webhook.url,
        byEvents: webhook.by_events,
        sender,
        serverUrl: config.serverUrl
      })
      const headers = buildHeaders({ instance: sessionId, event: 'WEBHOOK_TEST', deliveryId: `test-${Date.now()}`, headers: customHeaders })
      const result = await postJson(url, headers, body, config.timeoutMs)
      const ok = classifyResult(result) === 'delivered'
      return {
        ok,
        statusCode: result.statusCode,
        durationMs: result.durationMs,
        ...(ok ? {} : { error: formatError(result.error, { timeoutMs: config.timeoutMs, statusCode: result.statusCode }) })
      }
    }
  }
}
