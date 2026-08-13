const express = require('express')
const { initPool } = require('../db')
const { auth } = require('../middleware/auth')
const OpenAI = require('openai')

const router = express.Router()
router.use(auth)

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null

function canSeeAll(role) {
  return role === 'gerente' || role === 'diretor'
}

async function loadAnomalia(pool, id) {
  const [[anomalia]] = [(await pool.query('SELECT a.*, u.nome AS user_nome FROM anomalias a JOIN users u ON u.id=a.user_id WHERE a.id=?', [id]))[0]]
  return anomalia
}

// LIST
router.get('/', async (req, res) => {
  try {
    const pool = await initPool()
    let sql = 'SELECT a.*, u.nome AS user_nome FROM anomalias a JOIN users u ON u.id = a.user_id WHERE a.arquivado = 0'
    const params = []
    if (!canSeeAll(req.user.role)) {
      sql += ' AND a.user_id = ?'
      params.push(req.user.id)
    }
    sql += ' ORDER BY a.semana_inicio DESC, a.id DESC'
    const [rows] = await pool.query(sql, params)
    res.json({ success: true, anomalias: rows })
  } catch (e) {
    console.error('[anomalias/list]', e)
    res.status(500).json({ success: false, error: 'erro interno' })
  }
})

// CREATE
router.post('/', async (req, res) => {
  try {
    const { semana_inicio, semana_fim, problema_descricao, impacto } = req.body
    if (!semana_inicio || !semana_fim || !problema_descricao) {
      return res.status(400).json({ success: false, error: 'campos obrigatorios faltando' })
    }
    const pool = await initPool()
    const [result] = await pool.query(
      'INSERT INTO anomalias (user_id, semana_inicio, semana_fim, problema_descricao, impacto, status) VALUES (?,?,?,?,?,?)',
      [req.user.id, semana_inicio, semana_fim, problema_descricao, impacto || 'medio', 'rascunho']
    )
    res.json({ success: true, id: result.insertId })
  } catch (e) {
    console.error('[anomalias/create]', e)
    res.status(500).json({ success: false, error: 'erro interno' })
  }
})

// DETAIL (with 5 whys + plano de acao + checklist + resultados + sintese)
router.get('/:id', async (req, res) => {
  try {
    const pool = await initPool()
    const id = req.params.id
    const anomalia = await loadAnomalia(pool, id)
    if (!anomalia) return res.status(404).json({ success: false, error: 'nao encontrado' })
    if (!canSeeAll(req.user.role) && anomalia.user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'sem permissao' })
    }
    const [perguntas] = await pool.query('SELECT * FROM cinco_perques WHERE anomalia_id=? ORDER BY numero', [id])
    const [plano] = await pool.query('SELECT * FROM plano_acao WHERE anomalia_id=? ORDER BY numero', [id])
    const [checklist] = await pool.query('SELECT * FROM plano_acao_checklist WHERE anomalia_id=? ORDER BY acao_numero, dia_semana', [id])
    const [resultados] = await pool.query('SELECT * FROM plano_acao_resultado WHERE anomalia_id=? ORDER BY acao_numero', [id])
    const [sinteseRows] = await pool.query('SELECT * FROM plano_acao_sintese WHERE anomalia_id=?', [id])
    res.json({ success: true, anomalia, perguntas, plano, checklist, resultados, sintese: sinteseRows[0] || null })
  } catch (e) {
    console.error('[anomalias/detail]', e)
    res.status(500).json({ success: false, error: 'erro interno' })
  }
})

// UPDATE status/descricao
router.put('/:id', async (req, res) => {
  try {
    const pool = await initPool()
    const id = req.params.id
    const anomalia = await loadAnomalia(pool, id)
    if (!anomalia) return res.status(404).json({ success: false, error: 'nao encontrado' })
    if (!canSeeAll(req.user.role) && anomalia.user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'sem permissao' })
    }
    const fields = []
    const params = []
    for (const key of ['problema_descricao', 'impacto', 'status', 'arquivado']) {
      if (req.body[key] !== undefined) {
        fields.push(key + ' = ?')
        params.push(req.body[key])
      }
    }
    if (!fields.length) return res.status(400).json({ success: false, error: 'nada para atualizar' })
    params.push(id)
    await pool.query('UPDATE anomalias SET ' + fields.join(', ') + ' WHERE id = ?', params)
    res.json({ success: true })
  } catch (e) {
    console.error('[anomalias/update]', e)
    res.status(500).json({ success: false, error: 'erro interno' })
  }
})

