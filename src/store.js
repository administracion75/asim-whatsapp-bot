import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const DATA_FILE = path.join(DATA_DIR, 'conversations.json');
const MAX_HISTORY_TURNS = parseInt(process.env.MAX_HISTORY_TURNS || '12', 10);

let conversations = {};

export function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      conversations = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
      conversations = {};
    }
  }
}

function saveStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(conversations, null, 2));
}

function getConv(jid) {
  if (!conversations[jid]) {
    conversations[jid] = { messages: [], pausedUntil: 0 };
  }
  return conversations[jid];
}

export function isPaused(jid) {
  return getConv(jid).pausedUntil > Date.now();
}

export function pause(jid, hours) {
  const conv = getConv(jid);
  conv.pausedUntil = Date.now() + hours * 3600 * 1000;
  saveStore();
}

export function getHistory(jid) {
  return getConv(jid).messages.map(({ role, content }) => ({ role, content }));
}

export function pushMessage(jid, role, content) {
  const conv = getConv(jid);
  conv.messages.push({ role, content });
  const maxLen = MAX_HISTORY_TURNS * 2;
  if (conv.messages.length > maxLen) {
    conv.messages = conv.messages.slice(-maxLen);
  }
  saveStore();
}
