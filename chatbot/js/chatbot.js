// ============================================================
//  CPCON CHATBOT — Camile v2 (fluxo controlado pelo backend)
//  Dependências: config.js, ui.js, api.js (já carregados antes)
// ============================================================

// ── Turnstile REMOVIDO 2026-05-02 ──
// Widget Turnstile carregava 130KB de JS Cloudflare + Web Workers pesados,
// quebrava em mobile/Safari ITP e zerava leads silenciosamente. Substituído
// por: signed form token (GET /api/leads/form-token) + rate limit per-IP
// + honeypot (cpcon_hp_a) + validação Zod + pre-filtros LLM.
// Origin allowlist sozinho NÃO autentica — o POST exige o token HMAC.
//
// Stubs mantidos pra compat de chamadas existentes:

// 17/10/2026 (form infalível): quem mexeu num formulário da página nos últimos
// 60 s não perde o foco para a Camile.
var cpconPageFormAt = 0;
document.addEventListener('focusin', function (e) {
  var t = e.target;
  if (t && t.form && !(t.closest && t.closest('#cpcon-inline-form'))) cpconPageFormAt = Date.now();
}, true);
function cpconPageFormBusy() {
  var a = document.activeElement;
  var inPage = a && a.form && !(a.closest && a.closest('#cpcon-inline-form'));
  return !!inPage || Date.now() - cpconPageFormAt < 60000;
}

function cpconRenderTurnstileInForm(_containerEl) { /* noop */ }
function cpconGetTurnstileToken() {
  return Promise.resolve('');
}

// ── Estado ─────────────────────────────────────────────────
const CRM_PROXY_URL = '/api/leads';
const CHAT_URL = '/api/chat';

async function cpconFetchFormToken() {
  const res = await fetch('/api/leads/form-token', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('form-token HTTP ' + res.status);
  const data = await res.json().catch(function () { return null; });
  if (!data || !data.form_token) throw new Error('form-token missing');
  return data.form_token;
}

const cpconState = {
  isOpen: false,
  started: false,
  sessionId: null,
  // sessionToken: HMAC emitido pelo /api/leads/chatbot após captura do
  // formulário inicial. Próximas chamadas (/api/chat,
  // /api/atendimento/iniciar) enviam isso como prova de autorização.
  sessionToken: '',
  stage: 'idle',
  transferred: false,
  history: [],            // [{role, content}]
  busy: false,
  userName: '',
  userEmail: '',
  userPhone: '',
  phoneCountry: 'BR',
  notRobot: false,
  userEmpresa: '',
  leadId: null,
  lastActivityAt: 0,
  reengageTimer: null,
  // Legacy fields (compat com api.js antigo). Não usados pela UI nova.
  handoffReady: false,
  camileLocked: false,
  responsesAfterHandoffReady: 0,
  // PR camile-ux-perf-2026-05-03 — fluxo novo
  handoffOffered: false,
  conversationEnded: false,
  lastSegment: null,
  lastTema: null,
  turns: 0,
};

// ── Validações do form inicial (iguais à versão antiga) ─────
const BLOCKED_NAMES = /^(oi|ola|olá|hey|hi|hello|boa|bom|bom\s*dia|boa\s*tarde|boa\s*noite|e|ee|eh|blz|beleza|opa|salve|ok|sim|nao|não|teste|test|asdf|aaa|xxx|kkk|haha|hehe)$/i;
const VOWEL_RE = /[aeiouáéíóúâêîôûãõ]/i;
function validarNome(n) {
  const t = (n || '').trim();
  if (t.length < 3 || !VOWEL_RE.test(t) || BLOCKED_NAMES.test(t)) return null;
  // Nome COMPLETO — split(' ')[0] cortava o sobrenome de todo lead do chat
  // no CRM (comercial recebia só o primeiro nome). O primeiro nome para
  // tratamento pessoal fica por conta do LLM, que recebe o nome inteiro.
  return t.replace(/\s+/g, ' ');
}
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
const DISPOSABLE = /^(tempmail|mailinator|guerrillamail|10minutemail|throwaway|yopmail|fakeinbox|trashmail|sharklasers)\./i;
function validarEmail(e) {
  const t = (e || '').trim().toLowerCase();
  if (!EMAIL_RE.test(t)) return null;
  if (DISPOSABLE.test(t.split('@')[1])) return null;
  return t;
}
function validarTelefone(p) {
  const d = (p || '').replace(/\D/g, '');
  if (d.length < 8) return '';
  return p.trim();
}
function validarEmpresa(e) {
  const t = (e || '').trim();
  if (t.length < 2) return null;
  return t;
}

// ── Captura de contato em TEXTO LIVRE (fix 2026-07-20) ───────────────
// Regra nº1 = NUNCA perder lead. Antes, o lead só era salvo pelos campos
// do formulário (cpconState.userEmail/userPhone). Se o cliente DIGITAVA
// os dados na conversa (comportamento natural), nada era capturado e, no
// handoff pro WhatsApp, o save ia com email/telefone vazios → rejeitado →
// LEAD PERDIDO. Agora, a cada mensagem, extraímos email/telefone/nome do
// texto e populamos o estado, pra o save SEMPRE ter os dados.
function cpconExtractContact(text) {
  var s = String(text || '');
  if (!s) return;
  // EMAIL (primeiro que casar + validação existente, ignora descartáveis)
  if (!cpconState.userEmail) {
    var em = (s.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i) || [])[0];
    var ev = em ? validarEmail(em) : null;
    if (ev) cpconState.userEmail = ev;
  }
  // TELEFONE (8+ dígitos; aceita "(", +, espaço, () e -)
  if (!cpconState.userPhone) {
    var pm = s.match(/\(?\+?\d[\d\s().\-]{6,}\d/);
    var pv = pm ? validarTelefone(pm[0]) : '';
    if (pv) cpconState.userPhone = pv;
  }
  // NOME: só quando já há email (obrigatório pro lead). Prioriza padrão
  // explícito ("meu nome é X" / "sou o/a X" / "me chamo X"); senão um nome
  // próprio Capitalizado antes do email; por fim a parte local do email.
  // Nunca captura frase solta ("quero orçamento") como nome.
  if (!cpconState.userName && cpconState.userEmail) {
    var nm = '';
    var mn = s.match(/(?:meu nome (?:é|e)|me chamo|sou (?:o|a)|nome[:\-])\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-]+(?:\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-]+){0,2})/i);
    if (mn && mn[1]) nm = mn[1].trim();
    if (nm.length < 2) {
      var head = s.split(/[a-z0-9._%+\-]+@/i)[0];
      var cap = (head.match(/[A-ZÀ-Ý][a-zà-ÿ'\-]{1,}(?:\s+[A-ZÀ-Ý][a-zà-ÿ'\-]{1,}){0,2}/) || [''])[0]
        .replace(/^(Oi|Ola|Olá|Boa|Bom|Meu|Minha|Prezad[oa]s?|Car[oa]s?)\s+/i, '').trim();
      if (cap.length >= 2) nm = cap;
    }
    if (nm.length < 2) nm = cpconState.userEmail.split('@')[0].replace(/[._\-]+/g, ' ').trim();
    if (nm.length >= 2) cpconState.userName = nm.slice(0, 120);
  }
}

// ── Helpers UI (reutiliza os existentes: cpconSay, cpconMeMsg, etc) ─

function cpconScheduleReengage() {
  if (cpconState.reengageTimer) clearTimeout(cpconState.reengageTimer);
  if (cpconState.transferred) return;
  if (cpconState.stage !== 'chat' && cpconState.stage !== 'greeting') return;
  cpconState.reengageTimer = setTimeout(function () {
    if (Date.now() - cpconState.lastActivityAt < 60000) return;
    if (cpconState.transferred) return;
    cpconSay('Tá por aí?', function () { cpconEnableInput(); });
  }, 60000);
}

// ── Toggle + greeting ──────────────────────────────────────

// Acessibilidade (02/10): a janela nascia com aria-hidden="true" e continuava
// assim depois de aberta, então leitor de tela não lia nada do chat. Aberta:
// sem aria-hidden e sem inert, e o foco entra na janela. Fechada:
// aria-hidden + inert (fora da tabulação, já que ela só fica transparente),
// e o foco volta para quem abriu.
let cpconOpener = null;
function cpconSyncA11y(chat) {
  const open = chat.classList.contains('open');
  if (open) {
    chat.removeAttribute('aria-hidden');
    chat.removeAttribute('inert');
    if (!chat.contains(document.activeElement)) {
      cpconOpener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      const first = chat.querySelector('.cpcon-hdr-close');
      if (first) setTimeout(function () { if (!chat.contains(document.activeElement)) first.focus(); }, 50);
    }
  } else {
    const hadFocus = chat.contains(document.activeElement);
    chat.setAttribute('aria-hidden', 'true');
    chat.setAttribute('inert', '');
    if (hadFocus) {
      const back = cpconOpener && document.contains(cpconOpener) && cpconOpener.offsetParent !== null
        ? cpconOpener
        : document.getElementById('cpcon-sticky');
      if (back && typeof back.focus === 'function') back.focus();
    }
    cpconOpener = null;
  }
}

