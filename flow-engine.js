/**
 * FlowEngine — interpretador do seu JSON de fluxo (formato Tonoff/React Flow)
 *
 * Tipos de nó suportados:
 *   - startNode        → entrada do fluxo (cooldown_time_value/range)
 *   - captureTextNode  → envia texto + aguarda resposta + salva em variável
 *   - messageNode      → envia texto e segue
 *   - delayNode        → espera N segundos
 *   - selector         → ramifica baseado em variável (ways: contain/exact/exit)
 *   - tagNode          → marca o contato com uma variável (atalho)
 *   - imageNode        → envia mídia (você precisa resolver o ID na sua tabela de mídias)
 *
 * Saídas externas:
 *   - sendText(to, text)
 *   - sendImage(to, mediaId)
 *   - tagContact(contactId, label, value)
 *   - saveState(contactId, state)
 *   - loadState(contactId) → state | null
 *   - scheduleResume(contactId, ms)  // pra delayNode
 */

class FlowEngine {
  constructor(flowJson, adapters) {
    const { nodes, edges, nodeData } = flowJson.data;
    this.nodes = new Map(nodes.map(n => [n.id, n]));
    this.nodeData = nodeData;

    // Indexa edges por (source, sourceHandle) → target
    this.edgesBySource = new Map();
    for (const e of edges) {
      const list = this.edgesBySource.get(e.source) || [];
      list.push({ handle: e.sourceHandle, target: e.target });
      this.edgesBySource.set(e.source, list);
    }

    this.adapters = adapters;
    this.startNodeId = [...this.nodes.values()].find(n => n.type === 'startNode')?.id;
  }

  // --- Helpers --------------------------------------------------------------

  interpolate(text, vars) {
    if (typeof text !== 'string') return text;
    // Substitui %nome%, %email%, etc — case-insensitive
    return text.replace(/%(\w+)%/g, (_, key) => {
      const found = Object.entries(vars).find(([k]) => k.toLowerCase() === key.toLowerCase());
      return found ? found[1] : '';
    });
  }

  nextNodeFrom(nodeId, handleId = null) {
    const list = this.edgesBySource.get(nodeId) || [];
    if (handleId) {
      const m = list.find(e => e.handle === handleId);
      return m ? m.target : null;
    }
    return list[0]?.target || null;
  }

  matchSelector(ways, value) {
    const v = String(value || '').trim().toLowerCase();
    let exitWay = null;
    for (const w of ways) {
      if (w.type === 'exit') { exitWay = w; continue; }
      const term = String(w.term || '').trim().toLowerCase();
      if (w.type === 'exact' && v === term) return w;
      if (w.type === 'contain' && term && v.includes(term)) return w;
    }
    return exitWay; // fallback
  }

  // --- Loop principal -------------------------------------------------------

  /**
   * Inicia uma nova conversa para um contato.
   */
  async start(contactId) {
    const state = { contactId, currentNodeId: this.startNodeId, variables: {}, waiting: false };
    await this.run(state);
  }

  /**
   * Recebe uma mensagem do contato (vinda do webhook do WhatsApp).
   */
  async receiveMessage(contactId, text) {
    const state = await this.adapters.loadState(contactId);
    if (!state) return this.start(contactId); // primeira interação

    const node = this.nodes.get(state.currentNodeId);
    if (!node) return;

    // Se está parado num captureTextNode, salva resposta na variável
    if (node.type === 'captureTextNode') {
      const data = this.nodeData[node.id] || {};
      const varName = data.selectedVariable?.label;
      if (varName) state.variables[varName] = text;
      state.currentNodeId = this.nextNodeFrom(node.id);
    }
    // Se está parado num selector implícito (capture seguido de selector), o run resolve

    state.waiting = false;
    await this.run(state);
  }

  /**
   * Retomada após delayNode.
   */
  async resumeAfterDelay(contactId) {
    const state = await this.adapters.loadState(contactId);
    if (!state) return;
    state.waiting = false;
    await this.run(state);
  }

