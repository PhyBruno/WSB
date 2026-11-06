import 'dotenv/config'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import QRCode from 'qrcode'
import pino from 'pino'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  WAMessageStatus,
  generateMessageIDV2,
  generateWAMessageFromContent,
  prepareWAMessageMedia
} from 'baileys'
import { pool, migrate } from './db.js'
import { usePostgresAuthState, wipeAuthState } from './postgresAuthState.js'
import { makePnResolver, normalizeKeyAddressing, normalizeContextInfoAddressing } from './lid.js'
import {
  shouldProcess,
  prepareMessage,
  classifyOrigin,
  parseProtocol,
  createApiMessageRegistry,
  statusName
} from './inbound.js'
import { saveMessage, applyProtocol, updateStatus, webhookDataFromRow, purgeOldMessages, findMessageByKeyId } from './messageStore.js'
import { createHeaderCipher } from './secrets.js'
import { createWebhookService } from './webhooks.js'
import { createDispatcher } from './webhookDispatcher.js'
import { createMediaDownloader } from './media.js'
import { createGroupMetadataCache } from './groupMetadata.js'
import webhookRoutes from './webhookRoutes.js'
import {
  LIST_BIZ_NODE,
  BUTTONS_BIZ_NODE,
  buildListMessage,
  validateButtonsPayload,
  buildButtonsMessage
} from './interactive.js'
import {
  NUMBER_FORMAT,
  normalizeNumber,
  parseRecipientNumber,
  decodeBase64Media,
  createSendMessageHandler
} from './outbound.js'
import {
  describeDisconnect,
  formatCloseLog,
  createConnectionEventStore,
  silenceSignalSessionDumps
} from './connectionEvents.js'
import { createSessionLogout } from './sessionLogout.js'
import { createMemoryMonitor } from './memoryMonitor.js'

// Antes de qualquer sessão abrir: o libsignal despeja chaves privadas no
// stdout a cada sessão de sinal (ver connectionEvents.js).
silenceSignalSessionDumps()

const PORT = process.env.PORT || 3000
const API_KEY = process.env.API_KEY

// Logs internos do baileys (pino, JSON no stdout). 'warn' mostra erros de
// socket/keepalive/decrypt sem o volume do 'info'; pra investigar uma queda
// específica suba pra 'info' ou 'debug' temporariamente. 'silent' desliga.
const BAILEYS_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']
const BAILEYS_LOG_LEVEL = (process.env.BAILEYS_LOG_LEVEL || 'warn').trim().toLowerCase()
if (!BAILEYS_LOG_LEVELS.includes(BAILEYS_LOG_LEVEL)) {
  console.error(`ERRO: BAILEYS_LOG_LEVEL precisa ser um de: ${BAILEYS_LOG_LEVELS.join(', ')}.`)
  process.exit(1)
}
const logger = pino({ level: BAILEYS_LOG_LEVEL, base: undefined, timestamp: pino.stdTimeFunctions.isoTime })

if (!API_KEY) {
  console.error('ERRO: defina a variável de ambiente API_KEY antes de subir a bridge.')
  process.exit(1)
}

// Reconexão automática: quantidade de tentativas e delay entre elas, ambos
// configuráveis por ambiente. Delay FIXO (não exponencial) — cada tentativa
// espera o mesmo tempo. Só entra em ação em queda de conexão; uma desconexão
// pedida via API (/disconnect ou DELETE) nunca aciona reconexão automática.
const RECONNECT_MAX_ATTEMPTS = Number(process.env.RECONNECT_MAX_ATTEMPTS ?? 5)
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS ?? 30_000)

if (!Number.isFinite(RECONNECT_MAX_ATTEMPTS) || RECONNECT_MAX_ATTEMPTS < 0) {
  console.error('ERRO: RECONNECT_MAX_ATTEMPTS precisa ser um número >= 0.')
  process.exit(1)
}
if (!Number.isFinite(RECONNECT_DELAY_MS) || RECONNECT_DELAY_MS < 0) {
  console.error('ERRO: RECONNECT_DELAY_MS precisa ser um número >= 0.')
  process.exit(1)
}

// Tempo máximo que uma sessão pode ficar em "connecting" sem nenhum sinal de
// vida (sem virar "qr", "connected" ou nem sequer fechar com erro) antes da
// bridge forçar a desconexão sozinha. Existe porque a abertura do socket do
// baileys pode travar indefinidamente num TCP handshake que nunca completa
// nem falha (comum atrás de firewall restritivo) — isso não é coberto pelo
// connectTimeoutMs interno do baileys, que só conta a partir do WebSocket já
// aberto. É só um "force disconnect", igual ao /disconnect manual: NÃO tenta
// reconectar sozinho depois — fica em "disconnected" esperando um /connect.
// 0 desativa o watchdog.
const CONNECTING_TIMEOUT_MS = Number(process.env.CONNECTING_TIMEOUT_MS ?? 45_000)

if (!Number.isFinite(CONNECTING_TIMEOUT_MS) || CONNECTING_TIMEOUT_MS < 0) {
  console.error('ERRO: CONNECTING_TIMEOUT_MS precisa ser um número >= 0 (0 desativa o watchdog).')
  process.exit(1)
}

// Limite de tamanho do body JSON aceito pela API. O default do express
// (100kb) é insuficiente pra imagem/documento em base64 (que já infla ~33%
// o tamanho do binário original) — sem aumentar isso, todo envio de mídia
// real seria rejeitado com 413 antes de chegar na validação da rota.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '20mb'

// As demais rotas (configurações, webhooks, listas...) recebem JSON pequeno.
// Limite próprio pra que só as rotas de mídia aceitem os 20MB: sem isso, uma
// configuração de webhook podia gravar megabytes de cabeçalhos no banco.
const SMALL_JSON_LIMIT = '256kb'

// sock.sendMessage() resolve assim que a mensagem é repassada pro servidor do
// WhatsApp (relay) — não quando o destinatário recebe de verdade. O status
// real (aceito pelo servidor, entregue no aparelho, ou erro) chega depois,
// de forma assíncrona, via evento 'messages.update'. Pra devolver isso na
// mesma resposta HTTP do POST /messages, esperamos até esse tempo por uma
// atualização de status antes de responder. 0 desativa a espera (responde
// assim que sendMessage() resolver, sem aguardar confirmação).
const MESSAGE_STATUS_TIMEOUT_MS = Number(process.env.MESSAGE_STATUS_TIMEOUT_MS ?? 8_000)

if (!Number.isFinite(MESSAGE_STATUS_TIMEOUT_MS) || MESSAGE_STATUS_TIMEOUT_MS < 0) {
  console.error('ERRO: MESSAGE_STATUS_TIMEOUT_MS precisa ser um número >= 0 (0 desativa a espera).')
  process.exit(1)
}

// Envs numéricas novas (webhooks): mesmo padrão de validação das de cima,
// num helper pra não repetir o bloco onze vezes.
function numberFromEnv(name, defaultValue, { min = 0, integer = false } = {}) {
  const value = Number(process.env[name] ?? defaultValue)
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    console.error(`ERRO: ${name} precisa ser um número${integer ? ' inteiro' : ''} >= ${min}.`)
    process.exit(1)
  }
  return value
}

// URL pública da bridge, repassada como "server_url" nos webhooks.
const SERVER_URL = process.env.SERVER_URL?.trim() || null

