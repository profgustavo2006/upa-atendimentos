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
    alert(data.mensagem);
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
      if (btn.dataset.tab === 'tabRelatorios') carregarGrafico();
      if (btn.dataset.tab === 'tabAdmin') carregarAdmin();
    });
  });

  const hoje = new Date().toISOString().split('T')[0];
  document.getElementById('dataPlantao').value = hoje;
  document.getElementById('filtroInicio').value = hoje.slice(0, 8) + '01';
  document.getElementById('filtroFim').value = hoje;

  function formatarDataBR(iso) {
    return iso.split('-').reverse().join('/');
  }

  function atualizarKPIsTela() {
    const somaTela = itensDia.reduce((acc, it) => acc + Number(it.quantidade || 0), 0);
    const qtdMedicos = itensDia.length || 1;
    const media = (somaTela / qtdMedicos).toFixed(1).replace('.', ',');

    document.getElementById('kpiDia').textContent = somaTela;
    document.getElementById('kpiMedia').textContent = media;
  }

  async function carregarResumo(data) {
    const res = await apiFetch(`/api/resumo?data=${data}`);
    resumoCache = await res.json();
    document.getElementById('kpiDia').textContent = resumoCache.totalDia;
    document.getElementById('kpiSemana').textContent = resumoCache.totalSemana;
    document.getElementById('kpiMes').textContent = resumoCache.totalMes;
    document.getElementById('kpiDiaSub').textContent = formatarDataBR(data);
    document.getElementById('kpiSemanaSub').textContent = `${formatarDataBR(resumoCache.inicioSemana)} a ${formatarDataBR(resumoCache.fimSemana)}`;
    document.getElementById('subtituloData').textContent = `UPA Parque dos Ferreira • Plantão de ${formatarDataBR(data)}`;
  }

  async function inicializar() {
    const res = await apiFetch('/api/medicos');
    medicosLista = await res.json();
    await carregarDia();
  }

  async function carregarDia() {
    const data = document.getElementById('dataPlantao').value;
    const [resAtend] = await Promise.all([
      apiFetch(`/api/atendimentos?data=${data}`),
      carregarResumo(data)
    ]);
    const json = await resAtend.json();
    itensDia = json.itens;
    renderizarTabela();
    atualizarKPIsTela();
  }

  function renderizarTabela() {
    const tbody = document.getElementById('tbodyEscala');
    tbody.innerHTML = '';
    itensDia.forEach((item, idx) => {
      const tr = document.createElement('tr');
      const isExtra = Boolean(item.medico_extra_nome);
      const nomeExibido = isExtra
        ? `${item.medico_extra_nome} <span class="badge-extra">Extra</span>`
        : (item.nome_real || item.nome_escalado || 'Novo Médico Extra');

      const opcoesMedicos = medicosLista
        .map((m) => `<option value="${m.id}" ${m.id == item.medico_real_id ? 'selected' : ''}>${m.nome}</option>`)
        .join('');

      tr.innerHTML = `
        <td><strong>${nomeExibido}</strong></td>
        <td>
          <button class="btn-soft" onclick="alternarTroca(${idx})">Trocar</button>
          <div id="troca-${idx}" class="troca-box ${item.editandoTroca ? '' : 'hidden'}">
            <select onchange="selecionarSubstituto(${idx}, this.value)">
              <option value="">-- Selecionar cadastrado --</option>
              ${opcoesMedicos}
            </select>
            <input type="text" placeholder="Ou digite nome do médico extra"
              value="${item.medico_extra_nome || ''}"
              oninput="digitarExtra(${idx}, this.value)">
          </div>
        </td>
        <td>
          <input type="number" min="0" value="${item.quantidade || 0}"
            oninput="atualizarQtd(${idx}, this.value)">
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  window.atualizarQtd = (idx, val) => {
    itensDia[idx].quantidade = Number(val || 0);
    atualizarKPIsTela();
  };

  window.alternarTroca = (idx) => {
    itensDia[idx].editandoTroca = !itensDia[idx].editandoTroca;
    renderizarTabela();
  };

  window.selecionarSubstituto = (idx, medId) => {
    if (!medId) return;
    const med = medicosLista.find((m) => m.id == medId);
    itensDia[idx].medico_real_id = Number(medId);
    itensDia[idx].nome_real = med?.nome;
    itensDia[idx].medico_extra_nome = '';
    renderizarTabela();
  };

  window.digitarExtra = (idx, texto) => {
    itensDia[idx].medico_extra_nome = texto;
    if (texto.trim()) itensDia[idx].medico_real_id = null;
  };

  document.getElementById('btnAddExtra').addEventListener('click', () => {
    itensDia.push({ escala_id: null, medico_escalado_id: null, medico_real_id: null, medico_extra_nome: '', quantidade: 0, editandoTroca: true });
    renderizarTabela();
    atualizarKPIsTela();
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

  // Gráfico principal da aba Relatórios
  async function carregarGrafico() {
    const inicio = document.getElementById('filtroInicio').value;
    const fim = document.getElementById('filtroFim').value;
    const res = await apiFetch(`/api/ranking?inicio=${inicio}&fim=${fim}`);
    const dados = await res.json();

    const ctx = document.getElementById('graficoRanking').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: dados.map((d) => d.medico),
        datasets: [{
          label: 'Total de Atendimentos',
          data: dados.map((d) => d.total),
          backgroundColor: '#155eef',
          borderRadius: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  }

  document.getElementById('btnAtualizarGrafico').addEventListener('click', carregarGrafico);

  // Gera imagem do gráfico para o período escolhido e baixa o Excel
  async function gerarImagemGraficoExcel(periodo, dataRef) {
    const ref = new Date(`${dataRef}T12:00:00`);
    const fmt = (d) => d.toISOString().split('T')[0];
    let ini = dataRef, fim = dataRef, titulo = `Atendimentos do Dia (${formatarDataBR(dataRef)})`;

    if (periodo === 'semanal') {
      const s = new Date(ref); s.setDate(ref.getDate() - ref.getDay());
      const e = new Date(s); e.setDate(s.getDate() + 6);
      ini = fmt(s); fim = fmt(e);
      titulo = `Atendimentos da Semana (${formatarDataBR(ini)} a ${formatarDataBR(fim)})`;
    } else if (periodo === 'mensal') {
      ini = fmt(new Date(ref.getFullYear(), ref.getMonth(), 1));
      fim = fmt(new Date(ref.getFullYear(), ref.getMonth() + 1, 0));
      titulo = `Atendimentos do Mês (${formatarDataBR(ini)} a ${formatarDataBR(fim)})`;
    }

    const res = await apiFetch(`/api/ranking?inicio=${ini}&fim=${fim}`);
    const dados = await res.json();
    if (!dados.length) return null;

    const canvas = document.getElementById('canvasExcel');
    const ctx = canvas.getContext('2d');
    const bgPlugin = {
      id: 'whiteBg',
      beforeDraw: (c) => {
        c.ctx.save();
        c.ctx.fillStyle = '#ffffff';
        c.ctx.fillRect(0, 0, c.width, c.height);
        c.ctx.restore();
      }
    };

    const tempChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: dados.map((d) => d.medico),
        datasets: [{ label: 'Atendimentos', data: dados.map((d) => d.total), backgroundColor: '#1F4E78', borderRadius: 6 }]
      },
      options: {
        animation: false,
        responsive: false,
        plugins: {
          title: { display: true, text: titulo, font: { size: 16, weight: 'bold' }, color: '#0f2544' },
          legend: { display: false }
        },
        scales: { y: { beginAtZero: true } }
      },
      plugins: [bgPlugin]
    });

    const base64 = canvas.toDataURL('image/png');
    tempChart.destroy();
    return base64;
  }

  window.exportarExcel = async (periodo) => {
    const dataRef = document.getElementById('dataPlantao').value;
    const chartBase64 = await gerarImagemGraficoExcel(periodo, dataRef);

    const res = await fetch('/api/exportar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ periodo, dataRef, chartBase64 })
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Atendimentos_UPA_${periodo}_${dataRef}.xlsx`;
    a.click();
  };

  // Administração
  async function carregarAdmin() {
    const [resU, resM] = await Promise.all([apiFetch('/api/usuarios'), apiFetch('/api/medicos')]);
    const usuarios = await resU.json();
    medicosLista = await resM.json();

    document.getElementById('listaUsuarios').innerHTML = usuarios.map((u) => `
      <li>
        <span><strong>${u.nome}</strong><br><small style="color:#64748b">${u.email} • ${u.role}</small></span>
        <div style="display:flex;gap:6px;">
          <button class="btn-mini" onclick="alterarSenhaAdmin(${u.id}, '${u.nome}', '${u.email}', '${u.role}')">Senha</button>
          <button class="btn-mini" onclick="alternarRole(${u.id}, '${u.nome}', '${u.email}', '${u.role}')">Cargo</button>
          <button class="btn-mini danger" onclick="excluirUsuario(${u.id})">X</button>
        </div>
      </li>
    `).join('');

    document.getElementById('listaMedicos').innerHTML = medicosLista.map((m) => `
      <li>
        <span><strong>${m.nome}</strong></span>
        <button class="btn-mini danger" onclick="excluirMedico(${m.id})">Remover</button>
      </li>
    `).join('');
  }

  document.getElementById('formNovoUsuario').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({
        nome: document.getElementById('usrNome').value,
        email: document.getElementById('usrEmail').value,
        role: document.getElementById('usrRole').value
      })
    });
    e.target.reset();
    carregarAdmin();
  });

  window.alterarSenhaAdmin = async (id, nome, email, role) => {
    const novaSenha = prompt(`Nova senha para ${nome} (use "upa123" para forçar troca no próximo login):`, 'upa123');
    if (!novaSenha) return;
    await apiFetch(`/api/usuarios/${id}`, { method: 'PUT', body: JSON.stringify({ nome, email, role, novaSenha }) });
    alert('Senha alterada com sucesso.');
  };

  window.alternarRole = async (id, nome, email, role) => {
    await apiFetch(`/api/usuarios/${id}`, { method: 'PUT', body: JSON.stringify({ nome, email, role: role === 'admin' ? 'comum' : 'admin' }) });
    carregarAdmin();
  };

  window.excluirUsuario = async (id) => {
    if (!confirm('Remover este usuário?')) return;
    await apiFetch(`/api/usuarios/${id}`, { method: 'DELETE' });
    carregarAdmin();
  };

  document.getElementById('formNovoMedico').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/medicos', { method: 'POST', body: JSON.stringify({ nome: document.getElementById('medNome').value }) });
    e.target.reset();
    carregarAdmin();
  });

  window.excluirMedico = async (id) => {
    if (!confirm('Remover médico da lista ativa?')) return;
    await apiFetch(`/api/medicos/${id}`, { method: 'DELETE' });
    carregarAdmin();
  };

  inicializar();
}