function cpconToggle() {
  const chat = document.getElementById('cpcon-chat');
  const isCurrentlyOpen = chat.classList.contains('open');
  const willOpen = !isCurrentlyOpen;

  // PR camile-ux-perf-2026-05-03 — telemetria abertura do widget.
  if (willOpen) {
    try {
      (window.dataLayer = window.dataLayer || []).push({
        event: 'camile_widget_opened',
        source: window.__cpconStickyClicked ? 'sticky_button' : 'fab',
        page_path: window.location.pathname,
      });
    } catch (e) { /* analytics opcional */ }
    window.__cpconStickyClicked = false;
    // Esconde o botão sticky enquanto janela aberta (volta no fechar).
    const sticky = document.getElementById('cpcon-sticky');
    if (sticky) sticky.style.display = 'none';
  } else {
    const sticky = document.getElementById('cpcon-sticky');
    if (sticky) sticky.style.display = '';
  }

  if (isCurrentlyOpen && !cpconState.started) {
    document.getElementById('cpcon-msgs').innerHTML = '';
    cpconState.isOpen = true;
    cpconState.started = true;
    cpconSyncA11y(chat);
    setTimeout(cpconFlowGreeting, 300);
    return;
  }
  cpconState.isOpen = willOpen;
  chat.classList.toggle('open', cpconState.isOpen);
  // 02/11/2026: hora de abertura (proteção contra clique-fantasma, ver cpconCaptureGuard).
  if (cpconState.isOpen) cpconState.openedAt = Date.now();
  cpconSyncA11y(chat);
  const badge = document.getElementById('cpcon-badge');
  if (badge) badge.style.display = 'none';
  if (cpconState.isOpen && !cpconState.started) {
    cpconState.started = true;
    setTimeout(cpconFlowGreeting, 500);
  }
}

function cpconFlowGreeting() {
  // Aviso discreto sobre proteção de dados
  cpconAppendNotice('Não compartilhe senhas, CPF ou dados de cartão aqui.');
  cpconSay(
    'Bom dia. Sou ' + (window.CPCON_CONFIG && window.CPCON_CONFIG.agentName ? window.CPCON_CONFIG.agentName : 'Camile') + ', assistente comercial do CPCON Group. Para que possamos auxiliá-lo(a), gentileza compartilhar seus dados de contato:',
    function () {
      cpconState.stage = 'form';
      cpconDisableInput();
      cpconShowInlineForm();
    }
  );
}

function cpconAppendNotice(text) {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const n = document.createElement('div');
  n.className = 'cpcon-notice';
  // a11y (2026-06-07): #64748b sobre #f1f5f9 = 4.34:1 (reprova WCAG AA por pouco).
  // #576475 = 5.5:1, escurecimento mínimo mantendo o tom neutro do aviso.
  n.style.cssText = 'font-size:11px;color:#576475;padding:6px 12px;text-align:center;background:#f1f5f9;border-radius:6px;margin:4px 12px;';
  n.textContent = text;
  container.appendChild(n);
  cpconScrollDown();
}

function cpconGetPhoneApi() {
  return window.cpconPhoneApi || null;
}

function cpconPhoneButtonLabel(option) {
  if (!option) return '🇧🇷 Brasil +55';
  return option.flag + ' ' + option.name + ' +' + option.dial;
}

function cpconHoneypotValues() {
  // A página pode ter o mesmo id na armadilha de outro formulário.
  // O chat lê só a armadilha do próprio formulário.
  const root = document.getElementById('cpcon-inline-form') || document;
  function read(id) {
    return (root.querySelector('#' + id) || {}).value || '';
  }
  return {
    cpcon_hp_a: read('cpcon-hp-a'),
    cpcon_hp_b: read('cpcon-hp-b'),
    cpcon_hp_c: read('cpcon-hp-c'),
  };
}

// ── Telemetria da captura (16/10/2026) ─────────────────────
// Funil da captura da Camile: capture_shown → capture_submitted, ou
// capture_rejected{reason: robot_box|phone|country|other}. Vai para o mesmo
// /api/form-telemetry dos formulários. Só códigos e nomes de campo: nada do
// que a pessoa digitou (sem nome, e-mail, empresa ou telefone).
var CPCON_TELEMETRY_URL = '/api/form-telemetry';
function cpconCaptureTelemetry(event, extra) {
  try {
    var body = { event: event, page: window.location.pathname.slice(0, 200), form: 'camile' };
    if (extra && extra.reason) body.reason = extra.reason;
    if (extra && extra.fields && extra.fields.length) body.fields = extra.fields.slice(0, 12);
    if (extra && extra.errors && extra.errors.length) body.errors = extra.errors.slice(0, 12);
    if (extra && /^[A-Z]{2}$/.test(extra.phone_country || '')) body.phone_country = extra.phone_country;
    var json = JSON.stringify(body);
    if (navigator.sendBeacon && navigator.sendBeacon(CPCON_TELEMETRY_URL, new Blob([json], { type: 'application/json' }))) return;
    fetch(CPCON_TELEMETRY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true, credentials: 'same-origin' }).catch(function () {});
  } catch (e) { /* telemetria nunca quebra o chat */ }
}

function cpconSetFieldError(input, errEl, msg) {
  if (errEl) errEl.textContent = msg || '';
  if (input) {
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    if (errEl && errEl.id) input.setAttribute('aria-describedby', errEl.id);
  }
}

