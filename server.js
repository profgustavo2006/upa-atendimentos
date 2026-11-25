require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' })); // Permite enviar a imagem do gráfico para o Excel
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'segredo_upa_trocar_em_producao';
const SENHA_PADRAO = 'upa123';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

async function garantirAdminInicial() {
  const { rows } = await pool.query('SELECT COUNT(*) FROM usuarios');
  if (Number(rows[0].count) === 0) {
    const hash = await bcrypt.hash(SENHA_PADRAO, 10);
    await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, role, primeiro_acesso)
       VALUES ($1, $2, $3, 'admin', TRUE)`,
      ['Administrador UPA', 'admin@upa.gov.br', hash]
    );
  }
}

function autenticar(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ erro: 'Token não fornecido.' });
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: 'Sessão expirada ou inválida.' });
  }
}

function apenasAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Acesso restrito a administradores.' });
  next();
}

function calcularIntervalos(dataStr) {
  const ref = dataStr ? new Date(`${dataStr}T12:00:00`) : new Date();
  const fmt = (d) => d.toISOString().split('T')[0];

  const inicioSemana = new Date(ref);
  inicioSemana.setDate(ref.getDate() - ref.getDay());
  const fimSemana = new Date(inicioSemana);
  fimSemana.setDate(inicioSemana.getDate() + 6);

  const inicioMes = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const fimMes = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);

  return {
    dia: fmt(ref),
    inicioSemana: fmt(inicioSemana),
    fimSemana: fmt(fimSemana),
    inicioMes: fmt(inicioMes),
    fimMes: fmt(fimMes)
  };
}

// ==================== AUTENTICAÇÃO E SENHAS ====================

app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE LOWER(email) = LOWER($1)', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(senha, user.senha_hash))) {
      return res.status(401).json({ erro: 'E-mail ou senha inválidos.' });
    }
    const token = jwt.sign(
      { id: user.id, nome: user.nome, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({
      token,
      usuario: { id: user.id, nome: user.nome, email: user.email, role: user.role, primeiro_acesso: user.primeiro_acesso }
    });
  } catch {
    res.status(500).json({ erro: 'Erro interno no login.' });
  }
});

app.post('/api/alterar-senha', autenticar, async (req, res) => {
  const { novaSenha } = req.body;
  if (!novaSenha || novaSenha.length < 6 || novaSenha === SENHA_PADRAO) {
    return res.status(400).json({ erro: 'A nova senha deve ter no mínimo 6 caracteres e ser diferente da padrão.' });
  }
  const hash = await bcrypt.hash(novaSenha, 10);
  await pool.query('UPDATE usuarios SET senha_hash = $1, primeiro_acesso = FALSE WHERE id = $2', [hash, req.user.id]);
  res.json({ mensagem: 'Senha atualizada com sucesso.' });
});

app.post('/api/esqueci-senha', async (req, res) => {
  const { email } = req.body;
  const { rows } = await pool.query('SELECT id, nome, email FROM usuarios WHERE LOWER(email) = LOWER($1)', [email]);
  if (rows.length === 0) return res.json({ mensagem: 'Se o e-mail estiver cadastrado, você receberá um link de redefinição.' });

  const token = crypto.randomBytes(24).toString('hex');
  const expira = new Date(Date.now() + 60 * 60 * 1000);
  await pool.query('UPDATE usuarios SET reset_token = $1, reset_expira = $2 WHERE id = $3', [token, expira, rows[0].id]);

  const link = `${process.env.APP_URL || 'http://localhost:3000'}/?resetToken=${token}`;
  if (process.env.SMTP_USER) {
    await transporter.sendMail({
      from: `"UPA Parque dos Ferreira" <${process.env.SMTP_USER}>`,
      to: rows[0].email,
      subject: 'Redefinição de Senha - UPA Parque dos Ferreira',
      html: `<p>Olá, ${rows[0].nome}.</p><p>Clique no link para redefinir sua senha (válido por 1 hora):</p><p><a href="${link}">${link}</a></p>`
    });
  }
  res.json({ mensagem: 'Se o e-mail estiver cadastrado, você receberá um link de redefinição.' });
});

app.post('/api/redefinir-senha', async (req, res) => {
  const { token, novaSenha } = req.body;
  if (!novaSenha || novaSenha.length < 6) return res.status(400).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });
  const { rows } = await pool.query('SELECT id FROM usuarios WHERE reset_token = $1 AND reset_expira > NOW()', [token]);
  if (rows.length === 0) return res.status(400).json({ erro: 'Token inválido ou expirado.' });

  const hash = await bcrypt.hash(novaSenha, 10);
  await pool.query(
    'UPDATE usuarios SET senha_hash = $1, primeiro_acesso = FALSE, reset_token = NULL, reset_expira = NULL WHERE id = $2',
    [hash, rows[0].id]
  );
  res.json({ mensagem: 'Senha redefinida com sucesso. Faça login novamente.' });
});

// ==================== ADMIN: USUÁRIOS E MÉDICOS ====================

app.get('/api/usuarios', autenticar, apenasAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, nome, email, role, primeiro_acesso FROM usuarios ORDER BY nome');
  res.json(rows);
});

app.post('/api/usuarios', autenticar, apenasAdmin, async (req, res) => {
  const { nome, email, role } = req.body;
  try {
    const hash = await bcrypt.hash(SENHA_PADRAO, 10);
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, role, primeiro_acesso)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING id, nome, email, role, primeiro_acesso`,
      [nome, email, hash, role === 'admin' ? 'admin' : 'comum']
    );
    res.status(201).json(rows[0]);
  } catch {
    res.status(400).json({ erro: 'E-mail já cadastrado ou dados inválidos.' });
  }
});

