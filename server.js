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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'segredo_upa_trocar_em_producao';
const SENHA_PADRAO = 'upa123';

// Configuração de E-mail (SMTP - ex: Gmail App Password ou Brevo)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Cria usuário Admin inicial automaticamente se o banco estiver vazio
async function garantirAdminInicial() {
  const { rows } = await pool.query('SELECT COUNT(*) FROM usuarios');
  if (Number(rows[0].count) === 0) {
    const hash = await bcrypt.hash(SENHA_PADRAO, 10);
    await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, role, primeiro_acesso)
       VALUES ($1, $2, $3, 'admin', TRUE)`,
      ['Administrador UPA', 'admin@upa.gov.br', hash]
    );
    console.log('Admin inicial criado: admin@upa.gov.br | Senha:', SENHA_PADRAO);
  }
}

// Middlewares de Autenticação e Permissão
function autenticar(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ erro: 'Token não fornecido.' });
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: 'Sessão expirada ou inválida.' });
  }
}

function apenasAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ erro: 'Acesso restrito a administradores.' });
  }
  next();
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
      usuario: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        role: user.role,
        primeiro_acesso: user.primeiro_acesso
      }
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno no login.' });
  }
});

// Troca obrigatória de senha no primeiro acesso (ou pelo próprio usuário)
app.post('/api/alterar-senha', autenticar, async (req, res) => {
  const { novaSenha } = req.body;
  if (!novaSenha || novaSenha.length < 6 || novaSenha === SENHA_PADRAO) {
    return res.status(400).json({ erro: 'A nova senha deve ter no mínimo 6 caracteres e ser diferente da padrão.' });
  }
  const hash = await bcrypt.hash(novaSenha, 10);
  await pool.query(
    'UPDATE usuarios SET senha_hash = $1, primeiro_acesso = FALSE WHERE id = $2',
    [hash, req.user.id]
  );
  res.json({ mensagem: 'Senha atualizada com sucesso.' });
});

// Esqueci minha senha (envia link por e-mail)
app.post('/api/esqueci-senha', async (req, res) => {
  const { email } = req.body;
  const { rows } = await pool.query('SELECT id, nome, email FROM usuarios WHERE LOWER(email) = LOWER($1)', [email]);
  if (rows.length === 0) {
    return res.json({ mensagem: 'Se o e-mail estiver cadastrado, você receberá um link de redefinição.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  const expira = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
  await pool.query('UPDATE usuarios SET reset_token = $1, reset_expira = $2 WHERE id = $3', [token, expira, rows[0].id]);

  const link = `${process.env.APP_URL || 'http://localhost:3000'}/?resetToken=${token}`;
  if (process.env.SMTP_USER) {
    await transporter.sendMail({
      from: `"UPA Parque dos Ferreira" <${process.env.SMTP_USER}>`,
      to: rows[0].email,
      subject: 'Redefinição de Senha - Controle de Atendimentos UPA',
      html: `<p>Olá, ${rows[0].nome}.</p><p>Clique no link abaixo para redefinir sua senha (válido por 1 hora):</p><p><a href="${link}">${link}</a></p>`
    });
  } else {
    console.log('Link de redefinição (SMTP não configurado):', link);
  }
  res.json({ mensagem: 'Se o e-mail estiver cadastrado, você receberá um link de redefinição.' });
});

app.post('/api/redefinir-senha', async (req, res) => {
  const { token, novaSenha } = req.body;
  if (!novaSenha || novaSenha.length < 6) {
    return res.status(400).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });
  }
  const { rows } = await pool.query(
    'SELECT id FROM usuarios WHERE reset_token = $1 AND reset_expira > NOW()',
    [token]
  );
  if (rows.length === 0) return res.status(400).json({ erro: 'Token inválido ou expirado.' });

  const hash = await bcrypt.hash(novaSenha, 10);
  await pool.query(
    'UPDATE usuarios SET senha_hash = $1, primeiro_acesso = FALSE, reset_token = NULL, reset_expira = NULL WHERE id = $2',
    [hash, rows[0].id]
  );
  res.json({ mensagem: 'Senha redefinida com sucesso. Faça login novamente.' });
});

// ==================== ADMIN: USUÁRIOS ====================

app.get('/api/usuarios', autenticar, apenasAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nome, email, role, primeiro_acesso FROM usuarios ORDER BY nome'
  );
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
  } catch (err) {
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
      await pool.query(
        'UPDATE usuarios SET nome = $1, email = $2, role = $3 WHERE id = $4',
        [nome, email, role, req.params.id]
      );
    }
    res.json({ mensagem: 'Usuário atualizado.' });
  } catch {
    res.status(400).json({ erro: 'Erro ao atualizar usuário.' });
  }
});

app.delete('/api/usuarios/:id', autenticar, apenasAdmin, async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ erro: 'Você não pode remover o próprio usuário.' });
  }
  await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
  res.json({ mensagem: 'Usuário removido.' });
});

// ==================== MÉDICOS ====================

app.get('/api/medicos', autenticar, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM medicos WHERE ativo = TRUE ORDER BY nome');
  res.json(rows);
});

app.post('/api/medicos', autenticar, apenasAdmin, async (req, res) => {
  const { nome, matriculas } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO medicos (nome, matriculas) VALUES ($1, $2) RETURNING *',
      [nome, matriculas || null]
    );
    res.status(201).json(rows[0]);
  } catch {
    res.status(400).json({ erro: 'Médico já cadastrado.' });
  }
});

app.delete('/api/medicos/:id', autenticar, apenasAdmin, async (req, res) => {
  await pool.query('UPDATE medicos SET ativo = FALSE WHERE id = $1', [req.params.id]);
  res.json({ mensagem: 'Médico desativado.' });
});

// ==================== LANÇAMENTO DIÁRIO E TROCAS ====================

app.get('/api/atendimentos', autenticar, async (req, res) => {
  const { data } = req.query; // Formato YYYY-MM-DD
  if (!data) return res.status(400).json({ erro: 'Informe a data.' });

  const [ano, mes, dia] = data.split('-').map(Number);
  const diaSemana = new Date(ano, mes - 1, dia).getDay();

  // 1. Verifica se já existem registros salvos para esta data
  const salvos = await pool.query(
    `SELECT a.*, me.nome AS nome_escalado, mr.nome AS nome_real
     FROM atendimentos a
     LEFT JOIN medicos me ON me.id = a.medico_escalado_id
     LEFT JOIN medicos mr ON mr.id = a.medico_real_id
     WHERE a.data = $1
     ORDER BY a.id`,
    [data]
  );

  if (salvos.rows.length > 0) {
    return res.json({ origem: 'salvo', itens: salvos.rows });
  }

  // 2. Se não houver, carrega a escala padrão do dia da semana
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
    res.json({ mensagem: 'Atendimentos salvos com sucesso no PostgreSQL!' });
  } catch (err) {
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
    `SELECT
       COALESCE(m.nome, a.medico_extra_nome, 'Não informado') AS medico,
       SUM(a.quantidade)::INTEGER AS total
     FROM atendimentos a
     LEFT JOIN medicos m ON m.id = a.medico_real_id
     WHERE ($1::date IS NULL OR a.data >= $1::date)
       AND ($2::date IS NULL OR a.data <= $2::date)
     GROUP BY COALESCE(m.nome, a.medico_extra_nome, 'Não informado')
     ORDER BY total DESC`,
    [inicio || null, fim || null]
  );
  res.json(rows);
});

// ==================== EXPORTAÇÃO EXCEL (EXCELJS) ====================

app.get('/api/exportar', autenticar, async (req, res) => {
  const { periodo, dataRef } = req.query; // periodo: diaria | semanal | mensal
  const ref = dataRef ? new Date(`${dataRef}T12:00:00`) : new Date();
  let inicio = new Date(ref);
  let fim = new Date(ref);

  if (periodo === 'semanal') {
    const dia = ref.getDay();
    inicio.setDate(ref.getDate() - dia);
    fim.setDate(inicio.getDate() + 6);
  } else if (periodo === 'mensal') {
    inicio = new Date(ref.getFullYear(), ref.getMonth(), 1);
    fim = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  }

  const fmt = (d) => d.toISOString().split('T')[0];
  const { rows } = await pool.query(
    `SELECT
       a.data,
       COALESCE(mr.nome, a.medico_extra_nome) AS medico_atendente,
       me.nome AS medico_escalado,
       CASE WHEN a.medico_extra_nome IS NOT NULL THEN 'Extra/Substituto'
            WHEN a.medico_real_id <> a.medico_escalado_id THEN 'Troca de Plantão'
            ELSE 'Escala Normal' END AS status,
       a.quantidade
     FROM atendimentos a
     LEFT JOIN medicos mr ON mr.id = a.medico_real_id
     LEFT JOIN medicos me ON me.id = a.medico_escalado_id
     WHERE a.data BETWEEN $1 AND $2
     ORDER BY a.data, medico_atendente`,
    [fmt(inicio), fmt(fim)]
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Atendimentos');

  ws.columns = [
    { header: 'Data', key: 'data', width: 14 },
    { header: 'Médico Atendente', key: 'medico_atendente', width: 32 },
    { header: 'Médico Escalado', key: 'medico_escalado', width: 32 },
    { header: 'Tipo / Status', key: 'status', width: 20 },
    { header: 'Atendimentos', key: 'quantidade', width: 16 }
  ];

  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } };

  rows.forEach((r) => {
    ws.addRow({
      data: new Date(r.data).toLocaleDateString('pt-BR', { timeZone: 'UTC' }),
      medico_atendente: r.medico_atendente,
      medico_escalado: r.medico_escalado || 'Extra',
      status: r.status,
      quantidade: Number(r.quantidade)
    });
  });

  const ultimaLinhaDados = rows.length + 1;
  if (rows.length > 0) {
    ws.addRow([]);
    const rowTotal = ws.addRow(['', '', '', 'TOTAL:', { formula: `SUM(E2:E${ultimaLinhaDados})` }]);
    const rowMedia = ws.addRow(['', '', '', 'MÉDIA:', { formula: `AVERAGE(E2:E${ultimaLinhaDados})` }]);
    rowTotal.font = { bold: true };
    rowMedia.font = { bold: true };
    rowMedia.getCell(5).numFmt = '0.00';
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=Atendimentos_UPA_${periodo}_${fmt(inicio)}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await garantirAdminInicial();
  console.log(`Servidor UPA rodando na porta ${PORT}`);
});