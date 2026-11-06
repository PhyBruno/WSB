import {
  WAMessageStatus,
  getContentType,
  getDevice,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  normalizeMessageContent,
  proto
} from 'baileys'

// Normalização das mensagens recebidas (messages.upsert) no formato "data" que
// a Evolution API 2.4.0-rc2 entrega nos webhooks (prepareMessage em
// whatsapp.baileys.service.ts). Módulo puro, sem I/O: recebe a WAMessage do
// Baileys e devolve objetos prontos pra gravar em wa_messages e repassar.
//
// A key chega aqui já tratada por normalizeKeyAddressing (lid.js) — a troca
// LID → PN depende do socket e fica fora deste módulo.

// Erros de decriptação que o Baileys reporta em messageStubParameters. Uma
// mensagem nesse estado não tem conteúdo legível (o WhatsApp reenvia depois,
// se conseguir). Mesma lista que a Evolution usa pra descartar.
const DECRYPTION_ERRORS = [
  'No matching sessions found for message',
  'Bad MAC',
  'failed to decrypt message',
  'SessionError',
  'Invalid PreKey ID',
  'No session record',
  'No session found to decrypt message',
  'Message absent from node'
]

const UPSERT_TYPES = new Set(['notify', 'append'])

const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'ptvMessage', 'audioMessage', 'documentMessage', 'stickerMessage'])

// Enum numérico do Baileys (ERROR=0 ... PLAYED=5) → nome, como a Evolution grava.
const STATUS_NAMES = Object.fromEntries(Object.entries(WAMessageStatus).map(([name, value]) => [value, name]))

/** 3 → 'DELIVERY_ACK' (null se não for um status conhecido). */
export function statusName(code) {
  return STATUS_NAMES[code] ?? null
}

const PROTOCOL_TYPES = proto.Message.ProtocolMessage.Type

// Só edição e exclusão viram evento. Os outros tipos de protocolMessage
// (sincronização de histórico, troca de chaves, configuração de mensagens
// temporárias...) são controle interno do WhatsApp, não conteúdo de conversa.
const HANDLED_PROTOCOL_TYPES = new Set(['MESSAGE_EDIT', 'REVOKE'])

function protocolTypeName(type) {
  return typeof type === 'number' ? PROTOCOL_TYPES[type] : type
}

/**
 * shouldIgnoreJid do makeWASocket: o Baileys responde ao servidor e descarta
 * o nó ANTES de decifrar. Só status (status@broadcast): a bridge não repassa
 * nem envia status (shouldProcess abaixo e parseSendTarget em outbound.js), e
 * decifrá-los custava caro à toa — sem a sender key do autor (comum logo
 * depois de parear) o decrypt falhava com "No session found to decrypt
 * message", o Baileys logava em nível de erro e pedia ao celular do autor que
 * reenviasse, só pra a mensagem ser descartada aqui depois. Mesmo padrão da
 * Evolution (readStatus desligado).
 */
export function shouldIgnoreJid(jid) {
  return Boolean(jid && isJidStatusBroadcast(jid))
}

/**
 * Decide se uma mensagem do messages.upsert entra no pipeline (grava + webhook).
 * Filtros iguais aos da Evolution, mais o "ignorar grupos" por instância.
 */
export function shouldProcess(received, upsertType, { groupsIgnore }) {
  if (!UPSERT_TYPES.has(upsertType)) return false
  if (received?.messageStubParameters?.some((param) => DECRYPTION_ERRORS.some((err) => String(param).includes(err)))) {
    return false
  }
  if (!received?.message) return false

  const remoteJid = received.key?.remoteJid
  if (!remoteJid || isJidStatusBroadcast(remoteJid) || isJidNewsletter(remoteJid)) return false
  if (groupsIgnore && isJidGroup(remoteJid)) return false

  const content = unwrapMessage(received.message)
  if (!getContentType(content)) return false
  if (content.protocolMessage && !HANDLED_PROTOCOL_TYPES.has(protocolTypeName(content.protocolMessage.type))) {
    return false
  }
  return true
}

/**
 * Tira os "envelopes" (ephemeralMessage, viewOnceMessage, viewOnceMessageV2,
 * documentWithCaptionMessage, editedMessage...) com o utilitário oficial do
 * Baileys, em vez de manter a lista MessageSubtype da Evolution na mão.
 */
export function unwrapMessage(message) {
  return normalizeMessageContent(message)
}

function isLong(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.low === 'number' &&
    typeof value.high === 'number' &&
    Object.keys(value).every((k) => k === 'low' || k === 'high' || k === 'unsigned')
  )
}

function longToNumber(value) {
  if (typeof value.toNumber === 'function') return value.toNumber()
  const high = value.unsigned ? value.high >>> 0 : value.high
  return high * 2 ** 32 + (value.low >>> 0)
}

/**
 * Cópia profunda pronta pra JSON. Buffers/Uint8Array viram string base64
 * (a Evolution os deixa como objeto indexado {"0":12,...}, que é maior e
 * ilegível — divergência documentada no contrato) e Long do protobuf vira
 * número (timestamps e tamanhos cabem com folga no Number).
 */
export function serializeBinary(value) {
  if (value === null || value === undefined) return value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (Array.isArray(value)) return value.map(serializeBinary)
  if (typeof value === 'object') {
    if (isLong(value) || (typeof value.toNumber === 'function' && 'low' in value && 'high' in value)) {
      return longToNumber(value)
    }
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'function' || v === undefined) continue
      out[k] = serializeBinary(v)
    }
    return out
  }
  if (typeof value === 'string') return stripNul(value)
  return value
}