// Repasse de mensagens pra webhooks (outbox em wa_webhook_deliveries). Os
// defaults e o porquê de cada um estão no .env.example; em especial, 15
// tentativas com backoff de 5s até 5min dão ~45 min de janela (a Evolution
// usa 10, ~20 min, pouco pra um receptor ficar 30 min fora do ar).
const WEBHOOK_CONFIG = {
  serverUrl: SERVER_URL,
  timeoutMs: numberFromEnv('WEBHOOK_TIMEOUT_MS', 10_000, { min: 1 }),
  concurrency: numberFromEnv('WEBHOOK_CONCURRENCY', 10, { min: 1, integer: true }),
  // Teto por webhook (dentro do global): um receptor lento não segura todas
  // as vagas e não atrasa os webhooks das outras instâncias.
  concurrencyPerWebhook: numberFromEnv('WEBHOOK_CONCURRENCY_PER_WEBHOOK', 2, { min: 1, integer: true }),
  pollIntervalMs: numberFromEnv('WEBHOOK_POLL_INTERVAL_MS', 1_000, { min: 100 }),
  retryMaxAttempts: numberFromEnv('WEBHOOK_RETRY_MAX_ATTEMPTS', 15, { min: 1, integer: true }),
  retryInitialDelayMs: numberFromEnv('WEBHOOK_RETRY_INITIAL_DELAY_MS', 5_000, { min: 1 }),
  retryMaxDelayMs: numberFromEnv('WEBHOOK_RETRY_MAX_DELAY_MS', 300_000, { min: 1 }),
  mediaMaxBytes: numberFromEnv('WEBHOOK_MEDIA_MAX_BYTES', 20_971_520, { min: 0 }),
  mediaTimeoutMs: numberFromEnv('WEBHOOK_MEDIA_TIMEOUT_MS', 30_000, { min: 1 }),
  mediaCacheMaxBytes: numberFromEnv('WEBHOOK_MEDIA_CACHE_MAX_BYTES', 104_857_600, { min: 0 }),
  retentionDays: numberFromEnv('WEBHOOK_DELIVERY_RETENTION_DAYS', 7, { min: 1 })
}

if (WEBHOOK_CONFIG.retryMaxDelayMs < WEBHOOK_CONFIG.retryInitialDelayMs) {
  console.error('ERRO: WEBHOOK_RETRY_MAX_DELAY_MS precisa ser >= WEBHOOK_RETRY_INITIAL_DELAY_MS.')
  process.exit(1)
}

// Chave da cifra dos cabeçalhos dos webhooks no banco (secrets.js). Sem ela,
// a chave é derivada da API_KEY — funciona sem configuração, mas trocar a
// API_KEY deixa os cabeçalhos salvos ilegíveis (as entregas desses webhooks
// passam a falhar com aviso claro até os valores serem cadastrados de novo).
// Definir WEBHOOK_HEADERS_KEY separa as duas coisas.
const WEBHOOK_HEADERS_KEY = process.env.WEBHOOK_HEADERS_KEY?.trim() || null
if (WEBHOOK_HEADERS_KEY !== null && WEBHOOK_HEADERS_KEY.length < 16) {
  console.error('ERRO: WEBHOOK_HEADERS_KEY precisa ter pelo menos 16 caracteres (ex: openssl rand -hex 32).')
  process.exit(1)
}

// Histórico de wa_messages: 0 (default) guarda pra sempre. Com N > 0, uma
// limpeza horária apaga mensagens gravadas há mais de N dias. Não é default
// pra não apagar histórico de quem já conta com ele.
const MESSAGE_RETENTION_DAYS = numberFromEnv('MESSAGE_RETENTION_DAYS', 0, { min: 0, integer: true })

// wa_connection_events (aberturas/quedas/logouts com o motivo): poucas linhas
// por dia por sessão, então 30 dias cobre a investigação de um padrão de
// quedas sem crescer à toa. Limpeza horária, junto com a de mensagens.
const CONNECTION_EVENTS_RETENTION_DAYS = numberFromEnv('CONNECTION_EVENTS_RETENTION_DAYS', 30, { min: 1, integer: true })

// Nome dos grupos (data.groupSubject nos webhooks e no histórico), em cache
// de memória → wa_groups → consulta ao WhatsApp (groupMetadata.js). Defaults
// e o porquê de cada um no .env.example.
const GROUP_METADATA_CONFIG = {
  ttlMs: numberFromEnv('GROUP_METADATA_TTL_MS', 21_600_000, { min: 1 }),
  failureTtlMs: numberFromEnv('GROUP_METADATA_FAILURE_TTL_MS', 300_000, { min: 0 }),
  timeoutMs: numberFromEnv('GROUP_METADATA_TIMEOUT_MS', 3_000, { min: 1 })
}
const GROUP_HISTORY_LIMITS = {
  maxLookups: numberFromEnv('GROUP_METADATA_HISTORY_MAX_LOOKUPS', 10, { min: 0, integer: true }),
  budgetMs: numberFromEnv('GROUP_METADATA_HISTORY_BUDGET_MS', 5_000, { min: 0 })
}

// Diagnóstico de memória (memoryMonitor.js): uma linha por MEMORY_LOG_INTERVAL_MS
// com o uso do processo e o que a aplicação está segurando; acima de
// MEMORY_WARN_RATIO do limite do heap vira ALERTA com os suspeitos e passa a
// sair a cada MEMORY_ALERT_INTERVAL_MS. 0 em MEMORY_LOG_INTERVAL_MS desativa.
const MEMORY_LOG_INTERVAL_MS = numberFromEnv('MEMORY_LOG_INTERVAL_MS', 60_000, { min: 0 })
const MEMORY_ALERT_INTERVAL_MS = numberFromEnv('MEMORY_ALERT_INTERVAL_MS', 10_000, { min: 1_000 })
const MEMORY_WARN_RATIO = numberFromEnv('MEMORY_WARN_RATIO', 0.7, { min: 0.1 })
if (MEMORY_WARN_RATIO > 1) {
  console.error('ERRO: MEMORY_WARN_RATIO precisa estar entre 0.1 e 1 (fração do limite do heap).')
  process.exit(1)
}

// Nomes legíveis pro enum numérico do baileys (ERROR=0, PENDING=1,
// SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5), pra devolver na API em vez
// do número cru.
const MESSAGE_STATUS_NAMES = Object.fromEntries(
  Object.entries(WAMessageStatus).map(([name, value]) => [value, name.toLowerCase()])
)

// Espera por uma atualização de status (via 'messages.update') pra uma
// mensagem específica, até timeoutMs. Resolve assim que chegar ERROR (falha
// confirmada) ou qualquer status >= SERVER_ACK (servidor confirmou o
// recebimento — não esperamos até DELIVERY_ACK/READ porque isso pode nunca
// chegar se o destinatário ficar offline, e não é isso que essa API promete).
// Se estourar o timeout sem nenhuma atualização, resolve com null — isso NÃO
// significa falha, só que não deu tempo de confirmar (a mensagem já foi
// aceita pelo relay antes desta função ser chamada).
function waitForMessageStatus(sock, messageId, timeoutMs) {
  if (timeoutMs <= 0) return Promise.resolve(null)

  return new Promise((resolve) => {
    let settled = false
    const finish = (status) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.ev.off('messages.update', onUpdate)
      resolve(status)
    }

    const onUpdate = (updates) => {
      for (const { key, update } of updates) {
        if (key.id !== messageId || typeof update.status !== 'number') continue
        if (update.status === WAMessageStatus.ERROR || update.status >= WAMessageStatus.SERVER_ACK) {
          finish(update.status)
          return
        }
      }
    }

    const timer = setTimeout(() => finish(null), timeoutMs)
    sock.ev.on('messages.update', onUpdate)
  })
}

// Quantas mensagens enviadas recentemente ficam guardadas em memória por
// sessão, pra atender getMessage (pedidos de retry do WhatsApp).
const MAX_CACHED_MESSAGES_PER_SESSION = 100

// fetchLatestBaileysVersion() faz uma chamada HTTP pro GitHub a cada vez que
// é chamada. Chamá-la dentro de startSession() significava refazer essa
// chamada em TODO /connect e em TODA reconexão automática (inclusive uma vez
// por sessão restaurada no boot) — desnecessário, já que a versão não muda
// no meio da execução do processo, e arriscado, já que a função não aceita
// timeout/AbortSignal: num ambiente com egress restrito (comum em deploy de
// produção que só libera os domínios do WhatsApp), uma chamada que trava sem
// nunca resolver travaria startSession() indefinidamente. Resolvemos a
// versão uma única vez no boot, com um timeout próprio, e reaproveitamos o
// resultado em toda chamada de startSession().
const BAILEYS_VERSION_FETCH_TIMEOUT_MS = 8_000
let cachedBaileysVersion = null

async function resolveBaileysVersion() {
  const timedOut = Symbol('timeout')
  const timeout = new Promise((resolve) => setTimeout(() => resolve(timedOut), BAILEYS_VERSION_FETCH_TIMEOUT_MS))
  const result = await Promise.race([fetchLatestBaileysVersion().catch(() => timedOut), timeout])
  if (result === timedOut) {
    console.warn(
      `fetchLatestBaileysVersion não respondeu em ${BAILEYS_VERSION_FETCH_TIMEOUT_MS}ms — ` +
        'seguindo com a versão embutida no pacote baileys instalado.'
    )
    return
  }
  cachedBaileysVersion = result.version
}

