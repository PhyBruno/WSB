# WhatsApp Bridge API (Baileys + Postgres)

Aplicação pequena e "burra" de propósito: conecta, reconecta, desconecta,
dispara mensagem por múltiplos números de WhatsApp e repassa as mensagens
recebidas para webhooks (no formato da Evolution API). Toda a lógica de
negócio fica na sua aplicação principal, que chama esta bridge por HTTP.

Cada número é uma sessão, identificada pelo próprio número. As credenciais
(sessão do WhatsApp Web) ficam persistidas no **Postgres**, não em arquivo —
então dá pra rodar em containers efêmeros, escalar horizontalmente lendo do
mesmo banco (com cuidado: cada sessão só pode estar "viva" em um processo por
vez), e restaurar tudo sozinho quando o processo reinicia.

## Formato do número (ID da sessão e destinatário)

**Só dígitos, com DDI, sem `+`, espaço, parênteses ou traço.**

```
5511999999999
│└┤└─────────┴─ número
│ └─ DDD
└─ DDI (Brasil = 55)
```

A API normaliza automaticamente o que vier com máscara (`(11) 99999-9999` vira
`11999999999`), mas o ID da sessão precisa bater com 8 a 15 dígitos depois de
normalizado — senão ela recusa com 400.

No `POST /sessions/:id/messages`, o destinatário (`to`) também aceita o JID de
um grupo de que o número participa (`120363000000000001@g.us` ou o formato
antigo `5511999999999-1600000000@g.us`) — ver "Enviando para um grupo" — e o
JID de usuário: `5511999999999@s.whatsapp.net` (resolvido pelo `onWhatsApp()`
como os dígitos) ou `123456789012345@lid` (enviado direto ao LID, já que o
`onWhatsApp()` não aceita LID). O sufixo de dispositivo (`:N`) é descartado.
Os demais JIDs (`@newsletter`, `@broadcast` etc.) são recusados com 400.

Nos endpoints de lista/botões (`/message/sendList` e `/message/sendButtons`),
o destinatário (`number`) também aceita o JID de usuário, como na Evolution:
`5511999999999@s.whatsapp.net`. Grupos (`@g.us`) e `@lid` não são suportados.

## Setup

### 1. Banco de dados

```bash
createdb whatsapp_bridge
```

As tabelas (`wa_sessions`, `wa_auth_state`, `wa_messages`, `wa_webhooks` e
`wa_webhook_deliveries`) são criadas automaticamente toda vez que o servidor
sobe (roda `schema.sql`, só com `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF
NOT EXISTS` — seguro sobre um banco já existente).

### 2. Variáveis de ambiente

Copie `.env.example` para `.env` e ajuste:

```
DATABASE_URL=postgres://usuario:senha@localhost:5432/whatsapp_bridge
PORT=3000
API_KEY=troque-por-uma-chave-forte      # obrigatória, o servidor não sobe sem ela
RECONNECT_MAX_ATTEMPTS=5                # tentativas de reconexão automática após queda
RECONNECT_DELAY_MS=30000                # espera fixa entre cada tentativa (30s)
CONNECTING_TIMEOUT_MS=45000             # força /disconnect sozinho se travar em "connecting" (0 desativa)
BAILEYS_LOG_LEVEL=warn                  # logs internos do baileys (pino JSON): fatal|error|warn|info|debug|trace|silent
CONNECTION_EVENTS_RETENTION_DAYS=30     # quantos dias guardar o histórico de quedas (wa_connection_events)
JSON_BODY_LIMIT=20mb                    # limite do body JSON nas rotas de mídia (/messages, /message/sendButtons); as demais aceitam até 256kb
MESSAGE_STATUS_TIMEOUT_MS=8000          # quanto tempo /messages espera pela confirmação real de entrega (0 desativa)
SERVER_URL=                             # URL pública da bridge, vai no "server_url" dos webhooks (vazio = null)
WEBHOOK_TIMEOUT_MS=10000                # timeout de cada POST de webhook
WEBHOOK_CONCURRENCY=10                  # POSTs de webhook simultâneos (todas as sessões)
WEBHOOK_CONCURRENCY_PER_WEBHOOK=2       # teto por webhook: um receptor lento não segura as vagas dos outros
WEBHOOK_POLL_INTERVAL_MS=1000           # polling de segurança da fila de entregas
WEBHOOK_RETRY_MAX_ATTEMPTS=15           # tentativas antes de "failed" (~45 min de janela com os defaults)
WEBHOOK_RETRY_INITIAL_DELAY_MS=5000     # primeiro atraso do backoff exponencial
WEBHOOK_RETRY_MAX_DELAY_MS=300000       # teto do backoff (5 min)
WEBHOOK_MEDIA_MAX_BYTES=20971520        # acima disso (20MB) a mídia não é embutida: base64Error "too_large"
WEBHOOK_MEDIA_TIMEOUT_MS=30000          # timeout do download de mídia
WEBHOOK_MEDIA_CACHE_MAX_BYTES=104857600 # teto do cache de mídia em memória (100MB)
WEBHOOK_DELIVERY_RETENTION_DAYS=7       # histórico de entregas concluídas
WEBHOOK_HEADERS_KEY=                    # chave da cifra dos cabeçalhos dos webhooks no banco (vazio = derivada da API_KEY)
MESSAGE_RETENTION_DAYS=0                # apaga mensagens de wa_messages com mais de N dias (0 = guarda pra sempre)
GROUP_METADATA_TTL_MS=21600000          # quanto tempo o nome do grupo fica em memória antes de reler wa_groups (6h)
GROUP_METADATA_FAILURE_TTL_MS=300000    # grupo cuja consulta ao WhatsApp falhou não é consultado de novo por 5 min
GROUP_METADATA_TIMEOUT_MS=3000          # espera máxima da consulta do nome ao WhatsApp (depois disso, groupSubject null)
GROUP_METADATA_HISTORY_MAX_LOOKUPS=10   # consultas ao WhatsApp por requisição do histórico
GROUP_METADATA_HISTORY_BUDGET_MS=5000   # tempo total que o histórico espera pelos nomes dos grupos
```

### 3. Instalar e rodar

```bash
npm install
node server.js
```

## Rodando com Docker

```bash
cp .env.example .env   # ajuste API_KEY e POSTGRES_PASSWORD
docker compose up -d --build
```

Isso sobe dois containers: `postgres` (com volume nomeado `pgdata`, então os
dados sobrevivem a `docker compose down`) e `bridge` (builda a partir do
`Dockerfile` local, só espera o Postgres passar no healthcheck antes de
subir). A bridge fica exposta em `http://localhost:3000` (ou o que você
definir em `PORT` no `.env`).

Rodando fora do compose (seu próprio Postgres, outro orquestrador etc.), o
`Dockerfile` sozinho também funciona:

```bash
docker build -t whatsapp-bridge .
docker run -p 3000:3000 \
  -e DATABASE_URL=postgres://user:pass@host:5432/whatsapp_bridge \
  -e API_KEY=troque-por-uma-chave-forte \
  whatsapp-bridge
```

A imagem é baseada em `node:22-slim` (não alpine): o Baileys puxa o `sharp`
como dependência transitiva, e resolver o binário pré-compilado certo é mais
previsível em glibc do que em musl. Não precisa de toolchain de build — nem
Python, nem gcc. O container roda como usuário não-root e não escreve nada em
disco (todo o estado vive no Postgres), então não precisa de volume na
bridge em si.

A versão da imagem base é fixa (versão exata do Node + digest, no `ARG
NODE_IMAGE` do `Dockerfile`), para que dois builds do mesmo commit saiam
iguais. Atualizar é intencional: o próprio `Dockerfile` tem os comandos. O
build é multi-stage: o primeiro estágio builda a tela `/manager`, e a imagem
final leva só os `.js` da bridge, o `schema.sql`, as dependências de produção
e os estáticos da tela.

## Autenticação

Toda rota sob `/sessions` exige uma API key global, enviada no header
`x-api-key`. Sem ela (ou com valor errado), a resposta é `401`. É a mesma
chave pra todos os endpoints — pensada pra ser usada pela sua aplicação
principal, não por múltiplos clientes com permissões diferentes.

`GET /health` fica fora da autenticação, pra load balancer/orquestrador
checar se o processo está de pé sem precisar da chave.

## Endpoints

Todos abaixo (exceto `/health`) exigem `x-api-key` no header.

