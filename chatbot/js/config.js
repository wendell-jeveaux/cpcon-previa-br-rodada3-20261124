// ============================================================
//  CPCON CHATBOT — Configurações
//  Edite aqui para personalizar sem mexer na lógica
// ============================================================

const CPCON_CONFIG = {

  // ── Identidade do atendente ──────────────────────────────
  agentName:    'Camile',
  agentInitials:'CA',
  companyName:  'CPCON',

  // ── WhatsApp ─────────────────────────────────────────────
  // Número com DDI + DDD, sem + ou espaços
  whatsappNumber: '5511962885969',

  // ── Links ────────────────────────────────────────────────
  privacyUrl: 'https://grupocpcon.com/politica-de-privacidade/',
  siteUrl:    'https://grupocpcon.com',

  // ── Comportamento ────────────────────────────────────────
  // Delay em ms para abrir WhatsApp após acionar live panel
  wppOpenDelay: 1000,

  // Delay em ms para simular agente "entrar" na conversa
  // Em produção: substituir pela conexão WebSocket real
  agentJoinDelay: 4000,

  // ── Palavras-chave que disparam contato imediato ─────────
  contactKeywords: /atend|falar com|humano|pessoa|vendedor|comercial|whatsapp|ligar|ligue|telefon|contato|quero falar|me chama|me liga|chamar|urgente|agora mesmo|imediato|suporte/i,

  // ── API LLM ──────────────────────────────────────────────
  // Modelo e key são gerenciados pelo backend (/api/chat). Nunca expor key no frontend.
  aiMaxTokens: 200,
};
