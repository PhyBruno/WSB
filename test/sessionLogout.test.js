import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionLogout } from '../sessionLogout.js'

const ID = '5511999999999'

// Socket falso: registra a ordem das chamadas pra conferir que os listeners de
// creds saem antes do wipe e que o logout remoto só roda com sessão conectada.
function fakeSocket(steps, { logoutFails = false } = {}) {
  return {
    ev: { removeAllListeners: (event) => steps.push(`removeAllListeners:${event}`) },
    logout: async () => {
      steps.push('logout')
      if (logoutFails) throw new Error('timeout')
    },
    end: () => steps.push('end')
  }
}

function setup({ entry, rowExists = true } = {}) {
  const steps = []
  const sessions = new Map()
  if (entry) sessions.set(ID, entry(steps))
  const warnings = []
  const logout = createSessionLogout({
    sessions,
    sessionExists: async () => rowExists,
    wipeAuthState: async (id) => steps.push(`wipe:${id}`),
    setSessionStatus: async (id, status) => steps.push(`status:${id}:${status}`),
    clearSessionTimers: (id) => steps.push(`clearTimers:${id}`),
    log: { warn: (msg) => warnings.push(msg) }
  })
  return { steps, sessions, warnings, logout }
}

test('sessão conectada: logout no WhatsApp, apaga credenciais e marca logged_out', async () => {
  let entry
  const { steps, sessions, logout } = setup({
    entry: (steps) => (entry = { status: 'connected', sock: fakeSocket(steps), intentionalDisconnect: false })
  })

  const result = await logout(ID)

  assert.deepEqual(result, { id: ID, status: 'logged_out', remoteLogout: true })
  assert.equal(sessions.has(ID), false, 'sai do map: /qr passa a responder 404')
  assert.equal(entry.intentionalDisconnect, true, 'o close não agenda reconexão')
  assert.equal(entry.intentionalStatus, 'logged_out')
  assert.deepEqual(steps, [
    `clearTimers:${ID}`,
    'removeAllListeners:creds.update',
    'logout',
    'end',
    `wipe:${ID}`,
    `status:${ID}:logged_out`
  ])
})

test('sessão em qr/reconnecting: não chama logout() remoto (ficaria pendurado), só fecha e apaga', async () => {
  for (const status of ['qr', 'connecting', 'reconnecting', 'disconnected']) {
    const { steps, logout } = setup({ entry: (steps) => ({ status, sock: fakeSocket(steps) }) })
    const result = await logout(ID)
    assert.equal(result.remoteLogout, false, status)
    assert.equal(steps.includes('logout'), false, status)
    assert.ok(steps.includes('end'), status)
    assert.ok(steps.includes(`wipe:${ID}`), status)
  }
})

test('logout() remoto falhando não impede apagar as credenciais', async () => {
  const { steps, warnings, logout } = setup({
    entry: (steps) => ({ status: 'connected', sock: fakeSocket(steps, { logoutFails: true }) })
  })
  const result = await logout(ID)
  assert.deepEqual(result, { id: ID, status: 'logged_out', remoteLogout: false })
  assert.ok(steps.includes(`wipe:${ID}`))
  assert.ok(steps.includes(`status:${ID}:logged_out`))
  assert.match(warnings[0], /timeout/)
})

test('sessão só no banco (ex.: depois de /disconnect + restart): apaga credenciais', async () => {
  const { steps, logout } = setup({ rowExists: true })
  const result = await logout(ID)
  assert.deepEqual(result, { id: ID, status: 'logged_out', remoteLogout: false })
  assert.deepEqual(steps, [`clearTimers:${ID}`, `wipe:${ID}`, `status:${ID}:logged_out`])
})

test('sessão inexistente: devolve null (rota responde 404) sem tocar em nada', async () => {
  const { steps, logout } = setup({ rowExists: false })
  assert.equal(await logout(ID), null)
  assert.deepEqual(steps, [])
})