// Busca a sessão viva deste processo e confirma que ela está conectada. Em
// caso de problema já responde (404/409) e retorna null.
function getConnectedEntry(id, res) {
  const entry = sessions.get(id)
  if (!entry) {
    res.status(404).json({ error: 'sessão não encontrada ou não ativa neste processo' })
    return null
  }
  if (entry.status !== 'connected') {
    res.status(409).json({ error: `sessão não está conectada (status: ${entry.status})` })
    return null
  }
  return entry
}

// Alimenta o cache que o getMessage usa pra atender pedidos de retry do
// WhatsApp (ver comentário em startSession). Cache limitado — só serve pra
// cobrir um retry logo após o envio, não é histórico permanente.
function cacheSentMessage(entry, messageId, message) {
  if (!messageId || !message) return
  entry.sentMessages.set(messageId, message)
  if (entry.sentMessages.size > MAX_CACHED_MESSAGES_PER_SESSION) {
    const oldestKey = entry.sentMessages.keys().next().value
    entry.sentMessages.delete(oldestKey)
  }
}

// O envio (sendMessage/relayMessage) já retornou — a mensagem foi repassada
// ao servidor do WhatsApp —, mas isso não confirma entrega. Esperamos até
// MESSAGE_STATUS_TIMEOUT_MS por uma atualização de status real antes de
// responder — ver comentário de waitForMessageStatus. A espera chega pronta
// (statusPromise), criada logo após o envio: se fosse criada só depois da
// gravação em wa_messages, um SERVER_ACK rápido podia chegar antes do
// listener e a resposta sairia "unknown" sem necessidade.
async function respondWithMessageStatus(res, messageId, statusPromise) {
  const statusCode = messageId ? await statusPromise : null

  if (statusCode === WAMessageStatus.ERROR) {
    return res.status(502).json({
      ok: false,
      id: messageId,
      status: 'error',
      error: 'o WhatsApp recusou/falhou ao entregar esta mensagem (confirmado via messages.update)'
    })
  }

  res.json({
    ok: true,
    id: messageId,
    // 'unknown' quando o timeout estourou sem confirmação — não é falha,
    // só significa que a entrega ainda não foi confirmada nesse tempo.
    status: statusCode === null ? 'unknown' : MESSAGE_STATUS_NAMES[statusCode]
  })
}

// Normaliza a key do jeito que o listener de messages.upsert faz (LID → PN,
// sem sufixo de dispositivo), pra que a gravação pela rota e o eco do
// Baileys caiam na mesma linha de wa_messages.
function addressingOptions(sock) {
  return { resolvePn: makePnResolver(sock), ownJids: [sock.user?.id, sock.user?.lid] }
}

function normalizeKey(sock, key) {
  return normalizeKeyAddressing(key, addressingOptions(sock))
}

// Mesma troca LID → PN para quem foi citado e mencionado (contextInfo),
// antes de gravar: o resultado vai pro histórico e pros webhooks.
async function prepareNormalizedMessage(sock, received, { instanceId, key }) {
  const data = prepareMessage(received, { instanceId, key })
  data.contextInfo = await normalizeContextInfoAddressing(data.contextInfo, addressingOptions(sock))
  return data
}

// Grava em wa_messages (origin = 'api') uma mensagem que acabou de ser
// enviada pela API. Roda sem await na rota, em paralelo à espera de status:
// a gravação não pode atrasar a resposta HTTP (SC-007). Se o eco do Baileys
// já tiver gravado a linha, o ON CONFLICT faz disto um no-op.
async function recordApiMessage(id, entry, fullMsg) {
  if (!fullMsg?.key?.id || !fullMsg.message) return
  const key = await normalizeKey(entry.sock, fullMsg.key)
  const data = await prepareNormalizedMessage(entry.sock, fullMsg, { instanceId: id, key })
  await saveMessage(id, data, 'api', { onInserted: (client, row) => enqueueMessageEvent(client, id, row) })
}

// Pipeline de cada mensagem do messages.upsert: filtra, normaliza a key,
// aplica edição/exclusão ou grava a mensagem nova.
async function processIncomingMessage(id, entry, sock, received, upsertType) {
  if (!shouldProcess(received, upsertType, { groupsIgnore: entry.groupsIgnore })) return

  const key = await normalizeKey(sock, received.key)

  const protocol = parseProtocol(received.message)
  if (protocol) {
    await applyProtocol(id, protocol, {
      // Na mesma transação da atualização da linha original. Sem a original
      // gravada, o evento sai com a key do protocolMessage: em conversa
      // individual quem edita/apaga é o autor, então o fromMe do envelope é
      // o da mensagem alvo.
      onApplied: (client, row) => {
        const targetKey = row
          ? { remoteJid: row.key.remoteJid, fromMe: row.key.fromMe, id: row.key.id }
          : { remoteJid: key.remoteJid, fromMe: Boolean(key.fromMe), id: protocol.key.id }
        const messageId = row?.id ?? null
        if (protocol.type === 'MESSAGE_EDIT') {
          return webhooks.enqueue(
            client,
            id,
            'MESSAGES_EDITED',
            { key: targetKey, type: 'MESSAGE_EDIT', editedMessage: protocol.editedMessage },
            { messageId }
          )
        }
        return webhooks.enqueue(client, id, 'MESSAGES_DELETE', targetKey, { messageId })
      }
    })
    return
  }

  const data = await prepareNormalizedMessage(sock, received, { instanceId: id, key })
  const origin = classifyOrigin(key, entry.apiMessageIds)
  await saveMessage(id, data, origin, { onInserted: (client, row) => enqueueMessageEvent(client, id, row) })
}

// Mudança de status (enviada → entregue → lida) de uma mensagem gravada.
// Os dados do evento saem da linha (remote_jid já normalizado no
// recebimento), então não precisa normalizar a key do update de novo.
async function processStatusUpdate(id, key, code) {
  const status = statusName(code)
  if (!status || !key?.id) return
  await updateStatus(id, key.id, key.fromMe, status, {
    onUpdated: (client, row) =>
      webhooks.enqueue(
        client,
        id,
        'MESSAGES_UPDATE',
        {
          messageId: String(row.id),
          keyId: row.key_id,
          remoteJid: row.remote_jid,
          fromMe: row.from_me,
          participant: row.participant,
          status,
          instanceId: id
        },
        { messageId: row.id }
      )
  })
}

// Campo "delay" da Evolution: mostra "digitando..." pro destinatário por esse
// tempo (ms) antes de enviar. Como na Evolution (sendMessageWithTyping), em
// esperas longas a presença é renovada a cada 20s.
const TYPING_REFRESH_MS = 20_000

async function simulateTyping(sock, jid, delayMs) {
  let remaining = delayMs
  while (remaining > 0) {
    const chunk = Math.min(remaining, TYPING_REFRESH_MS)
    await sock.presenceSubscribe(jid)
    await sock.sendPresenceUpdate('composing', jid)
    await new Promise((resolve) => setTimeout(resolve, chunk))
    await sock.sendPresenceUpdate('paused', jid)
    remaining -= chunk
  }
}

// Estado em memória das sessões vivas neste processo.
// id -> { sock, status, qr, jid, name, intentionalDisconnect, sentMessages,
//         groupsIgnore, apiMessageIds }
// groupsIgnore espelha wa_sessions.groups_ignore pra não consultar o banco a
// cada mensagem recebida (o PATCH /settings atualiza os dois).
const sessions = new Map()

