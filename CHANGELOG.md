# Changelog

Mudanças por versão e o que fazer para atualizar. A versão é a do
`package.json`; a imagem publicada é `justbrunasso/whatsapp-bridge`.

---

## 1.1.0 — 2026-11-06

Versão focada em **memória**: a bridge estava morrendo por estouro do heap do
Node (`FatalProcessOutOfMemory`) logo depois de parear um número. Esta versão
para de baixar o histórico de mensagens do WhatsApp, põe teto em tudo que
segura mídia em memória e passa a registrar no log o que está consumindo
memória antes de um crash.

**Não há migração de banco.** O `schema.sql` não mudou e todas as variáveis
novas têm default: a 1.1.0 sobe com o `.env` da 1.0.0. Mesmo assim, leia
"O que muda de comportamento" antes de atualizar.

### O que muda de comportamento

| Mudança | Quem percebe | O que fazer |
|---|---|---|
| `POST /sessions/:id/messages`, `/message/sendButtons` (com mídia) e `/chat/getBase64FromMediaMessage` podem responder **`503` com `Retry-After`** | Quem chama a API em rajada: mais de 5 envios com mídia (ou 3 pedidos de base64) ao mesmo tempo que esperem mais de 30s na fila | Tratar `503` reenviando depois de `Retry-After` segundos, ou subir `MEDIA_UPLOAD_CONCURRENCY` / `MEDIA_UPLOAD_QUEUE_TIMEOUT_MS`. Envio de texto nunca entra na fila. |
| Webhooks com mídia em rajada **saem mais devagar** (no máximo 3 montando/enviando por vez) | Receptores de webhook com `base64` ligado | Nada, é intencional (metade da memória no teste de estresse). Ajustável em `WEBHOOK_MEDIA_CONCURRENCY`. Webhook sem mídia não espera. |
| O histórico recente do WhatsApp **não é mais baixado** ao parear (`HISTORY_SYNC=minimal`) | Ninguém pela API (a bridge nunca guardou nem repassou histórico) | Ficar de olho em contatos chegando como `@lid` sem número no Chatwoot logo depois de parear; se acontecer, avisar. `HISTORY_SYNC=recent` volta ao comportamento antigo. |
| **Status** (`status@broadcast`) é descartado antes de decifrar | Ninguém (a bridge já descartava status) | Nada. Somem do log as linhas `No session found to decrypt message` de `status@broadcast`. |
| Uma linha `memória: ...` por minuto no log | Quem lê o log do container | Nada. `MEMORY_LOG_INTERVAL_MS=0` desliga. |

### Variáveis novas

Todas opcionais (têm default). As de memória pressupõem um container com
**2048MB**; com outro tamanho, ajuste `NODE_MAX_OLD_SPACE_MB` para ~75% dele.

| Variável | Default | O que faz |
|---|---|---|
| `NODE_MAX_OLD_SPACE_MB` | `1536` | **Só dos arquivos compose**: vira `NODE_OPTIONS=--max-old-space-size=<valor>`, o teto do heap do Node. Use ~75% do limite de memória do container; o resto fica para Buffers de mídia. Fora do compose, defina `NODE_OPTIONS` direto. |
| `MEMORY_LOG_INTERVAL_MS` | `60000` | Intervalo da linha `memória: ...` no log (`0` desativa). |
| `MEMORY_WARN_RATIO` | `0.7` | Fração do limite do heap **ou** da memória do container a partir da qual a linha vira `ALERTA` com os suspeitos. |
| `MEMORY_ALERT_INTERVAL_MS` | `10000` | Intervalo das leituras enquanto em `ALERTA` (mínimo `1000`). |
| `WEBHOOK_MEDIA_CONCURRENCY` | `3` | Entregas de webhook com mídia montando/enviando ao mesmo tempo (download + base64 + JSON + POST). |
| `MEDIA_UPLOAD_CONCURRENCY` | `5` | Envios com corpo grande (mídia em base64) lidos ao mesmo tempo em `/messages` e `/message/sendButtons`. Corpo até 256kb (texto) não conta. |
| `MEDIA_UPLOAD_QUEUE_TIMEOUT_MS` | `30000` | Espera máxima na fila por uma vaga de envio ou de base64; depois, `503` com `Retry-After`. |
| `MEDIA_BASE64_CONCURRENCY` | `3` | `getBase64FromMediaMessage` montando a resposta ao mesmo tempo. |
| `HISTORY_SYNC` | `minimal` | Histórico do WhatsApp ao parear: `minimal` (sem mensagens antigas, só os pacotes pequenos com mapeamentos LID→número e nomes), `off` (nada; o Baileys avisa de instabilidade com LIDs) ou `recent` (comportamento da 1.0.0). |