// 5 WHYS - submit answer + validate via OpenAI
router.post('/:id/perguntas/:numero', async (req, res) => {
  try {
    const pool = await initPool()
    const id = req.params.id
    const numero = parseInt(req.params.numero)
    const { pergunta, resposta_usuario } = req.body
    if (!resposta_usuario) return res.status(400).json({ success: false, error: 'resposta obrigatoria' })
    const anomalia = await loadAnomalia(pool, id)
    if (!anomalia) return res.status(404).json({ success: false, error: 'nao encontrado' })
    if (anomalia.user_id !== req.user.id && !canSeeAll(req.user.role)) {
      return res.status(403).json({ success: false, error: 'sem permissao' })
    }

    let validacao = 1
    let feedback = null
    if (openai) {
      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Voce avalia respostas de analise de causa raiz (metodo 5 porques). Responda em JSON: {"valido": true/false, "feedback": "texto curto em portugues explicando o que falta ou confirmando que esta bom"}. Considere invalido se a resposta for vaga, repetir o problema sem aprofundar, ou nao apontar uma causa concreta.' },
            { role: 'user', content: 'Problema original: ' + anomalia.problema_descricao + '\nPergunta (porque ' + numero + '): ' + (pergunta || '') + '\nResposta do usuario: ' + resposta_usuario }
          ],
          response_format: { type: 'json_object' }
        })
        const parsed = JSON.parse(completion.choices[0].message.content)
        validacao = parsed.valido ? 1 : 0
        feedback = parsed.feedback || null
      } catch (aiErr) {
        console.error('[anomalias/perguntas openai]', aiErr.message)
        validacao = 1
      }
    }

    const [existing] = await pool.query('SELECT id, refracoes FROM cinco_perques WHERE anomalia_id=? AND numero=?', [id, numero])
    if (existing.length) {
      const refracoes = validacao === 0 ? (existing[0].refracoes || 0) + 1 : existing[0].refracoes
      await pool.query(
        'UPDATE cinco_perques SET pergunta=?, resposta_usuario=?, validacao_chatgpt=?, feedback_refacao=?, refracoes=? WHERE id=?',
        [pergunta || '', resposta_usuario, validacao, feedback, refracoes, existing[0].id]
      )
    } else {
      await pool.query(
        'INSERT INTO cinco_perques (anomalia_id, numero, pergunta, resposta_usuario, validacao_chatgpt, feedback_refacao, refracoes) VALUES (?,?,?,?,?,?,?)',
        [id, numero, pergunta || '', resposta_usuario, validacao, feedback, validacao === 0 ? 1 : 0]
      )
    }
    res.json({ success: true, validacao, feedback })
  } catch (e) {
    console.error('[anomalias/perguntas]', e)
    res.status(500).json({ success: false, error: 'erro interno' })
  }
})

// PLANO DE ACAO - create/update SMART item (1-3)
router.post('/:id/plano/:numero', async (req, res) => {
  try {
    const pool = await initPool()
    const id = req.params.id
    const numero = parseInt(req.params.numero)
    const { what, why, who, when_date, where_context, how, how_much, tipo_execucao } = req.body
    const [existing] = await pool.query('SELECT id FROM plano_acao WHERE anomalia_id=? AND numero=?', [id, numero])
    let smart_score = 0
    for (const v of [what, who, when_date, how, how_much]) if (v) smart_score++
    const smart_validado = smart_score >= 5 ? 1 : 0
    if (existing.length) {
      await pool.query(
        'UPDATE plano_acao SET what=?, why=?, who=?, when_date=?, where_context=?, how=?, how_much=?, tipo_execucao=?, smart_score=?, smart_validado=? WHERE id=?',
        [what, why, who, when_date, where_context, how, how_much, tipo_execucao || 'pontual', smart_score, smart_validado, existing[0].id]
      )
      res.json({ success: true, id: existing[0].id, smart_score, smart_validado })
    } else {
      const [result] = await pool.query(
        'INSERT INTO plano_acao (anomalia_id, numero, what, why, who, when_date, where_context, how, how_much, tipo_execucao, smart_score, smart_validado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, numero, what, why, who, when_date, where_context, how, how_much, tipo_execucao || 'pontual', smart_score, smart_validado]
      )
      res.json({ success: true, id: result.insertId, smart_score, smart_validado })
    }
  } catch (e) {
    console.error('[anomalias/plano]', e)
    res.status(500).json({ success: false, error: 'erro interno' })
  }
})