// Webhooks: mídia sob demanda, worker do outbox e o serviço que cria as
// entregas. O serviço acorda o dispatcher depois do COMMIT de cada enqueue,
// então um aviso sai na hora, sem esperar o polling.
const media = createMediaDownloader({
  maxBytes: WEBHOOK_CONFIG.mediaMaxBytes,
  timeoutMs: WEBHOOK_CONFIG.mediaTimeoutMs,
  cacheMaxBytes: WEBHOOK_CONFIG.mediaCacheMaxBytes
})
const headerCipher = createHeaderCipher(WEBHOOK_HEADERS_KEY ?? API_KEY)
// Só consulta o WhatsApp com a sessão conectada; fora isso, memória e banco.
// Nos logs só o JID do grupo, nunca o nome (dado do usuário).
const groups = createGroupMetadataCache({
  pool,
  getSocket: (id) => {
    const entry = sessions.get(id)
    return entry?.status === 'connected' ? entry.sock : undefined
  },
  config: GROUP_METADATA_CONFIG,
  log: { info: console.log, warn: console.warn, debug: () => {} }
})
const dispatcher = createDispatcher({
  pool,
  cipher: headerCipher,
  getSocket: (id) => sessions.get(id)?.sock,
  config: WEBHOOK_CONFIG,
  media,
  groups
})
const webhooks = createWebhookService({ pool, cipher: headerCipher, onEnqueue: () => dispatcher.wake() })

const memoryMonitor = createMemoryMonitor({
  intervalMs: MEMORY_LOG_INTERVAL_MS,
  alertIntervalMs: MEMORY_ALERT_INTERVAL_MS,
  warnRatio: MEMORY_WARN_RATIO,
  getAppStats: () => {
    const byStatus = {}
    let sentMessages = 0
    for (const entry of sessions.values()) {
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1
      sentMessages += entry.sentMessages?.size ?? 0
    }
    return {
      sessions: byStatus,
      sentMessages,
      media: media.stats(),
      groups: groups.stats(),
      dispatcher: dispatcher.stats()
    }
  }
})

// Evento de mensagem nova, chamado dentro da transação que inseriu a linha
// (onInserted). Enviada pela API vira SEND_MESSAGE e nunca MESSAGES_UPSERT
// (selectTargets também barra isso); como só quem insere chama este gancho,
// o evento sai uma vez só, seja a rota ou o eco do Baileys quem gravou primeiro.
function enqueueMessageEvent(client, id, row) {
  const event = row.origin === 'api' ? 'SEND_MESSAGE' : 'MESSAGES_UPSERT'
  return webhooks.enqueue(client, id, event, webhookDataFromRow(row), { messageId: row.id, origin: row.origin })
}

// Eventos sem mensagem (conexão, QR), fora de transação. Disparo sem await e
// com erro só logado: falha de banco aqui nunca pode atrapalhar a máquina de
// reconexão do handler de connection.update.
function enqueueSessionEvent(id, event, buildData) {
  Promise.resolve()
    .then(buildData)
    .then((data) => webhooks.enqueue(pool, id, event, data))
    .catch((err) => console.error(`[${id}] falha ao enfileirar ${event}: ${err.message}`))
}

function connectionUpdateData(id, entry, state, statusReason) {
  return {
    instance: id,
    wuid: entry.jid ? entry.jid.replace(/:\d+@/, '@') : null,
    profileName: entry.name ?? null,
    state,
    statusReason: statusReason ?? null
  }
}

// Controle de tentativas de reconexão por sessão (fora do "entry" pra sobreviver
// a cada recriação de socket). id -> número de falhas consecutivas.
const reconnectAttempts = new Map()

// Handle do setTimeout de reconexão agendada por sessão. Sem isso, um /connect
// manual (ou o próprio restartRequired) podia criar uma sessão nova enquanto um
// setTimeout de uma queda anterior ainda estava pendente; quando esse timer
// disparasse mais tarde, ele criava MAIS uma sessão por cima da que já estava
// funcionando — dois sockets do Baileys vivos ao mesmo tempo com a mesma
// credencial, brigando entre si (o WhatsApp historicamente reage a isso
// derrubando um dos dois com connectionReplaced, e pode ficar nesse looping).
// Toda vez que startSession roda, cancelamos qualquer timer pendente da
// sessão — o que estamos fazendo agora já é a tentativa mais atual.
const reconnectTimers = new Map()

function clearReconnectTimer(id) {
  const timer = reconnectTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    reconnectTimers.delete(id)
  }
}

// Handle do watchdog de "connecting" travado, por sessão. Ver CONNECTING_TIMEOUT_MS acima.
const connectingWatchdogs = new Map()

function clearConnectingWatchdog(id) {
  const timer = connectingWatchdogs.get(id)
  if (timer) {
    clearTimeout(timer)
    connectingWatchdogs.delete(id)
  }
}

// Mesma ação de um POST /disconnect manual: encerra o socket e marca a sessão
// como "disconnected", sem agendar reconexão. Compartilhada entre a rota
// /disconnect e o watchdog de connecting travado, pra não duplicar a lógica.
async function forceDisconnect(id, entry) {
  entry.intentionalDisconnect = true
  clearReconnectTimer(id)
  clearConnectingWatchdog(id)
  entry.status = 'disconnected'
  await setSessionStatus(id, 'disconnected')
  entry.sock.end(undefined)
}

// Evita que duas chamadas concorrentes de /connect pro mesmo id criem dois
// sockets ao mesmo tempo brigando pela mesma credencial no Postgres.
// id -> Promise da chamada startSession() em andamento.
const startingSessions = new Map()

function startSessionSerialized(id) {
  const inFlight = startingSessions.get(id)
  if (inFlight) return inFlight

  const promise = startSession(id).finally(() => startingSessions.delete(id))
  startingSessions.set(id, promise)
  return promise
}

const connectionEvents = createConnectionEventStore({ pool })

const logoutSession = createSessionLogout({
  sessions,
  sessionExists: async (id) => {
    const { rowCount } = await pool.query('SELECT 1 FROM wa_sessions WHERE id = $1', [id])
    return rowCount > 0
  },
  wipeAuthState,
  setSessionStatus: (id, status) => setSessionStatus(id, status),
  clearSessionTimers: (id) => {
    clearReconnectTimer(id)
    clearConnectingWatchdog(id)
    reconnectAttempts.delete(id)
  }
})

async function setSessionStatus(id, status, jid = undefined, name = undefined) {
  await pool.query(
    `UPDATE wa_sessions SET status = $2, jid = COALESCE($3, jid), name = COALESCE($4, name), updated_at = now() WHERE id = $1`,
    [id, status, jid ?? null, name ?? null]
  )
}

