require('dotenv').config()
const mysql = require('mysql2/promise')

let pool = null
let tunnelServer = null

async function initPool() {
  if (pool) return pool

  if (process.env.SSH_TUNNEL_HOST) {
    const { createTunnel } = require('tunnel-ssh')
    const sshOptions = {
      host: process.env.SSH_TUNNEL_HOST,
      username: process.env.SSH_TUNNEL_USER,
    port: parseInt(process.env.SSH_TUNNEL_PORT || '22'),
      privateKey: process.env.SSH_TUNNEL_PRIVATE_KEY_B64 ? Buffer.from(process.env.SSH_TUNNEL_PRIVATE_KEY_B64, 'base64').toString('utf8') : process.env.SSH_TUNNEL_PRIVATE_KEY,
    readyTimeout: 60000,
    keepaliveInterval: 10000
    }
    const forwardOptions = {
      srcAddr: '127.0.0.1',
      srcPort: parseInt(process.env.DATABASE_PORT || '3306'),
      dstAddr: '127.0.0.1',
      dstPort: 3306
    }
    const tunnelOptions = { autoClose: false }
    const serverOptions = { port: parseInt(process.env.DATABASE_PORT || '3306') }
    const [server] = await createTunnel(tunnelOptions, serverOptions, sshOptions, forwardOptions)
    tunnelServer = server
    console.log('[db] tunel SSH estabelecido ate ' + sshOptions.host)
  }

  pool = mysql.createPool({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: parseInt(process.env.DATABASE_PORT || '3306'),
    user: process.env.DATABASE_USER || 'root',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'vivera_anomalias',
    waitForConnections: true,
    connectionLimit: 8,
    namedPlaceholders: true,
    timezone: 'Z'
  })

  await pool.query('SELECT 1')
  console.log('[db] conexao com MySQL confirmada')
  return pool
}

module.exports = { initPool }