function cpconShowInlineForm() {
  const api = cpconGetPhoneApi();
  const container = document.getElementById('cpcon-msgs');
  const formRow = document.createElement('div');
  formRow.className = 'cpcon-row';
  formRow.id = 'cpcon-inline-form';
  const placeholder = api ? api.placeholder('BR') : '';
  formRow.innerHTML =
    '<div class="cpcon-av"><img src="/chatbot/images/camile.webp" alt="Camile" width="26" height="26"/></div>' +
    '<div class="cpcon-bbl cpcon-form-bbl">' +
    '  <div class="cpcon-form-group"><input type="text" id="cpcon-form-nome" placeholder="Nome *" maxlength="100" autocomplete="given-name"/><div id="cpcon-form-nome-err" class="cpcon-form-err" role="alert"></div></div>' +
    '  <div class="cpcon-form-group"><input type="email" id="cpcon-form-email" placeholder="Email corporativo *" maxlength="200" autocomplete="email"/><div id="cpcon-form-email-err" class="cpcon-form-err" role="alert"></div></div>' +
    '  <div class="cpcon-form-group"><input type="text" id="cpcon-form-empresa" placeholder="Empresa *" maxlength="120" autocomplete="organization"/><div id="cpcon-form-empresa-err" class="cpcon-form-err" role="alert"></div></div>' +
    '  <div class="cpcon-form-group">' +
    '    <div class="cpcon-phone-row">' +
    '      <button type="button" id="cpcon-phone-cc" aria-haspopup="listbox" aria-expanded="false" aria-controls="cpcon-phone-list" aria-label="País do telefone, Brasil +55">🇧🇷 Brasil +55</button>' +
    '      <input type="tel" id="cpcon-form-tel" name="tel" placeholder="' + placeholder + '" autocomplete="tel" inputmode="tel" aria-label="Telefone"/>' +
    '    </div>' +
    '    <div id="cpcon-phone-pop" class="cpcon-phone-pop" hidden>' +
    '      <input type="text" id="cpcon-phone-search" placeholder="Buscar país ou código" aria-label="Buscar país" autocomplete="off" data-1p-ignore="true" data-lpignore="true"/>' +
    '      <ul id="cpcon-phone-list" role="listbox" aria-label="Países"></ul>' +
    '    </div>' +
    '    <div id="cpcon-form-tel-err" class="cpcon-form-err" role="alert"></div>' +
    '  </div>' +
    '  <div class="cpcon-form-actions">' +
    '    <label class="cpcon-robot" for="cpcon-not-robot"><input type="checkbox" id="cpcon-not-robot" autocomplete="off" aria-describedby="cpcon-robot-err"/> <span>Não sou robô</span></label>' +
    '    <button type="button" id="cpcon-form-btn">Continuar</button>' +
    '  </div>' +
    '  <div id="cpcon-robot-err" class="cpcon-form-err" role="alert"></div>' +
    '  <div class="cpcon-hp" aria-hidden="true">' +
    '    <input type="text" name="cpcon_hp_a" id="cpcon-hp-a" tabindex="-1" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other"/>' +
    '    <input type="text" name="cpcon_hp_b" id="cpcon-hp-b" tabindex="-1" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other"/>' +
    '    <input type="text" name="cpcon_hp_c" id="cpcon-hp-c" tabindex="-1" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other"/>' +
    '  </div>' +
    '</div>';
  container.appendChild(formRow);
  cpconScrollDown();
  cpconCaptureTelemetry('capture_shown');
  cpconState.formShownAt = Date.now();
  document.getElementById('cpcon-not-robot').addEventListener('change', function (e) {
    if (e.target.checked) cpconSetFieldError(e.target, document.getElementById('cpcon-robot-err'), '');
  });
  const nome = document.getElementById('cpcon-form-nome');
  const email = document.getElementById('cpcon-form-email');
  const empresa = document.getElementById('cpcon-form-empresa');
  const tel = document.getElementById('cpcon-form-tel');
  nome.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); email.focus(); } });
  email.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); empresa.focus(); } });
  empresa.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tel.focus(); } });
  tel.addEventListener('keydown', cpconPhoneEnter);
  tel.addEventListener('input', cpconMaskPhoneInput);
  // 16/11/2026: teclado que compõe (Samsung etc.): máscara só quando a composição termina.
  tel.addEventListener('compositionend', function (e) { cpconMaskPhoneInput({ target: e.target }); });
  document.getElementById('cpcon-form-btn').addEventListener('click', function () { cpconSubmitForm(); });
  document.getElementById('cpcon-phone-cc').addEventListener('click', cpconTogglePhoneList);
  document.getElementById('cpcon-phone-search').addEventListener('input', cpconRenderPhoneList);
  document.getElementById('cpcon-phone-search').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); cpconClosePhoneList(); }
    if (e.key === 'Enter') { e.preventDefault(); var first = document.querySelector('#cpcon-phone-list [data-iso]'); if (first) cpconPickPhoneCountry(first.getAttribute('data-iso')); }
  });
  cpconState.phoneCountry = 'BR';
  if (api) {
    const brazil = api.countries().filter(function (c) { return c.iso === 'BR'; })[0];
    const ccBtn = document.getElementById('cpcon-phone-cc');
    if (ccBtn && brazil) {
      ccBtn.textContent = cpconPhoneButtonLabel(brazil);
      ccBtn.setAttribute('aria-label', 'País do telefone, ' + brazil.name + ' +' + brazil.dial);
    }
  }
  // 17/10/2026 (form infalível): a Camile não rouba o foco de quem está
  // preenchendo um formulário da página (abertura automática).
  if (!cpconPageFormBusy()) nome.focus();
}

function cpconTogglePhoneList() {
  const pop = document.getElementById('cpcon-phone-pop');
  const btn = document.getElementById('cpcon-phone-cc');
  if (!pop || !btn) return;
  const willOpen = pop.hasAttribute('hidden');
  if (willOpen) {
    pop.removeAttribute('hidden');
    btn.setAttribute('aria-expanded', 'true');
    cpconRenderPhoneList();
    const search = document.getElementById('cpcon-phone-search');
    if (search) search.focus();
  } else {
    cpconClosePhoneList();
  }
}

function cpconClosePhoneList() {
  const pop = document.getElementById('cpcon-phone-pop');
  const btn = document.getElementById('cpcon-phone-cc');
  if (pop) pop.setAttribute('hidden', '');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function cpconRenderPhoneList() {
  const api = cpconGetPhoneApi();
  const list = document.getElementById('cpcon-phone-list');
  const search = document.getElementById('cpcon-phone-search');
  if (!api || !list) return;
  const q = ((search && search.value) || '').trim().toLowerCase().replace(/^\+/, '');
  const all = api.countries();
  const rows = !q ? all : all.filter(function (c) {
    return c.name.toLowerCase().indexOf(q) !== -1 || c.iso.toLowerCase().indexOf(q) !== -1 || c.dial.indexOf(q) !== -1;
  });
  list.innerHTML = '';
  rows.slice(0, 40).forEach(function (c) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('data-iso', c.iso);
    b.textContent = c.flag + ' ' + c.name + ' +' + c.dial;
    b.addEventListener('click', function () { cpconPickPhoneCountry(c.iso); });
    li.appendChild(b);
    list.appendChild(li);
  });
}

function cpconPickPhoneCountry(iso) {
  const api = cpconGetPhoneApi();
  const tel = document.getElementById('cpcon-form-tel');
  const btn = document.getElementById('cpcon-phone-cc');
  if (!api || !iso) return;
  cpconState.phoneCountry = iso;
  const option = api.countries().filter(function (c) { return c.iso === iso; })[0];
  if (btn && option) {
    btn.textContent = cpconPhoneButtonLabel(option);
    btn.setAttribute('aria-label', 'País do telefone, ' + option.name + ' +' + option.dial);
  }
  if (tel) {
    const applied = api.applyInput(tel.value, iso);
    if (applied) {
      tel.value = applied.national;
      cpconState.phoneCountry = applied.country;
    }
    tel.placeholder = api.placeholder(cpconState.phoneCountry);
    tel.focus();
  }
  cpconClosePhoneList();
}

// 16/11/2026 — causa raiz das recusas telefono:phone_invalid em Android (ES 16/11,
// Samsung Galaxy no navegador do TikTok): teclados que digitam por "composição"
// (teclado Samsung com texto preditivo e outros IME) mandam cada dígito como
// texto em composição. Reescrever o campo (máscara) no meio da composição faz o
// teclado reinserir a "palavra" inteira: o número saía com dígitos repetidos
// (número errado ou inválido). Padrão CPCON (igual nos 6 sites): durante a
// composição o campo fica como a pessoa digitou; a máscara entra no fim da
// composição (compositionend). A validação do envio continua igual.
function cpconImeComposing(e) {
  return !!(e && (e.isComposing || e.inputType === 'insertCompositionText'));
}

// 16/11/2026: Enter/"Ir" do teclado no telefone com a caixa "Não sou robô"
// desmarcada não envia às cegas (com o teclado aberto a caixa e o botão ficam
// fora da tela): fecha o teclado, leva a pessoa até a caixa e mostra o aviso.
function cpconPhoneEnter(e) {
  if (e.key !== 'Enter' || cpconImeComposing(e)) return;
  e.preventDefault();
  var robot = document.getElementById('cpcon-not-robot');
  if (robot && !robot.checked) {
    cpconSetFieldError(robot, document.getElementById('cpcon-robot-err'), 'Marque a caixa "Não sou robô" ao lado do botão para enviar.');
    cpconCaptureTelemetry('capture_rejected', { reason: 'robot_box', fields: ['nao_sou_robo'], errors: ['nao_sou_robo:robot_box'], phone_country: cpconState.phoneCountry });
    try { e.target.blur(); robot.focus(); robot.scrollIntoView({ block: 'center' }); } catch (err) { /* ok */ }
    return;
  }
  cpconSubmitForm();
}

function cpconMaskPhoneInput(e) {
  if (cpconImeComposing(e)) return;
  const api = cpconGetPhoneApi();
  if (!api) return;
  const applied = api.applyInput(e.target.value, cpconState.phoneCountry || 'BR');
  if (!applied) return;
  cpconState.phoneCountry = applied.country;
  e.target.value = applied.national;
  const btn = document.getElementById('cpcon-phone-cc');
  const option = api.countries().filter(function (c) { return c.iso === applied.country; })[0];
  if (btn && option) {
    btn.textContent = cpconPhoneButtonLabel(option);
    btn.setAttribute('aria-label', 'País do telefone, ' + option.name + ' +' + option.dial);
  }
}