async function startSession(id) {
  // Qualquer reconexão agendada de uma queda anterior está obsoleta a partir
  // daqui — estamos iniciando a tentativa mais atual pra esta sessão.
  clearReconnectTimer(id)
  clearConnectingWatchdog(id)

  const {
    rows: [sessionRow]
  } = await pool.query(
    `INSERT INTO wa_sessions (id, status) VALUES ($1, 'connecting')
     ON CONFLICT (id) DO UPDATE SET status = 'connecting', updated_at = now()
     RETURNING groups_ignore`,
    [id]
  )

  const { state, saveCreds } = await usePostgresAuthState(id)

  // Criado antes do socket pra poder ser referenciado pelo getMessage abaixo.
  const entry = {
    sock: null,
    status: 'connecting',
    qr: null,
    jid: null,
    name: null,
    intentionalDisconnect: false,
    // Cache em memória, limitado, das últimas mensagens enviadas por esta sessão.
    // É o que alimenta o getMessage do baileys (ver comentário abaixo).
    sentMessages: new Map(),
    groupsIgnore: sessionRow.groups_ignore,
    // Ids das mensagens que as rotas de envio vão mandar, registrados ANTES
    // do envio — ver createApiMessageRegistry em inbound.js.
    apiMessageIds: createApiMessageRegistry()
  }
  sessions.set(id, entry)

  const sessionLogger = logger.child({ session: id })
  const sock = makeWASocket({
    // Só inclui a chave se já resolvemos uma versão — deixar `version: undefined`
    // explícito pisaria no default interno do baileys (o spread do makeWASocket
    // é {...defaults, ...config}, então uma chave presente com valor undefined
    // vence o default em vez de cair nele).
    ...(cachedBaileysVersion ? { version: cachedBaileysVersion } : {}),
    // Utilitários oficiais do baileys em vez de reimplementar: makeCacheableSignalKeyStore
    // adiciona uma camada de cache em memória sobre as chaves (reduz leitura no Postgres,
    // é o padrão recomendado pela própria lib) e Browsers.ubuntu gera o identificador de
    // dispositivo no formato que o WhatsApp espera — se a lib mudar esse formato no futuro,
    // isso é resolvido só atualizando o pacote, sem tocar no nosso código.
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, sessionLogger)
    },
    // Cada linha do baileys sai com {"session":"<id>"}, pra filtrar por número.
    logger: sessionLogger,
    browser: Browsers.ubuntu('Bridge API'),
    // A bridge recebe as mensagens NOVAS (messages.upsert → wa_messages →
    // webhooks), mas não importa o histórico antigo de conversas. O default
    // do baileys (syncFullHistory: true) baixa e decripta o histórico
    // completo a cada pareamento novo, o que custa tempo e banda à toa e
    // dispararia avisos de webhook de mensagens velhas.
    syncFullHistory: false,
    // getMessage: a documentação do baileys trata isso como praticamente
    // obrigatório — é o que permite reenviar uma mensagem quando o WhatsApp
    // pede retry (evita mensagens travadas em "this message can take a
    // while" do lado de quem recebe). Guardamos só um cache limitado em
    // memória das últimas mensagens enviadas por sessão — não é um histórico
    // completo, só o suficiente pra atender um retry logo após o envio.
    // (O próprio baileys 7 já mantém um cache de retry interno — LRU de até
    // 512 mensagens por 5 minutos, ver enableRecentMessageCache, ligado por
    // padrão — e consulta ele antes de chamar nosso getMessage. Mantemos o
    // nosso mesmo assim como rede de segurança pra retries fora dessa janela.)
    getMessage: async (key) => entry.sentMessages.get(key.id),
    // Metadata de grupo já conhecido (groups.upsert ou consulta anterior), pro
    // Baileys não consultar o grupo de novo a cada envio. Só responde com o
    // metadata completo (com participants); sem isso ele mesmo consulta.
    cachedGroupMetadata: groups.cachedGroupMetadata(id)
    // (Nota: printQRInTerminal foi removido — está deprecated na doc atual;
    // já escutamos o campo `qr` no connection.update abaixo.)
  })
  entry.sock = sock

  if (CONNECTING_TIMEOUT_MS > 0) {
    connectingWatchdogs.set(
      id,
      setTimeout(async () => {
        // Confere identidade (não só o id): se uma sessão mais nova já
        // substituiu esta no meio do caminho, o watchdog desta é obsoleto.
        const current = sessions.get(id)
        if (current === entry && current.status === 'connecting') {
          console.log(
            `[${id}] "connecting" travado por mais de ${CONNECTING_TIMEOUT_MS}ms, ` +
              'forçando desconexão (sem reconectar sozinho — chame /connect manualmente)'
          )
          await forceDisconnect(id, entry)
        }
      }, CONNECTING_TIMEOUT_MS)
    )
  }

  sock.ev.on('creds.update', saveCreds)

  // Mensagens recebidas (e o eco das enviadas). Cada mensagem tem o próprio
  // try/catch: uma mensagem malformada ou um erro de banco não pode
  // interromper as outras do lote nem derrubar o socket.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    memoryMonitor.count(id, 'upsert', { messages: messages.length })
    for (const received of messages) {
      try {
        await processIncomingMessage(id, entry, sock, received, type)
      } catch (err) {
        console.error(`[${id}] falha ao processar mensagem recebida ${received?.key?.id ?? '?'}: ${err.message}`)
      }
    }
  })

  // Só mede e loga (a bridge não guarda o histórico): a sincronização que o
  // WhatsApp manda logo depois de parear é a maior pressão de memória do
  // Baileys, e saber quanto chegou, e quando, explica um estouro de heap.
  sock.ev.on('messaging-history.set', ({ messages, chats, contacts, syncType, progress }) => {
    const amounts = { messages: messages?.length ?? 0, chats: chats?.length ?? 0, contacts: contacts?.length ?? 0 }
    memoryMonitor.count(id, 'history', amounts)
    console.log(
      `[${id}] histórico recebido: mensagens=${amounts.messages} conversas=${amounts.chats} ` +
        `contatos=${amounts.contacts} syncType=${syncType ?? 'n/a'} progresso=${progress ?? 'n/a'}`
    )
  })

  // Nome dos grupos: entrou num grupo (upsert), renomeado ou sincronização
  // completa (update) e mudança de participantes (descarta a lista em memória). Gravam
  // em wa_groups sem bloquear o socket; nunca lançam.
  sock.ev.on('groups.upsert', (list) => groups.onGroupsUpsert(id, list))
  sock.ev.on('groups.update', (updates) => groups.onGroupsUpdate(id, updates))
  sock.ev.on('group-participants.update', (update) => groups.onParticipantsUpdate(id, update))

  // Recibos de status (MESSAGES_UPDATE). Convive com o listener temporário
  // de waitForMessageStatus, que só existe durante a espera de um envio.
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (typeof update?.status !== 'number') continue
      try {
        await processStatusUpdate(id, key, update.status)
      } catch (err) {
        console.error(`[${id}] falha ao processar status da mensagem ${key?.id ?? '?'}: ${err.message}`)
      }
    }
  })

  // O push name (nome de perfil) de uma conta PESSOAL não vem pronto no
  // momento em que a conexão abre — só contas Business recebem o nome já no
  // pair-success (nó <biz>, ver Utils/validate-connection.js). Pra conta
  // pessoal, o baileys só descobre o nome depois, quando uma mensagem
  // fromMe:true volta com o atributo "notify" preenchido (sync
  // multi-dispositivo) — nesse momento ele reemite 'creds.update' com
  // { me: { ...creds.me, name } } (ver upsertMessage em Socket/chats.js).
  // Sem este listener, entry.name (e a coluna "name") nunca são atualizados
  // pra contas pessoais, mesmo depois de enviar mensagens.
  sock.ev.on('creds.update', async (update) => {
    if (update.me?.name && update.me.name !== entry.name) {
      entry.name = update.me.name
      await setSessionStatus(id, entry.status, entry.jid, entry.name)
      console.log(`[${id}] nome de perfil atualizado: ${entry.name}`)
    }
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    const disconnectCode = lastDisconnect?.error?.output?.statusCode

    // Eventos de webhook da conexão (CONNECTION_UPDATE / QRCODE_UPDATED, no
    // formato da Evolution). enqueueSessionEvent nunca lança nem espera o
    // banco, então não interfere na lógica de reconexão abaixo. Só o socket
    // atual da sessão avisa: o "close" atrasado de um socket já substituído
    // (ex.: /connect logo depois de uma queda) chegaria ao receptor depois do
    // "connecting" do novo e pareceria uma desconexão que não aconteceu.
    const isCurrent = sessions.get(id) === entry
    if (qr && isCurrent) {
      enqueueSessionEvent(id, 'QRCODE_UPDATED', async () => ({
        qrcode: { instance: id, pairingCode: null, code: qr, base64: await QRCode.toDataURL(qr) }
      }))
    }
    if (connection === 'connecting' && isCurrent) {
      enqueueSessionEvent(id, 'CONNECTION_UPDATE', () => connectionUpdateData(id, entry, 'connecting', null))
    }
    if (connection === 'open' && isCurrent) {
      enqueueSessionEvent(id, 'CONNECTION_UPDATE', () => connectionUpdateData(id, entry, 'open', 200))
    }
    if (connection === 'close' && isCurrent) {
      enqueueSessionEvent(id, 'CONNECTION_UPDATE', () => connectionUpdateData(id, entry, 'close', disconnectCode))
    }

    if (qr) {
      entry.qr = qr
      entry.status = 'qr'
      clearConnectingWatchdog(id)
      await setSessionStatus(id, 'qr')
    }

    if (connection === 'open') {
      entry.status = 'connected'
      entry.qr = null
      entry.jid = sock.user?.id ?? null
      // Só um snapshot inicial: pra conta Business o nome às vezes já vem
      // pronto aqui. Pra conta pessoal normalmente ainda está undefined neste
      // ponto — quem realmente captura o nome pra esse caso é o listener de
      // 'creds.update' registrado acima (ver comentário lá).
      entry.name = sock.user?.name ?? null
      entry.connectedAt = Date.now()
      reconnectAttempts.set(id, 0)
      clearConnectingWatchdog(id)
      groups.onConnected(id)
      await setSessionStatus(id, 'connected', entry.jid, entry.name)
      console.log(`[${id}] conectado como ${entry.jid} (${entry.name ?? 'sem nome de perfil'})`)
      connectionEvents.record(id, 'open')
    }

    if (connection === 'close') {
      clearConnectingWatchdog(id)

      // Toda queda deixa rastro com o motivo (log + wa_connection_events),
      // inclusive as intencionais — é o que permite investigar depois uma
      // instância que "caiu do nada".
      const closeInfo = describeDisconnect(lastDisconnect)
      const uptimeMs = entry.connectedAt ? Date.now() - entry.connectedAt : undefined
      entry.connectedAt = undefined
      console.log(
        formatCloseLog(id, closeInfo, uptimeMs) +
          (entry.intentionalDisconnect ? ` intentional=${entry.intentionalStatus ?? 'disconnected'}` : '')
      )
      // close = queda NÃO pedida (o que se quer investigar); disconnect =
      // /disconnect ou watchdog; logout = /logout. DELETE não grava (a linha
      // da sessão está sendo apagada).
      if (entry.intentionalStatus !== 'removed') {
        const event =
          entry.intentionalStatus === 'logged_out' ? 'logout' : entry.intentionalDisconnect ? 'disconnect' : 'close'
        connectionEvents.record(id, event, { ...closeInfo, uptimeMs })
      }

      if (entry.intentionalDisconnect) {
        const finalStatus = entry.intentionalStatus ?? 'disconnected'
        entry.status = finalStatus
        // Só a sessão atual grava no banco: o close atrasado de um socket já
        // substituído (logout seguido de /connect, ou /disconnect e /connect
        // em sequência) sobrescreveria o status da sessão nova.
        if (isCurrent) {
          await setSessionStatus(id, finalStatus)
          clearReconnectTimer(id)
        }
        console.log(`[${id}] desconectado (intencional: ${finalStatus}, sem reconexão automática)`)
        return
      }

      const statusCode = disconnectCode
      const loggedOut = statusCode === DisconnectReason.loggedOut

      if (loggedOut) {
        entry.status = 'logged_out'
        console.log(`[${id}] sessão deslogada pelo WhatsApp, apagando credenciais`)
        await wipeAuthState(id)
        await setSessionStatus(id, 'logged_out')
        sessions.delete(id)
        reconnectAttempts.delete(id)
        clearReconnectTimer(id)
        return
      }

      // restartRequired (515) não é uma falha: o WhatsApp força esse
      // fechamento logo após o QR ser escaneado, como parte normal do
      // pareamento, e espera que a gente reconecte imediatamente — não
      // depois do delay configurado, e sem gastar tentativa do orçamento
      // de reconexão (ver "Connection Lifecycle" na doc do baileys).
      if (statusCode === DisconnectReason.restartRequired) {
        entry.status = 'reconnecting'
        await setSessionStatus(id, 'reconnecting')
        console.log(`[${id}] restartRequired (normal pós-QR), reconectando imediatamente...`)
        startSessionSerialized(id)
        return
      }

      const attempt = (reconnectAttempts.get(id) ?? 0) + 1
      reconnectAttempts.set(id, attempt)

      if (attempt > RECONNECT_MAX_ATTEMPTS) {
        entry.status = 'error'
        await setSessionStatus(id, 'error')
        sessions.delete(id)
        clearReconnectTimer(id)
        console.log(`[${id}] desistindo após ${attempt - 1} tentativas — chame /connect manualmente pra tentar de novo`)
        return
      }

      entry.status = 'reconnecting'
      await setSessionStatus(id, 'reconnecting')
      console.log(
        `[${id}] conexão caiu, reconectando em ${RECONNECT_DELAY_MS}ms ` +
          `(tentativa ${attempt}/${RECONNECT_MAX_ATTEMPTS})...`
      )
      clearReconnectTimer(id)
      reconnectTimers.set(id, setTimeout(() => startSessionSerialized(id), RECONNECT_DELAY_MS))
    }
  })

  return entry
}