| Método | Rota                        | O que faz                                                                 |
|--------|------------------------------|-----------------------------------------------------------------------------|
| GET    | `/health`                    | Liveness check, sem autenticação.                                          |
| POST   | `/sessions/:id/connect`      | Conecta/reconecta o número `:id`. Cria sessão nova se não existir.         |
| GET    | `/sessions/:id/qr`           | QR code (base64 PNG) pra parear, ou status atual se já conectado.          |
| GET    | `/sessions`                  | Lista todas as sessões (persistidas no banco) e seus status.               |
| POST   | `/sessions/:id/disconnect`   | Pausa: fecha a conexão mas **mantém** as credenciais — reconecta sem novo QR. |
| POST   | `/sessions/:id/logout`       | Desvincula o aparelho no WhatsApp e apaga as credenciais, mas **mantém** a sessão, os webhooks e o histórico — o próximo `/connect` gera QR novo. |
| DELETE | `/sessions/:id`              | Exclui a sessão: logout + apaga credenciais, webhooks, histórico e entregas (cascade). |
| GET    | `/sessions/:id/connection-events?limit=100` | Histórico de aberturas/quedas/logouts com o motivo (ver "Diagnóstico de quedas"). |
| POST   | `/sessions/:id/messages`     | Dispara mensagem — texto, imagem, vídeo, documento ou áudio, a um número ou grupo (ver formato abaixo). |
| POST   | `/sessions/:id/message/sendList`    | Lista de opções — mesmo payload do `/message/sendList` da Evolution API. |
| POST   | `/sessions/:id/message/sendButtons` | Botões — mesmo payload do `/message/sendButtons` da Evolution API.     |
| GET    | `/sessions/:id/settings`     | Configurações da instância (`groupsIgnore`).                               |
| PATCH  | `/sessions/:id/settings`     | Altera "ignorar grupos" (`{ "groupsIgnore": false }`).                     |
| GET    | `/sessions/:id/messages`     | Histórico de mensagens recebidas/enviadas gravadas (ver "Mensagens recebidas"). |
| GET    | `/sessions/:id/webhooks`     | Lista os webhooks da instância (cabeçalhos mascarados, última entrega). |
| POST   | `/sessions/:id/webhooks`     | Cadastra webhook (até 10 por instância). Ver "Webhooks".                   |
| PUT    | `/sessions/:id/webhooks/:webhookId` | Substitui a configuração do webhook.                               |
| DELETE | `/sessions/:id/webhooks/:webhookId` | Remove o webhook (e as entregas pendentes dele).                   |
| POST   | `/sessions/:id/webhooks/:webhookId/test` | Envia um `webhook.test` na hora e devolve o resultado.        |
| GET    | `/sessions/:id/webhooks/:webhookId/deliveries` | Histórico de entregas (`?status=&limit=&before=`).      |
| POST   | `/sessions/:id/chat/getBase64FromMediaMessage` | Baixa a mídia de uma mensagem recebida (compatível com a Evolution). |
| GET    | `/manager`                   | Tela de configuração (estáticos públicos; dados só com API key).         |

### Enviando texto, imagem, vídeo, documento ou áudio

`POST /sessions/:id/messages` aceita cinco formatos de corpo, selecionados pelo
campo `"type"` (default `"text"`, mantém compatibilidade total com o formato
antigo):

```jsonc
// texto (default, "type" pode ser omitido)
{ "to": "5511988887777", "message": "Olá!" }

// imagem
{
  "to": "5511988887777",
  "type": "image",
  "mediaBase64": "<conteúdo em base64, com ou sem prefixo data:image/...;base64,>",
  "mimetype": "image/png",   // opcional — o baileys detecta sozinho se omitido
  "caption": "legenda opcional"
}

// vídeo
{
  "to": "5511988887777",
  "type": "video",
  "mediaBase64": "<conteúdo em base64, com ou sem prefixo data:video/...;base64,>",
  "mimetype": "video/mp4",   // obrigatório em vídeos
  "caption": "legenda opcional"
}

// documento
{
  "to": "5511988887777",
  "type": "document",
  "mediaBase64": "<conteúdo em base64>",
  "mimetype": "application/pdf",   // obrigatório pro baileys em documentos
  "fileName": "nota-fiscal.pdf",   // opcional, default "arquivo"
  "caption": "legenda opcional"
}

// áudio
{
  "to": "5511988887777",
  "type": "audio",
  "mediaBase64": "<conteúdo em base64, com ou sem prefixo data:audio/...;base64,>",
  "mimetype": "audio/ogg; codecs=opus",   // obrigatório em áudios
  "ptt": true   // opcional, default false: true = mensagem de voz, false = arquivo de áudio
}
```

Áudio sem `mimetype` é recusado com `400 informe "mimetype" (obrigatório
quando "type" é "audio")`. Para a mensagem de voz (`ptt: true`) tocar como
gravada no aparelho, mande OGG/Opus com `"mimetype": "audio/ogg; codecs=opus"`
— a bridge não converte formatos (não há ffmpeg na imagem). Só o booleano
`true` liga o `ptt`; qualquer outro valor envia como arquivo de áudio.

#### Respondendo (citando) uma mensagem

Qualquer um dos cinco formatos aceita `quotedMessageId`, o `key.id` da
mensagem a citar (o mesmo do webhook), e a mensagem sai como resposta a ela:

```json
{ "to": "5511988887777", "message": "Recebido!", "quotedMessageId": "3EB0A1B2C3D4E5F60718" }
```

A mensagem citada precisa estar gravada nesta sessão (`wa_messages`, recebida
ou enviada). A bridge cita com o `key` dela e uma cópia só dos campos de texto
do conteúdo (texto, legenda, nome do arquivo). Em grupo, o autor citado é o
`participant` da linha. Se a mensagem não for encontrada (apagada pela
`MESSAGE_RETENTION_DAYS` ou anterior à bridge), o envio sai **sem citação**,
em vez de falhar. `quotedMessageId` que não seja string de 1 a 128 caracteres
(`A-Z a-z 0-9 . _ : -`) é recusado com 400.

Mídia só entra **embutida no request** (`mediaBase64`) — de propósito não
existe um `mediaUrl` que a bridge buscaria sozinha: isso abriria SSRF (fetch
de URL arbitrária vinda de qualquer cliente que tenha a API key global). Se
seu caso de uso precisar disso, considere um allowlist de domínios antes de
implementar. (Exceção consciente: o `thumbnailUrl` do `/message/sendButtons`
aceita URL, pra manter compatibilidade com a Evolution — ver a seção de
listas e botões abaixo.)

O limite de tamanho do body JSON é `20mb` por padrão (configurável via
`JSON_BODY_LIMIT` no `.env`) — o default do Express (100kb) não seria
suficiente pra imagem/vídeo/documento em base64.

**A resposta confirma o status real da entrega, não só que a bridge aceitou o
envio.** `sock.sendMessage()` do baileys resolve assim que a mensagem é
repassada ao servidor do WhatsApp (relay) — isso sozinho não garante que ela
chegou no destinatário. A rota espera até `MESSAGE_STATUS_TIMEOUT_MS`
(default `8000`, configurável no `.env`) por uma confirmação real via evento
`messages.update` antes de responder:

```jsonc
// confirmado pelo WhatsApp dentro do timeout
{ "ok": true, "id": "3EB0...", "status": "server_ack" } // ou "delivery_ack" / "read" / "played"

// o WhatsApp recusou/falhou a entrega (HTTP 502)
{ "ok": false, "id": "3EB0...", "status": "error", "error": "..." }

// estourou o timeout sem confirmação — NÃO é falha, só não deu tempo de saber
{ "ok": true, "id": "3EB0...", "status": "unknown" }
```

Além disso, o `to` é validado contra o próprio WhatsApp via `sock.onWhatsApp()`
antes de enviar — números brasileiros têm o dígito "9" adicional ambíguo (a
mesma conta pode estar registrada com ou sem ele), e montar o JID direto dos
dígitos que o cliente mandou podia resultar num envio "bem sucedido" (`ok:
true`) que na verdade ia pra um JID que não existe. Se o número não estiver
registrado no WhatsApp, a resposta é `404`.

#### Enviando para um grupo

Qualquer um dos formatos acima vai para um grupo trocando o `to` pelo JID do
grupo (`^[0-9]+(-[0-9]+)?@g\.us$`):

```json
{ "to": "120363000000000001@g.us", "type": "text", "message": "Bom dia, grupo" }
```

