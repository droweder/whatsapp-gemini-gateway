import express from 'express';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';

const { Client, LocalAuth } = pkg;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const ALLOWED = (process.env.WHATSAPP_ALLOWED_NUMBER || '5547933817309').replace(/\D/g, '');
const SESSION_DIR = process.env.SESSION_DIR || './whatsapp-session';

if (!GEMINI_API_KEY) {
  console.error('ERRO: GEMINI_API_KEY nao definida!');
  process.exit(1);
}

fs.mkdirSync(SESSION_DIR, { recursive: true });

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

const conversationHistory = new Map();

async function askGemini(userId, userMessage) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);
  history.push({ role: 'user', parts: [{ text: userMessage }] });
  if (history.length > 20) history.splice(0, 2);

  const chat = model.startChat({
    history: history.slice(0, -1),
    systemInstruction: 'Voce eh um assistente OpenClaw via WhatsApp. Responda sempre em portugues do Brasil, de forma objetiva, util e amigavel.',
  });

  const result = await chat.sendMessage(userMessage);
  const reply = result.response.text()?.trim() || 'Nao consegui gerar uma resposta agora.';

  history.push({ role: 'model', parts: [{ text: reply }] });
  return reply;
}

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: SESSION_DIR,
    clientId: 'openclaw-whatsapp',
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  },
});

client.on('qr', (qr) => {
  console.log('\n=== ESCANEIE O QR CODE NO WHATSAPP ===');
  console.log('Aparelhos conectados > Conectar dispositivo\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('Sessao autenticada com sucesso.');
});

client.on('auth_failure', (msg) => {
  console.error('Falha na autenticacao:', msg);
});

client.on('ready', () => {
  console.log(`WhatsApp Gateway online! Numero autorizado: ${ALLOWED}`);
});

client.on('disconnected', (reason) => {
  console.warn('WhatsApp desconectado:', reason);
});

client.on('message', async (message) => {
  try {
    if (message.fromMe) return;
    const isGroup = message.from?.includes('@g.us');
    if (isGroup) return;

    const senderNumber = (message.from || '').replace(/[^0-9]/g, '');
    if (!senderNumber.includes(ALLOWED) && !ALLOWED.includes(senderNumber)) {
      console.log(`Mensagem ignorada de numero nao autorizado: ${senderNumber}`);
      return;
    }

    console.log(`Mensagem recebida de ${senderNumber}: ${message.body?.substring(0, 80)}`);

    const typing = await message.getChat();
    await typing.sendStateTyping();

    const reply = await askGemini(senderNumber, message.body || '');
    await message.reply(reply);

    console.log(`Resposta enviada para ${senderNumber}`);
  } catch (err) {
    console.error('Erro ao processar mensagem:', err.message);
    try {
      await message.reply('Tive um erro momentaneo. Tente novamente em instantes.');
    } catch (_) {}
  }
});

app.get('/', (_, res) => {
  res.json({
    service: 'OpenClaw WhatsApp + Gemini Gateway',
    status: 'online',
    model: GEMINI_MODEL,
    allowedNumber: ALLOWED,
  });
});

app.get('/health', (_, res) => {
  const state = client.info ? 'connected' : 'connecting';
  res.json({ ok: true, whatsapp: state, timestamp: new Date().toISOString() });
});

app.get('/status', (_, res) => {
  res.json({
    whatsappReady: !!client.info,
    phoneNumber: client.info?.wid?.user || null,
    platform: client.info?.platform || null,
    conversations: conversationHistory.size,
  });
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP iniciado na porta ${PORT}`);
});

console.log('Iniciando cliente WhatsApp...');
client.initialize().catch((err) => {
  console.error('Erro ao inicializar WhatsApp:', err.message);
  process.exit(1);
});