// Ao subir o processo, reconecta automaticamente toda sessão que não foi
// deslogada/removida NEM desconectada manualmente. 'disconnected' fica de
// fora de propósito: reconectar sozinho nesse caso quebraria a garantia
// documentada de que /disconnect nunca aciona reconexão automática — um
// restart do processo (deploy, crash, reagendamento pelo orquestrador) não
// deve ser um jeito indireto de driblar um /disconnect intencional.
async function restorePersistedSessions() {
  const { rows } = await pool.query(
    `SELECT id FROM wa_sessions WHERE status NOT IN ('logged_out', 'disconnected')`
  )
  for (const { id } of rows) {
    console.log(`Restaurando sessão persistida: ${id}`)
    await startSessionSerialized(id)
  }
}

// ---------------------- API ----------------------

const app = express()

// Health check sem autenticação, útil pra load balancer / orquestrador.
app.get('/health', (req, res) => res.json({ ok: true }))

// Tela de configuração (SPA em manager/, buildada no Dockerfile). Estáticos
// públicos de propósito: não contêm dado nenhum — a tela pede a API key e
// toda chamada dela vai pras rotas /sessions, que exigem x-api-key.
// fileURLToPath em vez de .pathname: no Windows o .pathname vira "/C:/..." e
// o caminho não resolve. O fallback usa o wildcard do Express 5
// ("/manager/{*splat}"); "/manager/*" é inválido no path-to-regexp v8 e
// derruba o boot.
const MANAGER_DIST = fileURLToPath(new URL('./manager/dist', import.meta.url))
if (fs.existsSync(MANAGER_DIST)) {
  // A tela guarda a API key na aba: CSP restritivo (só scripts do próprio
  // bundle) reduz o estrago de um eventual XSS, e frame-ancestors 'none'
  // impede embutir a tela num iframe alheio (clickjacking). 'unsafe-inline'
  // em style-src é exigido pelos estilos inline dos componentes Radix.
  const managerSecurityHeaders = (res) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
  }
  app.use('/manager', express.static(MANAGER_DIST, { setHeaders: managerSecurityHeaders }))
  app.get('/manager/{*splat}', (req, res) => {
    managerSecurityHeaders(res)
    res.sendFile(path.join(MANAGER_DIST, 'index.html'))
  })
} else {
  console.warn(`Tela /manager indisponível: ${MANAGER_DIST} não existe (rode "npm run build" em manager/).`)
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  // Precisa ter o mesmo tamanho pra timingSafeEqual não lançar erro. Comparar
  // contra um buffer do mesmo tamanho de "b" primeiro evita que a checagem de
  // tamanho vaze quão perto a tentativa chegou do tamanho certo via early-return.
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufB, bufB) // mantém o tempo consistente mesmo no caso de tamanho diferente
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

// Todas as rotas de sessão exigem a API key global, enviada no header x-api-key.
app.use('/sessions', (req, res, next) => {
  const key = req.get('x-api-key')
  if (!key || !safeCompare(key, API_KEY)) {
    return res.status(401).json({ error: 'API key ausente ou inválida. Envie no header x-api-key.' })
  }
  next()
})

// O corpo só é lido DEPOIS da API key: antes, qualquer cliente sem chave
// fazia o servidor ler e parsear até 20MB por requisição só pra receber 401.
// Limite grande apenas nas rotas que recebem mídia em base64 (/messages e o
// thumbnailUrl de /message/sendButtons).
const MEDIA_UPLOAD_ROUTE = /^\/[^/]+\/(messages|message\/sendButtons)\/?$/
const largeJson = express.json({ limit: JSON_BODY_LIMIT })
const smallJson = express.json({ limit: SMALL_JSON_LIMIT })
app.use('/sessions', (req, res, next) =>
  (req.method === 'POST' && MEDIA_UPLOAD_ROUTE.test(req.path) ? largeJson : smallJson)(req, res, next)
)

// Configurações, histórico e webhooks por instância (webhookRoutes.js). Tem
// que vir depois do middleware acima: herda a exigência de x-api-key.
app.use(
  '/sessions/:id',
  webhookRoutes({ sessions, pool, webhooks, dispatcher, media, groups, historyLimits: GROUP_HISTORY_LIMITS })
)