// 02/11/2026 — causa raiz das recusas "todos os campos inválidos" (MX 01-02/11):
// o painel abre sozinho (ou é aberto) e o toque/clique que a pessoa ia dar na
// página cai no botão de envio 0-4 s depois, com o formulário VAZIO. Nada ia
// ao servidor, mas a pessoa via 4-5 erros vermelhos e ia embora.
// Padrão CPCON (igual nos 6 sites):
//  - clique < CPCON_GHOST_MS após abrir o painel/mostrar o formulário = clique-fantasma:
//    não valida nem pinta erro; só registra form:ghost_click.
//  - formulário todo vazio = uma mensagem clara no 1º campo + foco; registra form:empty.
// Nunca envia ao servidor nesses casos. Validação normal segue igual.
var CPCON_GHOST_MS = 800;
var CPCON_EMPTY_MSG = 'Preencha nome, email, empresa e telefone para começar a conversa.';
function cpconCaptureGuard() {
  var since = Date.now() - Math.max(cpconState.openedAt || 0, cpconState.formShownAt || 0);
  if (since < CPCON_GHOST_MS) {
    cpconCaptureTelemetry('capture_rejected', { reason: 'other', fields: ['form'], errors: ['form:ghost_click'] });
    return false;
  }
  var ids = ['cpcon-form-nome', 'cpcon-form-email', 'cpcon-form-empresa', 'cpcon-form-tel'];
  var empty = ids.every(function (id) { var el = document.getElementById(id); return !el || !String(el.value || '').trim(); });
  if (empty) {
    var n = document.getElementById('cpcon-form-nome');
    cpconSetFieldError(n, document.getElementById('cpcon-form-nome-err'), CPCON_EMPTY_MSG);
    cpconCaptureTelemetry('capture_rejected', { reason: 'other', fields: ['form'], errors: ['form:empty'] });
    if (n && n.focus) { try { n.focus(); n.scrollIntoView({ block: 'center' }); } catch (e) { /* ok */ } }
    return false;
  }
  return true;
}

async function cpconSubmitForm() {
  if (!cpconCaptureGuard()) return;
  const nomeInp = document.getElementById('cpcon-form-nome');
  const emailInp = document.getElementById('cpcon-form-email');
  const empresaInp = document.getElementById('cpcon-form-empresa');
  const telInp = document.getElementById('cpcon-form-tel');
  const nomeErr = document.getElementById('cpcon-form-nome-err');
  const emailErr = document.getElementById('cpcon-form-email-err');
  const empresaErr = document.getElementById('cpcon-form-empresa-err');
  const telErr = document.getElementById('cpcon-form-tel-err');
  const robotErr = document.getElementById('cpcon-robot-err');
  const robotBox = document.getElementById('cpcon-not-robot');
  cpconSetFieldError(nomeInp, nomeErr, ''); cpconSetFieldError(emailInp, emailErr, '');
  cpconSetFieldError(empresaInp, empresaErr, ''); cpconSetFieldError(telInp, telErr, '');
  cpconSetFieldError(robotBox, robotErr, '');
  const nome = validarNome(nomeInp.value);
  const email = validarEmail(emailInp.value);
  const empresa = validarEmpresa(empresaInp.value);
  const api = cpconGetPhoneApi();
  // 16/10/2026: país pelo DDI digitado (+351…); sem DDI = bandeira; sem país = BR.
  const phone = !api ? { ok: false, reason: 'other' }
    : (api.resolve ? api.resolve(telInp.value, cpconState.phoneCountry || 'BR') : api.validate(telInp.value, cpconState.phoneCountry || 'BR'));
  const failed = []; // [campo, chave, elemento] na ordem da tela
  if (!nome) { cpconSetFieldError(nomeInp, nomeErr, 'Nome válido (mín. 3 letras)'); failed.push(['nome', 'name_invalid', nomeInp]); }
  if (!email) { cpconSetFieldError(emailInp, emailErr, 'Email corporativo válido'); failed.push(['email', 'email_invalid', emailInp]); }
  if (!empresa) { cpconSetFieldError(empresaInp, empresaErr, 'Empresa válida (mín. 2 letras)'); failed.push(['empresa', 'company_invalid', empresaInp]); }
  if (!api) { cpconSetFieldError(telInp, telErr, 'Não foi possível validar o telefone. Recarregue a página.'); failed.push(['tel', 'phone_api_missing', telInp]); }
  // 17/10/2026: campo vazio = obrigatório (não "inválido").
  else if (!String(telInp.value || '').replace(/[^0-9\u0660-\u0669\u06F0-\u06F9]/g, '')) { cpconSetFieldError(telInp, telErr, 'O telefone é obrigatório.'); failed.push(['tel', 'phone_invalid', telInp]); }
  else if (!phone.ok && phone.reason === 'country') { cpconSetFieldError(telInp, telErr, 'Código de país (DDI) não reconhecido. Confira o número ou escolha o país na lista.'); failed.push(['tel', 'phone_country', telInp]); }
  else if (!phone.ok) { cpconSetFieldError(telInp, telErr, 'Informe um telefone válido (com DDD). De outro país? Digite com + e o código, ex.: +351…'); failed.push(['tel', 'phone_invalid', telInp]); }
  if (!robotBox || !robotBox.checked) {
    cpconSetFieldError(robotBox, robotErr, 'Marque a caixa "Não sou robô" ao lado do botão para enviar.');
    failed.push(['nao_sou_robo', 'robot_box', robotBox]);
  }
  if (failed.length) {
    const keys = failed.map(function (f) { return f[1]; });
    const reason = keys.indexOf('robot_box') !== -1 ? 'robot_box'
      : keys.indexOf('phone_country') !== -1 ? 'country'
      : (keys.indexOf('phone_invalid') !== -1 || keys.indexOf('phone_api_missing') !== -1) ? 'phone' : 'other';
    cpconCaptureTelemetry('capture_rejected', {
      reason: reason,
      fields: failed.map(function (f) { return f[0]; }),
      errors: failed.map(function (f) { return f[0] + ':' + f[1]; }),
      phone_country: cpconState.phoneCountry,
    });
    const first = failed[0][2];
    if (first && first.focus) { try { first.focus(); first.scrollIntoView({ block: 'center' }); } catch (e) { /* ok */ } }
    return;
  }

  cpconState.userName = nome;
  cpconState.userEmail = email;
  cpconState.userEmpresa = empresa;
  cpconState.userPhone = phone.e164;
  cpconState.phoneCountry = phone.country;
  cpconState.notRobot = true;
  cpconCaptureTelemetry('capture_submitted', { phone_country: phone.country });

  // Cria lead inicial no CRM (fire-and-forget — não bloqueia o chat).
  // Token HMAC (GET /api/leads/form-token) + rate limit + honeypot + Zod.
  try {
    {
      const leadFields = Object.assign({
        nome: nome,
        email: email,
        telefone: phone.e164,
        phone_country: phone.country,
        nao_sou_robo: true,
        empresa: empresa,
        origem: 'chatbot_camile',
        pagina: window.location.pathname,
        _render_elapsed_ms: 5000,
      }, cpconHoneypotValues());
      const postLead = async function () {
        const form_token = await cpconFetchFormToken();
        return fetch(CRM_PROXY_URL + '/chatbot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(Object.assign({}, leadFields, { form_token: form_token })),
        }).then(function (r) {
          return r.json().then(function (data) { return data || { ok: false }; }).catch(function () { return null; });
        }).catch(function () { return null; });
      };
      // O lead é criado AQUI, antes de qualquer conversa. Falha de rede
      // tenta uma vez. Erro de validação (422) mostra a mensagem e para.
      let resp = await postLead();
      if (!resp) {
        await new Promise(function (r) { setTimeout(r, 1500); });
        resp = await postLead();
      }
      if (!resp || !resp.lead_id) {
        cpconCaptureTelemetry('capture_rejected', { reason: 'other', errors: [resp ? 'server:rejected' : 'server:network'], phone_country: phone.country });
        telErr.textContent = (resp && resp.error) || 'Não foi possível registrar o contato agora. Tente novamente em instantes ou ligue para +55 11 3053-3535.';
        return;
      }
      cpconState.leadId = resp.lead_id;
      document.getElementById('cpcon-inline-form')?.remove();
      cpconMeMsg(nome + ' — ' + email + ' — ' + empresa + ' — ' + phone.e164);
      // Captura session_token + session_id emitidos pelo backend.
      // Próximas chamadas (/api/chat, /api/atendimento/iniciar) usam
      // isso em vez de gerar novo Turnstile token (que é single-use
      // em Managed mode e não pode ser reusado entre fetches).
      if (resp && resp.session_token) cpconState.sessionToken = resp.session_token;
      if (resp && resp.session_id) cpconState.sessionId = resp.session_id;
      // dataLayer: generate_lead (Google Ads + Bing UET conversion triggers)
      try {
        (window.dataLayer = window.dataLayer || []).push({
          event: 'generate_lead',
          form_name: 'chatbot_camile',
          lead_source: 'chatbot_camile',
          page_path: window.location.pathname,
        });
      } catch (e) { /* analytics opcional */ }
    }
  } catch (e) {
    telErr.textContent = 'Não foi possível registrar o contato agora. Tente novamente em instantes ou ligue para +55 11 3053-3535.';
    return;
  }

  cpconState.stage = 'greeting';
  // Abre a conversa chamando /api/chat com msg vazia (backend responde E1)
  cpconState.stage = 'chat';
  cpconCallChat('');
}

