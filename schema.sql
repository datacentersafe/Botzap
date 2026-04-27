-- Schema mínimo pra rodar o bot + painel

CREATE TABLE contacts (
  phone           TEXT PRIMARY KEY,
  name            TEXT,
  human_takeover  BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE messages (
  id              BIGSERIAL PRIMARY KEY,
  contact_phone   TEXT REFERENCES contacts(phone),
  direction       TEXT CHECK (direction IN ('in', 'out')),
  body            TEXT,
  sent_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON messages(contact_phone, sent_at DESC);

CREATE TABLE contact_tags (
  contact_phone   TEXT REFERENCES contacts(phone),
  label           TEXT,
  value           TEXT,
  PRIMARY KEY (contact_phone, label)
);

-- Opcional: persistência do fluxo (caso queira editar via painel)
CREATE TABLE flows (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  json            JSONB NOT NULL,
  active          BOOLEAN DEFAULT false,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