// Conecta (ou reconecta) uma sessão. O :id é o número, só dígitos com DDI.
app.post('/sessions/:id/connect', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  if (!NUMBER_FORMAT.test(id)) {
    return res.status(400).json({
      error: 'formato de número inválido. Use apenas dígitos com DDI, ex: 5511999999999'
    })
  }

  // 'reconnecting' entra na mesma lista dos outros estados "ativos": a sessão
  // já tem um socket em andamento (esperando o backoff de RECONNECT_DELAY_MS
  // pra tentar de novo sozinha), então um /connect manual aqui não deve
  // atropelar esse timer. Sem isso, um consumidor da API chamando /connect
  // repetidamente sem checar o status martelava o WhatsApp com tentativas
  // mais rápido do que o backoff configurado pretende.
  const existing = sessions.get(id)
  if (existing && ['connected', 'connecting', 'qr', 'reconnecting'].includes(existing.status)) {
    return res.json({ id, status: existing.status })
  }

  reconnectAttempts.set(id, 0)
  await startSessionSerialized(id)
  res.json({ id, status: 'connecting' })
})

// Fecha a conexão mas MANTÉM as credenciais salvas — dá pra reconectar depois sem novo QR.
// Também é o jeito de destravar manualmente uma sessão presa em "connecting"
// (ou em qualquer outro estado): sock.end() num socket já morto é um no-op
// seguro, então funciona mesmo se o socket já estiver travado/sem resposta.
app.post('/sessions/:id/disconnect', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  const entry = sessions.get(id)
  if (!entry) return res.status(404).json({ error: 'sessão não está ativa neste processo' })

  await forceDisconnect(id, entry)
  res.json({ id, status: 'disconnecting' })
})

// Logout: desvincula o aparelho no WhatsApp e apaga as credenciais, mas
// MANTÉM a sessão, os webhooks e o histórico. O próximo /connect gera QR novo.
// (O /disconnect acima só pausa; o DELETE abaixo apaga tudo.)
app.post('/sessions/:id/logout', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  const result = await logoutSession(id)
  if (!result) return res.status(404).json({ error: 'sessão não encontrada' })
  console.log(`[${id}] logout via API (remoteLogout=${result.remoteLogout}), credenciais apagadas`)
  res.json(result)
})

// Histórico de aberturas/quedas/logouts com o motivo (diagnóstico de quedas).
app.get('/sessions/:id/connection-events', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return res.status(400).json({ error: 'limit precisa ser um inteiro entre 1 e 1000' })
  }
  res.json(await connectionEvents.list(id, limit))
})

// Retorna o QR code (base64) para parear, ou o status atual da sessão
app.get('/sessions/:id/qr', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  const entry = sessions.get(id)
  if (!entry) return res.status(404).json({ error: 'sessão não encontrada' })

  if (entry.status === 'connected') {
    return res.json({ status: 'connected', jid: entry.jid })
  }
  if (!entry.qr) {
    return res.json({ status: entry.status, qr: null })
  }
  const qrImage = await QRCode.toDataURL(entry.qr)
  res.json({ status: 'qr', qr: qrImage })
})

// Lista as sessões (persistidas no banco, não só as vivas neste processo)
app.get('/sessions', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, status, jid, name, updated_at FROM wa_sessions ORDER BY updated_at DESC'
  )
  res.json(rows)
})

// Logout definitivo: invalida a sessão no WhatsApp e apaga as credenciais salvas.
// Pra usar esse número de novo, precisa escanear o QR do zero.
app.delete('/sessions/:id', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  const entry = sessions.get(id)

  if (entry) {
    entry.intentionalDisconnect = true
    // A linha da sessão vai ser apagada: o handler de close não grava evento
    // (a FK de wa_connection_events falharia) nem status.
    entry.intentionalStatus = 'removed'
    try {
      // logout() manda a stanza remove-companion-device pro WhatsApp e só
      // fecha o socket (end()) DEPOIS disso ter ido pro ar. Se esse envio
      // falhar/der timeout (rede instável, WhatsApp lento pra responder), a
      // exceção não pode ficar só logada — sem o end() no finally abaixo, o
      // socket ficava aberto e autenticado, ainda conectado de verdade ao
      // WhatsApp, sem que ninguém tivesse mais referência pra fechá-lo (já
      // saiu do "sessions" map): a API dizia "removed", mas o aparelho
      // continuava na lista de "Aparelhos conectados" de verdade.
      await entry.sock.logout()
    } catch (err) {
      console.warn(`[${id}] logout() falhou (${err.message}) — fechando o socket localmente mesmo assim`)
    } finally {
      // Garantido mesmo se logout() já tiver fechado o socket com sucesso —
      // end() num socket já encerrado é um no-op seguro (mesmo padrão do
      // forceDisconnect/watchdog de "connecting" travado).
      entry.sock.end(undefined)
    }
    sessions.delete(id)
  }
  clearReconnectTimer(id)
  clearConnectingWatchdog(id)

  await wipeAuthState(id)
  // O CASCADE leva junto mensagens, webhooks e entregas pendentes (FR-026).
  const { rowCount } = await pool.query('DELETE FROM wa_sessions WHERE id = $1', [id])
  webhooks.invalidate(id)
  groups.forgetSession(id)

  // Sem sessão em memória E sem linha no banco: nunca existiu (ou já tinha
  // sido removida antes). Antes disso a rota respondia "removed" sempre,
  // mesmo pra um :id que nunca foi conectado — 404 é o resultado honesto.
  if (!entry && rowCount === 0) {
    return res.status(404).json({ error: 'sessão não encontrada' })
  }

  res.json({ id, status: 'removed' })
})

// Endpoint principal: dispara mensagem (texto, imagem, vídeo, documento ou
// áudio) por uma sessão específica, a um número ou a um grupo (@g.us). "type"
// default é "text", pra manter compatibilidade total com o formato antigo
// { to, message }. Imagem/vídeo/documento/áudio vão em
// "mediaBase64" — de propósito NÃO existe um "mediaUrl" que o servidor
// buscaria sozinho: isso seria SSRF (fetch de URL arbitrária vinda de
// qualquer cliente que tenha a API key global), então mídia só entra
// embutida no próprio request.
//
// Validação, conteúdo e envio ficam em outbound.js (testados com socket falso).
app.post(
  '/sessions/:id/messages',
  createSendMessageHandler({
    getConnectedEntry,
    generateMessageId: generateMessageIDV2,
    waitForStatus: (sock, messageId) => waitForMessageStatus(sock, messageId, MESSAGE_STATUS_TIMEOUT_MS),
    cacheSentMessage,
    recordApiMessage,
    respondWithMessageStatus,
    // Participação no grupo: primeiro a lista em memória que o próprio
    // Baileys usa no envio (groupMetadata.js, validade curta); sem ela,
    // sock.groupMetadata. Evita uma consulta ao WhatsApp por mensagem.
    cachedGroupMetadata: (sessionId, jid) => groups.cachedGroupMetadata(sessionId)(jid),
    // Citação ("quotedMessageId"): a mensagem gravada em wa_messages.
    findQuotedMessage: (sessionId, keyId) => findMessageByKeyId(sessionId, keyId)
  })
)