// ── Chamada ao /api/chat ───────────────────────────────────

async function cpconCallChat(userText, extra) {
  if (cpconState.busy) return;
  if (cpconState.transferred) {
    cpconSay('Já te conectei com o time. Eles vão te responder aqui mesmo ou por WhatsApp em instantes.');
    return;
  }
  cpconState.busy = true;
  cpconDisableInput();
  cpconShowTyping();

  // Sem Turnstile desde 2026-05-02 — rate limit + honeypot + Zod
  // protegem o endpoint sem CAPTCHA.
  // Adiciona mensagem do cliente ao histórico local (se não for turn 0 com userText vazio)
  if (userText) {
    cpconState.history.push({ role: 'user', content: userText });
    // fix 2026-07-20: captura nome/email/telefone digitados na conversa,
    // pra o save do handoff (cpconPostLeadBeforeRedirect) nunca ir vazio.
    cpconExtractContact(userText);
  }

  // Se é primeira chamada (sem session_id e sem histórico), forçar um placeholder
  let messages = cpconState.history.slice(-10);
  if (messages.length === 0) {
    messages = [{ role: 'user', content: '[início]' }];
  }

  const payload = {
    messages: messages,
    userContext: {
      nome: cpconState.userName,
      email: cpconState.userEmail,
      telefone: cpconState.userPhone,
      empresa: cpconState.userEmpresa || undefined,
    },
    max_tokens: 200,
  };
  Object.assign(payload, cpconHoneypotValues());
  if (cpconState.sessionId) payload.session_id = cpconState.sessionId;
  if (cpconState.sessionToken) payload.session_token = cpconState.sessionToken;
  if (extra && extra.segment_choice) payload.segment_choice = extra.segment_choice;
  if (extra && extra.handoff_response) payload.handoff_response = extra.handoff_response;

  let data = null;
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(function () { return null; });
    if (!res.ok) {
      cpconHideTyping();
      cpconSay('Tive um probleminha aqui, mas não se preocupa. Já vou te conectar com alguém do time.');
      cpconState.busy = false;
      cpconFireTransfer('erro-backend');
      return;
    }
  } catch (e) {
    cpconHideTyping();
    cpconSay('Tive um probleminha aqui. Já aciono o time.');
    cpconState.busy = false;
    cpconFireTransfer('erro-rede');
    return;
  }

  cpconHideTyping();
  cpconState.busy = false;
  cpconState.sessionId = data.session_id || cpconState.sessionId;
  cpconState.stage = data.stage || cpconState.stage;
  cpconState.lastActivityAt = Date.now();

  if (data.reply) {
    // chat-guard: guarda a assinatura do servidor; sem ela o servidor não
    // devolve essa fala ao modelo.
    var turn = { role: 'assistant', content: data.reply };
    if (typeof data.reply_sig === 'string' && data.reply_sig) turn.sig = data.reply_sig;
    cpconState.history.push(turn);
    // PR AT-Nuclear PROVA #4 — log DEBUG identificável via grep no asset.
    // userContext?.nome usado como string-marker pra grep validation.
    try {
      console.log('[FRONTEND_RESPONSE]', JSON.stringify({
        handoffReady: data.handoffReady,
        responsesRemaining: data.handoffResponsesRemaining,
        camileLocked: data.camileLocked,
        hasUserContext: !!cpconState.userContext?.nome,
      }));
    } catch (e) { /* defensivo */ }
    // PR camile-ux-perf-2026-05-03 — espelho de campos novos do backend
    if (typeof data.turn_count === 'number') cpconState.turns = data.turn_count;
    if (typeof data.handoff_offered === 'boolean') cpconState.handoffOffered = data.handoff_offered;
    if (typeof data.conversation_ended === 'boolean') cpconState.conversationEnded = data.conversation_ended;
    // PR camile-no-promise-2026-05-03 — telemetria de violation de regras
    if (data.pre_handoff_violation_caught === true) {
      try {
        (window.dataLayer = window.dataLayer || []).push({
          event: 'camile_forbidden_pattern_caught',
          turn_count: data.turn_count || cpconState.turns || 0,
          fallback_used: !!data.pre_handoff_fallback_used,
          session_id: cpconHashSession(cpconState.sessionId),
          page_path: window.location.pathname,
        });
      } catch (e) { /* analytics opcional */ }
    }
    // Compat legado (api.js antigo ainda lê esses campos)
    if (typeof data.handoffReady === 'boolean') cpconState.handoffReady = data.handoffReady;
    if (typeof data.camileLocked === 'boolean') cpconState.camileLocked = data.camileLocked;
    if (data.tags) {
      cpconState.lastSegment = (data.tags.find && data.tags.find(function (t) { return /^segmento:/.test(t); }) || '').replace('segmento:', '') || cpconState.lastSegment || null;
      cpconState.lastTema = (data.tags.find && data.tags.find(function (t) { return /^tema:/.test(t); }) || '').replace('tema:', '') || cpconState.lastTema || null;
    }

    cpconSay(data.reply, function () {
      // PR camile-ux-perf-2026-05-03 — fluxo NOVO (substitui handoffReady
      // imediato + camileLocked após 4 respostas). Ordem de prioridade:
      // 1. conversation_ended (recusa registrada no backend)
      // 2. handoff_immediate (trigger T1-T5 ou fallback LLM)
      // 3. transferred legado (off-topic 3 strikes, reuniao, preço…)
      // 4. showSegmentButtons (E2.5)
      // 5. offer_handoff_button (chegou na 6ª troca, oferece Sim/Não)
      // 6. default — input liberado pra próximo turno
      if (data.conversation_ended) {
        cpconShowConversationEnded(data);
      } else if (data.handoff_immediate) {
        cpconHandleImmediateHandoff(data);
      } else if (data.transferred) {
        cpconState.transferred = true;
        cpconFireTransfer(data.tags || []);
      } else if (data.showSegmentButtons) {
        cpconShowSegmentButtons();
      } else if (data.offer_handoff_button) {
        cpconShowHandoffOffer(data);
      } else {
        cpconEnableInput();
        cpconScheduleReengage();
      }
    });
  } else {
    cpconEnableInput();
  }
}

function cpconShowSegmentButtons() {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'cpcon-seg-btns';
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 12px 12px;';
  const buttons = [
    { label: 'Pequenas e Médias Empresas', value: 'pme' },
    { label: 'Grandes Empresas', value: 'grande' },
    { label: 'Setor Governo', value: 'governo' },
    { label: 'Terceiro Setor', value: 'terceiro-setor' },
  ];
  buttons.forEach(function (b) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = 'cpcon-seg-btn';
    btn.style.cssText = 'background:#0d9488;color:#fff;border:0;padding:8px 12px;border-radius:16px;font-size:12px;cursor:pointer;';
    btn.onclick = function () {
      row.remove();
      cpconMeMsg(b.label);
      cpconCallChat(b.label, { segment_choice: b.value });
    };
    row.appendChild(btn);
  });
  container.appendChild(row);
  cpconScrollDown();
  // P0 (QA 16/08): NAO desabilitar. Os chips sao atalho, nunca o unico caminho.
  // Antes disto, depois da primeira resposta livre o visitante so conseguia
  // clicar num segmento — o resto da descoberta morria ali.
}

// ── Handoff WhatsApp 24/7 ──────────────────────────────────
// Atendimento Camile + handoff WhatsApp disponíveis em qualquer horário.
// Função mantida pra compatibilidade de callers existentes; sempre retorna true.

function cpconIsBusinessHours() {
  return true;
}

function cpconBuildWppUrl() {
  const num = (window.CPCON_CONFIG && window.CPCON_CONFIG.whatsappNumber) || '5511962885969';
  const nome = cpconState.userName || '';
  const email = cpconState.userEmail || '';
  const tel = cpconState.userPhone || '';
  const parts = ['Olá, iniciei contato pelo chat do site grupocpcon.com.'];
  if (nome) parts.push('Meu nome é ' + nome + '.');
  if (email || tel) parts.push('Dados de contato: ' + [email, tel].filter(Boolean).join(' / ') + '.');
  parts.push('Gostaria de conversar com a equipe especializada.');
  return 'https://wa.me/' + num + '?text=' + encodeURIComponent(parts.join(' '));
}