app.put('/api/usuarios/:id', autenticar, apenasAdmin, async (req, res) => {
  const { nome, email, role, novaSenha } = req.body;
  try {
    if (novaSenha) {
      const hash = await bcrypt.hash(novaSenha, 10);
      await pool.query(
        'UPDATE usuarios SET nome = $1, email = $2, role = $3, senha_hash = $4, primeiro_acesso = $5 WHERE id = $6',
        [nome, email, role, hash, novaSenha === SENHA_PADRAO, req.params.id]
      );
    } else {
      await pool.query('UPDATE usuarios SET nome = $1, email = $2, role = $3 WHERE id = $4', [nome, email, role, req.params.id]);
    }
    res.json({ mensagem: 'Usuário atualizado.' });
  } catch {
    res.status(400).json({ erro: 'Erro ao atualizar usuário.' });
  }
});

app.delete('/api/usuarios/:id', autenticar, apenasAdmin, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ erro: 'Você não pode remover o próprio usuário.' });
  await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
  res.json({ mensagem: 'Usuário removido.' });
});

app.get('/api/medicos', autenticar, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM medicos WHERE ativo = TRUE ORDER BY nome');
  res.json(rows);
});

app.post('/api/medicos', autenticar, apenasAdmin, async (req, res) => {
  const { nome, matriculas } = req.body;
  try {
    const { rows } = await pool.query('INSERT INTO medicos (nome, matriculas) VALUES ($1, $2) RETURNING *', [nome, matriculas || null]);
    res.status(201).json(rows[0]);
  } catch {
    res.status(400).json({ erro: 'Médico já cadastrado.' });
  }
});

app.delete('/api/medicos/:id', autenticar, apenasAdmin, async (req, res) => {
  await pool.query('UPDATE medicos SET ativo = FALSE WHERE id = $1', [req.params.id]);
  res.json({ mensagem: 'Médico desativado.' });
});

// ==================== RESUMO KPI (DIA, SEMANA, MÊS) ====================

app.get('/api/resumo', autenticar, async (req, res) => {
  const { dia, inicioSemana, fimSemana, inicioMes, fimMes } = calcularIntervalos(req.query.data);
  const [rDia, rSem, rMes] = await Promise.all([
    pool.query('SELECT COALESCE(SUM(quantidade), 0)::INT AS total FROM atendimentos WHERE data = $1', [dia]),
    pool.query('SELECT COALESCE(SUM(quantidade), 0)::INT AS total FROM atendimentos WHERE data BETWEEN $1 AND $2', [inicioSemana, fimSemana]),
    pool.query('SELECT COALESCE(SUM(quantidade), 0)::INT AS total FROM atendimentos WHERE data BETWEEN $1 AND $2', [inicioMes, fimMes])
  ]);
  res.json({
    totalDia: rDia.rows[0].total,
    totalSemana: rSem.rows[0].total,
    totalMes: rMes.rows[0].total,
    inicioSemana,
    fimSemana,
    inicioMes,
    fimMes
  });
});