// CHECKLIST - mark weekday done (keyed by anomalia_id + acao_numero)
router.post('/:id/plano/:numero/checklist', async (req, res) => {
  try {
    const pool = await initPool()
    const id = req.params.id
    const numero = parseInt(req.params.numero)
    const { dia_semana, concluido, evidencia } = req.body
    const [existing] = await pool.query('SELECT id FROM plano_acao_checklist WHERE anomalia_id=? AND acao_numero=? AND dia_semana=?', [id, numero, dia_semana])
    if (existing.length) {
      await pool.query('UPDATE plano_acao_checklist SET concluido=?, evidencia=? WHERE id=?', [concluido ? 1 : 0, evidencia || null, existing[0].id])
    } else {
      await pool.query('INSERT INTO plano_acao_checklist (anomalia_id, acao_numero, dia_semana, concluido, evidencia) VALUES (?,?,?,?,?)', [id, numero, dia_semana, concluido ? 1 : 0, evidencia || null])
    }
    res.json({ success: true })
  } catch (e) {
    console.error('[anomalias/checklist]', e)
    res.status(500).json({ success: false, error: 'erro interno' })
  }
})

// RESULTADO FINAL (keyed by anomalia_id + acao_numero)
router.post('/:id/plano/:numero/resultado', async (req, res) => {
  try {
    const pool = await initPool()
    const id = req.params.id
    const numero = parseInt(req.params.numero)
    const { resultado_final, evidencia_descricao, evidencia_arquivo_url, meta_atingida, aprendizados, pontos_positivos, dificuldades, proximos_passos } = req.body
    if (!resultado_final) return res.status(400).json({ success: false, error: 'resultado_final obrigatorio' })
    const [existing] = await pool.query('SELECT id FROM plano_acao_resultado WHERE anomalia_id=? AND acao_numero=?', [id, numero])
    if (existing.length) {
      await pool.query(
        'UPDATE plano_acao_resultado SET resultado_final=?, evidencia_descricao=?, evidencia_arquivo_url=?, meta_atingida=?, aprendizados=?, pontos_positivos=?, dificuldades=?, proximos_passos=?, data_preenchimento=NOW() WHERE id=?',
        [resultado_final, evidencia_descricao || null, evidencia_arquivo_url || null, meta_atingida ? 1 : 0, aprendizados || null, pontos_positivos || null, dificuldades || null, proximos_passos || null, existing[0].id]
      )
    } else {
      await pool.query(
        'INSERT INTO plano_acao_resultado (anomalia_id, acao_numero, resultado_final, evidencia_descricao, evidencia_arquivo_url, meta_atingida, aprendizados, pontos_positivos, dificuldades, proximos_passos, data_preenchimento) VALUES (?,?,?,?,?,?,?,?,?,?,NOW())',
        [id, numero, resultado_final, evidencia_descricao || null, evidencia_arquivo_url || null, meta_atingida ? 1 : 0, aprendizados || null, pontos_positivos || null, dificuldades || null, proximos_passos || null]
      )
    }
    res.json({ success: true })
  } catch (e) {
    console.error('[anomalias/resultado]', e)
    res.status(500).json({ success: false, error: 'erro interno' })
  }
})

// SINTESE SEMANAL
router.post('/:id/sintese', async (req, res) => {
  try {
    const pool = await initPool()
    const id = req.params.id
    const { o_que_evoluiu, o_que_travou, acao_precisa_apoio, acao_precisa_apoio_motivo, acao_fortalece_resultado, acao_fortalece_resultado_impacto, completado } = req.body
    if (!o_que_evoluiu || !o_que_travou) return res.status(400).json({ success: false, error: 'campos obrigatorios faltando' })
    const [existing] = await pool.query('SELECT id FROM plano_acao_sintese WHERE anomalia_id=?', [id])
    if (existing.length) {
      await pool.query(
        'UPDATE plano_acao_sintese SET o_que_evoluiu=?, o_que_travou=?, acao_precisa_apoio=?, acao_precisa_apoio_motivo=?, acao_fortalece_resultado=?, acao_fortalece_resultado_impacto=?, completado=?, data_preenchimento=NOW() WHERE id=?',
        [o_que_evoluiu, o_que_travou, acao_precisa_apoio || null, acao_precisa_apoio_motivo || null, acao_fortalece_resultado || null, acao_fortalece_resultado_impacto || null, completado ? 1 : 0, existing[0].id]
      )
    } else {
      await pool.query(
        'INSERT INTO plano_acao_sintese (anomalia_id, o_que_evoluiu, o_que_travou, acao_precisa_apoio, acao_precisa_apoio_motivo, acao_fortalece_resultado, acao_fortalece_resultado_impacto, completado, data_preenchimento) VALUES (?,?,?,?,?,?,?,?,NOW())',
        [id, o_que_evoluiu, o_que_travou, acao_precisa_apoio || null, acao_precisa_apoio_motivo || null, acao_fortalece_resultado || null, acao_fortalece_resultado_impacto || null, completado ? 1 : 0]
      )
    }
    res.json({ success: true })
  } catch (e) {
    console.error('[anomalias/sintese]', e)
    res.status(500).json({ success: false, error: 'erro interno' })
  }
})

module.exports = router