Grupo não passa pelo `onWhatsApp()` (que só existe pra número): antes de
enviar, a bridge confere com `groupMetadata` (a lista em memória que o Baileys
já usa no envio, ou a consulta ao WhatsApp) que o número da sessão participa
do grupo. Se a consulta falhar ou o número não estiver entre os participantes,
a resposta é `404 { "error": "grupo não encontrado ou o número não participa" }`.
O resto do fluxo é o mesmo do individual: id gerado antes do envio, gravação
em `wa_messages` com `origin = 'api'`, evento `SEND_MESSAGE` e espera do status.
`/message/sendList` e `/message/sendButtons` continuam só pra contato individual.

### Enviando listas e botões (payload da Evolution API)

`POST /sessions/:id/message/sendList` e `POST /sessions/:id/message/sendButtons`
aceitam **o mesmo corpo** dos endpoints `/message/sendList/{instance}` e
`/message/sendButtons/{instance}` da Evolution API 2.4.0, e montam a mensagem
do mesmo jeito que ela (commit `35a4bd44` da Evolution). O que muda é só a
URL (a sessão vai no `:id`), o header de auth (`x-api-key`) e a resposta, que
é a mesma da rota `/messages` (HTTP 200 com `{ ok, id, status }`, ver acima),
e não o 201 com a mensagem completa que a Evolution devolve.

`number` aceita dígitos com DDI (`5511988887777`) ou o JID de usuário
(`5511988887777@s.whatsapp.net`). Grupos (`@g.us`) e `@lid` não são
suportados. `delay` (ms, inteiro >= 0, opcional) mostra "digitando..." pro
destinatário antes de enviar — a resposta HTTP só volta depois desse tempo
(mais a espera de confirmação de status).
`quoted`, `mentioned`, `mentionsEveryOne` e `linkPreview` são aceitos e
ignorados (no caminho de listas/botões a própria Evolution não os aplica).

**Rodapé:** `footerText` na lista (obrigatório, pode ser `""`) e `footer`
nos botões (opcional). Os nomes diferentes são os da própria Evolution.

**Partes de uma mensagem do `sendButtons`.** Todas são opcionais e podem vir
juntas:

| Parte | Campo(s) | Observação |
|---|---|---|
| Cabeçalho | `headerText` (texto) **ou** `thumbnailUrl` (imagem) | Um tipo só por mensagem; os dois juntos → 400. `headerText` **não existe na Evolution** (extensão desta bridge). |
| Corpo | `title`, `description` | Formato da Evolution: `*title*` em negrito, `description` abaixo. Qualquer um pode faltar. |
| Rodapé | `footer` | |
| Botões | `buttons` | Pode ser omitido (ou `[]`): a mensagem vai só com cabeçalho/corpo/rodapé. |

A mensagem precisa ter ao menos cabeçalho, corpo ou botões. Todas as
combinações (com e sem botões, com e sem corpo, cabeçalho em texto ou
imagem) foram testadas num aparelho real e renderizaram.

```jsonc
// lista — POST /sessions/:id/message/sendList
{
  "number": "5511988887777",
  "title": "📊 CONSULTAR DÉBITOS",
  "description": "💰 *Vencidos:* R$ 116.31",      // opcional
  "footerText": "Selecione a opção abaixo",         // rodapé
  "buttonText": "Ver débitos",                      // texto do botão que abre a lista
  "sections": [
    {
      "title": "Débitos Vencidos",
      "rows": [
        { "title": "Doc: 22639 | P: 5", "description": "R$ 46.36 - Venc: 19/10/2026", "rowId": "1" }
      ]
    }
  ]
}

// botões de resposta (até 3) — POST /sessions/:id/message/sendButtons
{
  "number": "5511988887777",
  "title": "Confirma o pedido?",          // vai em negrito no corpo
  "description": "Pedido 123",            // opcional
  "footer": "Loja X",                     // rodapé, opcional
  "thumbnailUrl": "https://...",          // imagem do cabeçalho, opcional (URL ou base64)
  "buttons": [
    { "type": "reply", "displayText": "Sim", "id": "sim" },
    { "type": "reply", "displayText": "Não", "id": "nao" }
  ]
}

// cabeçalho em texto + corpo + rodapé, sem botões
{
  "number": "5511988887777",
  "headerText": "Pedido 123",
  "description": "Seu pedido saiu para entrega.",
  "footer": "Loja X"
}

// botões de ação (até 2, podem ser misturados entre si)
{ "type": "url",  "displayText": "Abrir site", "url": "https://exemplo.com" }
{ "type": "call", "displayText": "Ligar",      "phoneNumber": "+5511988887777" }
{ "type": "copy", "displayText": "Copiar código", "copyCode": "ABC123" }

// PIX (sozinho; recusa headerText/thumbnailUrl/footer; title/description são ignorados)
{ "number": "5511988887777",
  "buttons": [{ "type": "pix", "currency": "BRL", "name": "Loja X", "keyType": "cpf", "key": "12345678900" }] }
// keyType: "phone" | "email" | "cpf" | "cnpj" | "random"
```

Regras validadas (as da Evolution, mais algumas que ela não confere e que
deixariam o botão quebrado no aparelho):
- Lista: `title`, `footerText`, `buttonText` e `sections` obrigatórios; cada
  seção precisa de `title` e de ao menos uma linha; cada linha precisa de
  `title` e `rowId`; seções/linhas idênticas repetidas são recusadas.
- `reply`: até 3, não mistura com outros tipos. `id` é opcional (gerado se
  omitido).
- `url`/`call`/`copy`: até 2. Exigem `displayText` e o campo do tipo
  (`url`, `phoneNumber` ou `copyCode`).
- `pix`: um só, sozinho; exige `name`, `key` e `keyType`. Não aceita
  `headerText`, `thumbnailUrl` nem `footer` (a mensagem de PIX vai sem
  cabeçalho/corpo/rodapé, como na Evolution).
- Os limites do WhatsApp (ex.: ~10 linhas por lista, tamanho máximo de
  títulos e do `buttonText`) **não** são validados, igual à Evolution.

**Atenção ao `thumbnailUrl` com URL:** a imagem é baixada pelo próprio
servidor da bridge — ao contrário da rota `/messages`, que só aceita mídia
embutida. Isso permite SSRF (qualquer cliente com a API key consegue fazer a
bridge buscar uma URL arbitrária, inclusive da rede interna). Foi mantido pra
ficar compatível com a Evolution; se a bridge for exposta a clientes não
confiáveis, prefira mandar a imagem em base64.

**Como funciona e por que é frágil:** o WhatsApp só exibe lista/botão se a
stanza levar um nó `<biz>`, que o `sock.sendMessage()` do baileys não envia.
A bridge monta o proto (`listMessage` com `SINGLE_SELECT` /
`interactiveMessage` + `nativeFlowMessage`) e envia com
`sock.relayMessage(..., { additionalNodes: [<biz>] })` — ver
`interactive.js`. Isso é engenharia reversa: se o WhatsApp mudar o formato, a
mensagem pode voltar a ser descartada sem erro (foi o que aconteceu com a
Evolution em toda a 2.3.x). O `status` da resposta ajuda a perceber isso. A
opção escolhida pelo usuário chega como mensagem recebida
(`listResponseMessage`, `buttonsResponseMessage`, `templateButtonReplyMessage`
ou `interactiveResponseMessage`) — ver "Mensagens recebidas" e "Webhooks".

### Exemplo de uso

