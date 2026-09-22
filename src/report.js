import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';

const DATA_DIR = path.resolve('data');
const LOG_FILE = path.join(DATA_DIR, 'interacciones.jsonl');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Registra cada interaccion en un log diario (una linea JSON por evento).
export function logInteraction(entry) {
  try {
    ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error('No se pudo registrar la interaccion:', err.message);
  }
}

function readTodayEntries() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const today = new Date().toISOString().slice(0, 10);
    return fs
      .readFileSync(LOG_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter((e) => e && e.ts && e.ts.slice(0, 10) === today);
  } catch {
    return [];
  }
}

export function buildReportText() {
  const entries = readTodayEntries();
  const today = new Date().toISOString().slice(0, 10);

  const atendidos = entries.filter((e) => e.tipo === 'respondido');
  const pendientes = entries.filter((e) => e.tipo === 'handoff');
  const errores = entries.filter((e) => e.tipo === 'error');
  const usuarios = new Set(entries.map((e) => e.numero)).size;

  const linea = (e) => `  - +${e.numero || '¿?'}: "${(e.mensaje || '').slice(0, 120)}"`;

  return `INFORME DIARIO — ASIM Bot WhatsApp
Fecha: ${today}

RESUMEN
- Personas atendidas (numeros distintos): ${usuarios}
- Mensajes respondidos por el bot: ${atendidos.length}
- Conversaciones escaladas a humano (PENDIENTES de atender): ${pendientes.length}
- Errores tecnicos: ${errores.length}

PENDIENTES DE ATENDER POR EL EQUIPO (${pendientes.length})
${pendientes.length ? pendientes.map(linea).join('\n') : '  (ninguno)'}

RESPONDIDOS POR EL BOT (${atendidos.length})
${atendidos.length ? atendidos.map(linea).join('\n') : '  (ninguno)'}

${errores.length ? `ERRORES (${errores.length})\n${errores.map(linea).join('\n')}\n` : ''}
--
Informe automatico del Asistente ASIM. Los "pendientes" son conversaciones donde el bot ya avisó de que una persona del equipo debe responder.`;
}

export async function sendDailyReport() {
  const text = buildReportText();

  // Guarda siempre una copia en disco.
  try {
    ensureDir();
    const file = path.join(DATA_DIR, `informe-${new Date().toISOString().slice(0, 10)}.txt`);
    fs.writeFileSync(file, text);
    console.log('Informe guardado en', file);
  } catch (err) {
    console.error('No se pudo guardar el informe:', err.message);
  }

  // Envia por correo solo si hay SMTP configurado en .env.
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REPORT_TO } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('SMTP no configurado: informe guardado en disco, no enviado por correo.');
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT || '587', 10),
      secure: parseInt(SMTP_PORT || '587', 10) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    await transporter.sendMail({
      from: SMTP_USER,
      to: REPORT_TO || 'info@asim.org.es',
      subject: `Informe diario ASIM Bot — ${new Date().toISOString().slice(0, 10)}`,
      text,
    });
    console.log('Informe enviado por correo a', REPORT_TO || 'info@asim.org.es');
  } catch (err) {
    console.error('No se pudo enviar el informe por correo:', err.message);
  }
}

// Programa el informe a una hora fija cada dia (HH:mm, hora del servidor). Por defecto 20:00.
export function scheduleDailyReport() {
  const [h, m] = (process.env.REPORT_TIME || '20:00').split(':').map((x) => parseInt(x, 10));
  function msUntilNext() {
    const now = new Date();
    const next = new Date();
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }
  function schedule() {
    setTimeout(async () => {
      await sendDailyReport();
      schedule();
    }, msUntilNext());
  }
  schedule();
  console.log(`Informe diario programado a las ${process.env.REPORT_TIME || '20:00'} (hora del servidor).`);
}
