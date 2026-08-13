const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { initPool } = require('../db')

const router = express.Router()

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'email e senha obrigatorios' })
    }
    const pool = await initPool()
    const [rows] = await pool.query(
      'SELECT id, nome, email, password_hash, role, ativo FROM users WHERE email = ? LIMIT 1',
      [email]
    )
    const user = rows[0]
    if (!user || !user.ativo) {
      return res.status(401).json({ success: false, error: 'credenciais invalidas' })
    }
    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) {
      return res.status(401).json({ success: false, error: 'credenciais invalidas' })
    }
    const token = jwt.sign(
      { id: user.id, nome: user.nome, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )
    res.json({ success: true, token, user: { id: user.id, nome: user.nome, email: user.email, role: user.role } })
  } catch (e) {
    console.error('[auth/login]', e)
    res.status(500).json({ success: false, error: 'erro interno' })
  }
})

router.get('/me', require('../middleware/auth').auth, async (req, res) => {
  res.json({ success: true, user: req.user })
})

module.exports = router
