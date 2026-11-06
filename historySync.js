import { proto } from 'baileys'

// Que pacotes da sincronização de histórico o Baileys baixa e processa
// (opção shouldSyncHistoryMessage do makeWASocket).
//
// A bridge não guarda histórico: só repassa mensagens NOVAS. Mas, com o
// default do Baileys (tudo menos FULL), logo depois de parear um número ele
// baixa o histórico recente (RECENT, em vários pacotes), e o buffer de eventos
// dele (Utils/event-buffer.js) acumula cada mensagem num objeto comum indexado
// pelo id até a sincronização terminar. Com milhares de mensagens esse objeto
// vira dicionário no V8 e cresce até estourar o heap — a pilha do crash
// (Runtime_AddDictionaryProperty → NameDictionary::EnsureCapacity) é essa.
//
// Desligar TUDO também não serve: o próprio Baileys avisa (Socket/socket.js)
// que sem nenhum pacote ele perde os mapeamentos LID→número iniciais e fica
// instável. Por isso o modo padrão mantém só os pacotes pequenos que trazem
// esses mapeamentos e os nomes de contato, e descarta o histórico de mensagens:
//
//   minimal (default): INITIAL_BOOTSTRAP (conversas recentes, mapeamentos
//                      LID→número, tokens de privacidade), PUSH_NAME (nomes) e
//                      NON_BLOCKING_DATA (mapeamentos, ex-participantes).
//                      Sem RECENT o Baileys também não entra no modo de espera
//                      pela sincronização (buffer de até 20s após parear).
//   off:               nada. O Baileys loga um aviso de "DANGER"; LIDs só são
//                      resolvidos pelo que chega nas próprias mensagens e envios.
//   recent:            o default do Baileys (tudo menos FULL), o comportamento
//                      anterior. Só pra comparar/voltar atrás.
//
// Os mapeamentos LID→número continuam sendo aprendidos fora do histórico: em
// cada mensagem recebida (remoteJidAlt/participantAlt), em cada envio (consulta
// usync) e na migração de LID que o WhatsApp manda (LID_MIGRATION_MAPPING_SYNC).

const T = proto.HistorySync.HistorySyncType

export const HISTORY_SYNC_MODES = {
  minimal: new Set([T.INITIAL_BOOTSTRAP, T.PUSH_NAME, T.NON_BLOCKING_DATA]),
  off: new Set(),
  recent: new Set([T.INITIAL_BOOTSTRAP, T.PUSH_NAME, T.RECENT, T.ON_DEMAND, T.NON_BLOCKING_DATA, T.INITIAL_STATUS_V3])
}

/** Predicado pro shouldSyncHistoryMessage do makeWASocket. */
export function historySyncFilter(mode = 'minimal') {
  const allowed = HISTORY_SYNC_MODES[mode]
  if (!allowed) throw new Error(`HISTORY_SYNC inválido: ${mode} (use ${Object.keys(HISTORY_SYNC_MODES).join(', ')})`)
  return ({ syncType }) => allowed.has(syncType)
}

/** Nome legível do tipo (pro log). */
export function historySyncTypeName(syncType) {
  return T[syncType] ?? String(syncType)
}