// ==================== LANÇAMENTO DIÁRIO E TROCAS ====================

app.get('/api/atendimentos', autenticar, async (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).json({ erro: 'Informe a data.' });

  const [ano, mes, dia] = data.split('-').map(Number);
  const diaSemana = new Date(ano, mes - 1, dia).getDay();

  const salvos = await pool.query(
    `SELECT a.*, me.nome AS nome_escalado, mr.nome AS nome_real
     FROM atendimentos a
     LEFT JOIN medicos me ON me.id = a.medico_escalado_id
     LEFT JOIN medicos mr ON mr.id = a.medico_real_id
     WHERE a.data = $1 ORDER BY a.id`,
    [data]
  );
  if (salvos.rows.length > 0) return res.json({ origem: 'salvo', itens: salvos.rows });

  const escala = await pool.query(
    `SELECT e.id AS escala_id, e.medico_id AS medico_escalado_id,
            e.medico_id AS medico_real_id, m.nome AS nome_escalado,
            m.nome AS nome_real, e.matricula_plantao, 0 AS quantidade, NULL AS medico_extra_nome
     FROM escala_padrao e
     JOIN medicos m ON m.id = e.medico_id
     WHERE e.dia_semana = $1 AND e.ativo = TRUE AND m.ativo = TRUE
     ORDER BY m.nome`,
    [diaSemana]
  );
  res.json({ origem: 'escala', itens: escala.rows });
});

