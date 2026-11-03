-- Metadados de cada sessão (um número de WhatsApp conectado à bridge)
CREATE TABLE IF NOT EXISTS wa_sessions (
  id         TEXT PRIMARY KEY,           -- número normalizado (só dígitos, com DDI), ex: 5511999999999
  status     TEXT NOT NULL DEFAULT 'connecting',
  jid        TEXT,                        -- jid completo que o WhatsApp confirma ao conectar
  name       TEXT,                        -- push name / nome de perfil do WhatsApp confirmado ao conectar
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessões criadas antes da coluna "name" existir não têm essa coluna até a
-- migração rodar de novo; ALTER TABLE ... ADD COLUMN IF NOT EXISTS cobre o
-- upgrade de um banco já existente (CREATE TABLE IF NOT EXISTS acima não
-- altera uma tabela que já existe).
ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS name TEXT;

-- Credenciais e chaves de sinal do Baileys, uma linha por chave (equivalente a um
-- arquivo por chave no useMultiFileAuthState, só que em Postgres).
CREATE TABLE IF NOT EXISTS wa_auth_state (
  session_id TEXT NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,               -- 'creds' ou '<tipo>-<id>', ex: 'pre-key-3'
  value      TEXT NOT NULL,                -- JSON serializado (BufferJSON.replacer)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, key)
);

-- "Ignorar grupos" por instância (mesmo papel do Setting.groupsIgnore da
-- Evolution). Ligado por padrão: a maioria das integrações de atendimento só
-- quer conversa individual. Mesmo padrão de upgrade da coluna "name" acima.
ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS groups_ignore BOOLEAN NOT NULL DEFAULT true;

-- Mensagens recebidas e enviadas, já normalizadas no formato "data" da
-- Evolution (key/message/context_info em JSON, binários em base64), pra que o
-- payload do webhook saia direto da linha.
CREATE TABLE IF NOT EXISTS wa_messages (
  id                BIGSERIAL PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  key_id            TEXT NOT NULL,           -- key.id da mensagem
  remote_jid        TEXT NOT NULL,           -- conversa, já normalizada (PN preferido ao LID)
  remote_jid_alt    TEXT,                    -- LID quando houve troca pra PN
  participant       TEXT,                    -- autor, em grupo
  from_me           BOOLEAN NOT NULL,
  origin            TEXT NOT NULL,           -- 'inbound' (de terceiros) | 'device' (próprio número, outro aparelho) | 'api' (enviada por esta bridge)
  push_name         TEXT,
  message_type      TEXT NOT NULL,           -- ex: conversation, imageMessage, listResponseMessage
  key               JSONB NOT NULL,
  message           JSONB NOT NULL,
  context_info      JSONB,
  message_timestamp BIGINT NOT NULL,         -- segundos epoch
  status            TEXT,                    -- ERROR | PENDING | SERVER_ACK | DELIVERY_ACK | READ | PLAYED | EDITED | DELETED
  source            TEXT,                    -- android | ios | web | desktop | unknown
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Deduplicação: o Baileys reentrega mensagens após reconexão, e o eco de uma
  -- mensagem enviada pela API pode chegar antes ou depois da gravação da rota.
  -- O INSERT usa ON CONFLICT DO NOTHING; sem linha nova, não há aviso de webhook.
  CONSTRAINT wa_messages_session_key_uniq UNIQUE (session_id, key_id, from_me)
);

CREATE INDEX IF NOT EXISTS wa_messages_conversation_idx
  ON wa_messages (session_id, remote_jid, message_timestamp DESC);

-- GET /messages sem filtro de conversa (paginado por id) e a limpeza por
-- idade (MESSAGE_RETENTION_DAYS) não usam o índice de conversa acima.
CREATE INDEX IF NOT EXISTS wa_messages_session_id_idx ON wa_messages (session_id, id DESC);
CREATE INDEX IF NOT EXISTS wa_messages_created_at_idx ON wa_messages (created_at);