  /**
   * Loop até encontrar um nó que precisa parar (capture/delay) ou fim de fluxo.
   */
  async run(state) {
    let safety = 0;
    while (state.currentNodeId && safety++ < 200) {
      const node = this.nodes.get(state.currentNodeId);
      if (!node) break;
      const data = this.nodeData[node.id] || {};

      switch (node.type) {
        case 'startNode': {
          state.currentNodeId = this.nextNodeFrom(node.id);
          break;
        }

        case 'messageNode': {
          const text = this.interpolate(data.content, state.variables);
          await this.adapters.sendText(state.contactId, text);
          state.currentNodeId = this.nextNodeFrom(node.id);
          break;
        }

        case 'imageNode': {
          const midias = data.content?.midias || {};
          const mediaId = Object.keys(midias)[0];
          if (mediaId) await this.adapters.sendImage(state.contactId, mediaId);
          state.currentNodeId = this.nextNodeFrom(node.id);
          break;
        }

        case 'captureTextNode': {
          // Envia o prompt e PARA, esperando resposta do usuário
          const text = this.interpolate(data.content, state.variables);
          await this.adapters.sendText(state.contactId, text);
          state.waiting = true;
          await this.adapters.saveState(state.contactId, state);
          return; // sai do loop até receber mensagem
        }

        case 'delayNode': {
          const seconds = Number(data.content) || 0;
          if (seconds > 0) {
            state.waiting = true;
            await this.adapters.saveState(state.contactId, state);
            await this.adapters.scheduleResume(state.contactId, seconds * 1000);
            // O nextNode será resolvido quando resumeAfterDelay for chamado.
            // Antes disso, avançamos o ponteiro pra que o resume continue do próximo.
            state.currentNodeId = this.nextNodeFrom(node.id);
            await this.adapters.saveState(state.contactId, state);
            return;
          }
          state.currentNodeId = this.nextNodeFrom(node.id);
          break;
        }

        case 'selector': {
          const varName = data.selectedVariable?.label;
          const value = varName ? state.variables[varName] : '';
          const way = this.matchSelector(data.ways || [], value);
          state.currentNodeId = way ? this.nextNodeFrom(node.id, way.id) : null;
          break;
        }

        case 'tagNode': {
          const label = data.selectedVariable?.label;
          if (label) {
            // Procura case-insensitive (tagNode usa "NOME", variável é "Nome")
            const key = Object.keys(state.variables).find(k => k.toLowerCase() === label.toLowerCase());
            const value = key ? state.variables[key] : true;
            await this.adapters.tagContact(state.contactId, label, value);
          }
          state.currentNodeId = this.nextNodeFrom(node.id);
          break;
        }

        default:
          // Tipo desconhecido — pula
          state.currentNodeId = this.nextNodeFrom(node.id);
      }
    }

    // Fim do fluxo
    state.waiting = false;
    state.finished = !state.currentNodeId;
    await this.adapters.saveState(state.contactId, state);
  }
}

module.exports = { FlowEngine };


// =============================================================================
// EXEMPLO DE USO COM ADAPTERS EM MEMÓRIA (substitua por Postgres + Cloud API)
// =============================================================================

if (require.main === module) {
  const fs = require('fs');
  const flow = JSON.parse(fs.readFileSync(process.argv[2] || './flow.json', 'utf-8'));

  const states = new Map();
  const timers = new Map();

  const adapters = {
    sendText: async (to, text) => console.log(`\n📤 [${to}]\n${text}\n`),
    sendImage: async (to, mediaId) => console.log(`\n🖼  [${to}] image=${mediaId}\n`),
    tagContact: async (to, label, value) => console.log(`🏷  [${to}] ${label}=${value}`),
    saveState: async (id, st) => states.set(id, JSON.parse(JSON.stringify(st))),
    loadState: async (id) => states.get(id) || null,
    scheduleResume: async (id, ms) => {
      console.log(`⏱  agendado retomar em ${ms/1000}s`);
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => engine.resumeAfterDelay(id), ms));
    },
  };

  const engine = new FlowEngine(flow, adapters);

  // Simula uma conversa
  (async () => {
    const me = '5511999998888';
    await engine.start(me);
    // Espera o delay (7s) — pra demo, encurte o delay no JSON ou mock o scheduleResume
    setTimeout(async () => {
      await engine.receiveMessage(me, 'João Silva');           // responde "Nome"
      setTimeout(async () => {
        await engine.receiveMessage(me, '2');                  // escolhe Suporte
        setTimeout(async () => {
          await engine.receiveMessage(me, '1');                // escolhe primeira opção do selector2
          setTimeout(async () => {
            await engine.receiveMessage(me, 'joao@email.com'); // captura email
          }, 500);
        }, 9000);
      }, 9000);
    }, 9000);
  })();
}
