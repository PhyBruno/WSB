import { DisconnectReason } from 'baileys'

// Diagnóstico das quedas de conexão. Antes disso o motivo de um "close" não
// aparecia em lugar nenhum (o logger do baileys ficava silent e o código só
// era usado pra decidir se reconectava), então uma queda "do nada" não tinha
// como ser investigada. Aqui: (1) o motivo vira uma linha legível no log e
// (2) cada abertura/queda/logout é gravada em wa_connection_events, que
// sobrevive a redeploy do container (os logs do docker não sobrevivem).

// DisconnectReason é um enum do TypeScript: o objeto tem nome → código e
// código → nome. Alguns códigos têm dois nomes (408 = connectionLost e
// timedOut), por isso o join.
const REASON_NAMES = new Map()
for (const [name, code] of Object.entries(DisconnectReason)) {
  if (typeof code !== 'number') continue
  REASON_NAMES.set(code, REASON_NAMES.has(code) ? `${REASON_NAMES.get(code)}/${name}` : name)
}

const MAX_MESSAGE = 500
const MAX_DETAIL = 1000

function truncate(text, max) {
  if (text == null) return null
  const value = String(text)
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, (key, v) => {
      // Buffers de nós binários do WhatsApp viram só o tamanho: o que interessa
      // no diagnóstico é a tag/atributos do <stream:error>, não bytes crus.
      if (v && v.type === 'Buffer' && Array.isArray(v.data)) return `<Buffer ${v.data.length} bytes>`
      if (v instanceof Uint8Array) return `<Buffer ${v.length} bytes>`
      return v
    })
  } catch {
    return String(value)
  }
}

/**
 * Extrai o motivo de um connection.update "close" (lastDisconnect do baileys).
 * Nunca lança: a máquina de reconexão depende do handler que chama isto.
 */
export function describeDisconnect(lastDisconnect) {
  const error = lastDisconnect?.error
  const code = error?.output?.statusCode
  const statusCode = Number.isInteger(code) ? code : null
  return {
    statusCode,
    reason: statusCode == null ? null : (REASON_NAMES.get(statusCode) ?? 'unknown'),
    message: truncate(error?.message ?? null, MAX_MESSAGE),
    // Boom.data: no <stream:error> do WhatsApp é o nó com o código/motivo real.
    detail: error?.data == null ? null : truncate(safeStringify(error.data), MAX_DETAIL)
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** Linha de log de uma queda: código, nome, mensagem, há quanto tempo estava conectada. */
export function formatCloseLog(id, info, uptimeMs) {
  const parts = [
    `code=${info.statusCode ?? 'n/a'}`,
    `reason=${info.reason ?? 'n/a'}`,
    `message=${JSON.stringify(info.message ?? '')}`
  ]
  const uptime = formatDuration(uptimeMs)
  if (uptime) parts.push(`uptime=${uptime}`)
  if (info.detail) parts.push(`detail=${info.detail}`)
  return `[${id}] conexão fechou: ${parts.join(' ')}`
}

/**
 * Persistência dos eventos de conexão. record() nunca lança nem precisa de
 * await: falha de banco aqui não pode atrapalhar a reconexão.
 */
export function createConnectionEventStore({ pool, log = console }) {
  function record(sessionId, event, info = {}) {
    return pool
      .query(
        `INSERT INTO wa_connection_events (session_id, event, status_code, reason, message, detail, uptime_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sessionId,
          event,
          info.statusCode ?? null,
          info.reason ?? null,
          info.message ?? null,
          info.detail ?? null,
          Number.isFinite(info.uptimeMs) ? Math.round(info.uptimeMs) : null
        ]
      )
      .then(() => undefined)
      .catch((err) => log.error(`[${sessionId}] falha ao gravar evento de conexão ${event}: ${err.message}`))
  }

  async function list(sessionId, limit = 100) {
    const { rows } = await pool.query(
      `SELECT event, status_code AS "statusCode", reason, message, detail, uptime_ms AS "uptimeMs", created_at AS "createdAt"
         FROM wa_connection_events
        WHERE session_id = $1
        ORDER BY id DESC
        LIMIT $2`,
      [sessionId, limit]
    )
    return rows.map((row) => ({ ...row, uptimeMs: row.uptimeMs == null ? null : Number(row.uptimeMs) }))
  }

  async function purgeOlderThan(days) {
    const { rowCount } = await pool.query(
      `DELETE FROM wa_connection_events WHERE created_at < now() - make_interval(days => $1)`,
      [days]
    )
    return rowCount
  }

  return { record, list, purgeOlderThan }
}

// O libsignal (dependência do baileys) faz console.info do objeto inteiro da
// sessão de sinal a cada sessão aberta/fechada — inclusive privKey, rootKey e
// chainKeys. Isso enchia o log do container de chaves privadas (centenas de
// linhas por hora) e escondia as linhas de conexão. Descartamos só essas
// mensagens, identificadas pelo texto fixo do primeiro argumento.
const SIGNAL_SESSION_DUMPS = ['Closing session:', 'Opening session:', 'Removing old closed session:', 'Migrating session to:']

export function silenceSignalSessionDumps(target = console) {
  const original = target.info
  target.info = function (...args) {
    if (typeof args[0] === 'string' && SIGNAL_SESSION_DUMPS.includes(args[0])) return
    return original.apply(this, args)
  }
  return () => {
    target.info = original
  }
}