// Regra 06/07 (Wendell): cliente ESCOLHEU o WhatsApp → o chat desliga para
// não confundir com dois canais. Grava flag durável (7 dias — Camile.tsx nem
// carrega o widget enquanto ela valer) e fecha/esconde o chat desta página.
// Só dispara em escolha explícita de WhatsApp; fechar o chat não ativa nada.
function cpconChooseWhatsApp() {
  try { localStorage.setItem('cpcon_wa_channel_ts', String(Date.now())); } catch (e) {}
  try {
    const chat = document.getElementById('cpcon-chat');
    if (chat && chat.classList.contains('open') && typeof window.cpconToggle === 'function') {
      window.cpconToggle();
    }
    const sticky = document.getElementById('cpcon-sticky');
    if (sticky) sticky.style.display = 'none';
    const openBtn = document.getElementById('cpcon-btn-open');
    if (openBtn) openBtn.style.display = 'none';
  } catch (e) {}
}

// PR handoff WhatsApp — botão persistente que aparece após segmento+demanda
// detectados (mode='persistent') e ganha pulse após camileLocked
// (mode='highlighted'). Modo 'fallback' mantém comportamento legado de
// fallback de popup bloqueado.
function cpconAppendWppButton(url, mode) {
  mode = mode || 'fallback';
  // PR AT-Nuclear PROVA #4 — log DEBUG explícito antes de renderizar
  try {
    console.log('[BTN_RENDER]', JSON.stringify({
      mode,
      url,
      existingButton: !!document.querySelector('#cpcon-wpp-btn'),
      ts: Date.now(),
    }));
  } catch (e) { /* defensivo */ }

  const container = document.getElementById('cpcon-msgs');
  if (!container) return;

  // Idempotência: remove botão anterior pra evitar duplicar a cada resposta
  const existing = document.getElementById('cpcon-wpp-btn');
  if (existing && existing.parentElement) existing.parentElement.remove();

  const row = document.createElement('div');
  row.id = 'cpcon-wpp-btn-row';
  row.style.cssText = 'padding:10px 12px;display:flex;justify-content:center;';

  const btn = document.createElement('button');
  btn.id = 'cpcon-wpp-btn';
  btn.type = 'button';
  btn.className = 'cpcon-wpp-btn' + (mode === 'highlighted' ? ' cpcon-wpp-btn-highlight' : '');
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
    '<path d="M20.5 3.5A11 11 0 0 0 3.6 17.7L2 22l4.4-1.6a11 11 0 0 0 14.1-16.9zM12 20a8 8 0 0 1-4-1.1l-.3-.2-2.6 1 .9-2.6-.2-.3A8 8 0 1 1 12 20zm4.4-5.6c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.5.1l-.7 1c-.1.2-.3.2-.5.1a6.5 6.5 0 0 1-3.2-2.8c-.2-.4.2-.4.6-1.1.1-.1 0-.3 0-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4h-.4c-.2 0-.4.1-.6.3-.2.2-.8.8-.8 2s.8 2.3.9 2.5a8.7 8.7 0 0 0 3.4 3 11 11 0 0 0 1.1.4c.5.2 1 .1 1.3 0 .4-.1 1.2-.5 1.4-1l.1-.5c0-.2-.1-.3-.3-.3z"/>' +
    '</svg>' +
    '<span class="cpcon-wpp-btn-text">' +
      '<span class="cpcon-wpp-btn-main">Continuar pelo WhatsApp</span>' +
      '<span class="cpcon-wpp-btn-sub">Falar com especialista agora</span>' +
    '</span>';

  btn.onclick = async function () {
    if (btn.disabled) return;
    btn.disabled = true;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<span class="cpcon-wpp-btn-text"><span class="cpcon-wpp-btn-main">Aguarde...</span></span>';
    try {
      await cpconPostLeadBeforeRedirect();
      // dataLayer já é disparado dentro de cpconPostLeadBeforeRedirect
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      btn.disabled = false;
      btn.innerHTML = originalHTML;
      if (opened) cpconChooseWhatsApp();
      if (!opened) {
        // Fallback link clicável quando popup bloqueado
        const fallback = document.createElement('a');
        fallback.href = url;
        fallback.target = '_blank';
        fallback.rel = 'noopener noreferrer';
        fallback.textContent = 'Clique aqui para abrir o WhatsApp';
        fallback.addEventListener('click', function () { cpconChooseWhatsApp(); });
        fallback.style.cssText = 'display:block;margin-top:8px;color:#128C7E;font-size:13px;text-align:center;';
        row.appendChild(fallback);
      }
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 14a1 1 0 1 1 1-1 1 1 0 0 1-1 1zm1-4h-2V7h2z"/></svg>' +
        '<span class="cpcon-wpp-btn-text">' +
          '<span class="cpcon-wpp-btn-main">Tentar novamente</span>' +
          '<span class="cpcon-wpp-btn-sub">ou ligue +55 11 96288-5969</span>' +
        '</span>';
    }
  };

  row.appendChild(btn);
  container.appendChild(row);
  cpconScrollDown();
}

// ── PR camile-ux-perf-2026-05-03 — bloco de handoff novo ───────────
// Pergunta + botões Sim/Não exibidos quando backend devolve
// `offer_handoff_button: true` (turn_count >= 6 sem trigger).

function cpconShowHandoffOffer(data) {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  cpconState.handoffOffered = true;

  // Idempotência — se já está renderizado (turn duplicado), ignora.
  if (document.getElementById('cpcon-handoff-offer')) {
    cpconEnableInput();
    return;
  }

  const wrap = document.createElement('div');
  wrap.id = 'cpcon-handoff-offer';
  wrap.className = 'cpcon-handoff-offer';
  wrap.innerHTML =
    '<div class="cpcon-handoff-question">Quer continuar essa conversa com um especialista da CPCON pelo WhatsApp? É mais rápido e direto.</div>' +
    '<div class="cpcon-handoff-actions">' +
    '<button type="button" class="cpcon-handoff-yes-btn" id="cpcon-handoff-yes">' +
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<path d="M20.5 3.5A11 11 0 0 0 3.6 17.7L2 22l4.4-1.6a11 11 0 0 0 14.1-16.9zM12 20a8 8 0 0 1-4-1.1l-.3-.2-2.6 1 .9-2.6-.2-.3A8 8 0 1 1 12 20zm4.4-5.6c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.5.1l-.7 1c-.1.2-.3.2-.5.1a6.5 6.5 0 0 1-3.2-2.8c-.2-.4.2-.4.6-1.1.1-.1 0-.3 0-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4h-.4c-.2 0-.4.1-.6.3-.2.2-.8.8-.8 2s.8 2.3.9 2.5a8.7 8.7 0 0 0 3.4 3 11 11 0 0 0 1.1.4c.5.2 1 .1 1.3 0 .4-.1 1.2-.5 1.4-1l.1-.5c0-.2-.1-.3-.3-.3z"/>' +
    '</svg>' +
    'Sim, falar pelo WhatsApp</button>' +
    '<button type="button" class="cpcon-handoff-no-btn" id="cpcon-handoff-no">Não, obrigado</button>' +
    '</div>';
  container.appendChild(wrap);
  cpconScrollDown();
  // P0 (QA 16/08): os botoes Sim/Nao sao atalho. Quem preferir digitar em vez de
  // clicar nao pode ficar preso — o composer segue disponivel.

  document.getElementById('cpcon-handoff-yes').onclick = function () {
    cpconAcceptHandoffButton();
  };
  document.getElementById('cpcon-handoff-no').onclick = function () {
    cpconDeclineHandoffButton();
  };
}

async function cpconAcceptHandoffButton() {
  const offer = document.getElementById('cpcon-handoff-offer');
  const yesBtn = document.getElementById('cpcon-handoff-yes');
  const noBtn = document.getElementById('cpcon-handoff-no');
  if (yesBtn) yesBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;

  try {
    await cpconPostLeadBeforeRedirect({ accepted_handoff: true });
  } catch (err) {
    cpconShowSystemMessage(
      'Estamos com instabilidade momentânea. Por favor, contate diretamente +55 11 96288-5969.'
    );
    if (yesBtn) yesBtn.disabled = false;
    if (noBtn) noBtn.disabled = false;
    return;
  }

  // dataLayer: camile_handoff via botão da 6ª troca. Sem PII.
  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'camile_handoff',
      trigger_type: 'button_6th_turn_yes',
      turn_count_at_handoff: cpconState.turns || cpconState.history.length || 0,
      session_id: cpconHashSession(cpconState.sessionId),
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics opcional */ }

  if (offer) offer.remove();
  const url = cpconBuildWppUrl();
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) cpconAppendWppButton(url, 'highlighted');
  cpconState.transferred = true;
  // P0 (QA 16/08): abrir o WhatsApp e uma OFERTA. O visitante continua podendo
  // perguntar aqui. Travar obrigava reload -> nova captura -> lead duplicado.
  cpconEnableInput();
}

