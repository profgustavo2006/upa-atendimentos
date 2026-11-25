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

// ==================== LÓGICA DA TELA DE LOGIN ====================
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
    const res = await apiFetch('/api/alterar-senha', {
      method: 'POST',
      body: JSON.stringify({ novaSenha })
    });
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
    const res = await apiFetch('/api/redefinir-senha', {
      method: 'POST',
      body: JSON.stringify({ token: resetToken, novaSenha })
    });
    const data = await res.json();
    alert(data.mensagem || data.erro);
    if (res.ok) location.href = '/';
  });
}

// ==================== LÓGICA DO DASHBOARD ====================
if (document.getElementById('tbodyEscala')) {
  if (!token || !usuario) location.href = '/';
  document.getElementById('infoUsuario').textContent = `${usuario.nome} (${usuario.role.toUpperCase()})`;
  if (usuario.role === 'admin') document.getElementById('btnTabAdmin').classList.remove('hidden');

  document.getElementById('btnSair').addEventListener('click', () => {
    localStorage.clear();
    location.href = '/';
  });

  // Navegação entre abas
  document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
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

  async function inicializar() {
    const res = await apiFetch('/api/medicos');
    medicosLista = await res.json();
    await carregarDia();
  }

  async function carregarDia() {
    const data = document.getElementById('dataPlantao').value;
    const res = await apiFetch(`/api/atendimentos?data=${data}`);
    const json = await res.json();
    itensDia = json.itens;
    renderizarTabela();
  }

  function renderizarTabela() {
    const tbody = document.getElementById('tbodyEscala');
    tbody.innerHTML = '';
    itensDia.forEach((item, idx) => {
      const tr = document.createElement('tr');
      const nomeExibido = item.medico_extra_nome
        ? `${item.medico_extra_nome} (Extra)`
        : (item.nome_real || item.nome_escalado || 'Médico Extra');

      const opcoesMedicos = medicosLista
        .map((m) => `<option value="${m.id}" ${m.id == item.medico_real_id ? 'selected' : ''}>${m.nome}</option>`)
        .join('');

      tr.innerHTML = `
        <td>
          <strong>${nomeExibido}</strong>
          ${item.matricula_plantao ? `<br><small>${item.matricula_plantao}</small>` : ''}
        </td>
        <td>
          <button class="btn-secondary" onclick="alternarTroca(${idx})">Trocar</button>
          <div id="troca-${idx}" class="${item.editandoTroca ? '' : 'hidden'}" style="margin-top:6px;">
            <select onchange="selecionarSubstituto(${idx}, this.value)">
              <option value="">-- Selecionar cadastrado --</option>
              ${opcoesMedicos}
            </select>
            <input type="text" placeholder="Ou digite nome de médico extra"
              value="${item.medico_extra_nome || ''}"
              oninput="digitarExtra(${idx}, this.value)">
          </div>
        </td>
        <td>
          <input type="number" min="0" value="${item.quantidade || 0}"
            oninput="itensDia[${idx}].quantidade = Number(this.value)">
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

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
    itensDia.push({
      escala_id: null,
      medico_escalado_id: null,
      medico_real_id: null,
      medico_extra_nome: '',
      quantidade: 0,
      editandoTroca: true
    });
    renderizarTabela();
  });

  document.getElementById('dataPlantao').addEventListener('change', carregarDia);

  document.getElementById('btnSalvarDia').addEventListener('click', async () => {
    const data = document.getElementById('dataPlantao').value;
    const res = await apiFetch('/api/atendimentos', {
      method: 'POST',
      body: JSON.stringify({ data, itens: itensDia })
    });
    const json = await res.json();
    document.getElementById('msgLancamento').textContent = json.mensagem || json.erro;
  });

  // Gráfico Chart.js
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
          backgroundColor: '#0d47a1'
        }]
      },
      options: { responsive: true, scales: { y: { beginAtZero: true } } }
    });
  }

  document.getElementById('btnAtualizarGrafico').addEventListener('click', carregarGrafico);

  window.exportarExcel = async (periodo) => {
    const dataRef = document.getElementById('dataPlantao').value;
    const res = await fetch(`/api/exportar?periodo=${periodo}&dataRef=${dataRef}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Atendimentos_UPA_${periodo}_${dataRef}.xlsx`;
    a.click();
  };

  // Painel Admin
  async function carregarAdmin() {
    const [resU, resM] = await Promise.all([apiFetch('/api/usuarios'), apiFetch('/api/medicos')]);
    const usuarios = await resU.json();
    medicosLista = await resM.json();

    document.getElementById('listaUsuarios').innerHTML = usuarios.map((u) => `
      <li>
        <span><strong>${u.nome}</strong> (${u.email}) - ${u.role}</span>
        <div>
          <button onclick="alterarSenhaAdmin(${u.id}, '${u.nome}', '${u.email}', '${u.role}')">Senha</button>
          <button onclick="alternarRole(${u.id}, '${u.nome}', '${u.email}', '${u.role}')">Permissão</button>
          <button onclick="excluirUsuario(${u.id})">X</button>
        </div>
      </li>
    `).join('');

    document.getElementById('listaMedicos').innerHTML = medicosLista.map((m) => `
      <li>
        <span><strong>${m.nome}</strong> ${m.matriculas ? `(${m.matriculas})` : ''}</span>
        <button onclick="excluirMedico(${m.id})">Remover</button>
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
    const novaSenha = prompt(`Digite a nova senha para ${nome} (ou deixe "upa123" para forçar troca no próximo login):`, 'upa123');
    if (!novaSenha) return;
    await apiFetch(`/api/usuarios/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ nome, email, role, novaSenha })
    });
    alert('Senha alterada com sucesso.');
  };

  window.alternarRole = async (id, nome, email, role) => {
    const novoRole = role === 'admin' ? 'comum' : 'admin';
    await apiFetch(`/api/usuarios/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ nome, email, role: novoRole })
    });
    carregarAdmin();
  };

  window.excluirUsuario = async (id) => {
    if (!confirm('Remover este usuário?')) return;
    await apiFetch(`/api/usuarios/${id}`, { method: 'DELETE' });
    carregarAdmin();
  };

  document.getElementById('formNovoMedico').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/medicos', {
      method: 'POST',
      body: JSON.stringify({
        nome: document.getElementById('medNome').value,
        matriculas: document.getElementById('medMat').value
      })
    });
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