-- Nome (subject) dos grupos que a sessão já viu: só o mapeamento JID -> nome,
-- segunda camada do cache de groupMetadata.js (a primeira é a memória). Vem de
-- groups.upsert/groups.update e das consultas ao WhatsApp; é o que deixa o
-- histórico mostrar o nome com a sessão desconectada. O nome NÃO é gravado em
-- wa_messages nem no outbox: webhook e histórico resolvem na hora (nome atual).
CREATE TABLE IF NOT EXISTS wa_groups (
  session_id TEXT NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  jid        TEXT NOT NULL,                -- ex: 120363000000000000@g.us
  subject    TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, jid)
);

-- Webhooks cadastrados por instância (N por sessão; a Evolution só permite 1).
CREATE TABLE IF NOT EXISTS wa_webhooks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  events          TEXT[] NOT NULL DEFAULT '{MESSAGES_UPSERT}',
  base64          BOOLEAN NOT NULL DEFAULT false,  -- embutir mídia (webhookBase64 da Evolution)
  by_events       BOOLEAN NOT NULL DEFAULT false,  -- sufixo /<evento-kebab> na URL (webhookByEvents)
  include_from_me BOOLEAN NOT NULL DEFAULT false,  -- messages.upsert também pra mensagens do próprio número em outro aparelho
  headers         JSONB NOT NULL DEFAULT '{}',     -- cabeçalhos extras; "jwt_key" vira Authorization: Bearer <jwt>
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_webhooks_session_idx ON wa_webhooks (session_id);

-- Outbox de entregas de webhook. A linha nasce na MESMA transação que grava a
-- mensagem, então um aviso nunca se perde num restart entre gravar e enviar.
-- O envelope (date_time, destination...) é montado na hora do envio; aqui só
-- fica o "data", sem base64 (a mídia é baixada sob demanda no envio).
CREATE TABLE IF NOT EXISTS wa_webhook_deliveries (
  id               BIGSERIAL PRIMARY KEY,   -- também vai no header X-Delivery-ID
  webhook_id       UUID NOT NULL REFERENCES wa_webhooks(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL,
  event            TEXT NOT NULL,           -- nome de configuração, ex: MESSAGES_UPSERT
  message_id       BIGINT REFERENCES wa_messages(id) ON DELETE SET NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | delivering | delivered | failed
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until     TIMESTAMPTZ,             -- lease enquanto "delivering"; vencido = elegível de novo (crash no meio do envio)
  last_status_code INT,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS wa_webhook_deliveries_claim_idx
  ON wa_webhook_deliveries (status, next_attempt_at)
  WHERE status IN ('pending', 'delivering');

CREATE INDEX IF NOT EXISTS wa_webhook_deliveries_webhook_idx
  ON wa_webhook_deliveries (webhook_id, id DESC);

-- Aberturas, quedas e logouts de cada sessão, com o motivo que o baileys
-- reportou (DisconnectReason). Existe pra investigar quedas "do nada": os
-- logs do container somem a cada redeploy, isto aqui fica (limpeza por
-- CONNECTION_EVENTS_RETENTION_DAYS). Consulta: GET /sessions/:id/connection-events.
CREATE TABLE IF NOT EXISTS wa_connection_events (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,           -- open | close (queda não pedida) | disconnect (/disconnect ou watchdog) | logout
  status_code INT,                     -- código do lastDisconnect (ex.: 428, 408, 440, 401, 500, 515)
  reason      TEXT,                    -- nome no DisconnectReason (ex.: connectionClosed)
  message     TEXT,                    -- mensagem do erro (truncada)
  detail      TEXT,                    -- Boom.data em JSON (ex.: nó <stream:error>), truncado
  uptime_ms   BIGINT,                  -- quanto tempo ficou conectada antes de cair
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_connection_events_session_idx
  ON wa_connection_events (session_id, id DESC);

CREATE INDEX IF NOT EXISTS wa_connection_events_created_idx
  ON wa_connection_events (created_at);
