/**
 * Servidor webhook + adapters Cloud API.
 * Stack mínima: Fastify + Postgres (via 'pg') + Redis (via 'ioredis').
 *
 *   npm i fastify pg ioredis undici
 *
 * Variáveis de ambiente necessárias:
 *   WA_TOKEN          → token permanente da Meta (System User)
 *   WA_PHONE_ID       → ID do número conectado
 *   WA_VERIFY_TOKEN   → string que você define no painel da Meta
 *   DATABASE_URL      → postgres://...
 *   REDIS_URL         → redis://...
 */

const Fastify = require('fastify');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { request } = require('undici');
const { FlowEngine } = require('./flow-engine.js');
const fs = require('fs');

const app = Fastify({ logger: true });
const pg = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

const flowJson = JSON.parse(fs.readFileSync('./flow.json', 'utf-8'));

// --- Adapters Cloud API + persistência ---------------------------------------

const adapters = {
  async sendText(to, text) {
    await waCall('messages', {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    });
    // Loga no banco pra aparecer no painel
    await pg.query(
      'INSERT INTO messages(contact_phone, direction, body, sent_at) VALUES($1,$2,$3,NOW())',
      [to, 'out', text]
    );
    app.io?.emit('message', { to, direction: 'out', body: text });
  },

  async sendImage(to, mediaId) {
    await waCall('messages', {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { id: mediaId },
    });
  },

  async tagContact(contactId, label, value) {
    await pg.query(
      `INSERT INTO contact_tags(contact_phone, label, value)
       VALUES($1,$2,$3)
       ON CONFLICT (contact_phone, label) DO UPDATE SET value = EXCLUDED.value`,
      [contactId, label, String(value)]
    );
  },

  async saveState(contactId, state) {
    await redis.set(`flow:${contactId}`, JSON.stringify(state), 'EX', 60 * 60 * 24 * 7);
  },

  async loadState(contactId) {
    const raw = await redis.get(`flow:${contactId}`);
    return raw ? JSON.parse(raw) : null;
  },

  async scheduleResume(contactId, ms) {
    // Usando setTimeout em memória — pra produção, use BullMQ ou Postgres pg-boss
    // pra sobreviver a restarts.
    setTimeout(() => engine.resumeAfterDelay(contactId).catch(console.error), ms);
  },
};

const engine = new FlowEngine(flowJson, adapters);

// --- Helpers Cloud API -------------------------------------------------------

async function waCall(path, body) {
  const url = `https://graph.facebook.com/v22.0/${process.env.WA_PHONE_ID}/${path}`;
  const { statusCode, body: resBody } = await request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (statusCode >= 300) {
    const err = await resBody.text();
    throw new Error(`Cloud API ${statusCode}: ${err}`);
  }
  return resBody.json();
}

// --- Webhook -----------------------------------------------------------------

// Verificação inicial (Meta chama com hub.challenge)
app.get('/webhook', async (req, reply) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    return reply.send(challenge);
  }
  return reply.code(403).send();
});

// Recebimento de mensagens
app.post('/webhook', async (req, reply) => {
  reply.send({ ok: true }); // ACK rápido — Meta exige < 5s

  const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  if (!message) return;

  const from = message.from; // wa_id
  const text = message.text?.body || message.button?.text || '';
  if (!text) return;

  // Loga no banco e emite pro painel
  await pg.query(
    'INSERT INTO messages(contact_phone, direction, body, sent_at) VALUES($1,$2,$3,NOW())',
    [from, 'in', text]
  );

  // Verifica se um atendente humano assumiu
  const { rows } = await pg.query(
    'SELECT human_takeover FROM contacts WHERE phone = $1',
    [from]
  );
  if (rows[0]?.human_takeover) {
    return; // bot pausado, atendente assume
  }

  await engine.receiveMessage(from, text);
});

// Endpoint pro painel pausar o bot
app.post('/conversations/:phone/takeover', async (req) => {
  await pg.query(
    `INSERT INTO contacts(phone, human_takeover) VALUES($1, true)
     ON CONFLICT (phone) DO UPDATE SET human_takeover = true`,
    [req.params.phone]
  );
  return { ok: true };
});

app.post('/conversations/:phone/release', async (req) => {
  await pg.query('UPDATE contacts SET human_takeover = false WHERE phone = $1', [req.params.phone]);
  return { ok: true };
});

// Atendente envia uma mensagem manualmente
app.post('/conversations/:phone/send', async (req) => {
  await adapters.sendText(req.params.phone, req.body.text);
  return { ok: true };
});

app.listen({ port: 3000, host: '0.0.0.0' }).then(() => {
  console.log('Webhook em http://localhost:3000/webhook');
});