```bash
KEY="troque-por-uma-chave-forte"

# 1. inicia o pareamento do número
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/connect

# 2. pega o QR e escaneia no celular (Aparelhos conectados → Conectar aparelho)
curl -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/qr

# 3. dispara mensagem por esse número
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/messages \
  -H "Content-Type: application/json" \
  -d '{"to": "5511988887777", "message": "Olá!"}'

# 3b. dispara imagem (ver "Enviando texto, imagem, vídeo, documento ou áudio" acima pros formatos de vídeo, documento e áudio)
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/messages \
  -H "Content-Type: application/json" \
  -d '{"to": "5511988887777", "type": "image", "mediaBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "mimetype": "image/png", "caption": "teste"}'

# 3b'. dispara mensagem de voz (OGG/Opus em base64 no arquivo voz.b64) e texto num grupo
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/messages \
  -H "Content-Type: application/json" \
  -d "{\"to\": \"5511988887777\", \"type\": \"audio\", \"mediaBase64\": \"$(cat voz.b64)\", \"mimetype\": \"audio/ogg; codecs=opus\", \"ptt\": true}"
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/messages \
  -H "Content-Type: application/json" \
  -d '{"to": "120363000000000001@g.us", "message": "Bom dia, grupo"}'

# 3c. dispara lista de opções (ver "Enviando listas e botões" acima)
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/message/sendList \
  -H "Content-Type: application/json" \
  -d '{"number": "5511988887777", "title": "Menu", "footerText": "Escolha uma opção", "buttonText": "Ver opções", "sections": [{"title": "Opções", "rows": [{"title": "Falar com atendente", "rowId": "atendente"}]}]}'

# 3d. dispara botões com cabeçalho em texto, corpo e rodapé
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/message/sendButtons \
  -H "Content-Type: application/json" \
  -d '{"number": "5511988887777", "headerText": "Pedido 123", "title": "Confirma?", "footer": "Loja X", "buttons": [{"type": "reply", "displayText": "Sim", "id": "sim"}]}'

# 4. desconecta sem perder a sessão (dá pra reconectar depois sem novo QR,
#    e NÃO aciona reconexão automática — foi um pedido manual)
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/disconnect

# 5. reconecta usando a credencial salva
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/connect

# 6. logout: desvincula o aparelho e apaga as credenciais, mas mantém a
#    sessão e os webhooks (o próximo /connect pede QR de novo)
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/logout
# -> {"id":"5511999999999","status":"logged_out","remoteLogout":true}
#    remoteLogout=false: não havia socket conectado pra avisar o WhatsApp; as
#    credenciais foram apagadas mesmo assim (o aparelho pode continuar listado
#    no celular até ser removido lá ou expirar)

# 7. exclui a sessão de vez (logout + apaga webhooks, histórico e entregas)
curl -X DELETE -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999
```

## Mensagens recebidas

Toda mensagem nova de uma instância conectada é normalizada no formato
`data` do webhook `messages.upsert` da **Evolution API 2.4.0-rc2**
(`key`, `pushName`, `status`, `message`, `contextInfo`, `messageType`,
`messageTimestamp`, `instanceId`, `source`) e gravada **uma única vez** em
`wa_messages`. A deduplicação é por `(sessão, key.id, fromMe)`: reentregas
do WhatsApp depois de uma reconexão não geram linha (nem aviso) repetido.

Tipos cobertos: texto (inclusive com link ou citação, que viram
`conversation`), imagem, áudio/voz, vídeo, vídeo-nota (`ptvMessage`),
documento (com ou sem legenda, que vira `documentMessage`), sticker,
localização, contato(s), reação (`text: ""` = reação removida), voto em
enquete (cru, sem decriptar), respostas de lista/botão e mensagens
temporárias/visualização única (desembrulhadas). Edição e exclusão "para
todos" atualizam a mensagem original (`status` `EDITED` / `DELETED`) em vez de
criar linha nova. Histórico antigo **não** é importado (`syncFullHistory:
false`): só entra o que chegar depois que a instância conecta.

Formato completo e exemplos por tipo:
[`docs/contracts/webhook-payload.md`](docs/contracts/webhook-payload.md).
Binários (`mediaKey`, `jpegThumbnail` etc.) saem como string base64.

**Origem (`origin`)** — cada mensagem gravada tem uma de três origens:

| `origin`  | O que é                                                         |
|-----------|-----------------------------------------------------------------|
| `inbound` | Enviada por outra pessoa para a instância.                       |
| `device`  | Enviada pelo próprio número, por outro aparelho (celular, Web).  |
| `api`     | Enviada por esta bridge (`/messages`, `/message/sendList`, `/message/sendButtons`). |

As rotas de envio geram o id da mensagem **antes** de enviar e o registram em
memória, então o eco que o Baileys devolve é reconhecido como `api` — mesmo
quando chega antes da gravação da própria rota. É isso que impede uma
resposta enviada pelo Chatwoot (via API) de voltar como mensagem nova.

**LID (número oculto)** — quando o WhatsApp identifica o contato por
`<id>@lid`, a bridge troca para o número (`key.remoteJid` = número,
`key.remoteJidAlt` = LID, `addressingMode: "pn"`), usando o que vem na
mensagem ou o mapeamento LID→número que o próprio Baileys guarda. Se o
número for desconhecido, a mensagem segue com `remoteJid: "...@lid"` e
`addressingMode: "lid"`: quem consome precisa aceitar esse caso. Em grupo, a
mesma regra vale para `key.participant`. Vale também para quem foi citado
(`contextInfo.participant`, com o LID em `contextInfo.participantAlt`) e para
quem foi mencionado (`contextInfo.mentionedJid[]`, com os LIDs trocados no
vetor paralelo `contextInfo.mentionedJidAlt[]`, `null` nas posições não
trocadas). Campos extras do WSB; mensagens gravadas antes ficam como estavam.

**Nome do grupo** — mensagem de grupo sai no webhook (`messages.upsert` e
`send.message`) e no histórico com `groupSubject` (`string | null`); mensagem
individual não tem o campo. O nome é resolvido na hora (memória → tabela
`wa_groups` → consulta ao WhatsApp) e nunca gravado em `wa_messages` nem no
outbox, então o histórico mostra o nome **atual** do grupo. `wa_groups` é
alimentada pelos eventos de grupo do Baileys (entrar, renomear) e pelas
consultas, e é o que mantém os nomes com a sessão desconectada. Consulta que
falha ou demora vira `null` sem atrasar a entrega além de
`GROUP_METADATA_TIMEOUT_MS`. Os logs mostram só o JID do grupo, nunca o nome.

**Ignorar grupos** — por instância, **ligado por padrão**. Com ele ligado,
mensagens de grupo não são gravadas nem repassadas. Vale na hora para as
próximas mensagens:

```bash
curl -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/settings
# {"groupsIgnore":true}

curl -X PATCH -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/sessions/5511999999999/settings -d '{"groupsIgnore": false}'
```

**Histórico** — `GET /sessions/:id/messages?remoteJid=&limit=50&before=`
devolve as mensagens gravadas, da mais nova para a mais antiga
(`{ "items": [<data> + "origin"], "nextBefore": <id|null> }`). `remoteJid`
aceita só dígitos ou um JID; `limit` vai de 1 a 200; para a próxima página,
passe o `nextBefore` recebido em `before`. Itens de grupo trazem
`groupSubject` (nome **atual** do grupo, ver acima): cada grupo da página é
resolvido uma vez, com no máximo `GROUP_METADATA_HISTORY_MAX_LOOKUPS`
consultas ao WhatsApp e `GROUP_METADATA_HISTORY_BUDGET_MS` de espera por
requisição; o que passar disso sai `null` e a resposta continua `200`. Por padrão o histórico não
expira; com `MESSAGE_RETENTION_DAYS=N`, uma limpeza horária apaga as
mensagens gravadas há mais de N dias (as entregas de webhook já feitas
continuam no histórico de entregas, só sem o vínculo com a mensagem).

## Webhooks

Cada instância pode ter **até 10 webhooks**, cada um com sua URL, eventos e
cabeçalhos. A requisição é a mesma do webhook da Evolution API 2.4.0-rc2:
`POST` com o envelope `{ event, instance, data, destination, date_time,
sender, server_url, apikey }` e os cabeçalhos `X-Instance-ID`,
`X-Instance-Name`, `X-Event-Type`, `X-Timestamp`, mais `X-Delivery-ID`
(extra do WSB) e `User-Agent: WSB-Webhook/1.0`. Contrato completo, com
exemplos de cada evento:
[`docs/contracts/webhook-payload.md`](docs/contracts/webhook-payload.md).

```bash
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/sessions/5511999999999/webhooks \
  -d '{"url": "https://texteaseai.example/webhooks/wsb", "events": ["MESSAGES_UPSERT"], "base64": true,
       "headers": {"Authorization": "Bearer token-do-receptor"}}'
```

| Campo           | Default               | O que faz |
|-----------------|-----------------------|-----------|
| `url`           | obrigatório           | `http`/`https`, até 2048 caracteres. |
| `enabled`       | `true`                | Desativado não recebe eventos novos, e as entregas pendentes ficam pausadas até reativar. |
| `events`        | `["MESSAGES_UPSERT"]` | Subconjunto dos 7 eventos (tabela abaixo). |
| `base64`        | `false`               | Embute a mídia em `data.message.base64`. |
| `byEvents`      | `false`               | Acrescenta o evento ao path: `<url>/messages-upsert`. |
| `includeFromMe` | `false`               | `messages.upsert` também para mensagens enviadas pelo próprio número em outro aparelho. |
| `headers`       | `{}`                  | Até 20 cabeçalhos extras. O nome especial `jwt_key` não é repassado: vira `Authorization: Bearer <JWT HS256>` assinado com ele (como na Evolution). |

