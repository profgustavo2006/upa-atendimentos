const API = '';
let token = localStorage.getItem('upa_token');
let usuario = JSON.parse(localStorage.getItem('upa_user') || 'null');
let medicosLista = [];
let itensDia = [];
let chartInstance = null;
let resumoCache = { totalDia: 0, totalSemana: 0, totalMes: 0 };

async function apiFetch(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + url, { ...options, headers });
  if (res.status === 401 && !url.includes('/login')) {
    localStorage.clear();
    location.href = '/';
  }
  return res;
}

// ==================== TOOLTIP APÓS 3 SEGUNDOS ====================
const tooltipEl = document.getElementById('customTooltip');
let tipTimer = null;

if (tooltipEl) {
  document.addEventListener('mouseover', (e) => {
    const alvo = e.target.closest('[data-tip]');
    if (!alvo) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      tooltipEl.textContent = alvo.getAttribute('data-tip');
      tooltipEl.classList.remove('hidden');
      const rect = alvo.getBoundingClientRect();
      tooltipEl.style.left = `${Math.min(rect.left, window.innerWidth - 270)}px`;
      tooltipEl.style.top = `${Math.max(10, rect.top - tooltipEl.offsetHeight - 10)}px`;
    }, 3000);
  });

  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tip]')) {
      clearTimeout(tipTimer);
      tooltipEl.classList.add('hidden');
    }
  });
}

// ==================== TELA DE LOGIN ====================
if (document.getElementById('formLogin')) {
  const params = new URLSearchParams(location.search);
  const resetToken = params.get('resetToken');
  if (resetToken) document.getElementById('modalReset').classList.remove('hidden');

  document.getElementById('formLogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await apiFetch('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('email').value,
        senha: document.getElementById('senha').value
      })
    });
    const data = await res.json();
    if (!res.ok) return (document.getElementById('msgLogin').textContent = data.erro);

    token = data.token;
    usuario = data.usuario;
    localStorage.setItem('upa_token', token);
    localStorage.setItem('upa_user', JSON.stringify(usuario));

    if (usuario.primeiro_acesso) {
      document.getElementById('modalPrimeiroAcesso').classList.remove('hidden');
    } else {
      location.href = '/dashboard.html';
    }
  });

  document.getElementById('btnSalvarPrimeiroAcesso').addEventListener('click', async () => {
    const novaSenha = document.getElementById('novaSenhaPrimeiro').value;
    const res = await apiFetch('/api/alterar-senha', { method: 'POST', body: JSON.stringify({ novaSenha }) });
    const data = await res.json();
    if (!res.ok) return alert(data.erro);
    usuario.primeiro_acesso = false;
    localStorage.setItem('upa_user', JSON.stringify(usuario));
    location.href = '/dashboard.html';
  });

  document.getElementById('btnEsqueci').addEventListener('click', async () => {
    const email = prompt('Digite seu e-mail cadastrado:');
    if (!email) return;
    const res = await apiFetch('/api/esqueci-senha', { method: 'POST', body: JSON.stringify({ email }) });
    const data = await res.json();
    alert(data.mensagem || data.erro);
  });

  document.getElementById('btnConfirmarReset').addEventListener('click', async () => {
    const novaSenha = document.getElementById('novaSenhaReset').value;
    const res = await apiFetch('/api/redefinir-senha', { method: 'POST', body: JSON.stringify({ token: resetToken, novaSenha }) });
    const data = await res.json();
    alert(data.mensagem || data.erro);
    if (res.ok) location.href = '/';
  });
}

// ==================== DASHBOARD ====================
if (document.getElementById('tbodyEscala')) {
  if (!token || !usuario) location.href = '/';

  document.getElementById('infoUsuario').textContent = usuario.nome;
  document.getElementById('infoRole').textContent = usuario.role === 'admin' ? 'Administrador' : 'Usuário';
  document.getElementById('avatarLetra').textContent = (usuario.nome || 'U')[0].toUpperCase();
  if (usuario.role === 'admin') document.getElementById('btnTabAdmin').classList.remove('hidden');

  document.getElementById('btnSair').addEventListener('click', () => {
    localStorage.clear();
    location.href = '/';
  });

  document.querySelectorAll('.nav-item[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.remove('hidden');
      if (btn.dataset.tab === 'tabPlanilhas') carregarPreview('diaria');
      if (btn.dataset.tab === 'tabRelatorios') carregarGrafico();
      if (btn.dataset.tab === 'tabEscala') carregarEscalaGerenciar();
      if (btn.dataset.tab === 'tabAdmin') carregarAdmin();
    });
  });

  const hoje = new Date().toISOString().split('T')[0];
  document.getElementById('dataPlantao').value = hoje;
  document.getElementById('filtroInicio').value = hoje.slice(0, 8) + '01';
  document.getElementById('filtroFim').value = hoje;
  document.getElementById('escalaDataVigencia').value = hoje;
  document.getElementById('escalaDiaSemana').value = String(new Date().getDay());

  function formatarDataBR(iso) {
    return iso.split('-').reverse().join('/');
  }

  function mudarData(deltaDias) {
    const input = document.getElementById('dataPlantao');
    const dt = new Date(`${input.value}T12:00:00`);
    dt.setDate(dt.getDate() + deltaDias);
    input.value = dt.toISOString().split('T')[0];
    carregarDia();
  }

  document.getElementById('btnDiaAnterior').addEventListener('click', () => mudarData(-1));
  document.getElementById('btnDiaProximo').addEventListener('click', () => mudarData(1));

  function atualizarKPIsTela() {
    const somaTela = itensDia.reduce((acc, it) => acc + Number(it.quantidade || 0), 0);
    const qtdMedicos = itensDia.length || 1;
    const media = (somaTela / qtdMedicos).toFixed(1).replace('.', ',');
    document.getElementById('kpiDia').textContent = somaTela;
    document.getElementById('kpiMedia').textContent = media;
  }

  async function carregarResumo(data) {
    const res = await apiFetch(`/api/resumo?data=${data}`);
    resumoCache