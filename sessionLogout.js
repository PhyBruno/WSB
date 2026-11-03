// POST /sessions/:id/logout — desvincula o aparelho e apaga as credenciais,
// MAS mantém a sessão (linha em wa_sessions), os webhooks e o histórico.
//
// Fica entre os dois extremos que já existiam:
//   /disconnect  → só fecha o socket; credenciais ficam, reconecta sem QR.
//   DELETE       → logout + apaga a sessão inteira em cascata (webhooks,
//                  mensagens, entregas). Pra "excluir instância".
// É o equivalente ao logout da Evolution: depois dele, o próximo /connect
// gera QR novo, e quem registrou webhook continua recebendo os avisos.
//
// Dependências injetadas pra dar pra testar sem Postgres/WhatsApp.
export function createSessionLogout({
  sessions,
  sessionExists,
  wipeAuthState,
  setSessionStatus,
  clearSessionTimers,
  log = console
}) {
  return async function logoutSession(id) {
    const entry = sessions.get(id)
    if (!entry && !(await sessionExists(id))) return null

    clearSessionTimers(id)

    let remoteLogout = false
    if (entry) {
      // logout() manda o remove-companion-device pro WhatsApp (o aparelho sai
      // de "Aparelhos conectados" no celular). Só faz sentido com o socket
      // autenticado; em qr/connecting/reconnecting a query nunca seria
      // respondida e o pedido ficaria pendurado até o timeout.
      const wasConnected = entry.status === 'connected'

      // Antes de qualquer await: o handler de 'close' deste socket vê a flag
      // e não agenda reconexão; sair do map faz /qr responder 404 e impede
      // que o close atrasado sobrescreva o status de uma sessão mais nova.
      entry.intentionalDisconnect = true
      entry.intentionalStatus = 'logged_out'
      entry.status = 'logged_out'
      sessions.delete(id)

      // Um creds.update atrasado do socket que está saindo regravaria a linha
      // 'creds' depois do wipe abaixo, e o próximo /connect reaproveitaria a
      // credencial — exatamente o que este endpoint existe pra impedir.
      entry.sock.ev?.removeAllListeners?.('creds.update')

      if (wasConnected) {
        try {
          await entry.sock.logout()
          remoteLogout = true
        } catch (err) {
          log.warn(`[${id}] logout() no WhatsApp falhou (${err.message}) — apagando credenciais locais mesmo assim`)
        }
      }
      try {
        // Garantido mesmo depois de um logout() bem-sucedido (que já fecha o
        // socket): end() num socket encerrado é no-op.
        entry.sock.end(undefined)
      } catch {
        // nada a fazer: o socket já estava morto
      }
    }

    await wipeAuthState(id)
    await setSessionStatus(id, 'logged_out')
    return { id, status: 'logged_out', remoteLogout }
  }
}