Na leitura (`GET`), os valores dos cabeçalhos voltam como `"••••"`. No `PUT`
(substituição completa), mandar `"••••"` mantém o valor salvo — **só se o
destino (esquema + host + porta) não mudar**. Trocou o host e mandou a
máscara, a resposta é `400` pedindo os valores de novo (senão bastaria
apontar a URL para outro servidor para receber o token salvo). A URL não pode ter usuário/senha
(autentique por `headers`). Cada valor de cabeçalho vai até 8192 caracteres
ASCII/Latin-1, e `Host`, `Content-Length`, `Transfer-Encoding` e `Connection`
não podem ser personalizados; os cabeçalhos fixos (`X-Delivery-ID`,
`User-Agent` etc.) não são sobrescritos.

### Eventos

| Evento (config)     | `event`             | Quando dispara | `data` |
|---------------------|---------------------|----------------|--------|
| `MESSAGES_UPSERT`   | `messages.upsert`   | Mensagem nova recebida (e, com `includeFromMe`, enviada pelo celular). **Nunca** para mensagens enviadas pela API. | Mensagem no formato da Evolution (ver "Mensagens recebidas"). |
| `SEND_MESSAGE`      | `send.message`      | Mensagem enviada por esta API (`/messages`, `sendList`, `sendButtons`). | Mesmo formato do `messages.upsert`, `key.fromMe: true`. |
| `MESSAGES_UPDATE`   | `messages.update`   | Mudança de status de uma mensagem gravada (entregue, lida, reproduzida, erro). Só avança: `READ` não volta para `DELIVERY_ACK`. | `{ messageId, keyId, remoteJid, fromMe, participant, status, instanceId }`. |
| `MESSAGES_EDITED`   | `messages.edited`   | Mensagem editada. | `{ key, type: "MESSAGE_EDIT", editedMessage }`. |
| `MESSAGES_DELETE`   | `messages.delete`   | Mensagem apagada para todos. | `{ remoteJid, fromMe, id }` da mensagem apagada. |
| `CONNECTION_UPDATE` | `connection.update` | Instância conectando, conectada ou desconectada. | `{ instance, wuid, profileName, state: "open" \| "connecting" \| "close", statusReason }`. |
| `QRCODE_UPDATED`    | `qrcode.updated`    | QR code novo para parear. | `{ qrcode: { instance, pairingCode, code, base64 } }`. |

### Entrega, retentativa e deduplicação

- **Durável:** cada aviso é gravado numa fila no Postgres
  (`wa_webhook_deliveries`) na mesma transação da mensagem, e sai em
  seguida. Um restart da bridge não perde avisos: o que estava pendente sai
  quando ela volta.
- **Qualquer `2xx` conta como entregue.** `400`, `401`, `403`, `404`, `422`
  e redirects (`3xx`, que não são seguidos) são falha definitiva, sem
  retentativa (configuração errada do lado do receptor). `qrcode.updated`
  tem uma tentativa só: o QR expira em segundos. Timeout, erro de rede, `408`, `429` e `5xx` são retentados com
  backoff exponencial (5s, 10s, 20s… até 5 min, ±20% de variação). Com os
  defaults, são 15 tentativas em **~45 minutos**. Depois disso, a entrega
  fica `failed`.
- **At-least-once:** em casos raros (restart no meio de um envio, receptor
  que responde depois do timeout) o mesmo aviso pode chegar mais de uma vez.
  Deduplique por `data.key.id` + `instance`, ou por `X-Delivery-ID` (estável
  entre retentativas).
- A ordem é a de chegada "na medida do possível": com concorrência e
  retentativas, um aviso pode passar à frente de outro.
- O histórico de entregas (`GET .../deliveries`) mostra situação,
  tentativas, último código e último erro. Entregas concluídas — e as
  pendentes de webhooks desativados há muito tempo — são apagadas depois de
  `WEBHOOK_DELIVERY_RETENTION_DAYS` dias.
- **Concorrência:** até `WEBHOOK_CONCURRENCY` POSTs ao mesmo tempo no total e
  no máximo `WEBHOOK_CONCURRENCY_PER_WEBHOOK` por webhook, para que um
  receptor lento (ou fora do ar, esperando timeout) não atrase os webhooks das
  outras instâncias. O limite por webhook vale por processo.
- `POST .../test` envia `event: "webhook.test"` na hora, sem fila nem
  retentativa, e responde `200` com `{ ok, statusCode, durationMs, error? }`.

### Mídia

Com `base64: true`, imagem, vídeo, vídeo-nota, áudio, documento e sticker
chegam com o arquivo inteiro em `data.message.base64`. O arquivo é baixado
do WhatsApp **na hora do envio** e não fica guardado em disco nem no banco.
Se passar de `WEBHOOK_MEDIA_MAX_BYTES` ou o download falhar (expirado,
timeout de `WEBHOOK_MEDIA_TIMEOUT_MS`), o aviso sai mesmo assim, sem o
arquivo e com `data.message.base64Error: "too_large" | "download_failed"`.

O arquivo também pode ser pedido depois, como na Evolution:

```bash
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/sessions/5511999999999/chat/getBase64FromMediaMessage \
  -d '{"message": {"key": {"id": "3EB0A1B2C3D4E5F60718"}}}'
# { "mediaType": "imageMessage", "fileName": "...jpeg", "caption", "size", "mimetype", "base64" }
```

Aceita só a `key.id` (busca a mensagem gravada) ou a mensagem inteira no
formato da Evolution. `convertToMp4` é aceito e ignorado (não há ffmpeg na
imagem). Erros: `404` (mensagem não encontrada), `400` (não é mídia), `409`
(sessão não conectada: o socket é necessário para pedir o reenvio de mídia
expirada), `413` (acima de `WEBHOOK_MEDIA_MAX_BYTES`) e `502` (o WhatsApp
não devolveu a mídia).

### Diferenças em relação à Evolution

1. Campos binários (`mediaKey`, `jpegThumbnail`, `fileSha256` etc.) saem como
   string base64, e números `Long` (`fileLength`, `mediaKeyTimestamp`) como
   número. A Evolution manda os binários como objeto indexado
   (`{"0":12,"1":34,...}`).
2. `apikey` é sempre `null`: a bridge nunca envia a API key global a terceiros.
3. `data.message.base64Error`, `data.groupSubject`,
   `data.contextInfo.participantAlt` e `data.contextInfo.mentionedJidAlt[]`
   são campos extras (não existem na Evolution).
4. LID: a mesma troca da Evolution (`remoteJid` = número, `remoteJidAlt` =
   LID), mas em mensagens `fromMe` um alt que aponte para o próprio número é
   descartado (a Evolution gravaria a conversa com o número da instância), e
   o número também é buscado no mapeamento do Baileys. Sem número conhecido,
   chega `@lid` com `addressingMode: "lid"`.
5. `messages.upsert` não inclui por padrão as mensagens enviadas pelo próprio
   número (só com `includeFromMe`) e **nunca** inclui as enviadas pela API, que
   saem só como `send.message`. Isso evita eco e loop com o Chatwoot.

Além disso, `contextInfo` vem `null` quando não há citação (na Evolution o
campo some do JSON).

### Segurança

- As rotas de webhook exigem a API key, como todas as outras.
- Os cabeçalhos dos webhooks (tokens do receptor) nunca voltam na leitura e
  nunca vão para o log. O log também omite a query string e as credenciais
  da URL.
- **SSRF consciente:** a bridge faz `POST` para a URL cadastrada, que pode
  ser um endereço da rede interna (é o caso comum: texteaseai no mesmo
  Docker). Quem tem a API key consegue, portanto, fazer a bridge chamar
  qualquer endereço `http(s)` alcançável por ela — e o `POST .../test`
  devolve o código HTTP ou de rede (`ECONNREFUSED` etc.), o que permite
  sondar a rede interna. É o mesmo risco já documentado para o
  `thumbnailUrl` dos botões. A validação é só de protocolo (`http`/`https`).
  Redirects não são seguidos (um `3xx` levaria os cabeçalhos a outro destino).
- **Mídia só do CDN do WhatsApp:** `url` e `directPath` de uma mensagem
  recebida vêm de quem mandou a mensagem. A bridge ignora o `url` e só baixa
  pelo `directPath` validado, em `https://mmg.whatsapp.net` — senão uma
  mensagem forjada faria a bridge buscar um endereço interno sem precisar da
  API key. No máximo 3 downloads de mídia rodam ao mesmo tempo.
- **QR code em webhook:** `qrcode.updated` leva o código de pareamento,
  que dá acesso à conta enquanto não expira. Só inscreva esse evento em um
  receptor confiável. O payload fica no histórico de entregas até a limpeza
  (`WEBHOOK_DELIVERY_RETENTION_DAYS`).
