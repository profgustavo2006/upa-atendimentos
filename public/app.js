const API = '';
let token = localStorage.getItem('upa_token');
let usuario = JSON.parse(localStorage.getItem('upa_user') || 'null');
let medicosLista = [];
let itensDia = [];
let chartInstance = null;

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

// ==================== LOGIN ====================
if (document.getElementById('formLogin')) {
  const resetToken = new URLSearchParams(location.search).get('resetToken');
  if (resetToken) document.getElementById('modalReset').classList.remove('hidden');

  document.getElementById('formLogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await apiFetch('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: document.getElementById('email').value, senha: document.getElementById('senha').value })
    });
    const data = await res.json();
    if (!res.ok) return (document.getElementById('msgLogin').textContent = data.erro);
    token = data.token; usuario = data.usuario;
    localStorage.setItem('upa_token', token);
    localStorage.setItem('upa_user', JSON.stringify(usuario));
    if (usuario.primeiro_acesso) document.getElementById('modalPrimeiroAcesso').classList.remove('hidden');
    else location.href = '/dashboard.html';
  });

  document.getElementById('btnSalvarPrimeiroAcesso').addEventListener('click', async () => {
    const res = await apiFetch('/api/alterar-senha', { method: 'POST', body: JSON.stringify({ novaSenha: document.getElementById('novaSenhaPrimeiro').value }) });
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
  const texto = data.mensagem || data.erro;
  const msgEl = document.getElementById('msgLogin');
  if (msgEl) msgEl.textContent = texto;
  alert(texto);
});

  document.getElementById('btnConfirmarReset').addEventListener('click', async () => {
    const res = await apiFetch('/api/redefinir-senha', { method: 'POST', body: JSON.stringify({ token: resetToken, novaSenha: document.getElementById('novaSenhaReset').value }) });
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

  document.getElementById('btnSair').addEventListener('click', () => { localStorage.clear(); location.href = '/'; });

  document.querySelectorAll('.nav-item[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.remove('hidden');
      if (btn.dataset.tab === 'tabPlanilhas') carregarPrevia('diaria');
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

  const fmtBR = (iso) => iso.split('-').reverse().join('/');

  function mudarData(delta) {
    const input = document.getElementById('dataPlantao');
    const dt = new Date(`${input.value}T12:00:00`);
    dt.setDate(dt.getDate() + delta);
    input.value = dt.toISOString().split('T')[0];
    carregarDia();
  }
  document.getElementById('btnDiaAnterior').addEventListener('click', () => mudarData(-1));
  document.getElementById('btnDiaProximo').addEventListener('click', () => mudarData(1));

  function atualizarKPIsTela() {
    const soma = itensDia.reduce((a, it) => a + Number(it.quantidade || 0), 0);
    document.getElementById('kpiDia').textContent = soma;
    document.getElementById('kpiMedia').textContent = (soma / (itensDia.length || 1)).toFixed(1).replace('.', ',');
  }

  async function carregarResumo(data) {
    const r = await (await apiFetch(`/api/resumo?data=${data}`)).json();
    document.getElementById('kpiDia').textContent = r.totalDia;
    document.getElementById('kpiSemana').textContent = r.totalSemana;
    document.getElementById('kpiMes').textContent = r.totalMes;
    document.getElementById('kpiDiaSub').textContent = fmtBR(data);
    document.getElementById('kpiSemanaSub').textContent = `${fmtBR(r.inicioSemana)} a ${fmtBR(r.fimSemana)}`;
    document.getElementById('subtituloData').textContent = `UPA Parque dos Ferreira • Plantão de ${fmtBR(data)}`;
  }

  async function inicializar() {
    medicosLista = await (await apiFetch('/api/medicos')).json();
    document.getElementById('escalaMedicoId').innerHTML = medicosLista.map((m) => `<option value="${m.id}">${m.nome}</option>`).join('');
    await carregarDia();
  }

  async function carregarDia() {
    const data = document.getElementById('dataPlantao').value;
    const [resAtd] = await Promise.all([apiFetch(`/api/atendimentos?data=${data}`), carregarResumo(data)]);
    itensDia = (await resAtd.json()).itens;
    renderizarTabela();
    atualizarKPIsTela();
  }

  function renderizarTabela() {
    const tbody = document.getElementById('tbodyEscala');
    tbody.innerHTML = '';
    itensDia.forEach((item, idx) => {
      const nome = item.medico_extra_nome ? `${item.medico_extra_nome} <span class="badge-extra">Extra</span>` : (item.nome_real || item.nome_escalado || 'Novo Médico Extra');
      const turnoTag = item.turno && item.turno !== '24h' ? `<br><small style="color:#155eef;font-weight:600">${item.turno}</small>` : '';
      const opts = medicosLista.map((m) => `<option value="${m.id}" ${m.id == item.medico_real_id ? 'selected' : ''}>${m.nome}</option>`).join('');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${nome}</strong>${turnoTag}</td>
        <td>
          <button class="btn-soft" onclick="alternarTroca(${idx})" title="Trocar este médico por outro">Trocar</button>
          <div class="troca-box ${item.editandoTroca ? '' : 'hidden'}">
            <select onchange="selecionarSubstituto(${idx}, this.value)"><option value="">-- Selecionar --</option>${opts}</select>
            <input type="text" placeholder="Ou nome de médico extra" value="${item.medico_extra_nome || ''}" oninput="digitarExtra(${idx}, this.value)">
          </div>
        </td>
        <td><input type="number" min="0" value="${item.quantidade || 0}" oninput="atualizarQtd(${idx}, this.value)"></td>
        <td style="display:flex;gap:6px;">
          <button class="btn-mini" onclick="zerarMedico(${idx})" title="Apagar a quantidade de atendimentos deste médico">Zerar</button>
          <button class="btn-mini danger" onclick="removerLinhaDia(${idx})" title="Excluir este médico da lista deste dia">Excluir</button>
        </td>`;
      tbody.appendChild(tr);
    });
  }

  window.atualizarQtd = (idx, v) => { itensDia[idx].quantidade = Number(v || 0); atualizarKPIsTela(); };
  window.alternarTroca = (idx) => { itensDia[idx].editandoTroca = !itensDia[idx].editandoTroca; renderizarTabela(); };
  window.selecionarSubstituto = (idx, id) => {
    if (!id) return;
    const m = medicosLista.find((x) => x.id == id);
    itensDia[idx].medico_real_id = Number(id); itensDia[idx].nome_real = m?.nome; itensDia[idx].medico_extra_nome = '';
    renderizarTabela();
  };
  window.digitarExtra = (idx, t) => { itensDia[idx].medico_extra_nome = t; if (t.trim()) itensDia[idx].medico_real_id = null; };
  window.zerarMedico = (idx) => { itensDia[idx].quantidade = 0; renderizarTabela(); atualizarKPIsTela(); };
  window.removerLinhaDia = (idx) => { if (!confirm('Remover este médico da lista de hoje?')) return; itensDia.splice(idx, 1); renderizarTabela(); atualizarKPIsTela(); };

  document.getElementById('btnAddExtra').addEventListener('click', () => {
    itensDia.push({ escala_id: null, medico_escalado_id: null, medico_real_id: null, medico_extra_nome: '', turno: '24h', quantidade: 0, editandoTroca: true });
    renderizarTabela(); atualizarKPIsTela();
  });

  document.getElementById('btnLimparDia').addEventListener('click', () => {
    if (!confirm('Zerar os atendimentos de TODOS os médicos deste dia?')) return;
    itensDia.forEach((it) => (it.quantidade = 0));
    renderizarTabela(); atualizarKPIsTela();
  });

  document.getElementById('dataPlantao').addEventListener('change', carregarDia);

  document.getElementById('btnSalvarDia').addEventListener('click', async () => {
    const data = document.getElementById('dataPlantao').value;
    const res = await apiFetch('/api/atendimentos', { method: 'POST', body: JSON.stringify({ data, itens: itensDia }) });
    const json = await res.json();
    document.getElementById('msgLancamento').textContent = json.mensagem || json.erro;
    await carregarResumo(data);
    setTimeout(() => (document.getElementById('msgLancamento').textContent = ''), 4000);
  });

  // ==================== PRÉVIA E EXCEL ====================
  window.carregarPrevia = async (periodo) => {
    const dataRef = document.getElementById('dataPlantao').value;
    const d = await (await apiFetch(`/api/preview?periodo=${periodo}&dataRef=${dataRef}`)).json();
    document.getElementById('tituloPrevia').textContent = d.titulo;
    const area = document.getElementById('areaPrevia');

    if (periodo === 'semanal') {
      const ths = ['Médico(a)', ...d.diasNome.map((n, i) => `${n}<br><small>${fmtBR(d.datas[i]).slice(0, 5)}</small>`), 'Total', 'Média'];
      const trs = d.linhas.map((m) => `<tr><td><strong>${m.nome}</strong></td>${m.vals.map((v) => `<td>${v ?? '-'}</td>`).join('')}<td><strong>${m.total}</strong></td><td>${m.media}</td></tr>`).join('');
      area.innerHTML = `<table><thead><tr>${ths.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${trs}</tbody></table>`;
    } else {
      const cols = periodo === 'diaria' ? ['Médico(a)', 'Turno', 'Status', 'Atendimentos'] : ['Médico(a)', 'Dias Trabalhados', 'Total no Mês', 'Média Diária'];
      const trs = d.linhas.map((r) => `<tr><td><strong>${r.medico}</strong></td><td>${r.col2}</td><td>${periodo === 'diaria' ? r.col3 : r.total}</td><td><strong>${periodo === 'diaria' ? r.total : r.col3}</strong></td></tr>`).join('');
      area.innerHTML = `<table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${trs || '<tr><td colspan="4">Sem atendimentos registrados neste período.</td></tr>'}</tbody></table>`;
    }
  };

  async function gerarImagemGraficoExcel(periodo, dataRef) {
    const ref = new Date(`${dataRef}T12:00:00`);
    const fmt = (d) => d.toISOString().split('T')[0];
    let ini = dataRef, fim = dataRef;
    if (periodo === 'semanal') {
      const s = new Date(ref); s.setDate(ref.getDate() - ref.getDay());
      const e = new Date(s); e.setDate(s.getDate() + 6);
      ini = fmt(s); fim = fmt(e);
    } else if (periodo === 'mensal') {
      ini = fmt(new Date(ref.getFullYear(), ref.getMonth(), 1));
      fim = fmt(new Date(ref.getFullYear(), ref.getMonth() + 1, 0));
    }
    const dados = await (await apiFetch(`/api/ranking?inicio=${ini}&fim=${fim}`)).json();
    if (!dados.length) return null;
    const canvas = document.getElementById('canvasExcel');
    const bg = { id: 'bg', beforeDraw: (c) => { c.ctx.save(); c.ctx.fillStyle = '#fff'; c.ctx.fillRect(0, 0, c.width, c.height); c.ctx.restore(); } };
    const ch = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels: dados.map((d) => d.medico), datasets: [{ data: dados.map((d) => d.total), backgroundColor: '#1F4E78', borderRadius: 6 }] },
      options: { animation: false, responsive: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
      plugins: [bg]
    });
    const b64 = canvas.toDataURL('image/png');
    ch.destroy();
    return b64;
  }

  window.exportarExcel = async (periodo) => {
    const dataRef = document.getElementById('dataPlantao').value;
    const chartBase64 = await gerarImagemGraficoExcel(periodo, dataRef);
    const res = await fetch('/api/exportar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ periodo, dataRef, chartBase64 })
    });
    if (!res.ok) return alert('Erro ao gerar planilha Excel. Tente novamente.');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Atendimentos_UPA_${periodo}_${dataRef}.xlsx`;
    a.click();
  };

  // ==================== GRÁFICO ====================
  async function carregarGrafico() {
    const ini = document.getElementById('filtroInicio').value;
    const fim = document.getElementById('filtroFim').value;
    const dados = await (await apiFetch(`/api/ranking?inicio=${ini}&fim=${fim}`)).json();
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(document.getElementById('graficoRanking').getContext('2d'), {
      type: 'bar',
      data: { labels: dados.map((d) => d.medico), datasets: [{ label: 'Atendimentos', data: dados.map((d) => d.total), backgroundColor: '#155eef', borderRadius: 8 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });
  }
  document.getElementById('btnAtualizarGrafico').addEventListener('click', carregarGrafico);

  // ==================== GERENCIAR ESCALA ====================
  async function carregarEscalaGerenciar() {
    const dia = document.getElementById('escalaDiaSemana').value;
    const dt = document.getElementById('escalaDataVigencia').value;
    const lista = await (await apiFetch(`/api/escala?diaSemana=${dia}&data=${dt}`)).json();
    document.getElementById('listaEscalaDia').innerHTML = lista.map((e) => `
      <li>
        <span><strong>${e.nome}</strong> • <small>${e.turno || '24h'} (desde ${fmtBR(e.data_inicio.slice(0, 10))})</small></span>
        <button class="btn-mini danger" onclick="removerDaEscala(${e.id})" title="Remover da escala a partir da data selecionada">Remover</button>
      </li>`).join('');
  }
  document.getElementById('escalaDiaSemana').addEventListener('change', carregarEscalaGerenciar);
  document.getElementById('escalaDataVigencia').addEventListener('change', carregarEscalaGerenciar);
  document.getElementById('btnAddEscala').addEventListener('click', async () => {
    await apiFetch('/api/escala', {
      method: 'POST',
      body: JSON.stringify({
        dia_semana: document.getElementById('escalaDiaSemana').value,
        medico_id: document.getElementById('escalaMedicoId').value,
        turno: document.getElementById('escalaTurno').value,
        data_inicio: document.getElementById('escalaDataVigencia').value
      })
    });
    carregarEscalaGerenciar();
  });
  window.removerDaEscala = async (id) => {
    const dt = document.getElementById('escalaDataVigencia').value;
    if (!confirm(`Remover este médico da escala a partir de ${fmtBR(dt)}?`)) return;
    await apiFetch(`/api/escala/${id}?data_fim=${dt}`, { method: 'DELETE' });
    carregarEscalaGerenciar();
  };

  // ==================== ADMIN ====================
  async function carregarAdmin() {
    const [us, ms] = await Promise.all([(await apiFetch('/api/usuarios')).json(), (await apiFetch('/api/medicos')).json()]);
    medicosLista = ms;
    document.getElementById('listaUsuarios').innerHTML = us.map((u) => `
      <li><span><strong>${u.nome}</strong><br><small>${u.email} • ${u.role}</small></span>
        <div style="display:flex;gap:6px;">
          <button class="btn-mini" onclick="alterarSenhaAdmin(${u.id},'${u.nome}','${u.email}','${u.role}')" title="Alterar senha">Senha</button>
          <button class="btn-mini" onclick="alternarRole(${u.id},'${u.nome}','${u.email}','${u.role}')" title="Alternar Admin/Comum">Cargo</button>
          <button class="btn-mini danger" onclick="excluirUsuario(${u.id})" title="Excluir usuário">X</button>
        </div></li>`).join('');
    document.getElementById('listaMedicos').innerHTML = ms.map((m) => `
      <li><span><strong>${m.nome}</strong></span>
        <button class="btn-mini danger" onclick="excluirMedico(${m.id})" title="Remover médico">Remover</button></li>`).join('');
  }
  document.getElementById('formNovoUsuario').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/usuarios', { method: 'POST', body: JSON.stringify({ nome: document.getElementById('usrNome').value, email: document.getElementById('usrEmail').value, role: document.getElementById('usrRole').value }) });
    e.target.reset(); carregarAdmin();
  });
  window.alterarSenhaAdmin = async (id, nome, email, role) => {
    const novaSenha = prompt(`Nova senha para ${nome}:`, 'upa123');
    if (!novaSenha) return;
    await apiFetch(`/api/usuarios/${id}`, { method: 'PUT', body: JSON.stringify({ nome, email, role, novaSenha }) });
    alert('Senha alterada.');
  };
  window.alternarRole = async (id, nome, email, role) => {
    await apiFetch(`/api/usuarios/${id}`, { method: 'PUT', body: JSON.stringify({ nome, email, role: role === 'admin' ? 'comum' : 'admin' }) });
    carregarAdmin();
  };
  window.excluirUsuario = async (id) => { if (!confirm('Remover usuário?')) return; await apiFetch(`/api/usuarios/${id}`, { method: 'DELETE' }); carregarAdmin(); };
  document.getElementById('formNovoMedico').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/medicos', { method: 'POST', body: JSON.stringify({ nome: document.getElementById('medNome').value }) });
    e.target.reset(); carregarAdmin();
  });
  window.excluirMedico = async (id) => { if (!confirm('Remover médico?')) return; await apiFetch(`/api/medicos/${id}`, { method: 'DELETE' }); carregarAdmin(); };

  inicializar();
}