### Como atualizar

#### 1. Publicar a imagem

Não há CI publicando a imagem: build e push manuais, a partir do commit da
versão.

```bash
git pull
```

```bash
docker build -t justbrunasso/whatsapp-bridge:1.1.0 -t justbrunasso/whatsapp-bridge:latest .
```

```bash
docker push justbrunasso/whatsapp-bridge:1.1.0
```

```bash
docker push justbrunasso/whatsapp-bridge:latest
```

Prefira apontar a stack para a tag `1.1.0` em vez de `latest`: assim o
rollback é só voltar a tag.

#### 2a. Docker Swarm (`docker-compose.swarm.yml`)

No serviço `whatsapp_bridge_api` (no arquivo da stack ou no editor do
Portainer):

- **Imagem**: `justbrunasso/whatsapp-bridge:1.1.0`.
- **Memória**: em `deploy.resources.limits`, `memory: 2048M` (a 1.0.0 vinha
  com `512M`, pouco para o heap do Node com várias sessões).
- **Ambiente**: acrescente ao bloco `environment` (os valores são os defaults;
  só o `NODE_OPTIONS` faz diferença real se ficar de fora):

```yaml
      ## Envios com mídia (corpo grande) processados ao mesmo tempo e espera máxima na fila (depois, 503)
      - MEDIA_UPLOAD_CONCURRENCY=${MEDIA_UPLOAD_CONCURRENCY:-5}
      - MEDIA_UPLOAD_QUEUE_TIMEOUT_MS=${MEDIA_UPLOAD_QUEUE_TIMEOUT_MS:-30000}
      ## getBase64FromMediaMessage montando a resposta ao mesmo tempo
      - MEDIA_BASE64_CONCURRENCY=${MEDIA_BASE64_CONCURRENCY:-3}
      ## Webhooks com mídia montando/enviando ao mesmo tempo (os demais esperam a vez)
      - WEBHOOK_MEDIA_CONCURRENCY=${WEBHOOK_MEDIA_CONCURRENCY:-3}
      ## Histórico do WhatsApp ao parear: minimal (sem mensagens antigas, só mapeamentos LID), off ou recent
      - HISTORY_SYNC=${HISTORY_SYNC:-minimal}
      ## Memória: teto do heap do Node (deixe ~25% do limite do container pra Buffers) e diagnóstico
      - NODE_OPTIONS=--max-old-space-size=${NODE_MAX_OLD_SPACE_MB:-1536}
      - MEMORY_LOG_INTERVAL_MS=${MEMORY_LOG_INTERVAL_MS:-60000}
      - MEMORY_ALERT_INTERVAL_MS=${MEMORY_ALERT_INTERVAL_MS:-10000}
      - MEMORY_WARN_RATIO=${MEMORY_WARN_RATIO:-0.7}
```

Depois, atualize a stack (troque `<stack>` pelo nome dela):

```bash
docker stack deploy -c docker-compose.swarm.yml <stack>
```

As sessões conectadas reconectam sozinhas na subida, sem QR novo.

#### 2b. Docker Compose (`docker-compose.yml`)

O `docker-compose.yml` do repositório já traz as variáveis novas com os
defaults; o `.env` da 1.0.0 continua valendo. Para mudar algum valor, copie a
linha do `.env.example` para o `.env`.

```bash
git pull
```

```bash
docker compose up -d --build
```

Se o seu `docker-compose.yml` é uma cópia própria, acrescente ao `environment`
do serviço `bridge` as mesmas variáveis do bloco do Swarm acima (no formato
`CHAVE: valor`) e um limite de memória compatível com `NODE_MAX_OLD_SPACE_MB`.

#### 3. Conferir

Na subida, o log deve trazer:

```
memória: monitor ativo — limite do heap do V8 = 1584MB, limite do container = 2048MB, leitura a cada 60s (a cada 10s acima de 70%)
histórico do WhatsApp: HISTORY_SYNC=minimal (ver historySync.js)
```

