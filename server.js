// backend/server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Docker = require('dockerode');
const WebSocket = require('ws');
const cors = require('cors');

const docker = new Docker(); // usa socket /var/run/docker.sock
const app = express();
app.use(express.json());
app.use(cors());

// =================== ARCHIVOS Y UPLOAD ===================
const UPLOAD_BASE = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_BASE)) fs.mkdirSync(UPLOAD_BASE, { recursive: true });

const upload = multer({ dest: path.join(__dirname, 'tmp') });

// in-memory map: serverId -> containerId, metadata
const SERVERS = {}; // persistir en DB si quieres

// =================== RUTAS API ===================

// Crea nuevo "server" virtual
app.post('/api/create', (req, res) => {
  const { plan = 'free', runtime = 'python' } = req.body;
  const serverId = 'nh-' + uuidv4().split('-')[0];
  const dir = path.join(UPLOAD_BASE, serverId);
  fs.mkdirSync(dir, { recursive: true });
  SERVERS[serverId] = { serverId, plan, runtime, dir, containerId: null, status: 'offline' };
  return res.json({ ok: true, serverId });
});

// Sube archivos (bot.py o bot.js y requirements.txt)
app.post('/api/upload', upload.array('files'), (req, res) => {
  const serverId = req.body.serverId;
  if (!serverId || !SERVERS[serverId]) return res.status(400).json({ ok:false, error:'serverId invalid' });

  const dest = SERVERS[serverId].dir;
  let gotBot = false;
  for (const f of req.files) {
    const target = path.join(dest, f.originalname);
    fs.renameSync(f.path, target);
    if (f.originalname === 'bot.py' || f.originalname === 'bot.js') gotBot = true;
  }
  if (!gotBot) return res.status(400).json({ ok:false, error:'You must upload bot.py or bot.js' });
  return res.json({ ok:true });
});

// Inicia, detiene o reinicia servidor
app.post('/api/action', async (req, res) => {
  const { serverId, action, envVars } = req.body;
  if (!serverId || !SERVERS[serverId]) return res.status(400).json({ ok:false, error:'serverId invalid' });

  try {
    if (action === 'start') {
      const result = await startServer(serverId, envVars || {});
      return res.json({ ok:true, result });
    } else if (action === 'stop') {
      await stopServer(serverId);
      return res.json({ ok:true });
    } else if (action === 'restart') {
      await stopServer(serverId);
      await new Promise(r=>setTimeout(r,500));
      await startServer(serverId, envVars || {});
      return res.json({ ok:true });
    }
    return res.status(400).json({ ok:false, error:'invalid action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// Estado del servidor
app.get('/api/status', (req, res) => {
  const { serverId } = req.query;
  if (!serverId || !SERVERS[serverId]) return res.status(400).json({ ok:false, error:'serverId invalid' });
  return res.json({ ok:true, status: SERVERS[serverId].status });
});

// =================== FUNCIONES DOCKER ===================

async function startServer(serverId, envVars) {
  const meta = SERVERS[serverId];
  if (!meta) throw new Error('Missing server meta');
  if (meta.containerId) {
    const c = docker.getContainer(meta.containerId);
    try {
      await c.start();
      meta.status = 'online';
      return { startedExisting: true };
    } catch (e) {}
  }

  // Imagen y comando según runtime
  let image = 'python:3.11-slim';
  let cmd = ['python', 'bot.py'];
  if (meta.runtime === 'node' || meta.runtime === 'javascript') {
    image = 'node:20-slim';
    cmd = ['node', 'bot.js'];
  }

  const binds = [`${meta.dir}:/srv:ro`];
  const env = [];
  for (const k in envVars) env.push(`${k}=${envVars[k]}`);

  const createOptions = {
    Image: image,
    Cmd: cmd,
    Tty: false,
    HostConfig: {
      Binds: binds,
      Memory: 256 * 1024 * 1024, // 256MB
      CpuShares: 256,
      NetworkMode: 'bridge'
    },
    Env: env,
    WorkingDir: '/srv',
    OpenStdin: false
  };

  await ensureImage(image);

  const container = await docker.createContainer(createOptions);
  meta.containerId = container.id;
  meta.status = 'starting';

  await container.start();

  const logStream = await container.attach({stream: true, stdout: true, stderr: true});
  logStream.on('data', (chunk) => {
    broadcastLog(serverId, chunk.toString('utf8'));
  });

  container.wait().then((data) => {
    meta.status = 'offline';
    broadcastLog(serverId, `--- container exited: ${JSON.stringify(data)} ---`);
  });

  meta.status = 'online';
  broadcastLog(serverId, '--- container started ---');
  return { started: true, containerId: container.id };
}

async function stopServer(serverId) {
  const meta = SERVERS[serverId];
  if (!meta || !meta.containerId) return;
  try {
    const container = docker.getContainer(meta.containerId);
    await container.stop({ t: 5 }).catch(()=>{});
    await container.remove({ force: true });
  } catch(e) {
    console.warn('stop error', e);
  } finally {
    meta.containerId = null;
    meta.status = 'offline';
    broadcastLog(serverId, '--- container stopped/removed ---');
  }
}

async function ensureImage(image) {
  const imgs = await docker.listImages({ filters: { reference: [image] } });
  if (imgs.length === 0) {
    console.log('Pulling image', image);
    await new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, onFinished, () => {});
        function onFinished(err, out) { if (err) reject(err); else resolve(out); }
      });
    });
  }
}

// =================== WEBSOCKET LOGS ===================
const wss = new WebSocket.Server({ port: 8081 });
const wsClients = {}; // serverId -> set of ws

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const serverId = url.searchParams.get('serverId');
  if (!serverId || !SERVERS[serverId]) {
    ws.send(JSON.stringify({ line: 'Invalid serverId' }));
    ws.close();
    return;
  }
  ws.send(JSON.stringify({ line: `Connected to console ${serverId}` }));
  wsClients[serverId] = wsClients[serverId] || new Set();
  wsClients[serverId].add(ws);

  ws.on('close', () => {
    wsClients[serverId].delete(ws);
  });
});

function broadcastLog(serverId, line) {
  const set = wsClients[serverId];
  if (!set) return;
  const payload = JSON.stringify({ line });
  for (const ws of set) {
    try { ws.send(payload); } catch (e) {}
  }
}

// =================== PÁGINA PRINCIPAL ===================

// muestra un mensaje al entrar al dominio principal
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