- **Cabeçalhos cifrados no banco:** os valores dos cabeçalhos (tokens do
  receptor) são gravados com AES-256-GCM; um dump do banco não os expõe. A
  chave vem de `WEBHOOK_HEADERS_KEY` ou, sem ela, é derivada da `API_KEY`.
  Nesse segundo caso, **trocar a `API_KEY` invalida os cabeçalhos salvos**:
  as entregas desses webhooks passam a falhar com "não foi possível
  decifrar o cabeçalho..." (nada é enviado sem o token) até os valores serem
  cadastrados de novo. Para poder trocar a API key livremente, defina
  `WEBHOOK_HEADERS_KEY` (`openssl rand -hex 32`) e não a troque. As
  credenciais do Baileys (`wa_auth_state`) continuam em texto: proteja o
  acesso ao banco.
- **Corpo das requisições:** só é lido depois da API key, e só as rotas de
  mídia (`/messages`, `/message/sendButtons`) aceitam até `JSON_BODY_LIMIT`;
  as demais, até 256kb. JSON inválido ou grande demais responde
  `400`/`413` no formato `{ "error" }`.
- A tela `/manager` é servida com CSP restritivo (`script-src 'self'`) e
  `X-Frame-Options: DENY`.

## Tela de configuração

`http://localhost:3000/manager` abre uma tela (React + shadcn/ui) para
gerenciar os webhooks sem montar requisições na mão:

- entrar com a **mesma `API_KEY`** da API. A chave fica só no
  `sessionStorage` da aba: fechou a aba, pede de novo;
- ver as instâncias com número, nome de perfil e status;
- ligar ou desligar "ignorar grupos";
- criar, editar, ativar/desativar, testar e excluir webhooks;
- acompanhar o histórico de entregas, com filtro por situação.

Os arquivos da tela são públicos (não contêm dado nenhum). Tudo o que ela
mostra vem das rotas `/sessions`, com a API key.

A imagem Docker já builda a tela (estágio `manager-build` do `Dockerfile`).
Para desenvolver:

```bash
cd manager
npm install
npm run dev     # http://localhost:5173/manager/ (faz proxy de /sessions para localhost:3000)
npm run build   # gera manager/dist, servido pela bridge em /manager
```

Rodando a bridge fora do Docker sem `manager/dist`, a API funciona
normalmente e o log avisa que a tela está indisponível.

> `npm audit` em `manager/` aponta avisos no Tailwind CSS 3 e nas
> dependências dele (`braces`, `micromatch`, `chokidar`,
> `postcss-selector-parser`). São ferramentas de **build**: não vão para o
> navegador nem para a imagem final, e só seriam exploráveis com padrões de
> arquivo maliciosos no próprio `tailwind.config.ts`. A correção exige migrar
> para o Tailwind 4 (que muda a configuração do tema do shadcn), e ficou para
> uma tarefa própria.

## Status possíveis de uma sessão

`connecting` → `qr` (aguardando escaneamento) → `connected`
`connected` → `disconnected` (via `/disconnect`, credenciais mantidas, **sem** reconexão automática)
`connecting` → `disconnected` (travou em `connecting` por mais que `CONNECTING_TIMEOUT_MS` — watchdog força a saída, **sem** reconexão automática, igual a um `/disconnect` manual)
`connected`/`qr` → `reconnecting` (queda de rede — não solicitada — tenta sozinho)
`reconnecting` → `error` (desistiu após `RECONNECT_MAX_ATTEMPTS` tentativas — chame `/connect` de novo)
qualquer → `logged_out` (deslogado pelo próprio WhatsApp ou via `/logout`, credenciais apagadas; a sessão e os webhooks ficam)

**Sessão travada em `connecting` ou `connected`?** Chame `/disconnect` e
depois `/connect` — `/disconnect` funciona mesmo se o socket estiver morto/
sem resposta (encerrar um socket já fechado é um no-op seguro). Se ficar em
`connecting` por tempo demais sem digitar nada, o watchdog
(`CONNECTING_TIMEOUT_MS`, default 45s) já faz isso sozinho — mas só o
`/disconnect`, de propósito **não** reconecta em seguida (ver decisões de
design abaixo).

## Diagnóstico de quedas

Toda abertura (`open`), queda não pedida (`close`), `/disconnect` ou watchdog
(`disconnect`) e `/logout` (`logout`) fica registrada com o motivo que o
baileys reportou, em dois lugares:

- **Log do container**, uma linha por queda:
  `[5511999999999] conexão fechou: code=428 reason=connectionClosed message="Connection Terminated" uptime=52m05s`
- **Tabela `wa_connection_events`** (sobrevive a redeploy; limpeza após
  `CONNECTION_EVENTS_RETENTION_DAYS`, default 30), consultável pela API:
  `GET /sessions/:id/connection-events?limit=100`.

Como ler o `code`/`reason` (`DisconnectReason` do baileys):

| code | reason | O que costuma ser |
|------|--------|-------------------|
| 408 | `connectionLost/timedOut` | Keepalive sem resposta: rede da VPS ou do WhatsApp oscilou. |
| 428 | `connectionClosed` | WebSocket fechado pelo outro lado (o WhatsApp encerrou a conexão). |
| 440 | `connectionReplaced` | Outra conexão com a mesma credencial abriu (dois processos/sockets com o mesmo número). |
| 401 | `loggedOut` | Aparelho removido no celular ou sessão invalidada pelo WhatsApp: precisa de QR. |
| 500 | `badSession` | Credencial/sessão corrompida. |
| 503 | `unavailableService` | Instabilidade do lado do WhatsApp. |
| 515 | `restartRequired` | Normal logo depois de ler o QR; a bridge reconecta na hora. |

Os logs internos do baileys saem em JSON (pino) com `"session":"<id>"`, no
nível `BAILEYS_LOG_LEVEL` (default `warn`). Pra investigar uma instância que
cai com frequência, suba temporariamente pra `info` ou `debug`. Os dumps de
sessão de sinal que o libsignal imprimia (`Closing session: SessionEntry {...}`,
com chaves privadas) são descartados.

## Decisões de design (e o que falta pra produção séria)

- **Reconexão automática só em queda não solicitada**, com quantidade de
  tentativas e delay fixo entre elas configuráveis via `RECONNECT_MAX_ATTEMPTS`
  e `RECONNECT_DELAY_MS`. Uma desconexão pedida via `/disconnect`, `/logout` ou `DELETE`
  nunca acorda reconexão sozinha — só volta se você chamar `/connect`.
- **Watchdog de `connecting` travado** (`CONNECTING_TIMEOUT_MS`, default
  45s): se o handshake com o WhatsApp nunca completar nem falhar (comum
  atrás de firewall restritivo — o `connectTimeoutMs` interno do baileys só
  conta a partir do WebSocket já aberto, não cobre um TCP travado antes
  disso), a bridge força a saída sozinha. De propósito, essa ação é **só**
  um `/disconnect` — não tenta reconectar em seguida. A ideia é não sair
  batendo reconexão automática contra algo que pode ser estrutural (rede,
  firewall) e entrar num loop; fica em `disconnected` esperando um
  `/connect` explícito.
- **Usa os utilitários oficiais do Baileys sempre que possível**, em vez de
  reimplementar: `makeCacheableSignalKeyStore` (cache em memória sobre as
  chaves de sessão, reduz leitura no Postgres — é o padrão recomendado pela
  própria lib) e `Browsers.ubuntu(...)` pro identificador de dispositivo. Se o
  formato que o WhatsApp espera mudar, resolve com `npm update baileys`, sem
  mexer no nosso código.
- **`unhandledRejection`/`uncaughtException` são logados, não derrubam o
  processo.** Baileys mexe com WebSocket cru e criptografia de sinal e
  ocasionalmente algum erro escapa dos handlers normais; preferimos manter as
  outras sessões de pé.
- **A API key é única e global** — não distingue quem está chamando. Se
  precisar de múltiplos consumidores com permissões diferentes, isso pede uma
  camada de auth mais completa (uma key por cliente, JWT, etc.).
- **Um processo = um dono de cada sessão.** Se você rodar múltiplas réplicas
  da bridge apontando pro mesmo Postgres, cada sessão só deve ser "conectada"
  em uma réplica por vez (senão as duas brigam pelo mesmo socket do
  WhatsApp). Pra escalar de verdade, seria preciso um lock distribuído (ex:
  `pg_advisory_lock` por `session_id`) decidindo quem "possui" cada sessão.
