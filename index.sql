-- Adições ao schema pra suportar múltiplos números

CREATE TABLE whatsapp_numbers (
  id              SERIAL PRIMARY KEY,
  phone_number_id TEXT UNIQUE NOT NULL,   -- vem da Meta
  display_number  TEXT NOT NULL,           -- ex: '+5511999998888'
  label           TEXT,                    -- ex: 'Vendas SP', 'Suporte'
  access_token    TEXT NOT NULL,           -- token específico ou da WABA
  flow_id         INTEGER REFERENCES flows(id),  -- cada número pode ter SEU fluxo
  active          BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Mensagens e contatos passam a saber de qual número são
ALTER TABLE messages ADD COLUMN whatsapp_number_id INTEGER REFERENCES whatsapp_numbers(id);
ALTER TABLE contacts ADD COLUMN whatsapp_number_id INTEGER REFERENCES whatsapp_numbers(id);

-- A chave do contato vira (telefone + número que atendeu)
-- porque o mesmo cliente pode falar com Vendas E Suporte
ALTER TABLE contacts DROP CONSTRAINT contacts_pkey;
ALTER TABLE contacts ADD PRIMARY KEY (phone, whatsapp_number_id);

CREATE INDEX ON messages(whatsapp_number_id, sent_at DESC);
