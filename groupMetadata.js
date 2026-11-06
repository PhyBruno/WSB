import { isJidGroup } from 'baileys'

// Nome dos grupos (subject), pros webhooks (data.groupSubject) e pro
// histórico. Busca em três camadas, nesta ordem:
//   L1 — memória por sessão (TTL, teto de grupos, descarta o mais antigo);
//   L2 — wa_groups no Postgres, uma consulta por lote (nunca uma por mensagem);
//   L3 — sock.groupMetadata(jid) no WhatsApp, só quando L1 e L2 não têm.
//
// L3 é caro e o WhatsApp limita (rate-overlimit): uma consulta por grupo de
// cada vez (single-flight), poucas simultâneas por sessão, timeout e cache
// negativo pra não insistir num grupo que falhou. Todo resultado de L3 e todo
// groups.upsert/groups.update grava em L2 e atualiza L1 (write-through).
//
// Nada aqui lança: erro, timeout ou sessão sem socket conectado viram null, e
// quem chama (entrega de webhook, histórico) segue normalmente. O nome é dado
// do usuário: os logs mostram só o JID e o resultado, nunca o subject.

export const GROUP_METADATA_DEFAULTS = {
  ttlMs: 21_600_000,
  failureTtlMs: 300_000,
  timeoutMs: 3_000,
  maxEntries: 2_000,
  maxConcurrent: 3,
  // Validade da lista de participantes servida ao Baileys (cachedGroupMetadata).
  // Bem menor que a do nome: se um group-participants.update se perder, um
  // envio ao grupo não fica horas com a lista velha.
  metadataTtlMs: 300_000
}

// Teto do cache negativo (todas as sessões). Passou disso, os mais antigos saem.
const MAX_FAILURES = 10_000

const TIMEOUT = Symbol('timeout')

function withTimeout(promise, ms, fallback = TIMEOUT) {
  let timer
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(ms, 0))
  })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

/** remote_jid de grupo distintos de uma lista de itens "data", na ordem em que aparecem. */
export function distinctGroupJids(items) {
  return [...new Set(items.map((item) => item?.key?.remoteJid).filter((jid) => isJidGroup(jid)))]
}

/** Acrescenta groupSubject (string | null) só aos itens de grupo. Não altera os itens recebidos. */
export function withGroupSubjects(items, subjects) {
  return items.map((item) =>
    isJidGroup(item?.key?.remoteJid) ? { ...item, groupSubject: subjects.get(item.key.remoteJid) ?? null } : item
  )
}

/**
 * pool:      pg Pool (wa_groups)
 * getSocket: (sessionId) → socket CONECTADO ou undefined (sem socket, só L1 e L2)
 * config:    { ttlMs, failureTtlMs, timeoutMs, maxEntries, maxConcurrent, metadataTtlMs }
 */