async function cpconDeclineHandoffButton() {
  const offer = document.getElementById('cpcon-handoff-offer');
  const yesBtn = document.getElementById('cpcon-handoff-yes');
  const noBtn = document.getElementById('cpcon-handoff-no');
  if (yesBtn) yesBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;

  try {
    await cpconPostLeadBeforeRedirect({
      chat_completed_no_handoff: true,
      recusal_method: 'button_no',
    });
  } catch (err) {
    // Mesmo se POST falhar, encerramos a conversa visualmente.
    console.error('[Camile] decline POST failed', err);
  }

  // dataLayer: camile_chat_ended_no_handoff via botão "Não". Sem PII.
  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'camile_chat_ended_no_handoff',
      turn_count_at_end: cpconState.turns || cpconState.history.length || 0,
      session_id: cpconHashSession(cpconState.sessionId),
      recusal_method: 'button_no',
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics opcional */ }

  if (offer) offer.remove();
  // Envia "no" pro backend pra ele marcar conversation_ended e logar tag.
  // Resposta vem com a frase fixa de encerramento — vai ser renderizada
  // pelo handler de cpconCallChat normalmente (conversation_ended=true).
  cpconCallChat('Não, obrigado', { handoff_response: 'no' });
}

// Trigger T1-T5 ou fallback LLM — backend já marcou transferred=true.
// Frontend abre wa.me com resumo e dispara dataLayer.camile_handoff.
function cpconHandleImmediateHandoff(data) {
  cpconState.transferred = true;
  // P0 (QA 16/08): handoff nao encerra a conversa — ver cpconOpenWpp.
  cpconEnableInput();

  // dataLayer com trigger_type vindo do backend
  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'camile_handoff',
      trigger_type: data.trigger_type || 'unknown',
      trigger_reason: data.trigger_reason || '',
      turn_count_at_handoff:
        data.turn_count_at_handoff || cpconState.turns || cpconState.history.length || 0,
      session_id: cpconHashSession(cpconState.sessionId),
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics opcional */ }

  // Pequeno delay pra UI renderizar a mensagem antes do popup
  setTimeout(function () {
    cpconPostLeadBeforeRedirect({
      handoff_trigger_type: data.trigger_type || 'unknown',
    }).catch(function (err) {
      console.error('[Camile] immediate handoff POST failed', err);
    });
    setTimeout(function () {
      const url = cpconBuildWppUrl();
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) cpconAppendWppButton(url, 'highlighted');
    }, 600);
  }, 400);
}

// Conversa encerrada pela recusa do cliente. Backend já marcou
// conversationEnded=true e devolveu a frase fixa em data.reply.
function cpconShowConversationEnded(_data) {
  cpconState.transferred = true;
  cpconState.conversationEnded = true;
  cpconDisableInput();

  const inp = document.getElementById('cpcon-inp');
  if (inp) inp.placeholder = 'Conversa encerrada';

  // Badge persistente "Conversa encerrada" — visível e acessível.
  if (!document.getElementById('cpcon-ended-badge')) {
    const container = document.getElementById('cpcon-msgs');
    if (container) {
      const badge = document.createElement('div');
      badge.id = 'cpcon-ended-badge';
      badge.className = 'cpcon-ended-badge';
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-live', 'polite');
      badge.textContent = 'Conversa encerrada';
      container.appendChild(badge);
      cpconScrollDown();
    }
  }
}

// Hash leve de session_id pra telemetria (não-PII). 8 hex.
function cpconHashSession(sid) {
  if (!sid) return '';
  let h = 0;
  for (let i = 0; i < sid.length; i += 1) {
    h = ((h << 5) - h + sid.charCodeAt(i)) | 0;
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

// Mensagem do sistema (estilo neutro, sem avatar Camile) — usada quando
// camileLocked pra avisar que atendimento por chat encerrou.
function cpconShowSystemMessage(text) {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'cpcon-system-msg';
  row.textContent = text;
  container.appendChild(row);
  cpconScrollDown();
}

// Resumo curto da conversa pra incluir na mensagem do lead.
function cpconBuildResumoConversa() {
  const lines = ['Resumo da conversa via Camile:'];
  if (cpconState.userName) lines.push('- Contato: ' + cpconState.userName);
  if (cpconState.userEmpresa) lines.push('- Empresa: ' + cpconState.userEmpresa);
  if (cpconState.lastSegment) lines.push('- Segmento: ' + cpconState.lastSegment);
  if (cpconState.lastTema) lines.push('- Demanda: ' + cpconState.lastTema);
  lines.push('- Total de turnos: ' + (cpconState.turns || cpconState.history.length));
  const ultimaMsg = (cpconState.history.filter(function (m) { return m.role === 'user'; }).slice(-1)[0] || {}).content;
  if (ultimaMsg) lines.push('- Última mensagem: ' + String(ultimaMsg).slice(0, 200));
  return lines.join('\n');
}

// POST /api/leads/chatbot ANTES do redirect WhatsApp. Espera 200 OK; em caso
// de erro, lança pra que o caller (botão onclick) bloqueie window.open.
//
// PR camile-ux-perf-2026-05-03 — opts pode conter:
//   - chat_completed_no_handoff: true  (cliente recusou WhatsApp)
//   - accepted_handoff: true           (cliente aceitou via botão Sim)
//   - handoff_trigger_type: 'T1'|'T2'|… (handoff via trigger detectado)
//   - recusal_method: 'button_no'|'text_refusal'
async function cpconPostLeadBeforeRedirect(opts) {
  opts = opts || {};
  const refusal = !!opts.chat_completed_no_handoff;
  const tail = refusal
    ? '\n\nCliente recusou continuar pelo WhatsApp na 6ª troca. Lead arquivado.'
    : '\n\nCliente continuou pelo WhatsApp.';
  const payload = {
    nome: cpconState.userName,
    email: cpconState.userEmail,
    empresa: cpconState.userEmpresa || '',
    telefone: cpconState.userPhone,
    phone_country: cpconState.phoneCountry || 'BR',
    nao_sou_robo: cpconState.notRobot === true,
    mensagem: cpconBuildResumoConversa() + tail,
    origem: 'chatbot_camile',
    pagina_origem: window.location.href,
    metadata: {
      segmento: cpconState.lastSegment || null,
      demanda: cpconState.lastTema || null,
      handoff_via: opts.handoff_trigger_type
        ? 'trigger_' + String(opts.handoff_trigger_type)
        : refusal
          ? 'refused'
          : 'whatsapp_button_yes',
      handoff_trigger_type: opts.handoff_trigger_type || null,
      recusal_method: opts.recusal_method || null,
      turn_count: cpconState.turns || cpconState.history.length || 0,
      session_id: cpconState.sessionId,
    },
  };
  if (refusal) payload.chat_completed_no_handoff = true;
  // chat-guard: o servidor monta o resumo do CRM a partir das falas (as do
  // bot conferidas pela assinatura). Teto ~6 KB (limite do endpoint 10 KB).
  if (cpconState.sessionId) payload.session_id = cpconState.sessionId;
  var turns = cpconState.history.slice(-40).map(function (m) {
    var t = { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) };
    if (m.role === 'assistant' && m.sig) t.sig = m.sig;
    return t;
  }).filter(function (t) { return t.content; });
  while (turns.length > 1 && JSON.stringify(turns).length > 5500) turns.shift();
  if (turns.length) payload.conversation_turns = turns;
  payload.form_token = await cpconFetchFormToken();

  let leadId = null;
  try {
    const res = await fetch('/api/leads/chatbot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error('POST /api/leads/chatbot HTTP ' + res.status);
    }
    const data = await res.json().catch(function () { return null; });
    leadId = (data && data.lead_id) || null;
  } catch (err) {
    if (!refusal) {
      cpconShowSystemMessage(
        'Estamos com instabilidade momentânea. Por favor, contate diretamente ' +
        '+55 11 96288-5969 ou aguarde alguns instantes para tentar novamente.'
      );
    }
    throw err;
  }

  // Mantém o evento legacy `click_whatsapp` (GTM pre-existing trigger),
  // agora com trigger_type + turn_count_at_handoff. Para refusal NÃO
  // dispara (esse caso usa camile_chat_ended_no_handoff em outro caller).
  if (!refusal) {
    try {
      (window.dataLayer = window.dataLayer || []).push({
        event: 'click_whatsapp',
        source: 'camile_handoff',
        trigger_type:
          opts.handoff_trigger_type || (opts.accepted_handoff ? 'button_6th_turn_yes' : 'manual'),
        turn_count_at_handoff: cpconState.turns || cpconState.history.length || 0,
        session_id: cpconHashSession(cpconState.sessionId),
        leadId: leadId,
      });
    } catch (e) { /* analytics opcional */ }
  }
}

function cpconOpenWpp() {
  // dataLayer: click_whatsapp (GTM-T4DV9MH4 trigger Click - WhatsApp Link +
  // Bing UET MS UET - click_whatsapp). Restaurado após remoção em 4ef5a54.
  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'click_whatsapp',
      source: 'chatbot_camile',
      page_path: window.location.pathname,
      stage: cpconState && cpconState.stage,
      session_id: (cpconState && cpconState.sessionId) || null,
    });
  } catch (e) { /* analytics opcional */ }
  const url = cpconBuildWppUrl();
  let opened = null;
  try {
    opened = window.open(url, '_blank', 'noopener,noreferrer');
  } catch (e) {}
  if (opened) cpconChooseWhatsApp();
  // Popup bloqueado ou mobile sem nova aba: deixa botão clicável como fallback.
  if (!opened) cpconAppendWppButton(url);
}

