# WhatsApp Bridge

Uma ponte HTTP pequena, de propósito, entre a sua aplicação e o WhatsApp.
Conecta vários números (cada um é uma **sessão**), dispara mensagens, e entrega
tudo o que chega para **webhooks** no formato da Evolution API — com as
credenciais, o histórico e a fila de entregas guardados no **Postgres**.

Construída sobre o [Baileys](https://github.com/WhiskeySockets/Baileys)
(`baileys@7.0.0-rc14`), em Node.js 22 + Express 5.

> A lógica de negócio fica na sua aplicação. A bridge só conecta, envia,
> recebe e avisa.

## Sumário

- [Por que esta bridge existe](#por-que-esta-bridge-existe)
- [O que ela faz (e o que não faz)](#o-que-ela-faz-e-o-que-não-faz)
- [Como funciona](#como-funciona)
- [Início rápido](#início-rápido)
- [Instalação e deploy](#instalação-e-deploy)
- [Configuração](#configuração)
- [Autenticação](#autenticação)
- [Formato do número](#formato-do-número)
- [Referência da API](#referência-da-api)
- [Enviando mensagens](#enviando-mensagens)
- [Mensagens recebidas](#mensagens-recebidas)
- [Webhooks](#webhooks)
- [Tela de configuração (`/manager`)](#tela-de-configuração-manager)
- [Ciclo de vida da sessão e diagnóstico de quedas](#ciclo-de-vida-da-sessão-e-diagnóstico-de-quedas)
- [Decisões de design e limitações](#decisões-de-design-e-limitações)
- [Desenvolvimento e testes](#desenvolvimento-e-testes)
- [Avisos importantes](#avisos-importantes)
- [Mais documentação](#mais-documentação)

---

## Por que esta bridge existe

Este projeto **nasceu de dificuldades com outra implementação do Baileys**: a
[Evolution API](https://github.com/EvolutionAPI/evolution-api), que é um
produto completo de WhatsApp construído sobre a mesma biblioteca. Operando a
Evolution em produção, esbarramos em problemas que não conseguíamos resolver do
nosso lado:

- **Listas e botões que somem sem erro.** O WhatsApp só exibe lista e botão se
  a stanza levar um nó `<biz>`, e na série 2.3.x da Evolution a mensagem era
  descartada sem nenhum erro, então o destinatário nunca via nada.
- **Avisos perdidos num restart.** A retentativa de webhook da Evolution vive
  em memória: reiniciar o processo perde o que estava pendente. E a janela é
  curta (10 tentativas, cerca de 20 minutos).
- **Um webhook por instância**, quando mais de um sistema pode precisar ouvir o
  mesmo número.
- **Risco de eco e loop com o Chatwoot**, se a resposta enviada pela API
  voltar como mensagem nova.
- **Detalhes de payload que atrapalham quem consome.** Campos binários saem
  como objeto indexado (`{"0":12,"1":34,...}`) e a `apikey` global aparece no
  envelope enviado a terceiros.

Em vez de continuar contornando isso dentro de um produto grande, decidimos
escrever uma bridge **pequena, que dá para ler inteira**, com as decisões
feitas do jeito que a nossa operação precisa:

| Problema na prática | Como esta bridge trata |
|---|---|
| Aviso perdido num restart | Fila de entregas **no Postgres** (outbox), gravada na mesma transação da mensagem. Backoff exponencial, ~45 min de janela. |
| Só um webhook por instância | **Até 10 webhooks por instância**, cada um com URL, eventos e cabeçalhos próprios. |
| Eco da própria API | Toda mensagem enviada pela API é marcada `origin = 'api'` e **nunca** vira `messages.upsert` (só `send.message`). |
| Lista/botão descartados | Montados com o nó `<biz>` via `relayMessage`, mesmo payload da Evolution, e a resposta traz o **status real** da entrega. |
| Binários como objeto indexado | Binários saem como **string base64**. |
| `apikey` no envelope | Sempre `null`: a bridge nunca envia a API key a terceiros. |
| Queda sem explicação | Cada abertura, queda e logout é gravado com o **motivo** em `wa_connection_events`, consultável por API. |

**Compatibilidade de propósito:** os webhooks e os endpoints de lista/botões
usam o mesmo formato da Evolution API 2.4.0-rc2. Quem já consome a Evolution
troca a URL e o header de autenticação, e o resto continua funcionando. As
diferenças (poucas e intencionais) estão em
[Diferenças em relação à Evolution](#diferenças-em-relação-à-evolution).

---

## O que ela faz (e o que não faz)

**Faz**

- Várias sessões (números) ao mesmo tempo; pareamento por QR code.
- Credenciais do WhatsApp **no Postgres**, não em arquivo: roda em container
  efêmero e restaura as sessões sozinha quando o processo reinicia.
- Envia texto, imagem, vídeo, documento e áudio (inclusive mensagem de voz), a
  número ou grupo, com resposta/citação de mensagem.
- Envia listas e botões (reply, url, call, copy, PIX).
- Confirma o **status real** da entrega na própria resposta HTTP.
- Recebe mensagens, reações, edições, exclusões, status e eventos de conexão e
  os repassa a webhooks, com mídia embutida em base64 se você quiser.
- Guarda o histórico de mensagens e o consulta por API.
- Reconecta sozinha após queda, com watchdog para handshake travado.
- Tem uma tela de configuração em `/manager`.

**Não faz** (de propósito)

- Não tem regra de negócio, fila de campanhas, CRM ou chatbot.
- Não importa o histórico antigo do aparelho: só o que chega depois que a
  instância conecta (`syncFullHistory: false`).
- Não converte formatos de mídia (não há ffmpeg na imagem).
- Não tem fila de envio: cada disparo é síncrono.
- Não distingue consumidores: a API key é única e global.

---

## Como funciona

```
 Sua aplicação ── HTTP + x-api-key ──▶ ┌────────────────────┐ ──▶ WhatsApp
                                       │  Bridge (Express)  │      (via Baileys)
 Seu receptor  ◀── webhooks (outbox) ─ │  sessões em memória│ ◀──
                                       └─────────┬──────────┘
                                                 │
                                          ┌──────▼───────┐
                                          │   Postgres   │
                                          │ credenciais, │
                                          │ mensagens,   │
                                          │ fila, quedas │
                                          └──────────────┘
```

Cada sessão é identificada pelo próprio número. O processo mantém o socket do
Baileys de cada sessão viva; tudo o que precisa sobreviver (credenciais,
mensagens, webhooks, entregas pendentes, eventos de conexão) está no Postgres.

### Tabelas

Criadas sozinhas toda vez que o servidor sobe (`schema.sql`, só com
`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, seguro sobre banco
existente).

| Tabela | Conteúdo |
|---|---|
| `wa_sessions` | Uma linha por número: status, JID, nome de perfil, `groups_ignore`. |
| `wa_auth_state` | Credenciais e chaves de sinal do Baileys, uma linha por chave. |
| `wa_messages` | Mensagens recebidas e enviadas, já no formato `data` da Evolution. |
| `wa_groups` | JID do grupo → nome (cache do `groupSubject`). |
| `wa_webhooks` | Webhooks cadastrados por instância. |
| `wa_webhook_deliveries` | Fila (outbox) e histórico de entregas de webhook. |
| `wa_connection_events` | Aberturas, quedas e logouts, com o motivo. |

### Mapa do código

| Arquivo | Papel |
|---|---|
| `server.js` | HTTP, ciclo de vida das sessões, reconexão, watchdog. |
| `postgresAuthState.js` | Auth state do Baileys em Postgres (mesma lógica do `useMultiFileAuthState`). |
| `outbound.js` | Validação e envio de `POST /sessions/:id/messages`. |
| `interactive.js` | Listas e botões (proto + nó `<biz>`). |
| `inbound.js`, `lid.js` | Normalização das mensagens recebidas e troca LID → número. |
| `messageStore.js` | Persistência de `wa_messages` e criação das entregas, na mesma transação. |
| `webhooks.js`, `webhookRoutes.js`, `webhookDispatcher.js` | Cadastro de webhooks, rotas e worker do outbox. |
| `media.js` | Download sob demanda de mídia do CDN do WhatsApp. |
| `groupMetadata.js` | Nome dos grupos em três camadas (memória, `wa_groups`, WhatsApp). |
| `connectionEvents.js`, `sessionLogout.js` | Diagnóstico de quedas e `/logout`. |
| `secrets.js` | Cifra AES-256-GCM dos cabeçalhos dos webhooks. |
| `db.js`, `schema.sql` | Pool do Postgres e esquema. |
| `manager/` | Tela de configuração (React + shadcn/ui). |

---

## Início rápido

Com Docker, em três passos:

```bash
cp .env.example .env     # defina API_KEY e POSTGRES_PASSWORD
docker compose up -d --build
```

```bash
KEY="troque-por-uma-chave-forte"   # a mesma API_KEY do .env

# 1. inicia o pareamento do número
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/connect

# 2. pega o QR e escaneia no celular (Aparelhos conectados → Conectar aparelho)
curl -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/qr

# 3. dispara uma mensagem
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/sessions/5511999999999/messages \
  -d '{"to": "5511988887777", "message": "Olá!"}'
# {"ok":true,"id":"3EB0...","status":"server_ack"}
```

Para receber mensagens, cadastre um webhook (ver [Webhooks](#webhooks)):

```bash
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/sessions/5511999999999/webhooks \
  -d '{"url": "https://seu-receptor.example/webhooks/wsb", "events": ["MESSAGES_UPSERT"]}'
```

Ou use a tela em `http://localhost:3000/manager`. Há também uma coleção
do Postman na raiz: `Baileys-Bridge.postman_collection.json`.

---

## Instalação e deploy

### Local (sem Docker)

Requer Node.js 22 e um Postgres.

```bash
createdb whatsapp_bridge
cp .env.example .env     # ajuste DATABASE_URL e API_KEY
npm install
node server.js
```

### Docker Compose

```bash
cp .env.example .env   # ajuste API_KEY e POSTGRES_PASSWORD
docker compose up -d --build
```

Sobe dois containers: `postgres` (volume nomeado `pgdata`, então os dados
sobrevivem a `docker compose down`) e `bridge` (build do `Dockerfile` local, só
sobe depois do healthcheck do Postgres). A bridge fica em
`http://localhost:3000` (ou na `PORT` do `.env`).

### Só a imagem (Postgres próprio, outro orquestrador)

```bash
docker build -t whatsapp-bridge .
docker run -p 3000:3000 \
  -e DATABASE_URL=postgres://user:pass@host:5432/whatsapp_bridge \
  -e API_KEY=troque-por-uma-chave-forte \
  whatsapp-bridge
```

### Docker Swarm + Traefik

`docker-compose.swarm.yml` é um exemplo de stack para Swarm atrás do Traefik,
usando a imagem publicada `justbrunasso/whatsapp-bridge` (tags `latest` e o
SHA curto do commit). Ajuste a regra `Host(...)` do router, defina
`POSTGRES_PASSWORD` e `API_KEY` e crie o volume externo
`whatsapp_bridge_postgres_data` e a rede `network_public`. Atrás de proxy, o IP
do cliente chega em `x-forwarded-for` / `x-real-ip`.

### Sobre a imagem

- Base `node:22-slim` (glibc, não alpine): o Baileys puxa o `sharp` como
  dependência transitiva, e o binário pré-compilado é mais previsível em glibc.
  Não precisa de toolchain de build (nem Python, nem gcc).
- A versão da base é fixa (versão exata do Node + digest, no `ARG NODE_IMAGE`),
  para dois builds do mesmo commit saírem iguais. Atualizar é intencional: o
  `Dockerfile` traz os comandos.
- Build multi-stage: o primeiro estágio builda a tela `/manager`; a final leva
  só os `.js`, o `schema.sql`, as dependências de produção e os estáticos.
- Roda como usuário não-root e não escreve nada em disco (todo o estado vive
  no Postgres), então não precisa de volume. Tem `HEALTHCHECK` em `/health`.

---

## Configuração

Copie `.env.example` para `.env`. Só `API_KEY` é obrigatória (o servidor não
sobe sem ela); todo o resto tem default.

### Essenciais

| Variável | Default | O que faz |
|---|---|---|
| `API_KEY` | — | Chave global enviada em `x-api-key`. Gere com `openssl rand -hex 32`. |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/whatsapp_bridge` | Conexão com o Postgres. |
| `DATABASE_SSL` | — | `true` liga SSL no Postgres (exigido por muitos provedores gerenciados; usa `rejectUnauthorized: false`). |
| `PORT` | `3000` | Porta HTTP. |
| `POSTGRES_PASSWORD` | — | Só do `docker-compose`: cria o banco e monta o `DATABASE_URL` da bridge. |
| `SERVER_URL` | vazio | URL pública da bridge; vai no campo `server_url` dos webhooks (vazio = `null`). |
| `JSON_BODY_LIMIT` | `20mb` | Limite do body nas rotas de mídia (`/messages`, `/message/sendButtons`); as demais aceitam até 256kb. |
| `MEDIA_UPLOAD_CONCURRENCY` | `5` | Envios com corpo grande (mídia em base64) processados ao mesmo tempo nessas rotas. Corpo até 256kb (texto) não conta. |
| `MEDIA_UPLOAD_QUEUE_TIMEOUT_MS` | `30000` | Espera máxima na fila por uma vaga de envio; depois disso, `503` com `Retry-After` (o corpo nem é lido). |

### Conexão e envio

| Variável | Default | O que faz |
|---|---|---|
| `RECONNECT_MAX_ATTEMPTS` | `5` | Tentativas de reconexão automática após queda. |
| `RECONNECT_DELAY_MS` | `30000` | Espera fixa entre tentativas. |
| `CONNECTING_TIMEOUT_MS` | `45000` | Watchdog: força `/disconnect` se travar em `connecting` (`0` desativa). |
| `MESSAGE_STATUS_TIMEOUT_MS` | `8000` | Quanto `/messages` espera pela confirmação real de entrega (`0` desativa). |
| `BAILEYS_LOG_LEVEL` | `warn` | Logs internos do Baileys (pino JSON): `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. |
| `CONNECTION_EVENTS_RETENTION_DAYS` | `30` | Dias de histórico em `wa_connection_events`. |
| `NODE_MAX_OLD_SPACE_MB` | `1536` | Só do compose: vira `--max-old-space-size` (teto do heap do Node). Use ~75% do limite do container. |
| `MEMORY_LOG_INTERVAL_MS` | `60000` | Intervalo da linha `memória: ...` no log (`0` desativa). |
| `MEMORY_WARN_RATIO` | `0.7` | Fração do limite do heap do V8 **ou** da memória do container (RSS) a partir da qual a linha vira ALERTA com os suspeitos. |
| `MEMORY_ALERT_INTERVAL_MS` | `10000` | Intervalo das leituras enquanto em ALERTA (mínimo `1000`). |

`RECONNECT_MAX_ATTEMPTS` e `RECONNECT_DELAY_MS` são validados no boot: valor
inválido faz o servidor recusar subir (em vez de desativar o limite sem aviso).

### Webhooks

| Variável | Default | O que faz |
|---|---|---|
| `WEBHOOK_TIMEOUT_MS` | `10000` | Timeout de cada POST. |
| `WEBHOOK_CONCURRENCY` | `10` | POSTs simultâneos no total. |
| `WEBHOOK_CONCURRENCY_PER_WEBHOOK` | `2` | Teto por webhook: um receptor lento não segura as vagas dos outros. |
| `WEBHOOK_POLL_INTERVAL_MS` | `1000` | Polling de segurança da fila. |
| `WEBHOOK_RETRY_MAX_ATTEMPTS` | `15` | Tentativas antes de `failed` (~45 min com os defaults). |
| `WEBHOOK_RETRY_INITIAL_DELAY_MS` | `5000` | Primeiro atraso do backoff exponencial. |
| `WEBHOOK_RETRY_MAX_DELAY_MS` | `300000` | Teto do backoff (5 min). |
| `WEBHOOK_MEDIA_MAX_BYTES` | `20971520` | Acima disso (20MB) a mídia não é embutida (`base64Error: "too_large"`). |
| `WEBHOOK_MEDIA_TIMEOUT_MS` | `30000` | Timeout do download de mídia. |
| `WEBHOOK_MEDIA_CACHE_MAX_BYTES` | `104857600` | Teto do cache de mídia em memória (100MB). |
| `WEBHOOK_MEDIA_CONCURRENCY` | `3` | Entregas com mídia montando/enviando ao mesmo tempo (download, base64, JSON e POST, ~5x o arquivo cada). As outras esperam; entregas sem mídia não entram nessa fila. |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | `7` | Dias de histórico de entregas concluídas. |
| `WEBHOOK_HEADERS_KEY` | vazio | Chave da cifra dos cabeçalhos no banco (vazio = derivada da `API_KEY`). Ver [Segurança](#segurança). |

### Histórico e grupos

| Variável | Default | O que faz |
|---|---|---|
| `MESSAGE_RETENTION_DAYS` | `0` | Apaga mensagens de `wa_messages` com mais de N dias (`0` = guarda para sempre). |
| `GROUP_METADATA_TTL_MS` | `21600000` | Quanto o nome do grupo fica em memória antes de reler `wa_groups` (6h). |
| `GROUP_METADATA_FAILURE_TTL_MS` | `300000` | Grupo cuja consulta falhou não é consultado de novo por 5 min. |
| `GROUP_METADATA_TIMEOUT_MS` | `3000` | Espera máxima da consulta do nome ao WhatsApp (depois, `groupSubject: null`). |
| `GROUP_METADATA_HISTORY_MAX_LOOKUPS` | `10` | Consultas ao WhatsApp por requisição do histórico. |
| `GROUP_METADATA_HISTORY_BUDGET_MS` | `5000` | Tempo total que o histórico espera pelos nomes dos grupos. |

---

## Autenticação

Toda rota sob `/sessions` exige a API key global no header `x-api-key`. Sem ela
(ou errada), a resposta é `401`. A comparação é feita com
`crypto.timingSafeEqual`.

`GET /health` fica fora da autenticação, para load balancer e orquestrador
checarem o processo sem a chave.

A chave é única para todos os endpoints, pensada para a sua aplicação
principal, não para múltiplos clientes com permissões diferentes.

---

## Formato do número

**Só dígitos, com DDI, sem `+`, espaço, parênteses ou traço.**

```
5511999999999
│└┤└─────────┴─ número
│ └─ DDD
└─ DDI (Brasil = 55)
```

A API normaliza o que vier com máscara (`(11) 99999-9999` vira `11999999999`),
mas o ID da sessão precisa ter de 8 a 15 dígitos depois de normalizado, senão a
resposta é `400`.

Destinatário (`to`) em `POST /sessions/:id/messages` também aceita:

- JID de grupo de que o número participa: `120363000000000001@g.us` (ou o
  formato antigo `5511999999999-1600000000@g.us`);
- JID de usuário: `5511999999999@s.whatsapp.net` (resolvido como os dígitos) ou
  `123456789012345@lid` (enviado direto ao LID). O sufixo de dispositivo (`:N`)
  é descartado.

Outros JIDs (`@newsletter`, `@broadcast` etc.) são recusados com `400`.

Em `/message/sendList` e `/message/sendButtons`, `number` aceita dígitos ou
`...@s.whatsapp.net`, como na Evolution. Grupos e `@lid` não são suportados.

---

## Referência da API

Todas as rotas, exceto `/health`, exigem `x-api-key`. Os contratos completos,
com exemplos de resposta e erros, estão em
[`docs/contracts/rest-api.md`](docs/contracts/rest-api.md).

| Método | Rota | O que faz |
|---|---|---|
| GET | `/health` | Liveness check, sem autenticação. |
| POST | `/sessions/:id/connect` | Conecta/reconecta o número. Cria a sessão se não existir. |
| GET | `/sessions/:id/qr` | QR code (base64 PNG) para parear, ou o status atual se já conectado. |
| GET | `/sessions` | Lista as sessões (persistidas no banco) e seus status. |
| POST | `/sessions/:id/disconnect` | Pausa: fecha a conexão e **mantém** as credenciais (reconecta sem novo QR). |
| POST | `/sessions/:id/logout` | Desvincula o aparelho e apaga as credenciais, mas **mantém** a sessão, os webhooks e o histórico. O próximo `/connect` gera QR novo. |
| DELETE | `/sessions/:id` | Exclui a sessão: logout e apaga credenciais, webhooks, histórico e entregas (cascade). |
| GET | `/sessions/:id/connection-events?limit=100` | Histórico de aberturas/quedas/logouts com o motivo. |
| POST | `/sessions/:id/messages` | Envia texto, imagem, vídeo, documento ou áudio, a número ou grupo. |
| POST | `/sessions/:id/message/sendList` | Lista de opções (payload da Evolution). |
| POST | `/sessions/:id/message/sendButtons` | Botões (payload da Evolution). |
| GET | `/sessions/:id/messages` | Histórico de mensagens gravadas. |
| GET | `/sessions/:id/settings` | Configurações da instância (`groupsIgnore`). |
| PATCH | `/sessions/:id/settings` | Altera "ignorar grupos": `{ "groupsIgnore": false }`. |
| GET | `/sessions/:id/webhooks` | Lista os webhooks (cabeçalhos mascarados, última entrega). |
| POST | `/sessions/:id/webhooks` | Cadastra webhook (até 10 por instância). |
| PUT | `/sessions/:id/webhooks/:webhookId` | Substitui a configuração do webhook. |
| DELETE | `/sessions/:id/webhooks/:webhookId` | Remove o webhook e as entregas pendentes dele. |
| POST | `/sessions/:id/webhooks/:webhookId/test` | Envia um `webhook.test` na hora e devolve o resultado. |
| GET | `/sessions/:id/webhooks/:webhookId/deliveries` | Histórico de entregas (`?status=&limit=&before=`). |
| POST | `/sessions/:id/chat/getBase64FromMediaMessage` | Baixa a mídia de uma mensagem recebida (compatível com a Evolution). |
| GET | `/manager` | Tela de configuração (estáticos públicos; dados só com API key). |

Erros seguem o formato `{ "error": "<mensagem>" }`.

---

## Enviando mensagens

### Texto, imagem, vídeo, documento e áudio

`POST /sessions/:id/messages` seleciona o formato pelo campo `type` (default
`"text"`):

```jsonc
// texto (default, "type" pode ser omitido)
{ "to": "5511988887777", "message": "Olá!" }

// imagem
{
  "to": "5511988887777",
  "type": "image",
  "mediaBase64": "<base64, com ou sem prefixo data:image/...;base64,>",
  "mimetype": "image/png",   // opcional: o Baileys detecta se omitido
  "caption": "legenda opcional"
}

// vídeo
{
  "to": "5511988887777",
  "type": "video",
  "mediaBase64": "<base64, com ou sem prefixo data:video/...;base64,>",
  "mimetype": "video/mp4",   // obrigatório
  "caption": "legenda opcional"
}

// documento
{
  "to": "5511988887777",
  "type": "document",
  "mediaBase64": "<base64>",
  "mimetype": "application/pdf",   // obrigatório
  "fileName": "nota-fiscal.pdf",   // opcional, default "arquivo"
  "caption": "legenda opcional"
}

// áudio
{
  "to": "5511988887777",
  "type": "audio",
  "mediaBase64": "<base64, com ou sem prefixo data:audio/...;base64,>",
  "mimetype": "audio/ogg; codecs=opus",   // obrigatório
  "ptt": true   // opcional, default false: true = mensagem de voz, false = arquivo de áudio
}
```

Para a mensagem de voz (`ptt: true`) tocar como gravada no aparelho, mande
OGG/Opus com `"mimetype": "audio/ogg; codecs=opus"`: a bridge não converte
formatos. Só o booleano `true` liga o `ptt`.

**Mídia só entra embutida no request** (`mediaBase64`). De propósito não existe
`mediaUrl`: a bridge buscar URLs arbitrárias abriria SSRF para qualquer cliente
com a API key. (Exceção consciente: o `thumbnailUrl` do `sendButtons`, por
compatibilidade com a Evolution.)

### Status real da entrega

`sock.sendMessage()` do Baileys resolve quando a mensagem é repassada ao
servidor do WhatsApp, o que sozinho não garante que ela chegou. A rota espera
até `MESSAGE_STATUS_TIMEOUT_MS` por uma confirmação via `messages.update`:

```jsonc
// confirmado pelo WhatsApp dentro do timeout
{ "ok": true, "id": "3EB0...", "status": "server_ack" } // ou "delivery_ack" / "read" / "played"

// o WhatsApp recusou/falhou a entrega (HTTP 502)
{ "ok": false, "id": "3EB0...", "status": "error", "error": "..." }

// estourou o timeout sem confirmação: NÃO é falha, só não deu tempo de saber
{ "ok": true, "id": "3EB0...", "status": "unknown" }
```

O `to` individual é validado no próprio WhatsApp via `sock.onWhatsApp()`
antes do envio. Números brasileiros têm o "9" adicional ambíguo, e montar o JID
direto dos dígitos podia dar um `ok: true` para um JID inexistente. Número não
registrado responde `404`.

### Respondendo (citando) uma mensagem

Qualquer formato aceita `quotedMessageId`, o `key.id` da mensagem a citar (o
mesmo do webhook):

```json
{ "to": "5511988887777", "message": "Recebido!", "quotedMessageId": "3EB0A1B2C3D4E5F60718" }
```

A mensagem citada precisa estar gravada nesta sessão (`wa_messages`). Se não
for encontrada (apagada pela retenção ou anterior à bridge), o envio sai **sem
citação**, em vez de falhar. `quotedMessageId` precisa ser uma string de 1 a
128 caracteres (`A-Z a-z 0-9 . _ : -`), senão `400`.

### Enviando para um grupo

Troque o `to` pelo JID do grupo:

```json
{ "to": "120363000000000001@g.us", "type": "text", "message": "Bom dia, grupo" }
```

Antes de enviar, a bridge confere via `groupMetadata` que o número participa
do grupo. Se a consulta falhar ou o número não estiver entre os participantes:
`404 { "error": "grupo não encontrado ou o número não participa" }`.
`sendList` e `sendButtons` continuam só para contato individual.

### Listas e botões (payload da Evolution)

`POST /sessions/:id/message/sendList` e `POST /sessions/:id/message/sendButtons`
aceitam **o mesmo corpo** dos endpoints da Evolution API 2.4.0 e montam a
mensagem do mesmo jeito. Muda só a URL (a sessão vai em `:id`), o header de
auth (`x-api-key`) e a resposta, que é a mesma de `/messages`
(`{ ok, id, status }`), não o 201 com a mensagem completa.

`delay` (ms, opcional) mostra "digitando..." antes de enviar. `quoted`,
`mentioned`, `mentionsEveryOne` e `linkPreview` são aceitos e ignorados (a
própria Evolution não os aplica nesse caminho).

```jsonc
// lista
{
  "number": "5511988887777",
  "title": "📊 CONSULTAR DÉBITOS",
  "description": "💰 *Vencidos:* R$ 116.31",      // opcional
  "footerText": "Selecione a opção abaixo",         // obrigatório (pode ser "")
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

// botões de resposta (até 3)
{
  "number": "5511988887777",
  "title": "Confirma o pedido?",          // vai em negrito no corpo
  "description": "Pedido 123",            // opcional
  "footer": "Loja X",                     // opcional
  "thumbnailUrl": "https://...",          // imagem do cabeçalho, opcional (URL ou base64)
  "buttons": [
    { "type": "reply", "displayText": "Sim", "id": "sim" },
    { "type": "reply", "displayText": "Não", "id": "nao" }
  ]
}

// cabeçalho em texto + corpo + rodapé, sem botões
{ "number": "5511988887777", "headerText": "Pedido 123", "description": "Seu pedido saiu para entrega.", "footer": "Loja X" }

// botões de ação (até 2, podem ser misturados entre si)
{ "type": "url",  "displayText": "Abrir site", "url": "https://exemplo.com" }
{ "type": "call", "displayText": "Ligar",      "phoneNumber": "+5511988887777" }
{ "type": "copy", "displayText": "Copiar código", "copyCode": "ABC123" }

// PIX (sozinho; recusa headerText/thumbnailUrl/footer)
{ "number": "5511988887777",
  "buttons": [{ "type": "pix", "currency": "BRL", "name": "Loja X", "keyType": "cpf", "key": "12345678900" }] }
// keyType: "phone" | "email" | "cpf" | "cnpj" | "random"
```

**Partes do `sendButtons`** (todas opcionais, mas é preciso ao menos cabeçalho,
corpo ou botões):

| Parte | Campo(s) | Observação |
|---|---|---|
| Cabeçalho | `headerText` (texto) **ou** `thumbnailUrl` (imagem) | Um tipo só; os dois juntos → `400`. `headerText` é extensão desta bridge (não existe na Evolution). |
| Corpo | `title`, `description` | `*title*` em negrito, `description` abaixo. Qualquer um pode faltar. |
| Rodapé | `footer` | |
| Botões | `buttons` | Pode ser omitido ou `[]`. |

**Regras validadas**

- Lista: `title`, `footerText`, `buttonText` e `sections` obrigatórios; cada
  seção precisa de `title` e ao menos uma linha; cada linha precisa de `title`
  e `rowId`; seções/linhas idênticas repetidas são recusadas.
- `reply`: até 3, sem misturar com outros tipos. `id` é gerado se omitido.
- `url`/`call`/`copy`: até 2; exigem `displayText` e o campo do tipo.
- `pix`: um só, sozinho; exige `name`, `key` e `keyType`.
- Limites do WhatsApp (ex.: ~10 linhas por lista, tamanho de títulos) **não**
  são validados, igual à Evolution.

**Atenção ao `thumbnailUrl` com URL:** a imagem é baixada pelo servidor da
bridge, o que permite SSRF (a bridge buscaria URL da rede interna). Foi mantido
por compatibilidade; se a bridge for exposta a clientes não confiáveis, prefira
base64.

**Por que é frágil:** o WhatsApp só exibe lista/botão se a stanza levar um nó
`<biz>`, que o `sock.sendMessage()` não envia. A bridge monta o proto
(`listMessage` / `interactiveMessage` + `nativeFlowMessage`) e envia com
`sock.relayMessage(..., { additionalNodes: [<biz>] })` (ver `interactive.js`).
É engenharia reversa: se o WhatsApp mudar o formato, a mensagem pode voltar a
ser descartada sem erro. O `status` da resposta ajuda a perceber isso. A opção
escolhida pelo usuário chega como mensagem recebida (`listResponseMessage`,
`buttonsResponseMessage`, `templateButtonReplyMessage` ou
`interactiveResponseMessage`).

### Mais exemplos

```bash
# mensagem de voz (OGG/Opus em base64 no arquivo voz.b64)
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/sessions/5511999999999/messages \
  -d "{\"to\": \"5511988887777\", \"type\": \"audio\", \"mediaBase64\": \"$(cat voz.b64)\", \"mimetype\": \"audio/ogg; codecs=opus\", \"ptt\": true}"

# lista de opções
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/sessions/5511999999999/message/sendList \
  -d '{"number": "5511988887777", "title": "Menu", "footerText": "Escolha uma opção", "buttonText": "Ver opções", "sections": [{"title": "Opções", "rows": [{"title": "Falar com atendente", "rowId": "atendente"}]}]}'

# pausar sem perder a sessão (NÃO aciona reconexão automática)
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/disconnect

# logout: desvincula o aparelho, mantém sessão e webhooks (próximo /connect pede QR)
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/logout
# -> {"id":"5511999999999","status":"logged_out","remoteLogout":true}
#    remoteLogout=false: não havia socket conectado para avisar o WhatsApp; as
#    credenciais foram apagadas mesmo assim (o aparelho pode continuar listado
#    no celular até ser removido lá ou expirar)

# exclui a sessão de vez (logout + webhooks, histórico e entregas)
curl -X DELETE -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999
```

---

## Mensagens recebidas

Toda mensagem nova de uma instância conectada é normalizada no formato `data`
do webhook `messages.upsert` da **Evolution API 2.4.0-rc2** (`key`, `pushName`,
`status`, `message`, `contextInfo`, `messageType`, `messageTimestamp`,
`instanceId`, `source`) e gravada **uma única vez** em `wa_messages`. A
deduplicação é por `(sessão, key.id, fromMe)`: reentregas do WhatsApp depois de
uma reconexão não geram linha nem aviso repetido.

**Tipos cobertos:** texto (inclusive com link ou citação), imagem, áudio/voz,
vídeo, vídeo-nota (`ptvMessage`), documento, sticker, localização, contato(s),
reação (`text: ""` = removida), voto em enquete (cru), respostas de
lista/botão e mensagens temporárias/visualização única (desembrulhadas). Edição
e exclusão "para todos" atualizam a mensagem original (`status` `EDITED` /
`DELETED`) em vez de criar linha nova.

Formato completo e exemplos por tipo:
[`docs/contracts/webhook-payload.md`](docs/contracts/webhook-payload.md).

### Origem (`origin`)

| `origin` | O que é |
|---|---|
| `inbound` | Enviada por outra pessoa para a instância. |
| `device` | Enviada pelo próprio número, por outro aparelho (celular, Web). |
| `api` | Enviada por esta bridge (`/messages`, `/message/sendList`, `/message/sendButtons`). |

As rotas de envio geram o id da mensagem **antes** de enviar e o registram em
memória, então o eco que o Baileys devolve é reconhecido como `api`, mesmo
chegando antes da gravação da rota. É isso que impede uma resposta enviada pelo
Chatwoot (via API) de voltar como mensagem nova.

### LID (número oculto)

Quando o WhatsApp identifica o contato por `<id>@lid`, a bridge troca para o
número (`key.remoteJid` = número, `key.remoteJidAlt` = LID,
`addressingMode: "pn"`), usando o que vem na mensagem ou o mapeamento
LID→número do Baileys. Se o número for desconhecido, a mensagem segue com
`remoteJid: "...@lid"` e `addressingMode: "lid"`, e quem consome precisa
aceitar esse caso. Vale também para `key.participant` em grupo, para quem foi
citado (`contextInfo.participant` / `participantAlt`) e para quem foi mencionado
(`contextInfo.mentionedJid[]` / `mentionedJidAlt[]`).

### Grupos

- **Nome do grupo:** mensagens de grupo saem com `groupSubject`
  (`string | null`) no webhook e no histórico. O nome é resolvido na hora
  (memória → `wa_groups` → consulta ao WhatsApp) e nunca gravado em
  `wa_messages`, então o histórico mostra o nome **atual**. Consulta que falha
  ou demora vira `null` sem atrasar a entrega além de
  `GROUP_METADATA_TIMEOUT_MS`.
- **Ignorar grupos:** por instância, **ligado por padrão**. Ligado, mensagens
  de grupo não são gravadas nem repassadas. Vale na hora:

```bash
curl -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/settings
# {"groupsIgnore":true}

curl -X PATCH -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/sessions/5511999999999/settings -d '{"groupsIgnore": false}'
```

### Histórico

`GET /sessions/:id/messages?remoteJid=&limit=50&before=` devolve as mensagens
gravadas, da mais nova para a mais antiga:

```json
{ "items": [ { "...": "data + origin" } ], "nextBefore": 1234 }
```

`remoteJid` aceita só dígitos ou um JID; `limit` vai de 1 a 200; para a próxima
página passe o `nextBefore` em `before`. Itens de grupo trazem `groupSubject`,
com no máximo `GROUP_METADATA_HISTORY_MAX_LOOKUPS` consultas ao WhatsApp e
`GROUP_METADATA_HISTORY_BUDGET_MS` de espera por requisição (o que passar disso
sai `null` e a resposta continua `200`). O histórico não expira, a menos que
`MESSAGE_RETENTION_DAYS=N` apague, numa limpeza horária, as mensagens com mais
de N dias.

---

## Webhooks

Cada instância pode ter **até 10 webhooks**, cada um com sua URL, eventos e
cabeçalhos. A requisição é a do webhook da Evolution API 2.4.0-rc2: `POST` com
o envelope `{ event, instance, data, destination, date_time, sender,
server_url, apikey }` e os cabeçalhos `X-Instance-ID`, `X-Instance-Name`,
`X-Event-Type`, `X-Timestamp`, mais `X-Delivery-ID` (extra desta bridge) e
`User-Agent: WSB-Webhook/1.0`. Contrato completo:
[`docs/contracts/webhook-payload.md`](docs/contracts/webhook-payload.md).

```bash
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/sessions/5511999999999/webhooks \
  -d '{"url": "https://seu-receptor.example/webhooks/wsb", "events": ["MESSAGES_UPSERT"], "base64": true,
       "headers": {"Authorization": "Bearer token-do-receptor"}}'
```

| Campo | Default | O que faz |
|---|---|---|
| `url` | obrigatório | `http`/`https`, até 2048 caracteres, sem usuário/senha (autentique por `headers`). |
| `enabled` | `true` | Desativado não recebe eventos novos; as entregas pendentes ficam pausadas até reativar. |
| `events` | `["MESSAGES_UPSERT"]` | Subconjunto dos 7 eventos abaixo. |
| `base64` | `false` | Embute a mídia em `data.message.base64`. |
| `byEvents` | `false` | Acrescenta o evento ao path: `<url>/messages-upsert`. |
| `includeFromMe` | `false` | `messages.upsert` também para mensagens enviadas pelo próprio número em outro aparelho. |
| `headers` | `{}` | Até 20 cabeçalhos extras. O nome `jwt_key` vira `Authorization: Bearer <JWT HS256>` assinado com ele (como na Evolution). |

Na leitura (`GET`), os valores dos cabeçalhos voltam como `"••••"`. No `PUT`
(substituição completa), mandar `"••••"` mantém o valor salvo, **só se o
destino (esquema + host + porta) não mudar**; se o host mudou, a resposta é
`400` pedindo os valores de novo (senão bastaria apontar a URL para outro
servidor para receber o token salvo). Cada valor de cabeçalho vai até 8192
caracteres ASCII/Latin-1, e `Host`, `Content-Length`, `Transfer-Encoding` e
`Connection` não podem ser personalizados.

### Eventos

| Evento (config) | `event` | Quando dispara | `data` |
|---|---|---|---|
| `MESSAGES_UPSERT` | `messages.upsert` | Mensagem nova recebida (e, com `includeFromMe`, enviada pelo celular). **Nunca** para mensagens enviadas pela API. | Mensagem no formato da Evolution. |
| `SEND_MESSAGE` | `send.message` | Mensagem enviada por esta API. | Mesmo formato, `key.fromMe: true`. |
| `MESSAGES_UPDATE` | `messages.update` | Mudança de status (entregue, lida, reproduzida, erro). Só avança: `READ` não volta para `DELIVERY_ACK`. | `{ messageId, keyId, remoteJid, fromMe, participant, status, instanceId }` |
| `MESSAGES_EDITED` | `messages.edited` | Mensagem editada. | `{ key, type: "MESSAGE_EDIT", editedMessage }` |
| `MESSAGES_DELETE` | `messages.delete` | Mensagem apagada para todos. | `{ remoteJid, fromMe, id }` |
| `CONNECTION_UPDATE` | `connection.update` | Instância conectando, conectada ou desconectada. | `{ instance, wuid, profileName, state: "open" \| "connecting" \| "close", statusReason }` |
| `QRCODE_UPDATED` | `qrcode.updated` | QR code novo para parear. | `{ qrcode: { instance, pairingCode, code, base64 } }` |

### Entrega, retentativa e deduplicação

- **Durável.** Cada aviso é gravado na fila do Postgres
  (`wa_webhook_deliveries`) na **mesma transação** da mensagem e sai em
  seguida. Um restart não perde avisos: o que estava pendente sai quando a
  bridge volta. A fila usa `FOR UPDATE SKIP LOCKED`.
- **Qualquer `2xx` conta como entregue.** `400`, `401`, `403`, `404`, `422` e
  redirects (`3xx`, não seguidos) são falha definitiva, sem retentativa
  (configuração errada do receptor). `qrcode.updated` tem uma tentativa só: o
  QR expira em segundos. Timeout, erro de rede, `408`, `429` e `5xx` são
  retentados com backoff exponencial (5s, 10s, 20s… até 5 min, ±20%). Com os
  defaults, são 15 tentativas em **~45 minutos**; depois disso a entrega fica
  `failed`.
- **At-least-once.** Em casos raros (restart no meio de um envio, receptor que
  responde depois do timeout) o mesmo aviso pode chegar mais de uma vez.
  Deduplique por `data.key.id` + `instance`, ou por `X-Delivery-ID` (estável
  entre retentativas).
- **Ordem** é a de chegada "na medida do possível": com concorrência e
  retentativas, um aviso pode passar à frente de outro.
- **Histórico** (`GET .../deliveries`) mostra situação, tentativas, último
  código e último erro. Entregas concluídas (e as pendentes de webhooks
  desativados há muito tempo) são apagadas após
  `WEBHOOK_DELIVERY_RETENTION_DAYS`.
- **Concorrência:** até `WEBHOOK_CONCURRENCY` POSTs ao mesmo tempo no total e
  no máximo `WEBHOOK_CONCURRENCY_PER_WEBHOOK` por webhook, para um receptor
  lento não atrasar os das outras instâncias. O limite por webhook vale por
  processo.
- `POST .../test` envia `event: "webhook.test"` na hora, sem fila nem
  retentativa, e responde `200 { ok, statusCode, durationMs, error? }`.

### Mídia

Com `base64: true`, imagem, vídeo, vídeo-nota, áudio, documento e sticker
chegam com o arquivo inteiro em `data.message.base64`. O arquivo é baixado do
WhatsApp **na hora do envio** e não fica guardado em disco nem no banco. Se
passar de `WEBHOOK_MEDIA_MAX_BYTES` ou o download falhar, o aviso sai mesmo
assim, sem o arquivo e com `data.message.base64Error: "too_large" |
"download_failed"`.

O arquivo também pode ser pedido depois, como na Evolution:

```bash
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/sessions/5511999999999/chat/getBase64FromMediaMessage \
  -d '{"message": {"key": {"id": "3EB0A1B2C3D4E5F60718"}}}'
# { "mediaType": "imageMessage", "fileName": "...jpeg", "caption", "size", "mimetype", "base64" }
```

Aceita só a `key.id` (busca a mensagem gravada) ou a mensagem inteira no
formato da Evolution. `convertToMp4` é aceito e ignorado. Erros: `404`
(mensagem não encontrada), `400` (não é mídia), `409` (sessão não conectada),
`413` (acima de `WEBHOOK_MEDIA_MAX_BYTES`) e `502` (o WhatsApp não devolveu a
mídia).

### Diferenças em relação à Evolution

1. Campos binários (`mediaKey`, `jpegThumbnail`, `fileSha256` etc.) saem como
   string base64, e números `Long` (`fileLength`, `mediaKeyTimestamp`) como
   número. A Evolution manda os binários como objeto indexado.
2. `apikey` é sempre `null`: a bridge nunca envia a API key global a terceiros.
3. `data.message.base64Error`, `data.groupSubject`,
   `data.contextInfo.participantAlt` e `data.contextInfo.mentionedJidAlt[]` são
   campos extras (não existem na Evolution).
4. LID: mesma troca da Evolution, mas em mensagens `fromMe` um alt que aponte
   para o próprio número é descartado, e o número também é buscado no
   mapeamento do Baileys.
5. `messages.upsert` não inclui por padrão as mensagens enviadas pelo próprio
   número (só com `includeFromMe`) e **nunca** inclui as enviadas pela API, que
   saem só como `send.message`. Isso evita eco e loop com o Chatwoot.
6. Até 10 webhooks por instância (a Evolution permite 1), com fila durável no
   Postgres e janela de retentativa de ~45 min (a Evolution faz retentativa em
   memória).
7. `contextInfo` vem `null` quando não há citação (na Evolution o campo some
   do JSON).

### Segurança

- As rotas de webhook exigem a API key, como todas as outras.
- Cabeçalhos dos webhooks (tokens do receptor) nunca voltam na leitura e nunca
  vão para o log, que também omite a query string e credenciais da URL.
- **SSRF consciente:** a bridge faz `POST` para a URL cadastrada, que pode ser
  um endereço da rede interna (o caso comum: o receptor no mesmo Docker). Quem
  tem a API key consegue, portanto, fazer a bridge chamar qualquer endereço
  `http(s)` alcançável por ela, e `POST .../test` devolve o código HTTP ou de
  rede, o que permite sondar a rede interna. Redirects não são seguidos.
- **Mídia só do CDN do WhatsApp:** `url` e `directPath` de uma mensagem
  recebida vêm de quem a mandou. A bridge ignora o `url` e só baixa pelo
  `directPath` validado, em `https://mmg.whatsapp.net`; uma mensagem forjada
  não faz a bridge buscar um endereço interno. No máximo 3 downloads ao mesmo
  tempo.
- **QR code em webhook:** `qrcode.updated` leva o código de pareamento, que dá
  acesso à conta enquanto não expira. Só inscreva esse evento em receptor
  confiável. O payload fica no histórico de entregas até a limpeza.
- **Cabeçalhos cifrados no banco:** os valores são gravados com AES-256-GCM;
  um dump do banco não os expõe. A chave vem de `WEBHOOK_HEADERS_KEY` ou, sem
  ela, é derivada da `API_KEY`. No segundo caso, **trocar a `API_KEY` invalida
  os cabeçalhos salvos**: as entregas desses webhooks falham até os valores
  serem cadastrados de novo (nada é enviado sem o token). Para trocar a API key
  livremente, defina `WEBHOOK_HEADERS_KEY` (`openssl rand -hex 32`) e não a
  troque. As credenciais do Baileys (`wa_auth_state`) continuam em texto:
  proteja o acesso ao banco.
- **Corpo das requisições:** só é lido depois da API key; apenas as rotas de
  mídia aceitam até `JSON_BODY_LIMIT`, as demais até 256kb. JSON inválido ou
  grande demais responde `400`/`413` no formato `{ "error" }`. Nas rotas de
  mídia, no máximo `MEDIA_UPLOAD_CONCURRENCY` corpos grandes são lidos ao mesmo
  tempo; o excedente espera na fila e, passado `MEDIA_UPLOAD_QUEUE_TIMEOUT_MS`,
  recebe `503` com `Retry-After` (reenvie depois desse tempo).
- `/manager` é servido com CSP restritivo (`script-src 'self'`) e
  `X-Frame-Options: DENY`.

---

## Tela de configuração (`/manager`)

`http://localhost:3000/manager` abre uma tela (React + shadcn/ui) para gerenciar
os webhooks sem montar requisições na mão:

- entrar com a **mesma `API_KEY`** da API (fica só no `sessionStorage` da aba);
- ver as instâncias com número, nome de perfil e status;
- ligar ou desligar "ignorar grupos";
- criar, editar, ativar/desativar, testar e excluir webhooks;
- acompanhar o histórico de entregas, com filtro por situação.

Os arquivos da tela são públicos (não contêm dado nenhum); tudo o que ela
mostra vem das rotas `/sessions`, com a API key. A imagem Docker já builda a
tela. Para desenvolver:

```bash
cd manager
npm install
npm run dev     # http://localhost:5173/manager/ (proxy de /sessions para localhost:3000)
npm run build   # gera manager/dist, servido pela bridge em /manager
```

Rodando a bridge fora do Docker sem `manager/dist`, a API funciona
normalmente e o log avisa que a tela está indisponível.

> `npm audit` em `manager/` aponta avisos no Tailwind CSS 3 e dependências
> (`braces`, `micromatch`, `chokidar`, `postcss-selector-parser`). São
> ferramentas de **build**: não vão para o navegador nem para a imagem final. A
> correção exige migrar para o Tailwind 4, e ficou para uma tarefa própria.

---

## Ciclo de vida da sessão e diagnóstico de quedas

### Status de uma sessão

```
connecting ─▶ qr (aguardando escaneamento) ─▶ connected
connected  ─▶ disconnected   via /disconnect (credenciais mantidas, SEM reconexão automática)
connecting ─▶ disconnected   watchdog: travou além de CONNECTING_TIMEOUT_MS (SEM reconexão automática)
connected/qr ─▶ reconnecting queda não solicitada: tenta sozinho
reconnecting ─▶ error        desistiu após RECONNECT_MAX_ATTEMPTS (chame /connect de novo)
qualquer ─▶ logged_out       deslogado pelo WhatsApp ou via /logout (credenciais apagadas;
                             sessão e webhooks ficam)
```

**Sessão travada em `connecting` ou `connected`?** Chame `/disconnect` e depois
`/connect`. O `/disconnect` funciona mesmo com o socket morto (encerrar um
socket já fechado é um no-op seguro). Se ficar em `connecting` por mais de
`CONNECTING_TIMEOUT_MS`, o watchdog faz isso sozinho, mas só o `/disconnect`:
de propósito **não** reconecta em seguida.

### Diagnóstico de quedas

Toda abertura (`open`), queda não pedida (`close`), `/disconnect` ou watchdog
(`disconnect`) e `/logout` (`logout`) fica registrada com o motivo que o
Baileys reportou, em dois lugares:

- **Log do container**, uma linha por queda:
  `[5511999999999] conexão fechou: code=428 reason=connectionClosed message="Connection Terminated" uptime=52m05s`
- **Tabela `wa_connection_events`** (sobrevive a redeploy; limpeza após
  `CONNECTION_EVENTS_RETENTION_DAYS`), consultável em
  `GET /sessions/:id/connection-events?limit=100`.

Como ler o `code`/`reason` (`DisconnectReason` do Baileys):

| code | reason | O que costuma ser |
|---|---|---|
| 408 | `connectionLost/timedOut` | Keepalive sem resposta: rede da VPS ou do WhatsApp oscilou. |
| 428 | `connectionClosed` | WebSocket fechado pelo outro lado (o WhatsApp encerrou a conexão). |
| 440 | `connectionReplaced` | Outra conexão com a mesma credencial abriu (dois processos/sockets com o mesmo número). |
| 401 | `loggedOut` | Aparelho removido no celular ou sessão invalidada: precisa de QR. |
| 500 | `badSession` | Credencial/sessão corrompida. |
| 503 | `unavailableService` | Instabilidade do lado do WhatsApp. |
| 515 | `restartRequired` | Normal logo depois de ler o QR; a bridge reconecta na hora. |

Os logs internos do Baileys saem em JSON (pino) com `"session":"<id>"`, no
nível `BAILEYS_LOG_LEVEL` (default `warn`). Para investigar uma instância que
cai com frequência, suba temporariamente para `info` ou `debug`. Os dumps de
sessão de sinal que o libsignal imprime (`Closing session: SessionEntry {...}`,
com chaves privadas) são descartados.

### Diagnóstico de memória

Um estouro de heap do V8 (`FatalProcessOutOfMemory`, seguido de uma pilha de
`v8::internal::...`) derruba o processo sem passar por nenhum handler de JS e
não deixa o motivo no log. Por isso a bridge registra, antes, o que está
segurando memória. Na subida:

```
memória: monitor ativo — limite do heap do V8 = 1584MB, limite do container = 2048MB, leitura a cada 60s (a cada 10s acima de 70%)
```

E, a cada `MEMORY_LOG_INTERVAL_MS`:

```
memória: rss=812/2048MB (40%) heap=640/1584MB (40%) Δheap=+120MB old=500MB grandes=90MB novos=30MB fora-do-heap=40MB buffers=30MB eventLoopP99=12ms sessões={connected=2,qr=1} enviadas-em-cache=200 mídia={cache=12MB/3,downloads=1+0} grupos={cache=450,metadata=80,participantes=9000} webhooks-em-voo=2 webhooks-mídia=1+0 envios-mídia=0+0 recebidas=30 histórico={mensagens=12000,conversas=300,contatos=800}
```

Como ler:

| Campo | O que indica |
|---|---|
| `rss=usado/container` | Memória real do processo contra o limite do container (lido do cgroup). Se chegar a 100%, o kernel mata o container (`OOMKilled`) sem log nenhum: por isso também dispara o ALERTA. |
| `heap=usado/limite` | Quanto do teto do V8 já foi usado. Inclui lixo ainda não coletado: um pico que volta é normal, **subir sem voltar** não é. |
| `Δheap` | Variação desde a leitura anterior. Salto grande de uma linha pra outra mostra *quando* começou. |
| `grandes` | Objetos enormes (strings/arrays). Alto = mídia em base64 ou JSON de webhook com mídia. |
| `fora-do-heap` / `buffers` | Memória que o heap não vê: mídia baixada, criptografia. |
| `mídia`, `grupos`, `enviadas-em-cache` | O que os caches da própria bridge seguram. |
| `webhooks-mídia` / `envios-mídia` | Vagas de mídia ocupadas + fila: webhooks montando/enviando mídia (`WEBHOOK_MEDIA_CONCURRENCY`) e `POST /messages` com mídia (`MEDIA_UPLOAD_CONCURRENCY`). Fila crescendo = mais mídia chegando do que a bridge processa. |
| `histórico` | Mensagens que o WhatsApp mandou na sincronização inicial, por leitura. Logo depois de parear um número novo costuma ser o maior pico. Cada pacote também sai em `[<número>] histórico recebido: ...`. |
| `recebidas` | Mensagens novas (`messages.upsert`) desde a leitura anterior. |
| `eventLoopP99` | Atraso do event loop: GC pesado ou trabalho síncrono grande. |

Acima de `MEMORY_WARN_RATIO` do limite do heap **ou** da memória do container, a linha vira `memória: ALERTA ...` (dizendo qual dos dois), as
leituras passam a sair a cada `MEMORY_ALERT_INTERVAL_MS` e vêm linhas
`memória: suspeito: ...` apontando onde olhar (mídia, histórico, grupos, muitas
sessões). Se nenhum contador da bridge explicar o uso, o suspeito é retenção
dentro do Baileys ou do driver do Postgres.

Quando o processo morrer, as **últimas linhas `memória:` antes do crash** são a
evidência: veja qual campo crescia e o que `Δheap` mostrava.

Para uma prova definitiva (o que, objeto por objeto, ocupa o heap), suba uma
vez com um heap snapshot automático perto do limite:

```
NODE_OPTIONS=--max-old-space-size=1536 --heapsnapshot-near-heap-limit=1 --diagnostic-dir=/tmp
```

O arquivo `.heapsnapshot` cai em `/tmp` do container (some no restart: copie com
`docker cp` antes) e abre no Chrome DevTools, aba *Memory*. Atenção: gerar o
snapshot precisa de memória extra (do tamanho do heap) e o arquivo **contém
mensagens e chaves da sessão**: não o compartilhe. Não deixe ligado em produção.

---

## Decisões de design e limitações

**Decisões**

- **Reconexão automática só em queda não solicitada**, com tentativas e delay
  configuráveis. `/disconnect`, `/logout` e `DELETE` nunca acordam reconexão;
  só volta se você chamar `/connect`. Um restart do processo também não religa
  sessões `disconnected` ou `logged_out`.
- **`restartRequired` (515) reconecta na hora**, sem contar como tentativa
  falha: é parte normal do pareamento.
- **Watchdog de `connecting` travado**: se o handshake nunca completar nem
  falhar (comum atrás de firewall restritivo), a bridge força a saída, mas sem
  reconectar, para não entrar em loop contra algo estrutural.
- **Auth state em Postgres**, na mesma lógica do `useMultiFileAuthState`, que a
  documentação do Baileys recomenda como guia para SQL/NoSQL em produção.
- **Utilitários oficiais do Baileys** sempre que possível
  (`makeCacheableSignalKeyStore`, `Browsers.ubuntu`, `fetchLatestBaileysVersion`
  resolvido uma vez no boot com timeout de 8s). Se o formato do WhatsApp
  mudar, o caminho é `npm update baileys`.
- **Fila de webhooks no próprio Postgres** (outbox), em vez de Redis/RabbitMQ: o
  Postgres já é dependência, a entrega sobrevive a restart e o histórico fica
  consultável.
- **Lock por sessão** (`startSessionSerialized`): duas chamadas concorrentes de
  `/connect` para o mesmo número não criam dois sockets.
- **`unhandledRejection`/`uncaughtException` são logados, não derrubam o
  processo**: preferimos manter as outras sessões de pé.
- **Sem `mediaUrl` no envio** (evita SSRF) e **sem histórico antigo**
  (`syncFullHistory: false`).

**Limitações conhecidas**

- **Um processo = um dono de cada sessão.** Várias réplicas apontando para o
  mesmo Postgres brigariam pelo mesmo socket do WhatsApp. Escalar de verdade
  pede um lock distribuído (ex.: `pg_advisory_lock` por `session_id`).
- **API key única e global**, sem granularidade por cliente.
- **Sem fila de envio**: disparos são síncronos, um por chamada. Para volume,
  enfileire por fora (ex.: BullMQ/Redis) com intervalo entre mensagens.
- **Atrás de proxy HTTP(S) a bridge não conecta**: o `ws` do Baileys ignora
  `HTTPS_PROXY`. Se a produção sair por proxy, isso precisa virar uma opção
  (`agent` do `makeWASocket`).
- **Credenciais do Baileys em texto** no Postgres: proteja o acesso ao banco.
- **Canal (`@newsletter`)** e listas/botões para grupo continuam fora.

---

## Desenvolvimento e testes

```bash
npm install
npm test        # node --test
```

Os testes unitários rodam sem dependências externas. Os de integração
(`test/integration/`) precisam de um Postgres descartável e são pulados sem a
variável:

```bash
TEST_DATABASE_URL=postgres://user:senha@localhost:5432/wsb_test npm test
```

`test/fixtures/` traz mensagens sintéticas no formato do Baileys e amostras do
webhook da Evolution 2.4.0-rc2; o teste de contrato compara o envelope gerado
pela bridge com essas amostras (chaves e tipos).

---

## Avisos importantes

- **O Baileys não é oficial.** Ele reimplementa o protocolo do WhatsApp Web;
  uma mudança da Meta pode quebrar a biblioteca até os mantenedores
  atualizarem.
- **Risco de banimento.** Números usados para disparo em massa, spam ou fora
  dos termos de uso do WhatsApp podem ser banidos. Use para comunicação
  legítima, com destinatários que esperam a mensagem.

---

## Mais documentação

- [`docs/contracts/rest-api.md`](docs/contracts/rest-api.md): contrato das
  rotas REST.
- [`docs/contracts/webhook-payload.md`](docs/contracts/webhook-payload.md):
  envelope e payload de cada evento de webhook.
- [`docs/revisoes-de-codigo.md`](docs/revisoes-de-codigo.md): histórico das
  revisões de código e dos testes reais feitos durante o desenvolvimento
  (incluindo o que **não** foi verificado de ponta a ponta).
- `Baileys-Bridge.postman_collection.json`: coleção do Postman com as rotas.