- `limite do heap do V8` perto de `NODE_MAX_OLD_SPACE_MB` (o V8 soma um pouco)
  confirma o `NODE_OPTIONS`. Se aparecer um valor bem menor, a variável não
  chegou ao container.
- `limite do container` deve bater com o limite configurado. `container sem
  limite de memória` indica que o limite não foi aplicado.

Depois, ao parear um número:

- poucos `[<número>] histórico recebido: ...`, pequenos, com `syncType`
  `INITIAL_BOOTSTRAP`, `PUSH_NAME` ou `NON_BLOCKING_DATA` (nenhum `RECENT`);
- linhas `memória: ...` sem salto grande em `Δheap` e sem `ALERTA`.

Como ler a linha `memória:` e o `ALERTA`: README, seção
[Diagnóstico de memória](README.md#diagnóstico-de-memória).

#### Voltar atrás

- **Tudo**: volte a imagem para a tag anterior. Não há migração a desfazer.
- **Só o histórico**: `HISTORY_SYNC=recent`.
- **Só as filas de mídia**: suba `WEBHOOK_MEDIA_CONCURRENCY`,
  `MEDIA_UPLOAD_CONCURRENCY` e `MEDIA_BASE64_CONCURRENCY` (o mínimo é `1`; não
  há como desligar o limite, só torná-lo alto).

### Mudanças

**Adicionado**

- Diagnóstico de memória (`memoryMonitor.js`): linha `memória: ...` periódica
  com RSS contra o limite do container (cgroup), heap do V8 por espaço, caches
  da bridge (mídia, grupos, mensagens enviadas), filas de mídia, mensagens
  recebidas e histórico sincronizado por sessão. Acima de `MEMORY_WARN_RATIO`
  vira `ALERTA`, sai a cada `MEMORY_ALERT_INTERVAL_MS` e lista os suspeitos.
- Log de cada pacote de histórico recebido: `[<número>] histórico recebido:
  mensagens=… conversas=… contatos=… syncType=… progresso=…`.
- Filas com teto para mídia (`limiter.js`): webhooks com mídia,
  `POST /messages` e `/message/sendButtons` com corpo grande (a vaga é ocupada
  antes de o corpo ser lido) e `getBase64FromMediaMessage`.
- `HISTORY_SYNC` (`historySync.js`).
- `NODE_OPTIONS=--max-old-space-size` nos dois compose; limite de memória do
  serviço da API no Swarm em `2048M`.

**Alterado**

- O Baileys não baixa mais o histórico recente de mensagens ao parear
  (`shouldSyncHistoryMessage`). Com `syncFullHistory: false` só o histórico
  completo (`FULL`) estava desligado; o recente (`RECENT`) chegava em pacotes
  e o buffer de eventos do Baileys acumulava as mensagens num objeto indexado
  pelo id da mensagem, crescendo até estourar o heap.
- Status (`status@broadcast`) é descartado pelo Baileys antes do decrypt
  (`shouldIgnoreJid`), sem pedido de reenvio ao autor.
- Cache de grupos: a lista de participantes sai da memória quando vence (5 min)
  por uma varredura a cada minuto; antes podia ficar até 6h.

**Medido** (teste de estresse com os módulos reais, heap de 1536MB)

| Cenário | 1.0.0 | 1.1.0 |
|---|---|---|
| 30 webhooks com mídia de 20MB em 10 webhooks, receptor lento | 1463MB de RSS | 764MB |
| 80 `POST /messages` com 14MB, 40 simultâneos | 1562MB de RSS | 529MB |

Não coberto pelo teste: a memória interna do Baileys com um WhatsApp real.
Que o crash de produção tenha sido o histórico é a hipótese mais provável (o
crash veio logo depois de parear, e o buffer do Baileys com histórico
sintético estoura um heap de 256MB), não uma prova: os logs `memória:` desta
versão é que vão confirmar ou descartar.

---

## 1.0.0

Primeira versão: sessões do Baileys com estado no Postgres, envio de mensagens
(texto, mídia, listas e botões), recebimento com histórico em `wa_messages`,
webhooks no formato da Evolution com outbox e retentativa, tela `/manager`,
`POST /sessions/:id/logout` e diagnóstico de quedas (`wa_connection_events`).
