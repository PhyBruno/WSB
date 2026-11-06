import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { BufferJSON } from 'baileys'
import {
  shouldProcess,
  unwrapMessage,
  prepareMessage,
  serializeBinary,
  classifyOrigin,
  parseProtocol,
  isMediaMessage,
  createApiMessageRegistry,
  shouldIgnoreJid
} from '../inbound.js'

// Fixtures sintéticos (Buffers no formato BufferJSON do Baileys).
const fixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/messages/${name}.json`, import.meta.url), 'utf-8'), BufferJSON.reviver)

const prepare = (name, extra = {}) => {
  const received = fixture(name)
  return prepareMessage(received, { instanceId: '5511900000001', key: received.key, ...extra })
}

// ---------------- (a) shouldProcess ----------------

test('shouldProcess descarta o que não é mensagem de conversa', () => {
  const opts = { groupsIgnore: true }
  assert.equal(shouldProcess({ key: fixture('conversation').key }, 'notify', opts), false, 'sem message')
  assert.equal(shouldProcess(fixture('stub-bad-mac'), 'notify', opts), false, 'stub de erro de decriptação')
  assert.equal(shouldProcess(fixture('status-broadcast'), 'notify', opts), false, 'status@broadcast')
  assert.equal(shouldProcess(fixture('newsletter'), 'notify', opts), false, 'newsletter')
  assert.equal(shouldProcess(fixture('conversation'), 'history', opts), false, 'upsert type fora de notify/append')
  assert.equal(shouldProcess(fixture('group-lid-participant'), 'notify', opts), false, 'grupo com groupsIgnore')
})

test('shouldProcess descarta erro de decriptação mesmo com message presente', () => {
  const received = { ...fixture('conversation'), messageStubParameters: ['failed to decrypt message'] }
  assert.equal(shouldProcess(received, 'notify', { groupsIgnore: true }), false)
})

test('shouldProcess descarta protocolMessage que não é edição nem exclusão', () => {
  const received = { ...fixture('conversation'), message: { protocolMessage: { type: 5 } } }
  assert.equal(shouldProcess(received, 'notify', { groupsIgnore: true }), false)
})

test('shouldProcess aceita notify/append, grupo sem groupsIgnore e protocolMessage de edição/exclusão', () => {
  assert.equal(shouldProcess(fixture('conversation'), 'notify', { groupsIgnore: true }), true)
  assert.equal(shouldProcess(fixture('conversation'), 'append', { groupsIgnore: true }), true)
  assert.equal(shouldProcess(fixture('group-lid-participant'), 'notify', { groupsIgnore: false }), true)
  assert.equal(shouldProcess(fixture('protocol-edit'), 'notify', { groupsIgnore: true }), true)
  assert.equal(shouldProcess(fixture('protocol-revoke'), 'notify', { groupsIgnore: true }), true)
})

// ---------------- (b) prepareMessage: messageType e message ----------------

const expectedTypes = {
  conversation: 'conversation',
  'extendedText-quoted': 'conversation',
  image: 'imageMessage',
  'audio-ptt': 'audioMessage',
  video: 'videoMessage',
  ptv: 'ptvMessage',
  document: 'documentMessage',
  documentWithCaption: 'documentMessage',
  sticker: 'stickerMessage',
  location: 'locationMessage',
  contact: 'contactMessage',
  contactsArray: 'contactsArrayMessage',
  reaction: 'reactionMessage',
  'reaction-removed': 'reactionMessage',
  pollUpdate: 'pollUpdateMessage',
  listResponse: 'listResponseMessage',
  buttonsResponse: 'buttonsResponseMessage',
  templateButtonReply: 'templateButtonReplyMessage',
  interactiveResponse: 'interactiveResponseMessage',
  ephemeral: 'conversation',
  viewOnceV2: 'imageMessage',
  'group-lid-participant': 'conversation'
}

for (const [name, messageType] of Object.entries(expectedTypes)) {
  test(`prepareMessage(${name}) → messageType ${messageType}`, () => {
    const data = prepare(name)
    assert.equal(data.messageType, messageType)
    assert.ok(data.message[messageType] !== undefined, `message.${messageType} presente`)
  })
}

test('prepareMessage monta o data no formato da Evolution', () => {
  const data = prepare('conversation')
  assert.deepEqual(Object.keys(data).sort(), [
    'contextInfo',
    'instanceId',
    'key',
    'message',
    'messageTimestamp',
    'messageType',
    'pushName',
    'source',
    'status'
  ])
  assert.equal(data.instanceId, '5511900000001')
  assert.equal(data.pushName, 'Maria Exemplo')
  assert.equal(data.contextInfo, null)
  assert.equal(data.source, 'android')
  assert.equal(data.message.conversation, 'Olá, tudo bem?')
})

test('extendedTextMessage vira conversation, inclusive na mensagem citada', () => {
  const data = prepare('extendedText-quoted')
  assert.equal(data.message.conversation, 'Respondendo a sua mensagem')
  assert.equal('extendedTextMessage' in data.message, false)
  assert.equal(data.contextInfo.stanzaId, 'A0009B2C3D4E5F60718293A4B5C6D7E8')
  assert.equal(data.contextInfo.quotedMessage.conversation, 'Mensagem original')
  assert.equal('extendedTextMessage' in data.contextInfo.quotedMessage, false)
})

test('documentWithCaptionMessage vira documentMessage', () => {
  const data = prepare('documentWithCaption')
  assert.equal('documentWithCaptionMessage' in data.message, false)
  assert.equal(data.message.documentMessage.caption, 'segue o contrato')
})

test('efêmera e viewOnceV2 são desembrulhadas, inclusive na citação', () => {
  const eph = prepare('ephemeral')
  assert.equal(eph.message.conversation, 'mensagem temporária')
  assert.equal(eph.contextInfo.quotedMessage.conversation, 'citada temporária')
  const once = prepare('viewOnceV2')
  assert.equal('viewOnceMessageV2' in once.message, false)
  assert.equal(once.message.imageMessage.viewOnce, true)
})

test('unwrapMessage usa normalizeMessageContent (ephemeral, viewOnce, documentWithCaption)', () => {
  assert.ok(unwrapMessage(fixture('ephemeral').message).extendedTextMessage)
  assert.ok(unwrapMessage(fixture('viewOnceV2').message).imageMessage)
  assert.ok(unwrapMessage(fixture('documentWithCaption').message).documentMessage)
  assert.equal(unwrapMessage(undefined), undefined)
})

test('pushName: fallback "Você" em fromMe e número do participante em grupo', () => {
  const received = { ...fixture('conversation'), pushName: undefined }
  const fromMe = { ...received.key, fromMe: true }
  assert.equal(prepareMessage(received, { instanceId: 'x', key: fromMe }).pushName, 'Você')
  const group = { ...fixture('group-lid-participant'), pushName: undefined }
  assert.equal(prepareMessage(group, { instanceId: 'x', key: group.key }).pushName, '123456789012345')
})

test('prepareMessage usa a key recebida (já normalizada), sem alterar o original', () => {
  const received = fixture('conversation')
  // structuredClone vira Buffer em Uint8Array; a serialização BufferJSON compara o conteúdo.
  const snapshot = JSON.stringify(received, BufferJSON.replacer)
  const key = { remoteJid: '5511988887777@s.whatsapp.net', fromMe: false, id: received.key.id, addressingMode: 'pn' }
  const data = prepareMessage(received, { instanceId: 'x', key })
  assert.deepEqual(data.key, key)
  assert.equal(JSON.stringify(received, BufferJSON.replacer), snapshot)
})

// ---------------- (c) binários, timestamp e status ----------------

test('Buffers/Uint8Array viram base64, Long vira número', () => {
  const data = prepare('image')
  const img = data.message.imageMessage
  assert.equal(typeof img.mediaKey, 'string')
  assert.equal(img.mediaKey, Buffer.alloc(32, 12).toString('base64'))
  assert.equal(typeof img.jpegThumbnail, 'string')
  assert.equal(img.fileLength, 48213)
  assert.equal(img.mediaKeyTimestamp, 1792749990)
  assert.equal(data.messageTimestamp, 1792750000)
  const conv = prepare('conversation')
  assert.equal(typeof conv.message.messageContextInfo.messageSecret, 'string')
})

test('serializeBinary trata Uint8Array, Long com toNumber, arrays e null', () => {
  const out = serializeBinary({
    a: new Uint8Array([1, 2, 3]),
    b: { low: 5, high: 0, unsigned: true, toNumber: () => 5 },
    c: [Buffer.from([255])],
    d: null,
    e: 'texto'
  })
  assert.deepEqual(out, { a: 'AQID', b: 5, c: ['/w=='], d: null, e: 'texto' })
})

test('caractere NUL some do texto e do pushName (o Postgres recusaria a gravação)', () => {
  const received = { ...fixture('conversation'), pushName: 'Ma\u0000ria', message: { conversation: 'oi\u0000tudo' } }
  const data = prepareMessage(received, { instanceId: 'x', key: received.key })
  assert.equal(data.message.conversation, 'oitudo')
  assert.equal(data.pushName, 'Maria')
})

test('messageTimestamp em string vira número', () => {
  const received = { ...fixture('conversation'), messageTimestamp: '1792750001' }
  assert.equal(prepareMessage(received, { instanceId: 'x', key: received.key }).messageTimestamp, 1792750001)
})

test('status: DELIVERY_ACK padrão para recebida, nome do enum quando presente', () => {
  assert.equal(prepare('conversation').status, 'DELIVERY_ACK')
  const received = { ...fixture('conversation'), status: 4 }
  assert.equal(prepareMessage(received, { instanceId: 'x', key: received.key }).status, 'READ')
  const sent = { ...fixture('conversation'), status: 1 }
  const key = { ...sent.key, fromMe: true }
  assert.equal(prepareMessage(sent, { instanceId: 'x', key }).status, 'PENDING')
  const noStatus = prepareMessage(fixture('conversation'), { instanceId: 'x', key })
  assert.equal(noStatus.status, null)
})

// ---------------- (d) classifyOrigin ----------------

test('classifyOrigin: inbound, api e device', () => {
  const registry = createApiMessageRegistry()
  registry.mark('API1')
  assert.equal(classifyOrigin({ fromMe: false, id: 'API1' }, registry), 'inbound')
  assert.equal(classifyOrigin({ fromMe: true, id: 'API1' }, registry), 'api')
  assert.equal(classifyOrigin({ fromMe: true, id: 'OUTRO' }, registry), 'device')
  assert.equal(classifyOrigin({ fromMe: true, id: 'OUTRO' }, undefined), 'device')
})

// ---------------- (e) parseProtocol ----------------

test('parseProtocol identifica MESSAGE_EDIT com a key alvo e o conteúdo novo', () => {
  const protocol = parseProtocol(fixture('protocol-edit').message)
  assert.equal(protocol.type, 'MESSAGE_EDIT')
  assert.equal(protocol.key.id, 'A0012B2C3D4E5F60718293A4B5C6D7E8')
  assert.deepEqual(protocol.editedMessage, { conversation: 'texto novo' })
})

test('parseProtocol identifica REVOKE e ignora o resto', () => {
  const protocol = parseProtocol(fixture('protocol-revoke').message)
  assert.equal(protocol.type, 'REVOKE')
  assert.equal(protocol.key.id, 'A0013B2C3D4E5F60718293A4B5C6D7E8')
  assert.equal(parseProtocol(fixture('conversation').message), null)
  assert.equal(parseProtocol({ protocolMessage: { type: 5 } }), null)
  assert.equal(parseProtocol(undefined), null)
})

test('parseProtocol aceita o tipo pelo nome', () => {
  const protocol = parseProtocol({ protocolMessage: { type: 'REVOKE', key: { id: 'X' } } })
  assert.equal(protocol.type, 'REVOKE')
})

// ---------------- (f) isMediaMessage ----------------

test('isMediaMessage', () => {
  for (const type of ['imageMessage', 'videoMessage', 'ptvMessage', 'audioMessage', 'documentMessage', 'stickerMessage']) {
    assert.equal(isMediaMessage(type), true, type)
  }
  for (const type of ['conversation', 'locationMessage', 'reactionMessage', undefined]) {
    assert.equal(isMediaMessage(type), false, String(type))
  }
})

// ---------------- (g) createApiMessageRegistry ----------------

test('createApiMessageRegistry expira por TTL', () => {
  let clock = 1000
  const registry = createApiMessageRegistry({ ttlMs: 100, max: 10, now: () => clock })
  registry.mark('A')
  assert.equal(registry.has('A'), true)
  clock += 99
  assert.equal(registry.has('A'), true)
  clock += 1
  assert.equal(registry.has('A'), false)
  assert.equal(registry.has('NUNCA'), false)
})

test('createApiMessageRegistry descarta o mais antigo acima de max', () => {
  const registry = createApiMessageRegistry({ ttlMs: 10_000, max: 2, now: () => 0 })
  registry.mark('A')
  registry.mark('B')
  registry.mark('C')
  assert.equal(registry.has('A'), false)
  assert.equal(registry.has('B'), true)
  assert.equal(registry.has('C'), true)
})

test('shouldIgnoreJid descarta só status (antes do decrypt); conversa, grupo, LID e newsletter seguem', () => {
  assert.equal(shouldIgnoreJid('status@broadcast'), true)
  for (const jid of [
    '5511999999999@s.whatsapp.net',
    '120363000000000001@g.us',
    '25525091348716@lid',
    '120363000000000002@newsletter',
    's.whatsapp.net',
    undefined
  ]) {
    assert.equal(shouldIgnoreJid(jid), false, String(jid))
  }
})
