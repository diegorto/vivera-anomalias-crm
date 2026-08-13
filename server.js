require('dotenv').config()
const express = require('express')
const cors = require('cors')
const path = require('path')
const { initPool } = require('./db')

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/health', (req, res) => res.json({ ok: true }))

app.use('/api/auth', require('./routes/auth'))
app.use('/api/anomalias', require('./routes/anomalias'))

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ success: false, error: 'nao encontrado' })
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

const PORT = process.env.PORT || 3000

async function start() {
  try {
    await initPool()
    app.listen(PORT, () => console.log('[server] vivera-anomalias-crm rodando na porta ' + PORT))
  } catch (e) {
    console.error('[server] falha ao iniciar', e)
    process.exit(1)
  }
}

start()
