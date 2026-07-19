const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const QRCode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidDecode,
  proto,
  getContentType,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dental-whatsapp-secret-2026';
const SESSION_DIR = path.join(__dirname, '../sessions');

// Create sessions directory if not exists
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// ─── State ───────────────────────────────────────────────────────────────────
let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | connected
let connectedPhone = null;
let startupError = null;
let debugLogs = [];

const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  debugLogs.push(`[LOG] ${new Date().toISOString()}: ${msg}`);
  if (debugLogs.length > 200) debugLogs.shift();
  originalLog(...args);
};

console.error = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  debugLogs.push(`[ERR] ${new Date().toISOString()}: ${msg}`);
  if (debugLogs.length > 200) debugLogs.shift();
  originalError(...args);
};

// ─── Logger ──────────────────────────────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ─── Start WhatsApp Connection ────────────────────────────────────────────────
async function startWhatsApp() {
  try {
    startupError = null;
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    let version = undefined;
    try {
      const fetched = await fetchLatestBaileysVersion();
      if (fetched && fetched.version) {
        version = fetched.version;
      }
    } catch (err) {
      console.log('⚠️ Failed to fetch latest WhatsApp version from server, letting Baileys auto-select default.');
    }

    connectionStatus = 'connecting';
    io.emit('status', { status: 'connecting' });

    const socketConfig = {
      logger,
      auth: state,
      printQRInTerminal: false,
      browser: ['Mac OS', 'Chrome', '122.0.0.0'],
    };

    if (version) {
      socketConfig.version = version;
    }

    sock = makeWASocket(socketConfig);

  // Save credentials when updated
  sock.ev.on('creds.update', saveCreds);

  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr);
      connectionStatus = 'qr_ready';
      console.log('📱 QR Code generated — scan from app');
      io.emit('qr', { qr: qrCodeData });
      io.emit('status', { status: 'qr_ready' });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);
      
      qrCodeData = null;
      connectedPhone = null;
      connectionStatus = 'disconnected';
      io.emit('status', { status: 'disconnected', code: statusCode });

      if (shouldReconnect) {
        console.log('🔄 Reconnecting in 5 seconds...');
        setTimeout(startWhatsApp, 5000);
      } else {
        // Logged out — clear session
        console.log('🚪 Logged out — clearing session');
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        fs.mkdirSync(SESSION_DIR, { recursive: true });
      }
    }

    if (connection === 'open') {
      qrCodeData = null;
      connectionStatus = 'connected';
      connectedPhone = sock.user?.id || null;
      console.log(`✅ WhatsApp connected: ${connectedPhone}`);
      io.emit('status', { status: 'connected', phone: connectedPhone });
    }
  });
} catch (err) {
  console.error('❌ startWhatsApp error:', err);
  startupError = err.message || String(err);
  connectionStatus = 'disconnected';
  io.emit('status', { status: 'disconnected', error: startupError });
}
}

// ─── Format Phone Number ──────────────────────────────────────────────────────
function formatPhone(phone) {
  // Remove all non-digits
  let cleaned = phone.replace(/\D/g, '');
  
  // Pakistan numbers: if starts with 0, replace with 92
  if (cleaned.startsWith('0')) {
    cleaned = '92' + cleaned.slice(1);
  }
  
  // If no country code (10 digits for Pakistan), add 92
  if (cleaned.length === 10) {
    cleaned = '92' + cleaned;
  }
  
  return cleaned + '@s.whatsapp.net';
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({ success: true, service: 'dental-whatsapp', status: connectionStatus });
});

// Get connection status
app.get('/api/status', authenticate, (req, res) => {
  res.json({
    success: true,
    status: connectionStatus,
    phone: connectedPhone,
    qrReady: !!qrCodeData,
    error: startupError,
  });
});

app.get('/api/debug-logs', authenticate, (req, res) => {
  res.json({ success: true, logs: debugLogs });
});

// Get QR Code
app.get('/api/qr', authenticate, (req, res) => {
  if (connectionStatus === 'connected') {
    return res.json({ success: true, status: 'connected', phone: connectedPhone });
  }
  if (!qrCodeData) {
    return res.json({ success: false, status: connectionStatus, qr: null });
  }
  res.json({ success: true, status: 'qr_ready', qr: qrCodeData });
});

// Send a text message
app.post('/api/send', authenticate, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'phone and message required' });
  }

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
  }

  try {
    const jid = formatPhone(phone);
    await sock.sendMessage(jid, { text: message });
    console.log(`✉️  Message sent to ${phone}`);
    res.json({ success: true, message: 'Message sent', to: phone });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send message with image (for prescriptions etc.)
app.post('/api/send-image', authenticate, async (req, res) => {
  const { phone, caption, imageUrl } = req.body;

  if (!phone || !imageUrl) {
    return res.status(400).json({ success: false, error: 'phone and imageUrl required' });
  }

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
  }

  try {
    const jid = formatPhone(phone);
    await sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || ''
    });
    res.json({ success: true, message: 'Image sent', to: phone });
  } catch (err) {
    console.error('Send image error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Disconnect / Logout
app.post('/api/disconnect', authenticate, async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    res.json({ success: true, message: 'Disconnected' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Restart connection (re-generate QR)
app.post('/api/restart', authenticate, async (req, res) => {
  try {
    if (sock) {
      sock.end();
    }
    // Clear session to force new QR
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    
    setTimeout(startWhatsApp, 1000);
    res.json({ success: true, message: 'Restarting — new QR will be generated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('🔌 Client connected to socket');
  // Send current status immediately on connect
  socket.emit('status', { status: connectionStatus, phone: connectedPhone });
  if (qrCodeData) {
    socket.emit('qr', { qr: qrCodeData });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 WhatsApp Service running on port ${PORT}`);
  console.log(`🔒 Auth Token: ${AUTH_TOKEN}`);
  startWhatsApp();
});
