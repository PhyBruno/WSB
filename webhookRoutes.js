import express from 'express'
import { getContentType, jidNormalizedUser } from 'baileys'
import { listMessages, findMessageByKeyId, webhookDataFromRow } from './messageStore.js'
import { validateWebhookInput } from './webhooks.js'
import { isMediaMessage, normalizeContentShape, unwrapMessage } from './inbound.js'
import { buildBase64Response } from './media.js'
import { distinctGroupJids, withGroupSubjects } from './groupMetadata.js'
import { holdSlotForResponse } from './limiter.js'

// Rotas novas por instância (contrato em
// docs/contracts/rest-api.md), montadas em
// /sessions/:id DEPOIS do middleware de x-api-key do server.js — por isso
// nenhuma delas checa a chave de novo. O estado do server.js chega por deps
// (sem import circular): { sessions, pool, webhooks, dispatcher, media,
// groups, historyLimits }.

const DELIVERY_STATUSES = ['pending', 'delivering', 'delivered', 'failed']

const NUMBER_FORMAT = /^\d{8,15}$/

// Express 5 já repassa rejeições pro handler de erro, mas o padrão dele
// responde HTML. Aqui todo erro inesperado vira { error } em JSON, como no
// resto da API.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    // Detalhe (que pode ser texto do Postgres) só no log, não na resposta.
    console.error(`[${req.params.id}] erro em ${req.method} ${req.baseUrl}${req.path}: ${err.message}`)
    if (!res.headersSent) res.status(500).json({ error: 'erro interno ao processar a requisição (detalhes no log da bridge)' })
  }
}

// Inteiro dentro do intervalo, ou o default se o parâmetro não veio.
// Retorna undefined se veio inválido (o chamador responde 400).
function parseIntParam(raw, { min, max, fallback }) {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(String(raw))) return undefined
  const value = Number(raw)
  return value >= min && value <= max ? value : undefined
}

// remoteJid do filtro de histórico: só dígitos (vira PN) ou um JID.
function parseRemoteJid(raw) {
  if (raw === undefined || raw === '') return null
  const value = String(raw).trim()
  if (value.includes('@')) return jidNormalizedUser(value) || undefined
  return NUMBER_FORMAT.test(value) ? `${value}@s.whatsapp.net` : undefined
}

/**
 * groupSubject (nome ATUAL do grupo) nos itens de grupo de uma página do
 * histórico. Cada grupo distinto da página é resolvido uma vez só, num lote
 * (groupMetadata.js); limits = { maxLookups, budgetMs } limita as consultas
 * ao WhatsApp desta requisição — o que passar fica null. Paginação e ordem
 * não mudam, e item individual não ganha o campo.
 */
export async function addGroupSubjects(groups, sessionId, page, limits = {}) {
  const jids = distinctGroupJids(page.items)
  if (!groups || jids.length === 0) return page
  const subjects = await groups.resolveSubjects(sessionId, jids, limits)
  return { ...page, items: withGroupSubjects(page.items, subjects) }
}

