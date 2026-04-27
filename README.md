# Botzap

Robô de atendimento WhatsApp do Instituto TONOFF.

Recebe mensagens via WhatsApp Cloud API (Meta) e executa um fluxo de atendimento
configurável em JSON, com suporte a múltiplos números na mesma instância.

## Stack

- Node.js 20+
- Fastify (HTTP/webhook)
- PostgreSQL (mensagens, contatos, tags)
- Redis (estado da conversa)
- WhatsApp Cloud API (Graph API v22)

## Estrutura

```
flow-engine.js   → interpretador do JSON de fluxo
server-multi.js  → webhook + adapters Cloud API
index.sql        → schema do banco
flow.json        → fluxo de atendimento (NÃO commitado)
.env             → credenciais (NÃO commitado)
```

## Setup local

1. Instalar dependências:
   ```bash
   npm install
   ```

2. Copiar o template de variáveis e preencher:
   ```bash
   cp .env.example .env
   ```

3. Criar o banco e rodar o schema:
   ```bash
   createdb botzap
   psql botzap < index.sql
   ```

4. Subir Redis local (Docker é o caminho mais rápido):
   ```bash
   docker run -d -p 6379:6379 redis
   ```

5. Colocar seu fluxo em `flow.json` na raiz do projeto.

6. Rodar:
   ```bash
   npm start
   ```

## Configuração na Meta

1. Criar app em [developers.facebook.com](https://developers.facebook.com)
2. Adicionar produto **WhatsApp**
3. Cadastrar e verificar números na WhatsApp Business Account
4. Em **Webhooks**, apontar para `https://seu-dominio.com/webhook` com o
   mesmo `WA_VERIFY_TOKEN` do `.env`
5. Inscrever nos eventos: `messages`
6. Cadastrar cada número na tabela `whatsapp_numbers` via `POST /numbers`

## Deploy

Pra rodar em produção (24h), use Railway, Fly.io, Render ou uma VPS.
O webhook precisa de HTTPS público — em desenvolvimento use ngrok.

## Segurança

- Nunca comite `.env` ou tokens
- Nunca comite `flow.json` se ele tiver dados sensíveis
- Use System User na Meta com escopo limitado por número
