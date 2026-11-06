import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGroupMetadataCache, distinctGroupJids, withGroupSubjects } from '../groupMetadata.js'

// JIDs e nomes sintéticos.
const SESSION = '5511900000001'
const G1 = '120363000000000001@g.us'
const G2 = '120363000000000002@g.us'
const G3 = '120363000000000003@g.us'
const PEER = '5511988887777@s.whatsapp.net'

const silent = { info() {}, warn() {}, debug() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// wa_groups em memória: entende só o SELECT por lote e o INSERT ... unnest.
function fakePool(initial = []) {
  const rows = new Map(initial.map((row) => [`${row.session_id} ${row.jid}`, { ...row }]))
  const pool = {
    rows,
    selects: 0,
    inserts: 0,
    async query(sql, params) {
      if (sql.startsWith('SELECT jid, subject FROM wa_groups')) {
        pool.selects++
        const [sessionId, jids] = params
        return { rows: jids.map((jid) => rows.get(`${sessionId} ${jid}`)).filter(Boolean) }
      }
      if (sql.includes('INSERT INTO wa_groups')) {
        pool.inserts++
        const [sessionId, jids, subjects] = params
        jids.forEach((jid, i) => rows.set(`${sessionId} ${jid}`, { session_id: sessionId, jid, subject: subjects[i] }))
        return { rows: [] }
      }
      throw new Error(`consulta inesperada: ${sql}`)
    }
  }
  return pool
}

// Socket com groupMetadata controlável: conta chamadas e o pico de simultâneas.
function fakeSocket(answer = (jid) => ({ id: jid, subject: `Nome de ${jid}`, participants: [{ id: PEER }] })) {
  const sock = {
    calls: [],
    active: 0,
    maxActive: 0,
    async groupMetadata(jid) {
      sock.calls.push(jid)
      sock.active++
      sock.maxActive = Math.max(sock.maxActive, sock.active)
      try {
        return await answer(jid)
      } finally {
        sock.active--
      }
    }
  }
  return sock
}

function cache({ pool = fakePool(), sock = null, config = {}, now } = {}) {
  return createGroupMetadataCache({ pool, getSocket: () => sock ?? undefined, config, log: silent, ...(now ? { now } : {}) })
}

// Espera as gravações em segundo plano (persist sem await) terminarem.
const settle = () => sleep(5)

// ---------------- camadas ----------------

test('L1: segundo pedido do mesmo grupo não vai ao banco nem ao WhatsApp', async () => {
  const pool = fakePool([{ session_id: SESSION, jid: G1, subject: 'Grupo Um' }])
  const sock = fakeSocket()
  const groups = cache({ pool, sock })
  assert.equal(await groups.getSubject(SESSION, G1), 'Grupo Um')
  assert.equal(await groups.getSubject(SESSION, G1), 'Grupo Um')
  assert.equal(pool.selects, 1)
  assert.equal(sock.calls.length, 0)
})

test('falta no L1 e acerto no L2 sem socket conectado', async () => {
  const pool = fakePool([{ session_id: SESSION, jid: G1, subject: 'Grupo Um' }])
  const groups = cache({ pool })
  assert.equal(await groups.getSubject(SESSION, G1), 'Grupo Um')
})

test('falta no L1 e no L2: consulta o WhatsApp e grava no L2 e no L1', async () => {
  const pool = fakePool()
  const sock = fakeSocket()
  const groups = cache({ pool, sock })
  assert.equal(await groups.getSubject(SESSION, G1), `Nome de ${G1}`)
  await settle()
  assert.deepEqual(sock.calls, [G1])
  assert.equal(pool.rows.get(`${SESSION} ${G1}`).subject, `Nome de ${G1}`, 'gravou no L2')
  assert.equal(await groups.getSubject(SESSION, G1), `Nome de ${G1}`)
  assert.equal(pool.selects, 1, 'segunda leitura veio do L1')
  assert.equal(sock.calls.length, 1)
})

test('L1 com TTL vencido volta a ler o L2', async () => {
  let clock = 1_000
  const pool = fakePool([{ session_id: SESSION, jid: G1, subject: 'Grupo Um' }])
  const groups = cache({ pool, config: { ttlMs: 100 }, now: () => clock })
  await groups.getSubject(SESSION, G1)
  clock += 50
  await groups.getSubject(SESSION, G1)
  assert.equal(pool.selects, 1, 'dentro do TTL')
  clock += 100
  pool.rows.get(`${SESSION} ${G1}`).subject = 'Grupo Renomeado por outra réplica'
  assert.equal(await groups.getSubject(SESSION, G1), 'Grupo Renomeado por outra réplica')
  assert.equal(pool.selects, 2)
})

test('cache negativo: grupo que falhou não é consultado de novo até vencer', async () => {
  let clock = 1_000
  const sock = fakeSocket(() => {
    throw new Error('rate-overlimit')
  })
  const groups = cache({ sock, config: { failureTtlMs: 300_000 }, now: () => clock })
  assert.equal(await groups.getSubject(SESSION, G1), null)
  assert.equal(await groups.getSubject(SESSION, G1), null)
  assert.equal(sock.calls.length, 1, 'rate-overlimit conta como falha e entra no cache negativo')
  clock += 300_001
  await groups.getSubject(SESSION, G1)
  assert.equal(sock.calls.length, 2, 'depois de vencer, tenta de novo')
})

test('single-flight: duas pedidas simultâneas do mesmo grupo geram uma consulta', async () => {
  const sock = fakeSocket(async (jid) => (await sleep(20), { id: jid, subject: 'Grupo Um' }))
  const groups = cache({ sock })
  const [a, b] = await Promise.all([groups.getSubject(SESSION, G1), groups.getSubject(SESSION, G1)])
  assert.deepEqual([a, b], ['Grupo Um', 'Grupo Um'])
  assert.equal(sock.calls.length, 1)
})

test('no máximo 3 consultas simultâneas ao WhatsApp por sessão', async () => {
  const sock = fakeSocket(async (jid) => (await sleep(15), { id: jid, subject: jid }))
  const groups = cache({ sock })
  const jids = Array.from({ length: 7 }, (_, i) => `12036300000000010${i}@g.us`)
  const subjects = await groups.resolveSubjects(SESSION, jids, { budgetMs: 2_000 })
  assert.equal(sock.calls.length, 7)
  assert.equal(sock.maxActive, 3)
  for (const jid of jids) assert.equal(subjects.get(jid), jid)
})

test('teto de tamanho do L1 descarta o grupo mais antigo', async () => {
  const pool = fakePool([
    { session_id: SESSION, jid: G1, subject: 'Um' },
    { session_id: SESSION, jid: G2, subject: 'Dois' },
    { session_id: SESSION, jid: G3, subject: 'Três' }
  ])
  const groups = cache({ pool, config: { maxEntries: 2 } })
  await groups.getSubject(SESSION, G1)
  await groups.getSubject(SESSION, G2)
  await groups.getSubject(SESSION, G3) // G1 sai
  assert.equal(pool.selects, 3)
  await groups.getSubject(SESSION, G3)
  await groups.getSubject(SESSION, G2)
  assert.equal(pool.selects, 3, 'G2 e G3 seguem no L1')
  await groups.getSubject(SESSION, G1)
  assert.equal(pool.selects, 4, 'G1 foi descartado')
})

test('groups.update troca o nome no L1 e no L2', async () => {
  const pool = fakePool([{ session_id: SESSION, jid: G1, subject: 'Antigo' }])
  const groups = cache({ pool })
  assert.equal(await groups.getSubject(SESSION, G1), 'Antigo')
  await groups.onGroupsUpdate(SESSION, [{ id: G1, subject: 'Novo', author: PEER }, { id: G2, announce: true }])
  assert.equal(await groups.getSubject(SESSION, G1), 'Novo')
  assert.equal(pool.rows.get(`${SESSION} ${G1}`).subject, 'Novo')
  assert.equal(pool.rows.has(`${SESSION} ${G2}`), false, 'update sem subject não grava')
})

test('groups.upsert grava em lote no L2 e alimenta o cachedGroupMetadata', async () => {
  const pool = fakePool()
  const groups = cache({ pool })
  const full = { id: G1, subject: 'Grupo Um', participants: [{ id: PEER }] }
  await groups.onGroupsUpsert(SESSION, [full, { id: G2, subject: 'Grupo Dois', participants: [] }])
  assert.equal(pool.inserts, 1)
  assert.equal(pool.rows.size, 2)
  const cached = groups.cachedGroupMetadata(SESSION)
  assert.deepEqual(await cached(G1), full)
  assert.equal(await cached(G3), undefined)
  groups.onParticipantsUpdate(SESSION, { id: G1, action: 'add', participants: [] })
  assert.equal(await cached(G1), undefined, 'participantes mudaram: Baileys busca de novo')
  assert.equal(await groups.getSubject(SESSION, G1), 'Grupo Um', 'o nome continua')
})

test('cachedGroupMetadata não responde com o que veio só do banco (sem participants)', async () => {
  const pool = fakePool([{ session_id: SESSION, jid: G1, subject: 'Grupo Um' }])
  const groups = cache({ pool })
  await groups.getSubject(SESSION, G1)
  assert.equal(await groups.cachedGroupMetadata(SESSION)(G1), undefined)
})

test('timeout devolve null rápido e a resposta atrasada ainda é gravada', async () => {
  const pool = fakePool()
  const sock = fakeSocket(async (jid) => (await sleep(60), { id: jid, subject: 'Lento' }))
  const groups = cache({ pool, sock, config: { timeoutMs: 20 } })
  const started = Date.now()
  assert.equal(await groups.getSubject(SESSION, G1), null)
  assert.ok(Date.now() - started < 55, 'não esperou a resposta')
  await sleep(70)
  assert.equal(pool.rows.get(`${SESSION} ${G1}`)?.subject, 'Lento')
  assert.equal(await groups.getSubject(SESSION, G1), 'Lento')
  assert.equal(sock.calls.length, 1)
})

test('erro do WhatsApp ou do banco devolve null e nunca lança', async () => {
  const sock = fakeSocket(() => {
    throw new Error('item-not-found')
  })
  assert.equal(await cache({ sock }).getSubject(SESSION, G1), null)

  const brokenPool = {
    async query() {
      throw new Error('banco fora')
    }
  }
  const groups = cache({ pool: brokenPool, sock: fakeSocket() })
  assert.equal(await groups.getSubject(SESSION, G1), null)
  await groups.onGroupsUpsert(SESSION, [{ id: G1, subject: 'x' }]) // não rejeita
})

test('sessão sem socket conectado só lê L1 e L2', async () => {
  const pool = fakePool([{ session_id: SESSION, jid: G1, subject: 'Grupo Um' }])
  const groups = cache({ pool })
  const subjects = await groups.resolveSubjects(SESSION, [G1, G2])
  assert.deepEqual([...subjects], [
    [G1, 'Grupo Um'],
    [G2, null]
  ])
})

test('uma consulta ao Postgres por lote, não uma por grupo', async () => {
  const pool = fakePool([
    { session_id: SESSION, jid: G1, subject: 'Um' },
    { session_id: SESSION, jid: G2, subject: 'Dois' }
  ])
  const groups = cache({ pool })
  const subjects = await groups.resolveSubjects(SESSION, [G1, G2, G3, G1, PEER])
  assert.equal(pool.selects, 1)
  assert.deepEqual([...subjects.keys()], [G1, G2, G3], 'só grupos, sem repetição')
})

test('sessões não se misturam', async () => {
  const pool = fakePool([{ session_id: SESSION, jid: G1, subject: 'Da sessão 1' }])
  const groups = cache({ pool })
  assert.equal(await groups.getSubject(SESSION, G1), 'Da sessão 1')
  assert.equal(await groups.getSubject('5511900000002', G1), null)
  groups.forgetSession(SESSION)
  await groups.getSubject(SESSION, G1)
  assert.equal(pool.selects, 3, 'forgetSession limpou o L1')
})

// ---------------- limites por requisição (histórico) ----------------

test('passar de maxLookups deixa o excedente com null', async () => {
  const sock = fakeSocket()
  const groups = cache({ sock })
  const subjects = await groups.resolveSubjects(SESSION, [G1, G2, G3], { maxLookups: 2, budgetMs: 1_000 })
  assert.equal(sock.calls.length, 2)
  assert.deepEqual([...subjects.values()].filter((s) => s === null).length, 1)
})

test('orçamento esgotado devolve null sem esperar o WhatsApp', async () => {
  const sock = fakeSocket(async (jid) => (await sleep(200), { id: jid, subject: 'x' }))
  const groups = cache({ sock, config: { timeoutMs: 1_000 } })
  const started = Date.now()
  const subjects = await groups.resolveSubjects(SESSION, [G1, G2], { budgetMs: 30 })
  assert.ok(Date.now() - started < 150)
  assert.deepEqual([...subjects.values()], [null, null])
})

// ---------------- itens do histórico ----------------

const item = (remoteJid, id) => ({ key: { remoteJid, fromMe: false, id }, message: { conversation: id } })

test('página com 3 grupos e 1 conversa individual: 3 resoluções e só os grupos ganham o campo', async () => {
  const items = [item(G1, 'a'), item(PEER, 'b'), item(G2, 'c'), item(G1, 'd'), item(G3, 'e')]
  const jids = distinctGroupJids(items)
  assert.deepEqual(jids, [G1, G2, G3])

  const sock = fakeSocket()
  const groups = cache({ sock })
  const out = withGroupSubjects(items, await groups.resolveSubjects(SESSION, jids, { maxLookups: 10, budgetMs: 1_000 }))
  assert.equal(sock.calls.length, 3)
  assert.equal(out[0].groupSubject, `Nome de ${G1}`)
  assert.equal('groupSubject' in out[1], false, 'item individual não ganha o campo')
  assert.equal(out[3].groupSubject, `Nome de ${G1}`)
  assert.deepEqual(out.map((i) => i.key.id), ['a', 'b', 'c', 'd', 'e'], 'ordem preservada')
  assert.equal('groupSubject' in items[0], false, 'não altera os itens recebidos')
})

test('withGroupSubjects usa null quando o nome não foi resolvido', () => {
  const out = withGroupSubjects([item(G1, 'a')], new Map())
  assert.equal(out[0].groupSubject, null)
})

// ---------------- GET /sessions/:id/messages (addGroupSubjects) ----------------

test('histórico: nextBefore e ordem iguais aos de antes, só itens de grupo ganham o campo', async () => {
  const { addGroupSubjects } = await import('../webhookRoutes.js')
  const pool = fakePool([
    { session_id: SESSION, jid: G1, subject: 'Um' },
    { session_id: SESSION, jid: G2, subject: 'Dois' }
  ])
  const sock = fakeSocket()
  const groups = cache({ pool, sock })
  const page = { items: [item(G1, 'a'), item(PEER, 'b'), item(G2, 'c'), item(G3, 'd')], nextBefore: 4810 }
  const out = await addGroupSubjects(groups, SESSION, page, { maxLookups: 10, budgetMs: 1_000 })
  assert.deepEqual(Object.keys(out), ['items', 'nextBefore'])
  assert.equal(out.nextBefore, 4810)
  assert.deepEqual(out.items.map((i) => i.groupSubject), ['Um', undefined, 'Dois', `Nome de ${G3}`])
  assert.equal(pool.selects, 1, 'um SELECT pra página inteira')
  assert.deepEqual(sock.calls, [G3], 'só o que faltou no L2 foi ao WhatsApp')
})

test('histórico: excedente de maxLookups sai null; sessão desconectada responde pelo L2', async () => {
  const { addGroupSubjects } = await import('../webhookRoutes.js')
  const sock = fakeSocket()
  const page = { items: [item(G1, 'a'), item(G2, 'b'), item(G3, 'c')], nextBefore: null }
  const limited = await addGroupSubjects(cache({ sock }), SESSION, page, { maxLookups: 1, budgetMs: 1_000 })
  assert.equal(sock.calls.length, 1)
  assert.equal(limited.items.filter((i) => i.groupSubject === null).length, 2)

  const offline = cache({ pool: fakePool([{ session_id: SESSION, jid: G1, subject: 'Um' }]) })
  const out = await addGroupSubjects(offline, SESSION, page, { maxLookups: 10, budgetMs: 1_000 })
  assert.deepEqual(out.items.map((i) => i.groupSubject), ['Um', null, null])
})

test('histórico: filtro remoteJid=<grupo> resolve uma vez; página sem grupo sai intacta', async () => {
  const { addGroupSubjects } = await import('../webhookRoutes.js')
  const sock = fakeSocket()
  const groups = cache({ sock })
  const page = { items: [item(G1, 'a'), item(G1, 'b'), item(G1, 'c')], nextBefore: 7 }
  const out = await addGroupSubjects(groups, SESSION, page, { maxLookups: 10, budgetMs: 1_000 })
  assert.equal(sock.calls.length, 1)
  assert.ok(out.items.every((i) => i.groupSubject === `Nome de ${G1}`))

  const individual = { items: [item(PEER, 'x')], nextBefore: null }
  assert.equal(await addGroupSubjects(groups, SESSION, individual), individual)
})

// ---------------- correções da revisão ----------------

test('WhatsApp lento: o limite de 3 vale até a resposta real, e consulta abandonada na fila não roda', async () => {
  const sock = fakeSocket(async (jid) => (await sleep(80), { id: jid, subject: jid }))
  const groups = cache({ sock, config: { timeoutMs: 20 } })
  const jids = Array.from({ length: 9 }, (_, i) => `12036300000000020${i}@g.us`)
  const subjects = await groups.resolveSubjects(SESSION, jids)
  assert.ok([...subjects.values()].every((s) => s === null), 'todos desistiram no timeout')
  await sleep(150)
  assert.equal(sock.maxActive, 3, 'nunca mais de 3 consultas ao mesmo tempo')
  assert.equal(sock.calls.length, 3, 'as 6 da fila foram descartadas: ninguém esperava mais')
})

test('timeout põe o grupo no cache negativo', async () => {
  const sock = fakeSocket(() => new Promise(() => {}))
  const groups = cache({ sock, config: { timeoutMs: 20 } })
  assert.equal(await groups.getSubject(SESSION, G1), null)
  assert.equal(await groups.getSubject(SESSION, G1), null)
  assert.equal(sock.calls.length, 1)
})

test('resposta atrasada do WhatsApp não sobrescreve o nome novo vindo de groups.update', async () => {
  const pool = fakePool()
  const sock = fakeSocket(async (jid) => (await sleep(60), { id: jid, subject: 'ANTIGO', participants: [] }))
  const groups = cache({ pool, sock, config: { timeoutMs: 20 } })
  assert.equal(await groups.getSubject(SESSION, G1), null)
  await groups.onGroupsUpdate(SESSION, [{ id: G1, subject: 'NOVO' }])
  await sleep(70)
  await settle()
  assert.equal(await groups.getSubject(SESSION, G1), 'NOVO')
  assert.equal(pool.rows.get(`${SESSION} ${G1}`).subject, 'NOVO')
})

test('leitura do banco que começou antes de um groups.update não volta o nome antigo', async () => {
  const pool = fakePool([{ session_id: SESSION, jid: G1, subject: 'ANTIGO' }])
  const select = pool.query.bind(pool)
  pool.query = async (sql, params) => {
    if (sql.startsWith('SELECT')) {
      const answer = await select(sql, params)
      await sleep(30)
      return answer
    }
    return select(sql, params)
  }
  const groups = cache({ pool })
  const pending = groups.getSubject(SESSION, G1)
  await sleep(5)
  await groups.onGroupsUpdate(SESSION, [{ id: G1, subject: 'NOVO' }])
  assert.equal(await pending, 'NOVO')
  assert.equal(await groups.getSubject(SESSION, G1), 'NOVO')
})

test('cachedGroupMetadata: lista de participantes vence antes do nome; sincronização por groups.update alimenta', async () => {
  let clock = 1_000
  const groups = cache({ config: { metadataTtlMs: 100 }, now: () => clock })
  const full = { id: G1, subject: 'Grupo Um', participants: [{ id: PEER }] }
  await groups.onGroupsUpdate(SESSION, [full])
  const cached = groups.cachedGroupMetadata(SESSION)
  assert.deepEqual(await cached(G1), full)
  clock += 101
  assert.equal(await cached(G1), undefined, 'lista velha: o Baileys consulta')
  assert.equal(await groups.getSubject(SESSION, G1), 'Grupo Um', 'o nome continua')
})

test('onConnected descarta listas de participantes e o cache negativo da sessão', async () => {
  let fail = true
  const sock = fakeSocket((jid) => {
    if (fail) throw new Error('Connection Closed')
    return { id: jid, subject: 'Voltou' }
  })
  const groups = cache({ sock })
  await groups.onGroupsUpsert(SESSION, [{ id: G1, subject: 'Grupo Um', participants: [] }])
  assert.equal(await groups.getSubject(SESSION, G2), null)
  groups.onConnected(SESSION)
  fail = false
  assert.equal(await groups.cachedGroupMetadata(SESSION)(G1), undefined)
  assert.equal(await groups.getSubject(SESSION, G2), 'Voltou', 'cache negativo limpo na reconexão')
})

test('sweep tira da memória a lista de participantes vencida e o grupo vencido, sem ler de novo', async () => {
  let clock = 1_000
  const groups = cache({ config: { metadataTtlMs: 100, ttlMs: 1_000 }, now: () => clock })
  const participants = Array.from({ length: 50 }, (_, i) => ({ id: `55119000000${i}@s.whatsapp.net` }))
  await groups.onGroupsUpsert(SESSION, [
    { id: G1, subject: 'Grupo Um', participants },
    { id: G2, subject: 'Grupo Dois', participants }
  ])
  assert.deepEqual(groups.stats(), { groups: 2, withMetadata: 2, participants: 100, failures: 0, flights: 0 })

  assert.deepEqual(groups.sweep(), { groupsRemoved: 0, metadataRemoved: 0 }, 'nada venceu ainda')
  clock += 101
  assert.deepEqual(groups.sweep(), { groupsRemoved: 0, metadataRemoved: 2 })
  assert.deepEqual(groups.stats(), { groups: 2, withMetadata: 0, participants: 0, failures: 0, flights: 0 })
  assert.equal(await groups.getSubject(SESSION, G1), 'Grupo Um', 'o nome continua em memória')

  clock += 1_000
  assert.deepEqual(groups.sweep(), { groupsRemoved: 2, metadataRemoved: 0 })
  assert.equal(groups.stats().groups, 0)
})

test('sweep limpa o cache negativo vencido', async () => {
  let clock = 1_000
  const sock = fakeSocket(() => {
    throw new Error('rate-overlimit')
  })
  const groups = cache({ sock, config: { failureTtlMs: 50 }, now: () => clock })
  assert.equal(await groups.getSubject(SESSION, G1), null)
  assert.equal(groups.stats().failures, 1)
  clock += 51
  groups.sweep()
  assert.equal(groups.stats().failures, 0)
})

test('lista de participantes vencida sai da memória também quando o grupo é lido', async () => {
  let clock = 1_000
  const groups = cache({ config: { metadataTtlMs: 100 }, now: () => clock })
  await groups.onGroupsUpsert(SESSION, [{ id: G1, subject: 'Grupo Um', participants: [{ id: PEER }] }])
  clock += 101
  assert.equal(await groups.getSubject(SESSION, G1), 'Grupo Um')
  assert.equal(groups.stats().withMetadata, 0)
})
