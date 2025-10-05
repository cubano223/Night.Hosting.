// server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { WebSocketServer } = require('ws');

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

// Crear un nuevo "server" lógico (no Docker, solo registro)
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

// Simular acciones start/stop/restart (Render no permite contenedores)
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
const server = require('http').createServer(app);
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

// =================== PÁGINA PRINCIPAL ===================
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Night Hosting API</title>
        <style>
          body {
            background-color: #0f172a;
            color: #f1f5f9;
            font-family: Arial, sans-serif;
            text-align: center;
            padding-top: 100px;
          }
          h1 { font-size: 2.5rem; color: #38bdf8; }
          p { color: #94a3b8; }
        </style>
      </head>
      <body>
        <h1>🚀 Night Hosting API Online</h1>
        <p>Your backend is running successfully on Render.</p>
        <p>Use the endpoints under <b>/api/</b> to interact.</p>
      </body>
    </html>
  `);
});

// =================== INICIO DEL SERVIDOR ===================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`✅ API y WebSocket escuchando en puerto ${PORT}`)
);
