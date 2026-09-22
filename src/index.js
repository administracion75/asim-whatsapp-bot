import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { askClaude } from './claude.js';
import { loadStore, isPaused, pause, getHistory, pushMessage } from './store.js';
import { HANDOFF_TRIGGERS } from './context.js';
import { logInteraction, scheduleDailyReport, sendDailyReport } from './report.js';

const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean)
  .map((n) => `${n}@s.whatsapp.net`);

const BUFFER_DELAY_MS = 1500;
const pendingBuffers = new Map();
const botSentIds = new Set();

async function sendAndTrack(sock, jid, content) {
  const sent = await sock.sendMessage(jid, content);
  if (sent?.key?.id) botSentIds.add(sent.key.id);
  return sent;
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

function looksLikeHandoff(text) {
  const lower = text.toLowerCase();
  return HANDOFF_TRIGGERS.some((t) => lower.includes(t));
}

async function notifyAdmins(sock, jid, lastText) {
  const number = jid.split('@')[0];
  const text = `Aviso ASIM Bot: la conversacion con +${number} necesita atencion humana.\nUltimo mensaje: "${lastText}"`;
  for (const admin of ADMIN_NUMBERS) {
    try {
      await sendAndTrack(sock, admin, { text });
    } catch (err) {
      console.error('No se pudo avisar a', admin, err.message);
    }
  }
}

async function processMessage(sock, jid, text) {
  const number = jid.split('@')[0];

  if (isPaused(jid)) {
    console.log('[debug]', jid, 'esta pausado (lo atiende un humano), no responde el bot');
    return;
  }

  if (looksLikeHandoff(text)) {
    pause(jid, 6);
    logInteraction({ tipo: 'handoff', numero: number, mensaje: text });
    await notifyAdmins(sock, jid, text);
    await sendAndTrack(sock, jid, {
      text: 'Entiendo, te paso con el equipo de ASIM y te escriben en breve. Si es fuera de nuestro horario (L-V 9-14h y 16-19h), te contestaran en cuanto abramos. Mientras, puedes seguirnos en Instagram: https://www.instagram.com/ong.asim',
    });
    return;
  }

  pushMessage(jid, 'user', text);

  try {
    console.log('[debug] Llamando a Claude para', jid, '->', text);
    await sock.sendPresenceUpdate('composing', jid);
    const reply = await askClaude(getHistory(jid));
    console.log('[debug] Respuesta de Claude:', reply);

    if (reply.startsWith('[HANDOFF]')) {
      const cleaned = reply.replace('[HANDOFF]', '').trim();
      pause(jid, 6);
      logInteraction({ tipo: 'handoff', numero: number, mensaje: text });
      await notifyAdmins(sock, jid, text);
      await sendAndTrack(sock, jid, { text: cleaned || 'Te paso con el equipo de ASIM, te escriben en breve.' });
      return;
    }

    pushMessage(jid, 'assistant', reply);
    logInteraction({ tipo: 'respondido', numero: number, mensaje: text });
    await sendAndTrack(sock, jid, { text: reply });
  } catch (err) {
    console.error('Error llamando a Claude:', err);
    logInteraction({ tipo: 'error', numero: number, mensaje: text });
    await sendAndTrack(sock, jid, {
      text: 'Bienvenido a ASIM, Asociacion Internacional Mundo Solidario. Ahora mismo no puedo responderte bien, pero puedes escribirnos a info@asim.org.es o llamar al +34 961 94 55 66. Siguenos en https://asim.org.es y en Instagram https://www.instagram.com/ong.asim',
    });
  } finally {
    await sock.sendPresenceUpdate('paused', jid);
  }
}

function bufferMessage(sock, jid, text) {
  if (!pendingBuffers.has(jid)) {
    pendingBuffers.set(jid, { texts: [], timer: null });
  }
  const buf = pendingBuffers.get(jid);
  buf.texts.push(text);
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    const combined = buf.texts.join('\n');
    pendingBuffers.delete(jid);
    processMessage(sock, jid, combined);
  }, BUFFER_DELAY_MS);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['ASIM Bot', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nEscanea este QR desde el WhatsApp del +34 641 574 303 (Dispositivos vinculados > Vincular un dispositivo):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Motivo:', lastDisconnect?.error?.message || statusCode || 'desconocido');
      console.log('Conexion cerrada.', shouldReconnect ? 'Reconectando en 3s...' : 'Sesion cerrada. Borra la carpeta auth_info/ y vuelve a arrancar para re-vincular.');
      if (shouldReconnect) setTimeout(start, 3000);
    } else if (connection === 'open') {
      console.log('Bot ASIM conectado y escuchando WhatsApp.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

      if (msg.key.fromMe) {
        if (botSentIds.has(msg.key.id)) {
          botSentIds.delete(msg.key.id);
        } else {
          console.log('[debug] Respuesta manual detectada en', jid, '- pausando bot 24h ahi');
          pause(jid, 24);
        }
        continue;
      }

      const text = extractText(msg);
      if (!text) continue;

      console.log('[debug] Mensaje recibido de', jid, '->', text);
      bufferMessage(sock, jid, text);
    }
  });
}

process.on('unhandledRejection', (err) => {
  console.error('Error no capturado (el bot sigue vivo):', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('Excepcion no capturada (el bot sigue vivo):', err?.message || err);
});

// Permite generar el informe manualmente:  node src/index.js --informe
if (process.argv.includes('--informe')) {
  await sendDailyReport();
  process.exit(0);
}

loadStore();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Falta ANTHROPIC_API_KEY en .env. Copia .env.example a .env y pon tu clave.');
  process.exit(1);
}

scheduleDailyReport();

start().catch((err) => {
  console.error('Error fatal al arrancar el bot:', err);
  process.exit(1);
});
