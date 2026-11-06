import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proto, PROCESSABLE_HISTORY_TYPES } from 'baileys'
import { historySyncFilter, historySyncTypeName } from '../historySync.js'

const T = proto.HistorySync.HistorySyncType
const allows = (mode) => PROCESSABLE_HISTORY_TYPES.filter((syncType) => historySyncFilter(mode)({ syncType }))

test('minimal: só os pacotes pequenos com mapeamentos LID→número e nomes; nada de histórico de mensagens', () => {
  assert.deepEqual(allows('minimal').sort(), [T.INITIAL_BOOTSTRAP, T.PUSH_NAME, T.NON_BLOCKING_DATA].sort())
  for (const heavy of [T.RECENT, T.FULL, T.ON_DEMAND, T.INITIAL_STATUS_V3]) {
    assert.equal(historySyncFilter('minimal')({ syncType: heavy }), false, historySyncTypeName(heavy))
  }
})

test('minimal: o Baileys não espera a sincronização (pergunta por RECENT) e não dá o aviso de tudo desligado', () => {
  // Socket/chats.js: willSyncHistory = shouldSyncHistoryMessage({ syncType: RECENT })
  assert.equal(historySyncFilter('minimal')({ syncType: T.RECENT }), false)
  // Socket/socket.js: o aviso "DANGER" sai quando TODOS os tipos processáveis dão false
  assert.ok(allows('minimal').length > 0)
})

test('off desliga tudo; recent é o default do Baileys (tudo menos FULL)', () => {
  assert.deepEqual(allows('off'), [])
  assert.deepEqual(allows('recent').sort(), PROCESSABLE_HISTORY_TYPES.filter((t) => t !== T.FULL).sort())
})

test('modo inválido é recusado', () => {
  assert.throws(() => historySyncFilter('tudo'), /HISTORY_SYNC inválido/)
})

test('historySyncTypeName dá o nome do enum', () => {
  assert.equal(historySyncTypeName(T.RECENT), 'RECENT')
  assert.equal(historySyncTypeName(999), '999')
})