- **Fila de webhooks no próprio Postgres** (outbox `wa_webhook_deliveries`,
  com `FOR UPDATE SKIP LOCKED`), em vez de Redis/RabbitMQ: o Postgres já é
  dependência, a entrega sobrevive a restart e o histórico fica consultável.
  A Evolution faz retentativa em memória e perde avisos num restart.
- **Sem fila de envio** — disparos são síncronos, um por chamada. Se for
  disparar volume, vale enfileirar (ex: BullMQ/Redis) com um intervalo entre
  mensagens pra não levar ban.

## Avisos importantes

- **Baileys não é oficial** — reimplementa o protocolo do WhatsApp Web. Uma
  mudança da Meta pode quebrar a lib até os mantenedores atualizarem.
- **Risco de banimento**: números usados para disparo em massa, spam ou fora
  dos termos de uso do WhatsApp podem ser banidos. Use para comunicação
  legítima com destinatários que esperam a mensagem.

## Revisão de código (feita manualmente — sem subagent/segundo modelo disponível neste ambiente)

### Revisão contra a documentação oficial do Baileys (baileys.wiki)

- **`restartRequired` (515) agora reconecta na hora, sem contar como
  tentativa falha.** Esse código de desconexão é disparado pelo próprio
  WhatsApp logo após você escanear o QR — é parte normal do pareamento, não
  um erro. A doc é explícita: "Reconnect immediately". Antes, nosso código
  tratava isso como qualquer outra queda e esperava `RECONNECT_DELAY_MS`
  (30s por padrão) antes de reconectar, o que deixava o fluxo de parear um
  número novo lento e podia até gastar tentativas do orçamento de reconexão
  à toa.