// O jsonb/text do Postgres recusa o caractere NUL. Sem isso, um remetente
// que mande "\u0000" no texto faria a gravação falhar e a mensagem sumir.
function stripNul(text) {
  return text.includes('\u0000') ? text.replaceAll('\u0000', '') : text
}

function toNumber(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'object') return longToNumber(value)
  return Number(value)
}

/**
 * Ajustes de forma que a Evolution aplica no conteúdo: texto com link/citação
 * (extendedTextMessage) vira conversation simples e documento com legenda
 * vira documentMessage. Receptores (Chatwoot) só leem esses dois formatos.
 * Altera e devolve o próprio objeto (já é uma cópia).
 */
export function normalizeContentShape(message) {
  if (!message || typeof message !== 'object') return message
  if (message.extendedTextMessage) {
    message.conversation = message.extendedTextMessage.text
    delete message.extendedTextMessage
  }
  if (message.documentWithCaptionMessage) {
    message.documentMessage = message.documentWithCaptionMessage.message?.documentMessage
    delete message.documentWithCaptionMessage
  }
  return message
}

/**
 * Port do prepareMessage da Evolution 2.4.0-rc2. A key vem pronta
 * (normalizeKeyAddressing) e não é recalculada aqui.
 */
export function prepareMessage(received, { instanceId, key }) {
  const content = serializeBinary(unwrapMessage(received.message)) ?? {}
  const contentType = getContentType(content)

  // contextInfo sai do conteúdo antes da conversão extendedText → conversation,
  // como na Evolution (senão a citação de um texto se perderia).
  const contextInfo = content[contentType]?.contextInfo ? structuredClone(content[contentType].contextInfo) : null
  if (contextInfo?.quotedMessage) {
    contextInfo.quotedMessage = normalizeContentShape(unwrapMessage(contextInfo.quotedMessage))
  }

  const hadExtendedText = Boolean(content.extendedTextMessage)
  normalizeContentShape(content)

  let status = STATUS_NAMES[received.status] ?? null
  // Recebida sem status: o fato de ter chegado já é a entrega (Evolution faz o mesmo).
  if (!status && !key.fromMe) status = 'DELIVERY_ACK'

  return {
    key,
    pushName:
      (received.pushName && stripNul(received.pushName)) ||
      (key.fromMe ? 'Você' : key.participant ? key.participant.split('@')[0] : null),
    status,
    message: content,
    contextInfo,
    messageType: hadExtendedText ? 'conversation' : getContentType(content) || 'unknown',
    messageTimestamp: toNumber(received.messageTimestamp),
    instanceId,
    source: getDevice(key.id)
  }
}

/**
 * De onde veio a mensagem (coluna origin, research R4):
 * - inbound: de terceiros;
 * - api: enviada por esta bridge (id registrado antes do envio);
 * - device: enviada pelo próprio número em outro aparelho.
 */
export function classifyOrigin(key, registry) {
  if (!key.fromMe) return 'inbound'
  return registry?.has(key.id) ? 'api' : 'device'
}

/**
 * Edição (MESSAGE_EDIT) e exclusão pra todos (REVOKE) chegam como
 * protocolMessage apontando pra mensagem original. Retorna
 * { type, key, editedMessage? } ou null.
 */
export function parseProtocol(message) {
  const protocolMessage = unwrapMessage(message)?.protocolMessage
  if (!protocolMessage?.key) return null

  const type = protocolTypeName(protocolMessage.type)
  if (type === 'MESSAGE_EDIT') {
    return {
      type,
      key: serializeBinary(protocolMessage.key),
      editedMessage: normalizeContentShape(serializeBinary(unwrapMessage(protocolMessage.editedMessage)) ?? null)
    }
  }
  if (type === 'REVOKE') return { type, key: serializeBinary(protocolMessage.key) }
  return null
}

export function isMediaMessage(messageType) {
  return MEDIA_TYPES.has(messageType)
}

/**
 * Ids de mensagens enviadas pela API, registrados ANTES do envio. Existe por
 * causa de uma corrida: o sendMessage do Baileys emite o eco (messages.upsert
 * 'append') num process.nextTick antes de retornar, então o listener pode ver
 * a mensagem antes da rota gravá-la. Com o id registrado antes, o eco é
 * classificado como 'api' e nunca sai como messages.upsert (evita loop com o
 * Chatwoot). TTL curto e teto de tamanho: só precisa cobrir a janela do eco.
 */
export function createApiMessageRegistry({ ttlMs = 300_000, max = 1000, now = Date.now } = {}) {
  const ids = new Map() // id -> expiresAt, em ordem de inserção

  const prune = () => {
    const current = now()
    for (const [id, expiresAt] of ids) {
      if (expiresAt > current) break
      ids.delete(id)
    }
    while (ids.size > max) ids.delete(ids.keys().next().value)
  }

  return {
    mark(id) {
      if (!id) return
      ids.delete(id)
      ids.set(id, now() + ttlMs)
      prune()
    },
    has(id) {
      const expiresAt = ids.get(id)
      if (expiresAt === undefined) return false
      if (expiresAt <= now()) {
        ids.delete(id)
        return false
      }
      return true
    }
  }
}
