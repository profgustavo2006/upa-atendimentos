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
app.use(express.json({ limit: '5mb' }));
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
  secure: Number(process.env.SMTP_PORT) === 465,
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
  return { dia: fmt(ref), inicioSemana: fmt(inicioSemana), fimSemana: fmt(fimSemana), inicioMes: fmt(inicioMes), fimMes: fmt(fimMes) };
}

// ==================== AUTENTICAÇÃO ====================
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE LOWER(email) = LOWER($1)', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(senha, user.senha_hash))) {
      return res.status(401).json({ erro: 'E-mail ou senha inválidos.' });
    }
    const token = jwt.sign({ id: user.id, nome: user.nome, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, usuario: { id: user.id, nome: user.nome, email: user.email, role: user.role, primeiro_acesso: user.primeiro_acesso } });
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
  const
 { email } = req.body;
  try
 {
    const { rows } = await pool.query('SELECT id, nome, email FROM usuarios WHERE LOWER(email) = LOWER($1)'
, [email]);
    if (rows.length === 0
) {
      return res.json({ mensagem: 'Se o e-mail estiver cadastrado, você receberá um link de redefinição.'
 });
    }
    if
 (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(400).json({ erro: 'Envio de e-mail ainda não configurado no Render (SMTP_USER / SMTP_PASS).'
 });
    }
    const token = crypto.randomBytes(24).toString('hex'
);
    const expira = new Date(Date.now() + 60 * 60 * 1000
);
    await pool.query('UPDATE usuarios SET reset_token = $1, reset_expira = $2 WHERE id = $3', [token, expira, rows[0
].id]);

    const link = `${process.env.APP_URL || 'https://upa-atendimentos.onrender.com'}/?resetToken=${token}`
;
    const info = await
 transporter.sendMail({
      from: `"UPA Parque dos Ferreira" <${process.env.SMTP_USER}>`
,
      to: rows[0
].email,
      subject: 'Redefinição de Senha - UPA Parque dos Ferreira'
,
      html: `<p>Olá, ${rows[0].nome}.</p><p>Clique no link para redefinir sua senha (válido por 1 hora):</p><p><a href="${link}">${link}</a></p>`
    });

    console.log('E-mail enviado com sucesso:', info.messageId, 'para', rows[0
].email);
    res.json({ 
mensagem: `E-mail de confirmação enviado com sucesso para ${rows[0].email}! Verifique sua caixa de entrada e a pasta de Spam.`
 });
  } 
catch
 (err) {
    console.error('Erro SMTP:'
, err);
    res.status(
500).json({ erro: `Falha ao enviar e-mail (${err.code || 'SMTP'}): ${err.message}`
 });
  }
});

app.post('/api/redefinir-senha', async (req, res) => {
  const { token, novaSenha } = req.body;
  if (!novaSenha || novaSenha.length < 6) return res.status(400).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });
  const { rows } = await pool.query('SELECT id FROM usuarios WHERE reset_token = $1 AND reset_expira > NOW()', [token]);
  if (rows.length === 0) return res.status(400).json({ erro: 'Token inválido ou expirado.' });
  const hash = await bcrypt.hash(novaSenha, 10);
  await pool.query('UPDATE usuarios SET senha_hash = $1, primeiro_acesso = FALSE, reset_token = NULL, reset_expira = NULL WHERE id = $2', [hash, rows[0].id]);
  res.json({ mensagem: 'Senha redefinida com sucesso. Faça login novamente.' });
});