- **Adicionado `getMessage` ao socket.** A documentação trata `auth`,
  `logger` e `getMessage` como as três opções praticamente obrigatórias do
  `makeWASocket` — sem `getMessage`, o WhatsApp não consegue pedir reenvio
  de uma mensagem quando falha em decriptar do lado de quem recebe (o
  sintoma conhecido é a mensagem ficar travada em "this message can take a
  while"). Implementei com um cache em memória, limitado a 100 mensagens por
  sessão — cobre o caso de retry logo após o envio sem precisar de uma
  tabela nova no Postgres nem virar um histórico de mensagens de verdade.
- **Removido `printQRInTerminal: false`** — está marcado como deprecated na
  doc atual. Já escutávamos o campo `qr` direto no `connection.update`
  (que é o jeito recomendado), então a opção não fazia nada além de usar uma
  API obsoleta.
- **Confirmado que `fetchLatestBaileysVersion()` é o padrão certo** (não é a
  função arriscada que a doc pede pra evitar — essa é `fetchLatestWaWebVersion`,
  que a gente não usa) e que ela já degrada graciosamente pra versão padrão
  do pacote se a rede falhar. Bate com todo exemplo oficial e da comunidade
  que encontrei, incluindo implementações de auth state customizado.
- **Confirmado que a abordagem de auth state em Postgres é exatamente a
  recomendada**: a própria doc/README do Baileys diz que `useMultiFileAuthState`
  "serves as a good guide to help write auth & key states for SQL/no-SQL
  databases, which I would recommend in any production grade system" — e a
  FAQ chega a desaconselhar `useMultiFileAuthState` em produção pelo I/O de
  disco. Nosso `postgresAuthState.js` segue essa recomendação à risca.

### Achados anteriores (revisão de código geral)

Achados corrigidos:

- **Race condition no startup**: o servidor podia aceitar requisições HTTP
  antes de `migrate()` criar as tabelas. Corrigido: `migrate()` agora roda
  (e é esperado) antes do `app.listen()`, e uma falha aí derruba o processo
  com mensagem clara em vez de silenciosamente deixar a app num estado
  quebrado.
- **`RECONNECT_MAX_ATTEMPTS`/`RECONNECT_DELAY_MS` inválidos viravam `NaN`**,
  o que desativava silenciosamente o limite de tentativas (`attempt > NaN` é
  sempre falso) — voltando ao loop apertado de reconexão que a gente tinha
  corrigido antes. Agora valida no boot e recusa subir se vier algo inválido.
- **Duas chamadas concorrentes de `/connect` pro mesmo número** podiam criar
  dois sockets Baileys ao mesmo tempo escrevendo na mesma linha de
  credenciais no Postgres. Adicionado um lock em memória por sessão
  (`startSessionSerialized`) que faz a segunda chamada esperar a primeira em
  vez de duplicar.
- **Comparação da API key não era timing-safe** (`!==` numa string vaza
  timing). Trocada por `crypto.timingSafeEqual`.
- **`package-lock.json` não estava nos arquivos entregues** — o Dockerfile
  usa `npm ci`, que exige esse arquivo. Corrigido.
- **Sem suporte a SSL no Postgres** — a maioria dos provedores gerenciados
  exige. Adicionado `DATABASE_SSL=true` como opção.

Limitações conhecidas que **não** foram resolvidas agora (escopo/trade-off,
não bug):

- **Só manda mensagem pra contato individual**, não pra grupo (`@g.us`) ou
  canal — a validação de número rejeitaria o formato de JID de grupo. Se
  precisar disso, dá pra adicionar sem muita dificuldade. *(Resolvido depois:
  `POST /messages` aceita `to` de grupo — ver "Enviando para um grupo". Canal
  e listas/botões pra grupo continuam fora.)*
- **`restartRequired` é tratado à parte (reconecta na hora); os demais
  motivos de queda que não são "logged out" recebem o mesmo tratamento**
  (retry com delay fixo). A doc também documenta `badSession`,
  `forbidden` e `multideviceMismatch` como casos que **retry sozinho
  provavelmente não resolve** (sessão corrompida, credencial rejeitada,
  versão desatualizada) — hoje eles caem no mesmo caminho genérico de
  retry-até-desistir. Funciona (eventualmente desiste e pede `/connect`
  manual), só não é o mais rápido possível pra esses casos específicos.
- **A API key é única e global**, sem granularidade por cliente.

## Revisão de código — rodada 2 (Claude Code, com Docker/Postgres reais e o pacote baileys instalado)

Feita num ambiente com Docker, Node 22 e Postgres reais disponíveis (a
diferença real em relação à rodada anterior, que rodou só no chat do
claude.ai). Ainda **sem número de WhatsApp de teste disponível**, então o
pareamento real (QR → `connection: 'open'`) e o envio de mensagem real
continuam **não testados de ponta a ponta** — essa é a lacuna que mais
importa resolver antes de confiar cegamente nisso em produção.

### O que rodou de verdade aqui

- **`npm install` / `npm ci --omit=dev`**: ambos passam limpos com o
  `package-lock.json` entregue — confirma que o Dockerfile builda a etapa de
  instalação de dependências sem surpresas.
- **`npm audit`**: **0 vulnerabilidades** em 208 dependências (177 prod + 28
  optional + peer).
- **`baileys@^7.0.0-rc14` é a versão mais atual publicada** (`npm view
  baileys dist-tags` → `latest: 7.0.0-rc14`). Não há nada mais novo pra
  atualizar agora.
- **`server.js` rodou de verdade contra um Postgres real** (não o chat, um
  Postgres instalado neste ambiente): migração automática, todos os
  endpoints (401/200, validação de formato, `/connect` → `/disconnect` →
  restart do processo → `/connect` de novo), incluindo os dois bugs
  encontrados e corrigidos abaixo — reproduzidos e confirmados corrigidos,
  não só deduzidos lendo o código.
- **`docker compose up --build` NÃO rodou de ponta a ponta.** O Docker
  Engine deste ambiente péde daemon rodando manualmente, e uma vez rodando,
  tanto `postgres:16-alpine` quanto `node:22-slim` falham o pull com `403
  Forbidden` — a política de rede deste ambiente bloqueia o registry do
  Docker Hub (confirmado como bloqueio de política, não falha transitória:
  o endpoint de status do proxy interno reporta `connect_rejected` /
  "policy denial" pro host do CDN do Docker Hub). Isso não é algo pra
  contornar — é uma limitação real deste ambiente de revisão, igual à falta
  de acesso aos servidores do WhatsApp. **O build Docker continua não
  validado de ponta a ponta**; o que dava pra confirmar sem pull de imagem
  (sintaxe do `docker-compose.yml`, `npm ci` isolado, resolução do binário
  nativo do `sharp` — que instalou normalmente tanto a variante glibc quanto
  a musl como dependência transitiva do baileys) segue OK.

### Revisão contra o código-fonte instalado do baileys (não só a doc)

Com o pacote `baileys@7.0.0-rc14` de verdade instalado em `node_modules`,
deu pra confirmar direto no código (não só confiar na wiki, que muda de
versão pra versão) que:

- `DisconnectReason.restartRequired = 515` e o próprio baileys trata esse
  código como caso especial internamente (loga como "restart required", não
  como erro) — o fix da rodada anterior está alinhado com o que a lib
  realmente faz, não só com o que a doc diz.
- **O baileys 7 já tem um cache de retry de mensagens embutido, ligado por
  padrão.** Existe uma opção `enableRecentMessageCache` (default `true` em
  `Defaults/index.js`) que liga um `MessageRetryManager` interno — um LRU de
  até 512 mensagens com TTL de 5 minutos — e o fluxo de retry
  (`sendMessagesAgain` em `messages-recv.js`) consulta esse cache **antes**
  de cair no `getMessage` que a aplicação fornece. Ou seja: o `getMessage`
  customizado deste projeto (cache de 100 mensagens, sem TTL, por sessão)
  não é mais "praticamente obrigatório" do jeito que a rodada anterior
  descreveu — isso era verdade em versões/docs mais antigas do baileys, mas
  na 7.0.0-rc14 ele só entra em ação pra um retry que chegue depois da
  janela de 5 minutos/512 mensagens do cache interno da própria lib. Não é
  incorreto manter (é uma rede de segurança adicional, sem custo real), só
  não tem mais o peso de "sem isso, mensagem trava" que a doc mais antiga
  sugeria — deixei um comentário no código explicando isso.
- `postgresAuthState.js` é, linha a linha, a mesma lógica de
  `useMultiFileAuthState` (lib/Utils/use-multi-file-auth-state.js do
  próprio pacote): mesmo formato de chave (`creds` / `<tipo>-<id>`), mesmo
  tratamento especial de `app-state-sync-key` via
  `proto.Message.AppStateSyncKeyData.fromObject`, mesmo uso de
  `BufferJSON`/`initAuthCreds`. Confirma que o auth state customizado está
  correto pra essa versão do baileys, não só "parecido com a doc".
- `fetchLatestBaileysVersion()`, `makeCacheableSignalKeyStore`,
  `Browsers.ubuntu(...)` e todos os outros imports nomeados de `'baileys'`
  usados no projeto existem e resolvem normalmente no pacote instalado —
  nada ficou órfão de uma renomeação de API entre versões.
- **Default que vale a pena conhecer**: `syncFullHistory: true` é o default
  do `makeWASocket` (`DEFAULT_CONNECTION_CONFIG` em `Defaults/index.js`).
  Essa bridge não lê chat nem histórico — só dispara mensagem — então
  baixar e decriptar o histórico completo de conversas a cada pareamento
  novo (o que esse default faz) é tempo e banda gastos à toa, sem nenhum
  consumidor pro resultado. Corrigido: `syncFullHistory: false` explícito
  no socket.

### Bugs/race conditions novos, encontrados e corrigidos nesta rodada

- **Timer de reconexão órfão podia criar dois sockets vivos pra mesma
  sessão.** O `setTimeout` de reconexão automática (`RECONNECT_DELAY_MS`)
  nunca era cancelado. Sequência que reproduz o problema: a conexão cai →
  agenda reconexão em 30s → antes desse prazo, alguém chama `/connect`
  manualmente (ou o fluxo de `restartRequired` reconecta na hora) e a
  sessão volta a ficar `connected` → o timer de 30s, que ninguém cancelou,
  dispara mesmo assim e cria **mais um** socket do baileys por cima do que
  já estava funcionando — dois sockets vivos ao mesmo tempo com a mesma
  credencial. Na prática isso tende a fazer o WhatsApp derrubar um dos dois
  com `connectionReplaced` (440), e como esse motivo cai no caminho
  genérico de retry, pode virar um ciclo de reconexão desnecessário.
  Corrigido guardando o handle do `setTimeout` por sessão
  (`reconnectTimers`) e cancelando-o em todo ponto que inicia uma sessão de
  novo (início de `startSession`) ou que a encerra de propósito
  (`/disconnect`, `DELETE`, `logged_out`, desistência após
  `RECONNECT_MAX_ATTEMPTS`).
- **Reiniciar o processo religava sessões que tinham sido desconectadas de
  propósito via `/disconnect`.** `restorePersistedSessions()` reconectava
  toda sessão com status diferente de `logged_out` — incluindo
  `disconnected`. Isso quebra a garantia documentada de que "`/disconnect`
  nunca aciona reconexão automática sozinha": bastava um redeploy, crash ou
  reagendamento pelo orquestrador pra religar sozinho uma sessão que o
  operador tinha desligado de propósito. Corrigido excluindo `disconnected`
  também do filtro de restauração no boot. (Também corrigido, no mesmo
  espírito: pedir `/disconnect` para uma sessão que já estava na janela de
  espera de `reconnecting` não cancelava o timer pendente — o socket antigo
  já estava fechado, então chamar `.end()` nele de novo era um no-op que não
  disparava o `connection.update` que cancelaria a reconexão. Agora
  `/disconnect` cancela o timer diretamente, sem depender desse evento.)
- **`fetchLatestBaileysVersion()` rodava em todo `/connect`, toda
  reconexão automática e uma vez por sessão restaurada no boot** — uma
  chamada HTTP ao GitHub repetida sem necessidade (a versão não muda em
  runtime) e sem timeout algum (a função não aceita `AbortSignal`; se a
  chamada travar sem nunca resolver — plausível num deploy com egress
  restrito a só os domínios do WhatsApp — `startSession()` travava
  indefinidamente junto). Corrigido: a versão é resolvida uma única vez no
  boot, com um timeout próprio de 8s (`Promise.race`), e reaproveitada em
  toda chamada de `startSession()`; se o timeout estourar, segue com a
  versão embutida no pacote instalado.

- **`.gitignore` não excluía `.env`** — só o `.dockerignore` excluía (o que
  protege o build da imagem, mas não protege o repositório git). Um
  `git add -A`/`git add .` descuidado neste projeto commitava a
  `API_KEY`/`POSTGRES_PASSWORD`/`DATABASE_URL` reais direto no histórico.
  Corrigido: `.env`, `.env.*` (com exceção do `.env.example`) adicionados ao
  `.gitignore`, espelhando o que o `.dockerignore` já fazia.

### Teste real — rodada 3 (listas, botões e cabeçalhos)

Rodado contra os servidores reais do WhatsApp, com um número real pareado
via QR code e confirmação visual no aparelho de destino:

- Pareamento via QR, `restartRequired` pós-QR e restauração da sessão a
  partir do Postgres depois de reiniciar o processo (sem novo QR).
- `/messages`: texto, imagem e documento — todos `server_ack` e recebidos.
- `/message/sendList`: lista com 5 seções e 9 linhas, rodapé e
  `number` no formato `...@s.whatsapp.net` — recebida e renderizada.
- `/message/sendButtons`: reply (3 botões + `delay`), url + copy, PIX,
  cabeçalho com imagem (URL e base64), cabeçalho em texto, com e sem corpo,
  com e sem botões, e só corpo — todos recebidos e renderizados.

Achados desta rodada:

- **Atrás de proxy HTTP(S) a bridge não conecta.** O `ws` usado pelo baileys
  abre o TLS direto e ignora `HTTPS_PROXY`/`NODE_USE_ENV_PROXY`; neste
  ambiente o teste só funcionou injetando um agente de proxy num script de
  pré-carga (fora do projeto). Se a produção sair pra internet por proxy,
  isso precisa virar uma opção (`agent` do `makeWASocket`).
- **O libsignal (dependência do baileys) escreve chaves de sessão no
  console** ao fechar/renegociar uma sessão Signal (`Closing session:
  SessionEntry { ... privKey: <Buffer ...> }`). Não vem do nosso código, mas
  vale não reter esse stdout em produção (ou filtrá-lo).

### Ainda não verificado (limitação deste ambiente, não deste código)

- Um cenário real de retry (pra validar o `getMessage` customizado e o
  cache interno do baileys 7 na prática, não só lendo o código-fonte).
- Renderização de listas/botões em cada cliente separadamente (Android, iOS,
  WhatsApp Web/Desktop) — o teste real confirmou o recebimento no aparelho de
  destino, sem uma matriz por plataforma.
- `docker compose up --build` de ponta a ponta (bloqueado pela política de
  rede deste ambiente pro registry do Docker Hub, não pelo projeto).