export default function webhookRoutes({
  sessions,
  pool,
  webhooks,
  dispatcher,
  media,
  groups = null,
  historyLimits = {},
  // Vagas do getBase64FromMediaMessage (download + base64 + JSON da resposta,
  // ~4x o arquivo cada). Sem limiter, sem limite.
  base64Slots = null,
  base64QueueTimeoutMs = 30_000
}) {
  const router = express.Router({ mergeParams: true })

  // Sessão que existe no banco (viva ou não neste processo). Responde 404 e
  // retorna null se não existir.
  async function loadSession(req, res) {
    const id = String(req.params.id).replace(/\D/g, '')
    const {
      rows: [row]
    } = await pool.query('SELECT id, jid, groups_ignore FROM wa_sessions WHERE id = $1', [id])
    if (!row) {
      res.status(404).json({ error: 'sessão não encontrada' })
      return null
    }
    return row
  }

  // ---------------- Configurações ----------------

  router.get(
    '/settings',
    handle(async (req, res) => {
      const session = await loadSession(req, res)
      if (!session) return
      res.json({ groupsIgnore: session.groups_ignore })
    })
  )

  router.patch(
    '/settings',
    handle(async (req, res) => {
      const { groupsIgnore } = req.body ?? {}
      if (typeof groupsIgnore !== 'boolean') {
        return res.status(400).json({ error: '"groupsIgnore" precisa ser booleano (true ou false)' })
      }
      const session = await loadSession(req, res)
      if (!session) return

      await pool.query('UPDATE wa_sessions SET groups_ignore = $2, updated_at = now() WHERE id = $1', [
        session.id,
        groupsIgnore
      ])
      // Vale já pra próxima mensagem: o listener lê do entry em memória.
      const entry = sessions.get(session.id)
      if (entry) entry.groupsIgnore = groupsIgnore
      res.json({ groupsIgnore })
    })
  )

  // ---------------- Histórico ----------------

  router.get(
    '/messages',
    handle(async (req, res) => {
      const remoteJid = parseRemoteJid(req.query.remoteJid)
      if (remoteJid === undefined) {
        return res.status(400).json({ error: '"remoteJid" inválido: use dígitos com DDI (ex: 5511999999999) ou um JID' })
      }
      const limit = parseIntParam(req.query.limit, { min: 1, max: 200, fallback: 50 })
      if (limit === undefined) return res.status(400).json({ error: '"limit" precisa ser um inteiro entre 1 e 200' })
      const before = parseIntParam(req.query.before, { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: null })
      if (before === undefined) return res.status(400).json({ error: '"before" precisa ser um id inteiro positivo' })

      const session = await loadSession(req, res)
      if (!session) return
      const page = await listMessages(session.id, { remoteJid, limit, before })
      res.json(await addGroupSubjects(groups, session.id, page, historyLimits))
    })
  )

  // ---------------- Webhooks ----------------

  router.get(
    '/webhooks',
    handle(async (req, res) => {
      const session = await loadSession(req, res)
      if (!session) return
      res.json(await webhooks.listWebhooks(session.id))
    })
  )

  router.post(
    '/webhooks',
    handle(async (req, res) => {
      const { value, error } = validateWebhookInput(req.body)
      if (error) return res.status(400).json({ error })
      const session = await loadSession(req, res)
      if (!session) return

      const created = await webhooks.createWebhook(session.id, value)
      if (created.error) return res.status(400).json({ error: created.error })
      res.status(201).json(created.webhook)
    })
  )

  router.put(
    '/webhooks/:webhookId',
    handle(async (req, res) => {
      const { value, error } = validateWebhookInput(req.body)
      if (error) return res.status(400).json({ error })
      const session = await loadSession(req, res)
      if (!session) return

      const updated = await webhooks.updateWebhook(session.id, req.params.webhookId, value)
      if (!updated) return res.status(404).json({ error: 'webhook não encontrado nesta sessão' })
      if (updated.error) return res.status(400).json({ error: updated.error })
      res.json(updated.webhook)
    })
  )

  router.delete(
    '/webhooks/:webhookId',
    handle(async (req, res) => {
      const session = await loadSession(req, res)
      if (!session) return
      const removed = await webhooks.deleteWebhook(session.id, req.params.webhookId)
      if (!removed) return res.status(404).json({ error: 'webhook não encontrado nesta sessão' })
      res.json({ id: req.params.webhookId, status: 'removed' })
    })
  )

  // Sempre 200 quando o teste rodou: o resultado do destino (inclusive erro)
  // vai no corpo, pra tela mostrar o que o receptor respondeu.
  router.post(
    '/webhooks/:webhookId/test',
    handle(async (req, res) => {
      const session = await loadSession(req, res)
      if (!session) return
      const webhook = await webhooks.getWebhookRaw(session.id, req.params.webhookId)
      if (!webhook) return res.status(404).json({ error: 'webhook não encontrado nesta sessão' })
      const sender = sessions.get(session.id)?.jid ?? session.jid
      res.json(await dispatcher.sendTest(webhook, session.id, sender))
    })
  )

  router.get(
    '/webhooks/:webhookId/deliveries',
    handle(async (req, res) => {
      const status = req.query.status || null
      if (status && !DELIVERY_STATUSES.includes(status)) {
        return res.status(400).json({ error: `"status" inválido. Use: ${DELIVERY_STATUSES.join(', ')}` })
      }
      const limit = parseIntParam(req.query.limit, { min: 1, max: 200, fallback: 50 })
      if (limit === undefined) return res.status(400).json({ error: '"limit" precisa ser um inteiro entre 1 e 200' })
      const before = parseIntParam(req.query.before, { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: null })
      if (before === undefined) return res.status(400).json({ error: '"before" precisa ser um id inteiro positivo' })

      const session = await loadSession(req, res)
      if (!session) return
      const webhook = await webhooks.getWebhook(session.id, req.params.webhookId)
      if (!webhook) return res.status(404).json({ error: 'webhook não encontrado nesta sessão' })
      res.json(await webhooks.listDeliveries(webhook.id, { status, limit, before }))
    })
  )

  // ---------------- Mídia sob demanda ----------------

  // Compatível com POST /chat/getBase64FromMediaMessage/:instance da
  // Evolution. Aceita só a key (busca a mensagem gravada) ou a mensagem
  // inteira no formato da Evolution, com binários em base64 ou como objeto
  // indexado. convertToMp4 é aceito e ignorado: a imagem não tem ffmpeg.
  router.post(
    '/chat/getBase64FromMediaMessage',
    handle(async (req, res) => {
      const message = req.body?.message
      const keyId = message?.key?.id
      if (typeof keyId !== 'string' || keyId === '') {
        return res.status(400).json({ error: 'informe "message.key.id" (id da mensagem de mídia)' })
      }
      const session = await loadSession(req, res)
      if (!session) return

      let data
      const row = await findMessageByKeyId(session.id, keyId)
      if (row) {
        data = webhookDataFromRow(row)
      } else if (message.message && typeof message.message === 'object') {
        const content = normalizeContentShape(structuredClone(unwrapMessage(message.message)))
        data = { key: message.key, message: content, messageType: getContentType(content) }
      } else {
        return res.status(404).json({ error: 'mensagem não encontrada nesta sessão' })
      }

      if (!isMediaMessage(data.messageType)) {
        return res.status(400).json({ error: `a mensagem não é de mídia (tipo: ${data.messageType ?? 'desconhecido'})` })
      }

      // O socket conectado é o que permite pedir ao celular o reenvio de uma
      // mídia que já expirou no CDN (reuploadRequest).
      const entry = sessions.get(session.id)
      if (!entry || entry.status !== 'connected') {
        return res.status(409).json({ error: `sessão não está conectada (status: ${entry?.status ?? 'inativa'})` })
      }

      // A vaga vale até a resposta (com o base64) terminar de sair.
      if (
        base64Slots &&
        !(await holdSlotForResponse({ limiter: base64Slots, res, timeoutMs: base64QueueTimeoutMs, label: 'pedidos de mídia em base64' }))
      ) {
        return
      }

      let buffer
      try {
        buffer = await media.download(entry.sock, session.id, data)
      } catch (err) {
        if (err.code === 'too_large') {
          return res.status(413).json({ error: 'mídia maior que o limite WEBHOOK_MEDIA_MAX_BYTES' })
        }
        return res.status(502).json({ error: `o WhatsApp não devolveu a mídia (expirada ou indisponível): ${err.message}` })
      }
      res.json(buildBase64Response(data, buffer))
    })
  )

  return router
}