export function createGroupMetadataCache({ pool, getSocket = () => undefined, config = {}, log = console, now = Date.now }) {
  const { ttlMs, failureTtlMs, timeoutMs, maxEntries, maxConcurrent, metadataTtlMs } = {
    ...GROUP_METADATA_DEFAULTS,
    ...config
  }
  const debug = log.debug?.bind(log) ?? (() => {})

  // sessionId → Map<jid, { subject, expiresAt, metadata, metadataExpiresAt }>.
  // metadata é o GroupMetadata completo (L3, groups.upsert ou a sincronização
  // de groups.update), servido ao Baileys pelo cachedGroupMetadata; do L2 só
  // vem o subject.
  const memory = new Map()
  // "<sessionId> <jid>" → validade do cache negativo (L3 falhou)
  const failures = new Map()
  // "<sessionId> <jid>" → { promise, neededUntil } da consulta L3 em andamento
  const flights = new Map()
  // sessionId → { active, queue } — limite de consultas L3 simultâneas
  const slots = new Map()
  // "<sessionId> <jid>" → número de sequência da última troca de nome por
  // evento (groups.upsert/update). Uma leitura (L2 ou L3) que começou antes
  // disso é velha e não pode sobrescrever o nome novo.
  const renamed = new Map()
  let sequence = 0

  const flightId = (sessionId, jid) => `${sessionId} ${jid}`

  function remember(sessionId, jid, subject, metadata) {
    let groups = memory.get(sessionId)
    if (!groups) memory.set(sessionId, (groups = new Map()))
    const previous = groups.get(jid)
    // delete + set: o grupo vai pro fim da ordem de inserção (mais novo).
    groups.delete(jid)
    const entry = { subject, expiresAt: now() + ttlMs, metadata: null, metadataExpiresAt: 0 }
    if (metadata) Object.assign(entry, { metadata, metadataExpiresAt: now() + metadataTtlMs })
    else if (metadata === undefined && previous) Object.assign(entry, { metadata: previous.metadata, metadataExpiresAt: previous.metadataExpiresAt })
    groups.set(jid, entry)
    while (groups.size > maxEntries) groups.delete(groups.keys().next().value)
  }

  function fromMemory(sessionId, jid) {
    const groups = memory.get(sessionId)
    const hit = groups?.get(jid)
    if (!hit) return undefined
    if (hit.expiresAt <= now()) {
      groups.delete(jid)
      return undefined
    }
    return hit
  }

  function markRenamed(id) {
    renamed.delete(id)
    renamed.set(id, ++sequence)
    while (renamed.size > MAX_FAILURES) renamed.delete(renamed.keys().next().value)
  }

  const renamedSince = (id, mark) => (renamed.get(id) ?? 0) > mark

  function setFailure(id) {
    failures.delete(id)
    failures.set(id, now() + failureTtlMs)
    while (failures.size > MAX_FAILURES) failures.delete(failures.keys().next().value)
  }

  function recentlyFailed(id) {
    const until = failures.get(id)
    if (until === undefined) return false
    if (until > now()) return true
    failures.delete(id)
    return false
  }

  async function fromDatabase(sessionId, jids) {
    const { rows } = await pool.query('SELECT jid, subject FROM wa_groups WHERE session_id = $1 AND jid = ANY($2::text[])', [
      sessionId,
      jids
    ])
    return new Map(rows.filter((row) => typeof row.subject === 'string').map((row) => [row.jid, row.subject]))
  }

  async function persist(sessionId, subjects) {
    if (subjects.size === 0) return
    try {
      // Um INSERT só pro lote; a Map já deixou um nome por grupo (repetido no
      // mesmo comando, o ON CONFLICT DO UPDATE falharia).
      await pool.query(
        `INSERT INTO wa_groups (session_id, jid, subject)
         SELECT $1, jid, subject FROM unnest($2::text[], $3::text[]) AS t(jid, subject)
         ON CONFLICT (session_id, jid) DO UPDATE SET subject = EXCLUDED.subject, updated_at = now()`,
        [sessionId, [...subjects.keys()], [...subjects.values()]]
      )
    } catch (err) {
      log.warn(`[${sessionId}] grupos: falha ao gravar ${subjects.size} nome(s) em wa_groups: ${err.message}`)
    }
  }

  // Resposta do L3 → L1 e L2. Se o grupo foi renomeado por evento depois que
  // a consulta começou (mark), a resposta é velha: vale o nome do evento.
  // Retorna o subject atual, ou null se a resposta não tinha subject.
  function learn(sessionId, jid, metadata, mark) {
    if (typeof metadata?.subject !== 'string') return null
    const id = flightId(sessionId, jid)
    failures.delete(id)
    if (renamedSince(id, mark)) return fromMemory(sessionId, jid)?.subject ?? metadata.subject
    remember(sessionId, jid, metadata.subject, Array.isArray(metadata.participants) ? metadata : null)
    persist(sessionId, new Map([[jid, metadata.subject]]))
    return metadata.subject
  }

  function acquire(sessionId) {
    let slot = slots.get(sessionId)
    if (!slot) slots.set(sessionId, (slot = { active: 0, queue: [] }))
    if (slot.active < maxConcurrent) {
      slot.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => slot.queue.push(resolve))
  }

  function release(sessionId) {
    const slot = slots.get(sessionId)
    const next = slot.queue.shift()
    if (next) next() // a vaga passa direto pro próximo da fila
    else if (--slot.active === 0) slots.delete(sessionId)
  }

  // A consulta em si. A vaga fica presa até o WhatsApp responder de verdade
  // (o próprio Baileys tem timeout de query), pra o limite de simultâneas
  // valer mesmo com o WhatsApp lento. Quem pediu espera no máximo o próprio
  // prazo (lookup); passado timeoutMs sem resposta, o grupo entra no cache
  // negativo, e uma resposta que chegue depois ainda é gravada.
  async function runLookup(sessionId, jid, sock, flight) {
    const id = flightId(sessionId, jid)
    await acquire(sessionId)
    try {
      // Na fila, todo mundo que esperava pode ter desistido: não consulta à toa.
      if (now() >= flight.neededUntil) return null
      // Pode ter chegado por groups.update enquanto esperava a vaga.
      const cached = fromMemory(sessionId, jid)
      if (cached) return cached.subject

      const mark = sequence
      const slow = setTimeout(() => {
        setFailure(id)
        log.warn(`[${sessionId}] grupo ${jid}: WhatsApp não respondeu em ${timeoutMs}ms — nome fica null por ${failureTtlMs}ms`)
      }, timeoutMs)
      let metadata
      try {
        metadata = await sock.groupMetadata(jid)
      } catch (err) {
        // rate-overlimit, grupo inexistente, sem permissão... tudo conta como falha.
        setFailure(id)
        log.warn(`[${sessionId}] grupo ${jid}: consulta ao WhatsApp falhou (${err.message}) — nome fica null por ${failureTtlMs}ms`)
        return null
      } finally {
        clearTimeout(slow)
      }
      const subject = learn(sessionId, jid, metadata, mark)
      if (subject === null) {
        setFailure(id)
        log.warn(`[${sessionId}] grupo ${jid}: consulta ao WhatsApp sem subject — nome fica null por ${failureTtlMs}ms`)
        return null
      }
      log.info(`[${sessionId}] grupo ${jid}: nome obtido do WhatsApp`)
      return subject
    } finally {
      release(sessionId)
      flights.delete(id)
    }
  }

  // L3, single-flight: pedidos simultâneos do mesmo grupo esperam a mesma
  // consulta, cada um até o próprio prazo (wait).
  function lookup(sessionId, jid, sock, wait) {
    const id = flightId(sessionId, jid)
    let flight = flights.get(id)
    if (!flight) {
      flight = { neededUntil: 0 }
      flight.promise = runLookup(sessionId, jid, sock, flight).catch(() => null)
      flights.set(id, flight)
    }
    flight.neededUntil = Math.max(flight.neededUntil, now() + wait)
    return withTimeout(flight.promise, wait, null)
  }

  /**
   * Nomes de vários grupos de uma vez: L1, depois UMA consulta ao L2 com os
   * que faltaram, depois L3 em paralelo (limitado por sessão) pro resto.
   * Retorna Map<jid, string | null> com todos os JIDs de grupo pedidos.
   *
   * options.maxLookups: máximo de consultas L3 iniciadas nesta chamada
   * options.budgetMs:   tempo total da chamada; sem ele, cada consulta L3
   *                     espera até timeoutMs
   */
  async function resolveSubjects(sessionId, jids, { maxLookups = Infinity, budgetMs = null } = {}) {
    const started = now()
    const result = new Map()
    const wanted = [...new Set(jids)].filter((jid) => isJidGroup(jid))
    for (const jid of wanted) result.set(jid, null)

    try {
      const missing = []
      for (const jid of wanted) {
        const hit = fromMemory(sessionId, jid)
        if (hit) {
          result.set(jid, hit.subject)
          debug(`[${sessionId}] grupo ${jid}: nome em memória (L1)`)
        } else {
          missing.push(jid)
        }
      }
      if (missing.length === 0) return result

      const mark = sequence
      const stored = await fromDatabase(sessionId, missing)
      const pending = []
      for (const jid of missing) {
        if (renamedSince(flightId(sessionId, jid), mark) && fromMemory(sessionId, jid)) {
          // Renomeado enquanto o SELECT rodava: o banco pode ter o nome velho.
          result.set(jid, fromMemory(sessionId, jid).subject)
        } else if (stored.has(jid)) {
          remember(sessionId, jid, stored.get(jid))
          result.set(jid, stored.get(jid))
          debug(`[${sessionId}] grupo ${jid}: nome no banco (L2)`)
        } else {
          pending.push(jid)
        }
      }

      const sock = getSocket(sessionId)
      if (!sock || pending.length === 0) return result

      let lookups = 0
      await Promise.all(
        pending.map(async (jid) => {
          if (recentlyFailed(flightId(sessionId, jid)) || lookups >= maxLookups) return
          const wait = budgetMs === null ? timeoutMs : budgetMs - (now() - started)
          if (wait <= 0) return
          lookups++
          result.set(jid, await lookup(sessionId, jid, sock, wait))
        })
      )
    } catch (err) {
      log.warn(`[${sessionId}] grupos: falha ao resolver ${wanted.length} nome(s): ${err.message}`)
    }
    return result
  }

  return {
    timeoutMs,

    resolveSubjects,

    /** Retrato pro diagnóstico de memória (memoryMonitor.js). */
    stats() {
      let groups = 0
      let withMetadata = 0
      let participants = 0
      for (const map of memory.values()) {
        groups += map.size
        for (const entry of map.values()) {
          if (!entry.metadata) continue
          withMetadata++
          participants += entry.metadata.participants?.length ?? 0
        }
      }
      return { groups, withMetadata, participants, failures: failures.size, flights: flights.size }
    },

    /** Nome de um grupo (string | null). Nunca lança. */
    async getSubject(sessionId, jid) {
      return (await resolveSubjects(sessionId, [jid])).get(jid) ?? null
    },

    /**
     * cachedGroupMetadata do makeWASocket (Baileys 7.0.0-rc14:
     * (jid) => Promise<GroupMetadata | undefined>). Só responde da memória, só
     * com o metadata completo e dentro de metadataTtlMs: fora disso o Baileys
     * consulta o grupo ele mesmo, como fazia antes.
     */
    cachedGroupMetadata(sessionId) {
      return async (jid) => {
        const hit = fromMemory(sessionId, jid)
        return hit?.metadata && hit.metadataExpiresAt > now() ? hit.metadata : undefined
      }
    },

    /** groups.upsert: GroupMetadata[] (entrou num grupo). */
    onGroupsUpsert(sessionId, list) {
      const subjects = new Map()
      for (const metadata of list ?? []) {
        if (!metadata?.id || typeof metadata.subject !== 'string') continue
        const id = flightId(sessionId, metadata.id)
        remember(sessionId, metadata.id, metadata.subject, Array.isArray(metadata.participants) ? metadata : null)
        failures.delete(id)
        markRenamed(id)
        subjects.set(metadata.id, metadata.subject)
      }
      return persist(sessionId, subjects)
    },

    /**
     * groups.update: Partial<GroupMetadata>[] — troca o nome quando ele vem.
     * A sincronização do Baileys (groupFetchAllParticipating) também chega
     * por aqui, com o metadata completo (participants incluso).
     */
    onGroupsUpdate(sessionId, updates) {
      const subjects = new Map()
      for (const update of updates ?? []) {
        if (!update?.id) continue
        const id = flightId(sessionId, update.id)
        const current = memory.get(sessionId)?.get(update.id)
        const metadata =
          Array.isArray(update.participants) || current?.metadata ? { ...(current?.metadata ?? {}), ...update } : undefined
        if (typeof update.subject === 'string') {
          remember(sessionId, update.id, update.subject, metadata)
          failures.delete(id)
          markRenamed(id)
          subjects.set(update.id, update.subject)
        } else if (current && metadata) {
          current.metadata = metadata
          if (Array.isArray(update.participants)) current.metadataExpiresAt = now() + metadataTtlMs
        }
      }
      return persist(sessionId, subjects)
    },

    /**
     * group-participants.update: a lista de participantes em memória ficou
     * velha. Mantém o nome e descarta o metadata, pro Baileys buscar a lista
     * nova no próximo envio ao grupo.
     */
    onParticipantsUpdate(sessionId, { id } = {}) {
      const current = id ? memory.get(sessionId)?.get(id) : undefined
      if (current) current.metadata = null
    },

    /**
     * Conexão (re)aberta: o que mudou nos grupos com a sessão fora do ar pode
     * não ter chegado. Descarta as listas de participantes e o cache negativo
     * (uma falha por conexão caída não segura o nome por mais 5 min); os
     * nomes ficam.
     */
    onConnected(sessionId) {
      for (const entry of memory.get(sessionId)?.values() ?? []) entry.metadata = null
      for (const id of failures.keys()) if (id.startsWith(`${sessionId} `)) failures.delete(id)
    },

    /** Sessão removida: o CASCADE apaga wa_groups, aqui sai a memória. */
    forgetSession(sessionId) {
      memory.delete(sessionId)
      for (const map of [failures, renamed]) for (const id of map.keys()) if (id.startsWith(`${sessionId} `)) map.delete(id)
    }
  }
}