// Fluxo comum de /message/sendList e /message/sendButtons. buildContent(sock)
// monta o proto (já com o payload validado) e retorna { message } ou
// { error } (vira 400). bizNode é o nó <biz> que faz o WhatsApp renderizar a
// mensagem — ver interactive.js.
async function sendInteractiveMessage(req, res, buildContent, bizNode) {
  const id = normalizeNumber(req.params.id)
  const body = req.body ?? {}

  const to = parseRecipientNumber(body.number)
  if (!to) {
    return res.status(400).json({
      error:
        'informe "number" no corpo: dígitos com DDI (ex: 5511999999999) ou JID de usuário ' +
        '(ex: 5511999999999@s.whatsapp.net). Grupo e @lid não são suportados.'
    })
  }
  if (body.delay !== undefined && !(Number.isInteger(body.delay) && body.delay >= 0)) {
    return res.status(400).json({ error: '"delay" precisa ser um inteiro >= 0 (milissegundos)' })
  }

  const entry = getConnectedEntry(id, res)
  if (!entry) return

  try {
    // Mesmo motivo da rota /messages: o JID canônico vem do servidor do
    // WhatsApp (resolve o "9" ambíguo dos números brasileiros).
    const [resolved] = (await entry.sock.onWhatsApp(to)) || []
    if (!resolved?.exists) {
      return res.status(404).json({ error: `número "${to}" não está registrado no WhatsApp (ou não foi possível confirmar)` })
    }

    const built = await buildContent(entry.sock)
    if (built.error) return res.status(400).json({ error: built.error })

    if (body.delay) await simulateTyping(entry.sock, resolved.jid, body.delay)

    // sock.sendMessage() não serve aqui: ele não aceita listMessage /
    // interactiveMessage e não deixa adicionar o nó <biz>. Geramos a mensagem
    // completa (id incluso) e mandamos pelo relayMessage, que é o que o
    // próprio sendMessage usa por baixo, com o <biz> em additionalNodes.
    const fullMsg = generateWAMessageFromContent(resolved.jid, built.message, { userJid: entry.sock.user.id })
    // O relayMessage não emite eco próprio, mas o registro antes do envio
    // mantém as duas rotas com a mesma garantia (research R4).
    entry.apiMessageIds.mark(fullMsg.key.id)
    await entry.sock.relayMessage(resolved.jid, fullMsg.message, {
      messageId: fullMsg.key.id,
      additionalNodes: [bizNode]
    })
    const statusPromise = waitForMessageStatus(entry.sock, fullMsg.key.id, MESSAGE_STATUS_TIMEOUT_MS)

    cacheSentMessage(entry, fullMsg.key.id, fullMsg.message)
    recordApiMessage(id, entry, fullMsg).catch((err) =>
      console.error(`[${id}] falha ao gravar mensagem enviada ${fullMsg.key.id}: ${err.message}`)
    )
    await respondWithMessageStatus(res, fullMsg.key.id, statusPromise)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// Lista de opções, com o mesmo payload do POST /message/sendList da
// Evolution API 2.4.0 (number, title, description, footerText, buttonText,
// sections[].rows[]). "footerText" é o rodapé. Campos da Evolution que não se
// aplicam a esta bridge (quoted, mentioned, mentionsEveryOne, linkPreview)
// são aceitos e ignorados — no caminho de listas/botões a própria Evolution
// também não os aplica à mensagem enviada.
app.post('/sessions/:id/message/sendList', async (req, res) => {
  const built = buildListMessage(req.body ?? {})
  if (built.error) return res.status(400).json({ error: built.error })
  await sendInteractiveMessage(req, res, async () => built, LIST_BIZ_NODE)
})

// Botões (reply, url, call, copy, pix), com o mesmo payload do POST
// /message/sendButtons da Evolution API 2.4.0. "footer" é o rodapé. Além da
// Evolution, aceita "headerText" (cabeçalho em texto) e deixa cabeçalho,
// corpo, rodapé e botões opcionais — ver validateButtonsPayload.
//
// thumbnailUrl (imagem do cabeçalho), como na Evolution, aceita uma URL
// http(s) OU a imagem em base64. Atenção: a URL é baixada pelo PRÓPRIO
// servidor da bridge — diferente da rota /messages, que de propósito só
// aceita mídia embutida (ver comentário lá). Isso é SSRF por definição:
// qualquer cliente com a API key consegue fazer a bridge buscar uma URL
// arbitrária (inclusive endereços internos da rede onde ela roda). Foi uma
// decisão consciente pra manter compatibilidade com a Evolution.
app.post('/sessions/:id/message/sendButtons', async (req, res) => {
  const body = req.body ?? {}
  const error = validateButtonsPayload(body)
  if (error) return res.status(400).json({ error })

  await sendInteractiveMessage(
    req,
    res,
    async (sock) => {
      if (!body.thumbnailUrl) return { message: buildButtonsMessage(body) }

      let image
      if (/^https?:\/\//i.test(body.thumbnailUrl)) {
        image = { url: body.thumbnailUrl }
      } else {
        image = decodeBase64Media(body.thumbnailUrl)
        if (!image || image.length === 0) {
          return { error: '"thumbnailUrl" precisa ser uma URL http(s) ou uma imagem em base64 (puro ou data URL)' }
        }
      }

      let media
      try {
        media = await prepareWAMessageMedia({ image }, { upload: sock.waUploadToServer, logger })
      } catch (err) {
        return { error: `não foi possível obter/enviar a imagem de "thumbnailUrl": ${err.message}` }
      }
      return { message: buildButtonsMessage(body, media.imageMessage) }
    },
    BUTTONS_BIZ_NODE
  )
})

// Erros que escapam das rotas (inclusive os do parser de JSON, que rodam
// antes delas) saem no formato { error } da API em vez da página HTML
// padrão do Express. O detalhe interno fica só no log.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  if (err.type === 'entity.too.large') {
    const limit = MEDIA_UPLOAD_ROUTE.test(req.path.replace(/^\/sessions/, '')) ? JSON_BODY_LIMIT : SMALL_JSON_LIMIT
    return res.status(413).json({ error: `corpo da requisição maior que o limite de ${limit} desta rota` })
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'corpo da requisição não é um JSON válido' })
  }
  console.error(`erro não tratado em ${req.method} ${req.path}:`, err)
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: 'erro interno ao processar a requisição' })
})

// Limpeza horária de wa_messages (MESSAGE_RETENTION_DAYS > 0). Erro só é
// logado: a limpeza nunca pode derrubar o processo.
function startMessageRetention() {
  const purge = async () => {
    try {
      const removed = await purgeOldMessages(MESSAGE_RETENTION_DAYS)
      if (removed) console.log(`histórico: ${removed} mensagem(ns) com mais de ${MESSAGE_RETENTION_DAYS} dia(s) removida(s)`)
    } catch (err) {
      console.error(`histórico: falha na limpeza de mensagens antigas: ${err.message}`)
    }
  }
  purge()
  setInterval(purge, 60 * 60_000).unref()
}

// Limpeza horária de wa_connection_events. Mesmo cuidado da de mensagens:
// erro só é logado.
function startConnectionEventsRetention() {
  const purge = async () => {
    try {
      const removed = await connectionEvents.purgeOlderThan(CONNECTION_EVENTS_RETENTION_DAYS)
      if (removed) {
        console.log(
          `eventos de conexão: ${removed} registro(s) com mais de ${CONNECTION_EVENTS_RETENTION_DAYS} dia(s) removido(s)`
        )
      }
    } catch (err) {
      console.error(`eventos de conexão: falha na limpeza: ${err.message}`)
    }
  }
  purge()
  setInterval(purge, 60 * 60_000).unref()
}

async function main() {
  // migrate() TEM que terminar antes do listen(): senão uma requisição pode
  // chegar e consultar tabelas que ainda não existem.
  await migrate()
  // Webhooks criados antes da cifra dos cabeçalhos ainda têm valores em texto
  // puro: cifra antes de o dispatcher começar (idempotente).
  const reencrypted = await webhooks.encryptLegacyHeaders()
  if (reencrypted) console.log(`webhook: cabeçalhos de ${reencrypted} webhook(s) cifrados no banco`)
  // Depois do migrate (as tabelas do outbox precisam existir) e antes das
  // sessões: entregas que sobraram de antes do restart já voltam a sair.
  dispatcher.start()
  memoryMonitor.start()
  if (MESSAGE_RETENTION_DAYS > 0) startMessageRetention()
  startConnectionEventsRetention()
  // Bounded pelo timeout interno de resolveBaileysVersion — nunca trava o
  // boot indefinidamente mesmo se o GitHub estiver inacessível.
  await resolveBaileysVersion()
  app.listen(PORT, () => {
    console.log(`Bridge API rodando em http://localhost:${PORT}`)
  })
  await restorePersistedSessions()
}

main().catch((err) => {
  console.error('Falha ao iniciar a bridge:', err)
  process.exit(1)
})

process.on('SIGTERM', async () => {
  // Espera os POSTs de webhook em andamento antes de fechar o pool: senão o
  // resultado deles não seria gravado e a entrega só voltaria quando o lease
  // vencesse (repetindo um aviso que talvez já tenha chegado).
  await dispatcher.stop()
  await pool.end()
  process.exit(0)
})

// Rede de segurança: o baileys mexe com WebSocket cru e criptografia de sinal,
// e ocasionalmente solta uma rejeição/erro que não passa pelos handlers acima.
// Preferimos logar e manter o processo (e as outras sessões) de pé a derrubar
// a bridge inteira por causa de uma sessão problemática.
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection (bridge segue rodando):', err)
})
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (bridge segue rodando):', err)
})