function cpconShowAfterHoursMessage() {
  // Mantida pra compatibilidade de callers; usada hoje só em fallback de erro técnico.
  const msg = 'Tivemos uma instabilidade no serviço de IA. Seu contato já está registrado e nosso time vai retornar em breve.';
  cpconSay(msg);
}

// ── Transferência pra humano ───────────────────────────────

async function cpconFireTransfer(tagsOrReason) {
  if (cpconState._transferFired) return;
  cpconState._transferFired = true;
  cpconState.transferred = true;

  let handoffOk = false;
  const tags = Array.isArray(tagsOrReason) ? tagsOrReason : [String(tagsOrReason || 'transferido')];
  // Sem Turnstile desde 2026-05-02. Se temos session_token (HMAC do
  // /api/leads/chatbot), usa pra validação de sessão. O POST também
  // exige o form_token HMAC (GET /api/leads/form-token + cookie
  // cpcon_ft) — Origin sozinho não autentica.
  const useToken = cpconState.sessionToken;
  const msgInicial = cpconState.history.filter(function (m) { return m.role === 'user'; }).map(function (m) { return m.content; }).join(' | ').slice(0, 1500);
  const segment = tags.find(function (t) { return t && t.indexOf('segmento-') === 0; });
  const tema = tags.find(function (t) { return t && t.indexOf('tema-') === 0; });

  try {
    const reqBody = {
      nome: cpconState.userName || 'Visitante',
      email: cpconState.userEmail || '',
      telefone: cpconState.userPhone || '',
      phone_country: cpconState.phoneCountry || 'BR',
      empresa: cpconState.userEmpresa || '',
      nao_sou_robo: cpconState.notRobot === true,
      origem: 'chatbot_camile',
      lead_id: cpconState.leadId || null,
      mensagem_inicial: msgInicial,
      session_id: cpconState.sessionId,
      tags: tags,
      segment: segment ? segment.replace('segmento-', '') : undefined,
      tema: tema ? tema.replace('tema-', '') : undefined,
    };
    Object.assign(reqBody, cpconHoneypotValues());
    if (useToken) reqBody.session_token = useToken;
    reqBody.form_token = await cpconFetchFormToken();

    const res = await fetch('/api/atendimento/iniciar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(reqBody),
    });
    const data = await res.json().catch(function () { return null; });
    if (data && data.session_id) {
      cpconState.liveSessionId = data.session_id;
    }
    // QA 16/08: antes disto o catch era VAZIO e a frase "Time notificado" saía
    // mesmo quando a chamada falhava. Ficou 35 dias afirmando algo falso — o
    // endpoint respondia 403 e ninguém do time era avisado.
    handoffOk = !!(res && res.ok);
  } catch (e) {
    handoffOk = false;
    console.error('[camile] handoff falhou:', e);
  }

  // Feedback discreto + direcionamento — sempre abre WhatsApp (24/7).
  // P0 (QA 16/08): o composer PRECISA seguir utilizavel. Era aqui que a conversa
  // morria depois de "Time notificado": o unico jeito de continuar era recarregar
  // a pagina, refazer a captura e gerar um SEGUNDO lead da mesma pessoa.
  cpconEnableInput();
  setTimeout(function () {
    // Nunca mostrar erro técnico ao visitante: o WhatsApp abre nos dois casos.
    // Só paramos de afirmar que o time foi avisado quando ele não foi.
    cpconAppendNotice(handoffOk
      ? 'Time notificado. Seu contato foi registrado.'
      : 'Não confirmamos o registro por aqui. Vamos seguir pelo WhatsApp.');
    setTimeout(function () {
      cpconOpenWpp();
    }, 1200);
  }, 400);
}

// ── Handler central ─────────────────────────────────────────

function cpconOnSend() {
  const inp = document.getElementById('cpcon-inp');
  if (!inp) return;
  const v = inp.value.trim();
  if (!v) return;
  if (v.length > 500) {
    cpconSay('A mensagem tá longa demais pra mim. Resumo em até 500 caracteres?');
    return;
  }
  inp.value = '';
  inp.style.height = 'auto';
  cpconMeMsg(v);
  cpconState.lastActivityAt = Date.now();
  if (cpconState.transferred) {
    cpconSay('Já te conectei com o time. Eles vão te responder aqui mesmo ou por WhatsApp em instantes.');
    return;
  }
  cpconCallChat(v);
}

function cpconOnKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cpconOnSend(); }
}

// ── Utilitários compartilhados com UI antiga ─────────────────

function cpconShowTyping() {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const row = document.createElement('div');
  row.id = 'cpcon-typing';
  row.className = 'cpcon-row';
  row.innerHTML = '<div class="cpcon-av"><img src="/chatbot/images/camile.webp" alt="Camile" width="26" height="26"/></div><div class="cpcon-bbl"><em>digitando…</em></div>';
  container.appendChild(row);
  cpconScrollDown();
}
function cpconHideTyping() {
  const n = document.getElementById('cpcon-typing');
  if (n) n.remove();
}
function cpconShowTypingSlowHint() {
  const row = document.getElementById('cpcon-typing');
  if (!row) return;
  const bubble = row.querySelector('.cpcon-bbl');
  if (!bubble || row.querySelector('.cpcon-slow-hint')) return;
  const hint = document.createElement('span');
  hint.className = 'cpcon-slow-hint';
  hint.style.cssText = 'font-style:italic;color:#9ca3af;font-size:12px;margin-left:6px;';
  hint.textContent = 'só um segundo…';
  bubble.appendChild(hint);
}
function cpconClearTypingSlowHint() {
  const h = document.querySelector('#cpcon-typing .cpcon-slow-hint');
  if (h) h.remove();
}

function cpconEnableInput() {
  const inp = document.getElementById('cpcon-inp');
  const btn = document.getElementById('cpcon-send-btn');
  if (btn) btn.disabled = false;
  if (inp) {
    inp.disabled = false;
    inp.placeholder = 'Digite sua mensagem';
    inp.removeAttribute('inputmode');
    inp.focus();
  }
}

function cpconDisableInput() {
  const inp = document.getElementById('cpcon-inp');
  const btn = document.getElementById('cpcon-send-btn');
  if (btn) btn.disabled = true;
  if (inp) inp.disabled = true;
}

function cpconScrollDown() {
  const m = document.getElementById('cpcon-msgs');
  if (m) m.scrollTop = m.scrollHeight;
}

function cpconResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 80) + 'px';
}

function cpconEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cpconNl2br(s) { return s.replace(/\n/g, '<br>'); }

// Final: ao fechar a página, encerra sessão no backend
window.addEventListener('beforeunload', function () {
  if (cpconState.sessionId) {
    try {
      navigator.sendBeacon('/api/chat?session_id=' + encodeURIComponent(cpconState.sessionId));
    } catch (e) {}
  }
});

// Liga handler do enter no live panel se existir (compat com UI antiga)
function cpconOnLiveKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); /* ignore */ }
}
function cpconSendLive() {}
function cpconCloseLive() {
  const p = document.getElementById('cpcon-live-panel');
  if (p) p.classList.remove('show');
}
