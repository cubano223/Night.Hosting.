// server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
app.use(express.json());
app.use(cors());

// =================== CONFIGURACIÓN DE ARCHIVOS ===================
const UPLOAD_BASE = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_BASE)) fs.mkdirSync(UPLOAD_BASE, { recursive: true });

const upload = multer({ dest: path.join(__dirname, 'tmp') });

// memoria temporal: serverId -> datos
const SERVERS = {};

// =================== ENDPOINTS API ===================

// Crear un nuevo "server" lógico
app.post('/api/create', (req, res) => {
  const { plan = 'free', runtime = 'node' } = req.body;
  const serverId = 'nh-' + uuidv4().split('-')[0];
  const dir = path.join(UPLOAD_BASE, serverId);
  fs.mkdirSync(dir, { recursive: true });
  SERVERS[serverId] = { serverId, plan, runtime, dir, status: 'offline' };
  res.json({ ok: true, serverId });
});

// Subir archivos (ej. bot.py o bot.js)
app.post('/api/upload', upload.array('files'), (req, res) => {
  const serverId = req.body.serverId;
  if (!serverId || !SERVERS[serverId]) {
    return res.status(400).json({ ok: false, error: 'serverId inválido' });
  }

  const dest = SERVERS[serverId].dir;
  let gotBot = false;
  for (const f of req.files) {
    const target = path.join(dest, f.originalname);
    fs.renameSync(f.path, target);
    if (f.originalname === 'bot.py' || f.originalname === 'bot.js') gotBot = true;
  }

  if (!gotBot)
    return res.status(400).json({ ok: false, error: 'Debes subir bot.py o bot.js' });

  res.json({ ok: true });
});

// Simular acciones start/stop/restart
app.post('/api/action', async (req, res) => {
  const { serverId, action } = req.body;
  if (!serverId || !SERVERS[serverId]) {
    return res.status(400).json({ ok: false, error: 'serverId inválido' });
  }

  const meta = SERVERS[serverId];
  if (action === 'start') {
    meta.status = 'online';
  } else if (action === 'stop') {
    meta.status = 'offline';
  } else if (action === 'restart') {
    meta.status = 'restarting';
    setTimeout(() => (meta.status = 'online'), 1000);
  } else {
    return res.status(400).json({ ok: false, error: 'acción inválida' });
  }

  broadcastLog(serverId, `Server ${serverId} → ${meta.status}`);
  res.json({ ok: true, status: meta.status });
});

// Consultar estado
app.get('/api/status', (req, res) => {
  const { serverId } = req.query;
  if (!serverId || !SERVERS[serverId])
    return res.status(400).json({ ok: false, error: 'serverId inválido' });

  res.json({ ok: true, status: SERVERS[serverId].status });
});

// =================== WEBSOCKET UNIFICADO ===================
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const wsClients = {}; // serverId -> Set(ws)

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const serverId = url.searchParams.get('serverId');
  if (!serverId || !SERVERS[serverId]) {
    ws.send(JSON.stringify({ line: '❌ serverId inválido' }));
    ws.close();
    return;
  }
  ws.send(JSON.stringify({ line: `✅ Conectado a ${serverId}` }));
  wsClients[serverId] = wsClients[serverId] || new Set();
  wsClients[serverId].add(ws);
  ws.on('close', () => wsClients[serverId].delete(ws));
});

function broadcastLog(serverId, line) {
  const set = wsClients[serverId];
  if (!set) return;
  const payload = JSON.stringify({ line });
  for (const ws of set) {
    try {
      ws.send(payload);
    } catch {}
  }
}

// =================== PÁGINA PRINCIPAL (ROOT) ===================
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Night Hosting API</title>
        <style>
          body {
            background-color: #0d0d0d;
            color: #00ffcc;
            font-family: monospace;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            flex-direction: column;
            text-align: center;
          }
          h1 {
            font-size: 2em;
            margin-bottom: 10px;
          }
          p {
            color: #888;
            font-size: 1em;
          }
          .pulse {
            animation: pulse 1.5s infinite;
          }
          @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.4; }
            100% { opacity: 1; }
          }
        </style>
      </head>
      <body>
        <h1 class="pulse">🚀 Night Hosting API Online</h1>
        <p>Servidor activo y escuchando en el puerto ${process.env.PORT || 3000}</p>
        <p>Endpoints disponibles en <b>/api/</b></p>
      </body>
    </html>
  `);
});

// =================== INICIO DEL SERVIDOR ===================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ API y WebSocket escuchando en puerto ${PORT}`);
});
