/**
 * Webhook multi-número.
 * O endpoint /webhook é ÚNICO — a Meta manda mensagens de todos os seus
 * números pra cá. A gente identifica qual número recebeu pelo
 * metadata.phone_number_id e roteia pro engine certo.
 */

const Fastify = require('fastify');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { request } = require('undici');
const { FlowEngine } = require('./flow-engine.js');

const app = Fastify({ logger: true });
const pg = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

// Cache de engines por número (carrega na primeira mensagem)
const engineCache = new Map();

async function getEngineForNumber(phoneNumberId) {
  if (engineCache.has(phoneNumberId)) return engineCache.get(phoneNumberId);

  const { rows } = await pg.query(
    `SELECT n.*, f.json AS flow_json
     FROM whatsapp_numbers n
     LEFT JOIN flows f ON f.id = n.flow_id
     WHERE n.phone_number_id = $1 AND n.active = true`,
    [phoneNumberId]
  );
  if (!rows[0]) return null;

  const number = rows[0];

  // Adapters específicos desse número (token e phone_id ficam no closure)
  const adapters = {
    sendText: (to, text) => sendCloudApi(number, to, {
      type: 'text', text: { body: text }
    }, 'out_text', text),

    sendImage: (to, mediaId) => sendCloudApi(number, to, {
      type: 'image', image: { id: mediaId }
    }, 'out_image', `[image:${mediaId}]`),

    tagContact: (to, label, value) => pg.query(
      `INSERT INTO contact_tags(contact_phone, label, value)
       VALUES($1,$2,$3)
       ON CONFLICT (contact_phone, label) DO UPDATE SET value = EXCLUDED.value`,
      [to, label, String(value)]
    ),

    // A chave do estado precisa incluir o número, senão um cliente que fala
    // com 2 números seus teria os fluxos misturados
    saveState: (contactId, state) => redis.set(
      `flow:${number.phone_number_id}:${contactId}`,
      JSON.stringify(state),
      'EX', 60 * 60 * 24 * 7
    ),

    loadState: async (contactId) => {
      const raw = await redis.get(`flow:${number.phone_number_id}:${contactId}`);
      return raw ? JSON.parse(raw) : null;
    },

    scheduleResume: (contactId, ms) => {
      // Em produção: BullMQ com job que sabe qual phoneNumberId retomar
      setTimeout(() => engine.resumeAfterDelay(contactId).catch(console.error), ms);
    },
  };

  const engine = new FlowEngine(number.flow_json, adapters);
  engineCache.set(phoneNumberId, engine);
  return engine;
}

async function sendCloudApi(number, to, payload, kind, logBody) {
  const url = `https://graph.facebook.com/v22.0/${number.phone_number_id}/messages`;
  const { statusCode, body } = await request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${number.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...payload }),
  });
  if (statusCode >= 300) {
    const err = await body.text();
    throw new Error(`Cloud API ${statusCode}: ${err}`);
  }
  await pg.query(
    `INSERT INTO messages(contact_phone, whatsapp_number_id, direction, body, sent_at)
     VALUES($1,$2,'out',$3,NOW())`,
    [to, number.id, logBody]
  );
}

// --- Webhook ÚNICO recebendo de todos os números -----------------------------

app.get('/webhook', async (req, reply) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
    return reply.send(req.query['hub.challenge']);
  }
  return reply.code(403).send();
});

app.post('/webhook', async (req, reply) => {
  reply.send({ ok: true });

  const change = req.body?.entry?.[0]?.changes?.[0]?.value;
  const phoneNumberId = change?.metadata?.phone_number_id;
  const message = change?.messages?.[0];
  if (!phoneNumberId || !message) return;

  const engine = await getEngineForNumber(phoneNumberId);
  if (!engine) {
    app.log.warn(`Mensagem recebida em número não cadastrado: ${phoneNumberId}`);
    return;
  }

  const from = message.from;
  const text = message.text?.body || message.button?.text || '';
  if (!text) return;

  // Loga
  const { rows } = await pg.query(
    'SELECT id FROM whatsapp_numbers WHERE phone_number_id = $1',
    [phoneNumberId]
  );
  await pg.query(
    `INSERT INTO messages(contact_phone, whatsapp_number_id, direction, body, sent_at)
     VALUES($1,$2,'in',$3,NOW())`,
    [from, rows[0].id, text]
  );

  // Verifica takeover (agora considerando o número também)
  const tk = await pg.query(
    `SELECT human_takeover FROM contacts
     WHERE phone = $1 AND whatsapp_number_id = $2`,
    [from, rows[0].id]
  );
  if (tk.rows[0]?.human_takeover) return;

  await engine.receiveMessage(from, text);
});

// CRUD pra cadastrar números pelo painel
app.post('/numbers', async (req) => {
  const { phone_number_id, display_number, label, access_token, flow_id } = req.body;
  const { rows } = await pg.query(
    `INSERT INTO whatsapp_numbers(phone_number_id, display_number, label, access_token, flow_id)
     VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [phone_number_id, display_number, label, access_token, flow_id]
  );
  return { id: rows[0].id };
});

app.listen({ port: 3000, host: '0.0.0.0' });