app.post('/api/atendimentos', autenticar, async (req, res) => {
  const { data, itens } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM atendimentos WHERE data = $1', [data]);
    for (const item of itens) {
      await client.query(
        `INSERT INTO atendimentos
          (data, escala_id, medico_escalado_id, medico_real_id, medico_extra_nome, quantidade, registrado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          data,
          item.escala_id || null,
          item.medico_escalado_id || null,
          item.medico_extra_nome ? null : (item.medico_real_id || item.medico_escalado_id),
          item.medico_extra_nome?.trim() || null,
          Number(item.quantidade || 0),
          req.user.id
        ]
      );
    }
    await client.query('COMMIT');
    res.json({ mensagem: 'Atendimentos salvos com sucesso!' });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ erro: 'Erro ao salvar atendimentos.' });
  } finally {
    client.release();
  }
});

// ==================== GRÁFICO (AGRUPADO POR PROFISSIONAL) ====================

app.get('/api/ranking', autenticar, async (req, res) => {
  const { inicio, fim } = req.query;
  const { rows } = await pool.query(
    `SELECT COALESCE(m.nome, a.medico_extra_nome, 'Não informado') AS medico,
            SUM(a.quantidade)::INTEGER AS total
     FROM atendimentos a
     LEFT JOIN medicos m ON m.id = a.medico_real_id
     WHERE ($1::date IS NULL OR a.data >= $1::date)
       AND ($2::date IS NULL OR a.data <= $2::date)
     GROUP BY COALESCE(m.nome, a.medico_extra_nome, 'Não informado')
     HAVING SUM(a.quantidade) > 0
     ORDER BY total DESC`,
    [inicio || null, fim || null]
  );
  res.json(rows);
});

// ==================== EXPORTAÇÃO EXCEL (MODELO UPA + GRÁFICO) ====================

app.post('/api/exportar', autenticar, async (req, res) => {
  const { periodo, dataRef, chartBase64 } = req.body;
  const { dia, inicioSemana, fimSemana, inicioMes, fimMes } = calcularIntervalos(dataRef);
  const fmtBR = (iso) => iso.split('-').reverse().join('/');

  const wb = new ExcelJS.Workbook();
  const azulEscuro = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  const amareloClaro = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
  const cinzaClaro = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F7' } };
  const bordaFina = {
    top: { style: 'thin', color: { argb: 'FFD0D7DE' } },
    left: { style: 'thin', color: { argb: 'FFD0D7DE' } },
    bottom: { style: 'thin', color: { argb: 'FFD0D7DE' } },
    right: { style: 'thin', color: { argb: 'FFD0D7DE' } }
  };

  let ws;
  let linhaGrafico = 15;

  if (periodo === 'semanal') {
    const nomeAba = `${inicioSemana.slice(8, 10)}-${inicioSemana.slice(5, 7)} a ${fimSemana.slice(8, 10)}-${fimSemana.slice(5, 7)}`;
    ws = wb.addWorksheet(nomeAba);

    // Título idêntico ao modelo
    ws.mergeCells('A1:K1');
    ws.getCell('A1').value = 'CONTROLE DE ATENDIMENTOS MÉDICOS POR DIA DA SEMANA – UPA PARQUE DOS FERREIRA';
    ws.getCell('A1').fill = azulEscuro;
    ws.getCell('A1').font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 28;

    ws.getCell('A2').value = 'Semana de:';
    ws.getCell('A2').font = { bold: true };
    ws.getCell('B2').value = fmtBR(inicioSemana);
    ws.getCell('C2').value = 'a';
    ws.getCell('C2').alignment = { horizontal: 'center' };
    ws.getCell('D2').value = fmtBR(fimSemana);

    const diasSemana = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    const datasSemana = [];
    const base = new Date(`${inicioSemana}T12:00:00`);
    for (let i = 0; i < 7; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      datasSemana.push(d.toISOString().split('T')[0]);
    }

    const r4 = ws.getRow(4);
    r4.values = ['Médico(a)', ...diasSemana, 'Total da Semana', 'Média Diária', 'Dias na Escala'];
    const r5 = ws.getRow(5);
    r5.values = ['Data', ...datasSemana.map(fmtBR), '', '', ''];

    [r4, r5].forEach((r) => {
      r.eachCell((c) => {
        c.fill = azulEscuro;
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.border = bordaFina;
      });
    });

    const [medicosRes, escalaRes, atendRes] = await Promise.all([
      pool.query('SELECT id, nome FROM medicos WHERE ativo = TRUE ORDER BY nome'),
      pool.query('SELECT dia_semana, medico_id FROM escala_padrao WHERE ativo = TRUE'),
      pool.query(
        `SELECT TO_CHAR(a.data, 'YYYY-MM-DD') AS data_str,
                COALESCE(m.nome, a.medico_extra_nome) AS nome,
                SUM(a.quantidade)::INT AS qtd
         FROM atendimentos a
         LEFT JOIN medicos m ON m.id = a.medico_real_id
         WHERE a.data BETWEEN $1 AND $2
         GROUP BY data_str, nome`,
        [inicioSemana, fimSemana]
      )
    ]);

    const escalaPorMedico = {};
    escalaRes.rows.forEach((e) => {
      escalaPorMedico[e.medico_id] = escalaPorMedico[e.medico_id] || new Set();
      escalaPorMedico[e.medico_id].add(e.dia_semana);
    });

    const atendMapa = {};
    const extras = new Set();
    const nomesCadastrados = new Set(medicosRes.rows.map((m) => m.nome));

    atendRes.rows.forEach((r) => {
      atendMapa[`${r.nome}|${r.data_str}`] = r.qtd;
      if (r.nome && !nomesCadastrados.has(r.nome)) extras.add(r.nome);
    });

    const listaFinal = [
      ...medicosRes.rows.map((m) => ({ nome: m.nome, diasEscala: escalaPorMedico[m.id] || new Set() })),
      ...Array.from(extras).map((nome) => ({ nome, diasEscala: new Set() }))
    ];

    let rowIdx = 6;
    listaFinal.forEach((med) => {
      const row = ws.getRow(rowIdx);
      row.getCell(1).value = med.nome;
      row.getCell(1).font = { bold: true };
      row.getCell(1).border = bordaFina;

      for (let d = 0; d < 7; d++) {
        const cell = row.getCell(d + 2);
        const val = atendMapa[`${med.nome}|${datasSemana[d]}`];
        const naEscala = med.diasEscala.has(d);
        if (val !== undefined) {
          cell.value = val;
          cell.fill = amareloClaro;
          cell.font = { color: { argb: 'FF0000FF' }, bold: true };
        } else if (naEscala) {
          cell.fill = amareloClaro;
        } else {
          cell.value = '–';
          cell.fill = cinzaClaro;
          cell.font = { color: { argb: 'FF999999' } };
        }
        cell.alignment = { horizontal: 'center' };
        cell.border = bordaFina;
      }

      row.getCell(9).value = { formula: `SUM(B${rowIdx}:H${rowIdx})` };
      row.getCell(10).value = { formula: `IF(COUNT(B${rowIdx}:H${rowIdx})=0,0,AVERAGE(B${rowIdx}:H${rowIdx}))` };
      row.getCell(10).numFmt = '0.0';
      row.getCell(11).value = med.diasEscala.size;
      [9, 10, 11].forEach((col) => {
        row.getCell(col).alignment = { horizontal: 'center' };
        row.getCell(col).border = bordaFina;
        row.getCell(col).font = { bold: col === 9 };
      });
      rowIdx++;
    });

    const lastDataRow = rowIdx - 1;
    const rTotal = ws.getRow(rowIdx);
    rTotal.getCell(1).value = 'TOTAL DO DIA';
    const rEscala = ws.getRow(rowIdx + 1);
    rEscala.getCell(1).value = 'MÉDICOS NA ESCALA';
    const rMedia = ws.getRow(rowIdx + 2);
    rMedia.getCell(1).value = 'MÉDIA POR MÉDICO ESCALADO';

    const cols = ['B', 'C', 'D', 'E', 'F', 'G', 'H'];
    cols.forEach((colLet, idx) => {
      const c = idx + 2;
      const qtdEscalaDia = escalaRes.rows.filter((e) => e.dia_semana === idx).length;
      rTotal.getCell(c).value = { formula: `SUM(${colLet}6:${colLet}${lastDataRow})` };
      rEscala.getCell(c).value = qtdEscalaDia;
      rMedia.getCell(c).value = { formula: `IF(${colLet}${rowIdx + 1}=0,0,${colLet}${rowIdx}/${colLet}${rowIdx + 1})` };
      rMedia.getCell(c).numFmt = '0.0';
    });

    rTotal.getCell(9).value = { formula: `SUM(B${rowIdx}:H${rowIdx})` };
    rEscala.getCell(9).value = { formula: `SUM(B${rowIdx + 1}:H${rowIdx + 1})` };
    rMedia.getCell(9).value = { formula: `IF(I${rowIdx + 1}=0,0,I${rowIdx}/I${rowIdx + 1})` };
    rMedia.getCell(9).numFmt = '0.0';

    [rTotal, rEscala, rMedia].forEach((r) => {
      r.eachCell((cell) => {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } };
        cell.alignment = { horizontal: cell.col === 1 ? 'left' : 'center' };
        cell.border = bordaFina;
      });
    });

    ws.columns = [
      { width: 28 }, { width: 14 }, { width: 15 }, { width: 14 }, { width: 14 },
      { width: 14 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 15 }, { width: 15 }
    ];
    linhaGrafico = rowIdx + 4;
  } else {
    // DIÁRIA ou MENSAL (com o mesmo visual oficial + gráfico na mesma aba)
    const isDiaria = periodo === 'diaria';
    const ini = isDiaria ? dia : inicioMes;
    const fim = isDiaria ? dia : fimMes;
    ws = wb.addWorksheet(isDiaria ? `Dia ${dia.slice(8, 10)}-${dia.slice(5, 7)}` : `Mes ${inicioMes.slice(5, 7)}-${inicioMes.slice(0, 4)}`);

    ws.mergeCells('A1:E1');
    ws.getCell('A1').value = `CONTROLE DE ATENDIMENTOS (${isDiaria ? 'DIÁRIO' : 'MENSAL'}) – UPA PARQUE DOS FERREIRA`;
    ws.getCell('A1').fill = azulEscuro;
    ws.getCell('A1').font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 28;

    ws.getCell('A2').value = isDiaria ? `Data: ${fmtBR(dia)}` : `Período: ${fmtBR(ini)} a ${fmtBR(fim)}`;
    ws.getCell('A2').font = { bold: true };

    const headerRow = ws.getRow(4);
    headerRow.values = isDiaria
      ? ['Médico(a)', 'Data', 'Tipo / Status', 'Atendimentos', '']
      : ['Médico(a)', 'Dias Trabalhados', 'Total no Mês', 'Média Diária', ''];

    headerRow.eachCell((c, colNum) => {
      if (colNum <= 4) {
        c.fill = azulEscuro;
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.alignment = { horizontal: 'center' };
        c.border = bordaFina;
      }
    });

    const query = isDiaria
      ? `SELECT COALESCE(mr.nome, a.medico_extra_nome) AS medico,
                CASE WHEN a.medico_extra_nome IS NOT NULL THEN 'Extra/Substituto'
                     WHEN a.medico_real_id <> a.medico_escalado_id THEN 'Troca de Plantão'
                     ELSE 'Escala Normal' END AS status,
                a.quantidade::INT AS total
         FROM atendimentos a
         LEFT JOIN medicos mr ON mr.id = a.medico_real_id
         WHERE a.data = $1 ORDER BY total DESC`
      : `SELECT COALESCE(mr.nome, a.medico_extra_nome) AS medico,
                COUNT(DISTINCT a.data)::INT AS dias,
                SUM(a.quantidade)::INT AS total
         FROM atendimentos a
         LEFT JOIN medicos mr ON mr.id = a.medico_real_id
         WHERE a.data BETWEEN $1 AND $2 AND a.quantidade > 0
         GROUP BY medico ORDER BY total DESC`;

    const { rows } = await pool.query(query, isDiaria ? [dia] : [ini, fim]);
    let rowIdx = 5;
    rows.forEach((r) => {
      const row = ws.getRow(rowIdx);
      if (isDiaria) {
        row.values = [r.medico, fmtBR(dia), r.status, r.total];
        row.getCell(4).fill = amareloClaro;
        row.getCell(4).font = { bold: true, color: { argb: 'FF0000FF' } };
      } else {
        row.values = [r.medico, r.dias, r.total, { formula: `IF(B${rowIdx}=0,0,C${rowIdx}/B${rowIdx})` }];
        row.getCell(3).fill = amareloClaro;
        row.getCell(3).font = { bold: true, color: { argb: 'FF0000FF' } };
        row.getCell(4).numFmt = '0.0';
      }
      for (let c = 1; c <= 4; c++) {
        row.getCell(c).border = bordaFina;
        if (c > 1) row.getCell(c).alignment = { horizontal: 'center' };
      }
      rowIdx++;
    });

    const lastR = Math.max(5, rowIdx - 1);
    const rTot = ws.getRow(rowIdx);
    const rMed = ws.getRow(rowIdx + 1);
    if (isDiaria) {
      rTot.values = ['TOTAL DO DIA', '', '', rows.length ? { formula: `SUM(D5:D${lastR})` } : 0];
      rMed.values = ['MÉDIA POR MÉDICO', '', '', rows.length ? { formula: `AVERAGE(D5:D${lastR})` } : 0];
      rMed.getCell(4).numFmt = '0.0';
    } else {
      rTot.values = ['TOTAL DO MÊS', rows.length ? { formula: `SUM(B5:B${lastR})` } : 0, rows.length ? { formula: `SUM(C5:C${lastR})` } : 0, ''];
      rMed.values = ['MÉDIA POR MÉDICO', '', rows.length ? { formula: `AVERAGE(C5:C${lastR})` } : 0, ''];
      rMed.getCell(3).numFmt = '0.0';
    }
    [rTot, rMed].forEach((r) => {
      for (let c = 1; c <= 4; c++) {
        r.getCell(c).font = { bold: true };
        r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } };
        r.getCell(c).border = bordaFina;
        if (c > 1) r.getCell(c).alignment = { horizontal: 'center' };
      }
    });

    ws.columns = [{ width: 32 }, { width: 18 }, { width: 20 }, { width: 18 }, { width: 5 }];
    linhaGrafico = rowIdx + 3;
  }

  // Insere o gráfico na mesma aba do Excel
  if (chartBase64 && chartBase64.startsWith('data:image/png;base64,')) {
    const imgId = wb.addImage({ base64: chartBase64, extension: 'png' });
    ws.addImage(imgId, {
      tl: { col: 0, row: linhaGrafico },
      ext: { width: 760, height: 360 }
    });
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=Atendimentos_UPA_${periodo}_${dia}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await garantirAdminInicial();
  console.log(`Servidor UPA rodando na porta ${PORT}`);
});