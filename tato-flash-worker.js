// tato-flash-worker.js — segundo worker de IA do Tato
// Modelo: Agnes 2.5 Flash. Mesma chave da Agnes, guardada só como
// env var no Render (AGNES_API_KEY) — nunca hardcoded aqui.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const AGNES_API_KEY = process.env.AGNES_API_KEY;
const AGNES_API_URL = process.env.AGNES_API_URL || 'https://api.agnes.ai/v1/chat/completions';
const AGNES_MODEL = 'agnes-2.5-flash';

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'tato-flash-worker', model: AGNES_MODEL });
});

app.post('/', async (req, res) => {
  try {
    if (!AGNES_API_KEY) {
      console.error('[tato-flash-worker] AGNES_API_KEY não configurada.');
      return res.status(500).json({ ok: false, error: 'Servidor sem chave configurada.' });
    }

    const { messages, prompt } = req.body || {};
    const chatMessages = Array.isArray(messages)
      ? messages
      : [{ role: 'user', content: String(prompt || '') }];

    const upstream = await fetch(AGNES_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGNES_API_KEY}`
      },
      body: JSON.stringify({ model: AGNES_MODEL, messages: chatMessages, stream: false })
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      console.error('[tato-flash-worker] Erro upstream:', upstream.status, text);
      return res.status(502).json({ ok: false, error: 'Falha ao falar com a Agnes.' });
    }

    const data = await upstream.json();
    const reply =
      data?.choices?.[0]?.message?.content ??
      data?.reply ??
      data?.output_text ??
      '';

    return res.json({ ok: true, reply });
  } catch (err) {
    console.error('[tato-flash-worker] Erro inesperado:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno no worker.' });
  }
});

app.listen(PORT, () => {
  console.log(`[tato-flash-worker] rodando na porta ${PORT}, modelo ${AGNES_MODEL}`);
});