// ==================== USUÁRIOS E MÉDICOS ====================
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
       VALUES ($1, $2, $3, $4, TRUE) RETURNING id, nome, email, role`,
      [nome, email, hash, role === 'admin' ? 'admin' : 'comum']
    );
    res.status(201).json(rows[0]);
  } catch {
    res.status(400).json({ erro: 'E-mail já cadastrado.' });
  }
});

app.put('/api/usuarios/:id', autenticar, apenasAdmin, async (req, res) => {
  const { nome, email, role, novaSenha } = req.body;
  try {
    if (novaSenha) {
      const hash = await bcrypt.hash(novaSenha, 10);
      await pool.query('UPDATE usuarios SET nome=$1, email=$2, role=$3, senha_hash=$4, primeiro_acesso=$5 WHERE id=$6',
        [nome, email, role, hash, novaSenha === SENHA_PADRAO, req.params.id]);
    } else {
      await pool.query('UPDATE usuarios SET nome=$1, email=$2, role=$3 WHERE id=$4', [nome, email, role, req.params.id]);
    }
    res.json({ mensagem: 'Usuário atualizado.' });
  } catch {
    res.status(400).json({ erro: 'Erro ao atualizar usuário.' });
  }
});

app.delete('/api/usuarios/:id', autenticar, apenasAdmin, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ erro: 'Você não pode remover a si mesmo.' });
  await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
  res.json({ mensagem: 'Usuário removido.' });
});

app.get('/api/medicos', autenticar, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM medicos WHERE ativo = TRUE ORDER BY nome');
  res.json(rows);
});

app.post('/api/medicos', autenticar, async (req, res) => {
  const { nome } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO medicos (nome, ativo) VALUES ($1, TRUE) ON CONFLICT (nome) DO UPDATE SET ativo = TRUE RETURNING *',
      [nome.trim()]
    );
    res.status(201).json(rows[0]);
  } catch {
    res.status(400).json({ erro: 'Erro ao cadastrar médico.' });
  }
});

app.delete('/api/medicos/:id', autenticar, async (req, res) => {
  await pool.query('UPDATE medicos SET ativo = FALSE WHERE id = $1', [req.params.id]);
  res.json({ mensagem: 'Médico removido.' });
});

// ==================== GERENCIAR ESCALA COM DATA DE VIGÊNCIA ====================
app.get('/api/escala', autenticar, async (req, res) => {
  const { diaSemana, data } = req.query;
  const ref = data || new Date().toISOString().split('T')[0];
  const { rows } = await pool.query(
    `SELECT e.id, e.dia_semana, e.medico_id, m.nome, e.turno, e.data_inicio, e.data_fim
     FROM escala_padrao e JOIN medicos m ON m.id = e.medico_id
     WHERE e.dia_semana = $1 AND e.ativo = TRUE
       AND e.data_inicio <= $2::date
       AND (e.data_fim IS NULL OR e.data_fim >= $2::date)
     ORDER BY m.nome`,
    [Number(diaSemana), ref]
  );
  res.json(rows);
});

app.post('/api/escala', autenticar, async (req, res) => {
  const { dia_semana, medico_id, turno, data_inicio } = req.body;
  await pool.query(
    `INSERT INTO escala_padrao (dia_semana, medico_id, turno, data_inicio, ativo)
     VALUES ($1, $2, $3, $4, TRUE)`,
    [Number(dia_semana), Number(medico_id), turno || '24h', data_inicio]
  );
  res.status(201).json({ mensagem: 'Médico adicionado à escala a partir de ' + data_inicio });
});

app.delete('/api/escala/:id', autenticar, async (req, res) => {
  const { data_fim } = req.query;
  if (data_fim) {
    // Encerra a vigência no dia anterior à data escolhida para não afetar o passado
    await pool.query(`UPDATE escala_padrao SET data_fim = ($1::date - INTERVAL '1 day')::date WHERE id = $2`, [data_fim, req.params.id]);
  } else {
    await pool.query('UPDATE escala_padrao SET ativo = FALSE WHERE id = $1', [req.params.id]);
  }
  res.json({ mensagem: 'Removido da escala.' });
});

// ==================== RESUMO & LANÇAMENTOS ====================
app.get('/api/resumo', autenticar, async (req, res) => {
  const { dia, inicioSemana, fimSemana, inicioMes, fimMes } = calcularIntervalos(req.query.data);
  const [rDia, rSem, rMes] = await Promise.all([
    pool.query('SELECT COALESCE(SUM(quantidade), 0)::INT AS total FROM atendimentos WHERE data = $1', [dia]),
    pool.query('SELECT COALESCE(SUM(quantidade), 0)::INT AS total FROM atendimentos WHERE data BETWEEN $1 AND $2', [inicioSemana, fimSemana]),
    pool.query('SELECT COALESCE(SUM(quantidade), 0)::INT AS total FROM atendimentos WHERE data BETWEEN $1 AND $2', [inicioMes, fimMes])
  ]);
  res.json({ totalDia: rDia.rows[0].total, totalSemana: rSem.rows[0].total, totalMes: rMes.rows[0].total, inicioSemana, fimSemana, inicioMes, fimMes });
});

app.get('/api/atendimentos', autenticar, async (req, res) => {
  const { data } = req.query;
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
    `SELECT e.id AS escala_id, e.medico_id AS medico_escalado_id, e.medico_id AS medico_real_id,
            m.nome AS nome_escalado, m.nome AS nome_real, COALESCE(e.turno, '24h') AS turno,
            0 AS quantidade, NULL AS medico_extra_nome
     FROM escala_padrao e JOIN medicos m ON m.id = e.medico_id
     WHERE e.dia_semana = $1 AND e.ativo = TRUE AND m.ativo = TRUE
       AND e.data_inicio <= $2::date AND (e.data_fim IS NULL OR e.data_fim >= $2::date)
     ORDER BY m.nome`,
    [diaSemana, data]
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
        `INSERT INTO atendimentos (data, escala_id, medico_escalado_id, medico_real_id, medico_extra_nome, turno, quantidade, registrado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          data, item.escala_id || null, item.medico_escalado_id || null,
          item.medico_extra_nome ? null : (item.medico_real_id || item.medico_escalado_id),
          item.medico_extra_nome?.trim() || null, item.turno || '24h',
          Number(item.quantidade || 0), req.user.id
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

app.get('/api/ranking', autenticar, async (req, res) => {
  const { inicio, fim } = req.query;
  const { rows } = await pool.query(
    `SELECT COALESCE(m.nome, a.medico_extra_nome, 'Não informado') AS medico, SUM(a.quantidade)::INTEGER AS total
     FROM atendimentos a LEFT JOIN medicos m ON m.id = a.medico_real_id
     WHERE ($1::date IS NULL OR a.data >= $1::date) AND ($2::date IS NULL OR a.data <= $2::date)
     GROUP BY COALESCE(m.nome, a.medico_extra_nome, 'Não informado')
     HAVING SUM(a.quantidade) > 0 ORDER BY total DESC`,
    [inicio || null, fim || null]
  );
  res.json(rows);
});

// ==================== PRÉVIA E EXPORTAÇÃO DE PLANILHAS ====================
async function montarDadosPlanilha(periodo, dataRef) {
  const { dia, inicioSemana, fimSemana, inicioMes, fimMes } = calcularIntervalos(dataRef);
  const fmtBR = (iso) => iso.split('-').reverse().join('/');

  if (periodo === 'semanal') {
    const diasNome = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const datas = [];
    const base = new Date(`${inicioSemana}T12:00:00`);
    for (let i = 0; i < 7; i++) {
      const d = new Date(base); d.setDate(base.getDate() + i);
      datas.push(d.toISOString().split('T')[0]);
    }
    const [medRes, escRes, atdRes] = await Promise.all([
      pool.query('SELECT id, nome FROM medicos WHERE ativo = TRUE ORDER BY nome'),
      pool.query('SELECT dia_semana, medico_id FROM escala_padrao WHERE ativo = TRUE AND data_inicio <= $1::date AND (data_fim IS NULL OR data_fim >= $2::date)', [fimSemana, inicioSemana]),
      pool.query(`SELECT TO_CHAR(a.data,'YYYY-MM-DD') AS dt, COALESCE(m.nome, a.medico_extra_nome) AS nome, SUM(a.quantidade)::INT AS qtd
                  FROM atendimentos a LEFT JOIN medicos m ON m.id = a.medico_real_id
                  WHERE a.data BETWEEN $1 AND $2 GROUP BY 1, 2`, [inicioSemana, fimSemana])
    ]);
    const escMap = {};
    escRes.rows.forEach((e) => { (escMap[e.medico_id] = escMap[e.medico_id] || new Set()).add(e.dia_semana); });
    const atdMap = {};
    const extras = new Set();
    const cad = new Set(medRes.rows.map((m) => m.nome));
    atdRes.rows.forEach((r) => { atdMap[`${r.nome}|${r.dt}`] = r.qtd; if (r.nome && !cad.has(r.nome)) extras.add(r.nome); });

    const linhas = [...medRes.rows.map((m) => ({ nome: m.nome, diasEsc: escMap[m.id] || new Set() })), ...Array.from(extras).map((n) => ({ nome: n, diasEsc: new Set() }))]
      .map((m) => {
        const vals = datas.map((dt) => atdMap[`${m.nome}|${dt}`] ?? null);
        const total = vals.reduce((a, b) => a + (b || 0), 0);
        const trab = vals.filter((v) => v !== null && v > 0).length;
        return { nome: m.nome, vals, total, media: trab ? +(total / trab).toFixed(1) : 0, diasEscala: m.diasEsc.size, diasSet: Array.from(m.diasEsc) };
      });
    return { titulo: `CONTROLE SEMANAL (${fmtBR(inicioSemana)} a ${fmtBR(fimSemana)}) – UPA PARQUE DOS FERREIRA`, periodo, inicio: inicioSemana, fim: fimSemana, diasNome, datas, linhas };
  }

  const isDiaria = periodo === 'diaria';
  const ini = isDiaria ? dia : inicioMes;
  const fim = isDiaria ? dia : fimMes;
  const q = isDiaria
    ? `SELECT COALESCE(mr.nome, a.medico_extra_nome) AS medico, COALESCE(a.turno,'24h') AS col2,
              CASE WHEN a.medico_extra_nome IS NOT NULL THEN 'Extra' WHEN a.medico_real_id <> a.medico_escalado_id THEN 'Troca' ELSE 'Escala' END AS col3,
              a.quantidade::INT AS total
       FROM atendimentos a LEFT JOIN medicos mr ON mr.id = a.medico_real_id WHERE a.data = $1 ORDER BY total DESC`
    : `SELECT COALESCE(mr.nome, a.medico_extra_nome) AS medico, COUNT(DISTINCT a.data)::INT AS col2,
              SUM(a.quantidade)::INT AS total, ROUND(SUM(a.quantidade)::NUMERIC / GREATEST(COUNT(DISTINCT a.data),1), 1)::FLOAT AS col3
       FROM atendimentos a LEFT JOIN medicos mr ON mr.id = a.medico_real_id
       WHERE a.data BETWEEN $1 AND $2 AND a.quantidade > 0 GROUP BY medico ORDER BY total DESC`;
  const { rows } = await pool.query(q, isDiaria ? [dia] : [ini, fim]);
  return {
    titulo: `CONTROLE ${isDiaria ? 'DIÁRIO' : 'MENSAL'} (${isDiaria ? fmtBR(dia) : `${fmtBR(ini)} a ${fmtBR(fim)}`}) – UPA PARQUE DOS FERREIRA`,
    periodo, inicio: ini, fim, linhas: rows
  };
}

app.get('/api/preview', autenticar, async (req, res) => {
  try {
    const dados = await montarDadosPlanilha(req.query.periodo || 'diaria', req.query.dataRef);
    res.json(dados);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao gerar prévia.' });
  }
});

app.post('/api/exportar', autenticar, async (req, res) => {
  try {
    const { periodo, dataRef, chartBase64 } = req.body;
    const dados = await montarDadosPlanilha(periodo, dataRef);
    const fmtBR = (iso) => iso.split('-').reverse().join('/');
    const wb = new ExcelJS.Workbook();
    const azul = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    const amarelo = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    const cinza = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F7' } };
    const borda = { top: { style: 'thin', color: { argb: 'FFD0D7DE' } }, left: { style: 'thin', color: { argb: 'FFD0D7DE' } }, bottom: { style: 'thin', color: { argb: 'FFD0D7DE' } }, right: { style: 'thin', color: { argb: 'FFD0D7DE' } } };

    const ws = wb.addWorksheet(periodo === 'semanal' ? 'Semanal' : periodo === 'diaria' ? 'Diaria' : 'Mensal');
    let linhaGrafico = 15;

    if (periodo === 'semanal') {
      ws.mergeCells('A1:K1');
      ws.getCell('A1').value = dados.titulo;
      ws.getCell('A1').fill = azul; ws.getCell('A1').font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' }; ws.getRow(1).height = 26;

      const r3 = ws.getRow(3); r3.values = ['Médico(a)', ...dados.diasNome, 'Total', 'Média', 'Escala'];
      const r4 = ws.getRow(4); r4.values = ['Data', ...dados.datas.map(fmtBR), '', '', ''];
      [r3, r4].forEach((r) => { for (let c = 1; c <= 11; c++) { const cell = r.getCell(c); cell.fill = azul; cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.alignment = { horizontal: 'center' }; cell.border = borda; } });

      let ri = 5;
      dados.linhas.forEach((m) => {
        const row = ws.getRow(ri);
        row.getCell(1).value = m.nome; row.getCell(1).font = { bold: true }; row.getCell(1).border = borda;
        m.vals.forEach((v, idx) => {
          const cell = row.getCell(idx + 2);
          if (v !== null) { cell.value = v; cell.fill = amarelo; cell.font = { bold: true, color: { argb: 'FF0000FF' } }; }
          else if (m.diasSet.includes(idx)) { cell.fill = amarelo; }
          else { cell.value = '-'; cell.fill = cinza; cell.font = { color: { argb: 'FF999999' } }; }
          cell.alignment = { horizontal: 'center' }; cell.border = borda;
        });
        row.getCell(9).value = { formula: `SUM(B${ri}:H${ri})` };
        row.getCell(10).value = { formula: `IF(COUNT(B${ri}:H${ri})=0,0,AVERAGE(B${ri}:H${ri}))` };
        row.getCell(10).numFmt = '0.0';
        row.getCell(11).value = m.diasEscala;
        [9, 10, 11].forEach((c) => { row.getCell(c).alignment = { horizontal: 'center' }; row.getCell(c).border = borda; });
        ri++;
      });

      const lastR = Math.max(5, ri - 1);
      const rTot = ws.getRow(ri); rTot.getCell(1).value = 'TOTAL DO DIA';
      ['B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach((col, i) => { rTot.getCell(i + 2).value = { formula: `SUM(${col}5:${col}${lastR})` }; });
      rTot.getCell(9).value = { formula: `SUM(B${ri}:H${ri})` };
      for (let c = 1; c <= 11; c++) { const cell = rTot.getCell(c); cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } }; cell.border = borda; if (c > 1) cell.alignment = { horizontal: 'center' }; }
      ws.columns = [{ width: 26 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 11 }, { width: 11 }];
      linhaGrafico = ri + 2;
    } else {
      const isDiaria = periodo === 'diaria';
      ws.mergeCells('A1:D1'); // Título termina exatamente na coluna D
      ws.getCell('A1').value = dados.titulo;
      ws.getCell('A1').fill = azul; ws.getCell('A1').font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
      ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' }; ws.getRow(1).height = 26;

      const r3 = ws.getRow(3);
      r3.values = isDiaria ? ['Médico(a)', 'Turno', 'Status', 'Atendimentos'] : ['Médico(a)', 'Dias Trabalhados', 'Total no Mês', 'Média Diária'];
      for (let c = 1; c <= 4; c++) { const cell = r3.getCell(c); cell.fill = azul; cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.alignment = { horizontal: 'center' }; cell.border = borda; }

      let ri = 4;
      dados.linhas.forEach((r) => {
        const row = ws.getRow(ri);
        row.values = isDiaria
          ? [r.medico, r.col2, r.col3, r.total]
          : [r.medico, r.col2, r.total, { formula: `IF(B${ri}=0,0,C${ri}/B${ri})` }];
        if (!isDiaria) row.getCell(4).numFmt = '0.0';
        const colDest = isDiaria ? 4 : 3;
        row.getCell(colDest).fill = amarelo; row.getCell(colDest).font = { bold: true, color: { argb: 'FF0000FF' } };
        for (let c = 1; c <= 4; c++) { row.getCell(c).border = borda; if (c > 1) row.getCell(c).alignment = { horizontal: 'center' }; }
        ri++;
      });

      const lastR = Math.max(4, ri - 1);
      const rTot = ws.getRow(ri);
      rTot.values = isDiaria
        ? ['TOTAL DO DIA', '', '', dados.linhas.length ? { formula: `SUM(D4:D${lastR})` } : 0]
        : ['TOTAL DO MÊS', dados.linhas.length ? { formula: `SUM(B4:B${lastR})` } : 0, dados.linhas.length ? { formula: `SUM(C4:C${lastR})` } : 0, ''];
      for (let c = 1; c <= 4; c++) { const cell = rTot.getCell(c); cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } }; cell.border = borda; if (c > 1) cell.alignment = { horizontal: 'center' }; }
      ws.columns = [{ width: 30 }, { width: 20 }, { width: 16 }, { width: 16 }];
      linhaGrafico = ri + 2;
    }

    if (chartBase64 && chartBase64.startsWith('data:image/png;base64,')) {
      const imgId = wb.addImage({ base64: chartBase64, extension: 'png' });
      ws.addImage(imgId, { tl: { col: 0, row: linhaGrafico }, ext: { width: 720, height: 340 } });
    }

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Atendimentos_UPA_${periodo}_${dados.inicio}.xlsx`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Erro Excel:', err);
    res.status(500).json({ erro: 'Erro ao gerar arquivo Excel.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await garantirAdminInicial();
  console.log(`Servidor UPA rodando na porta ${PORT}`);
});
