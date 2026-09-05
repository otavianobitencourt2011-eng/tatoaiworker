const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

const API_URL = "https://api.experientiallabs.ai/v1/chat/completions";
const MODEL = "claude-fable-5.1";
const MAX_OUTPUT_TOKENS = 128000;

app.use(cors({
  origin: true,
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "20mb" }));

function sendSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function getErrorMessage(payload, fallback = "Erro desconhecido na API do Experiential Labs.") {
  if (!payload) return fallback;
  if (typeof payload === "string") return payload;
  const error = payload.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    return error.message || error.detail || error.code || JSON.stringify(error);
  }
  return payload.message || payload.detail || payload.reason || fallback;
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        return part.text || part.content || part.value || "";
      })
      .join("");
  }
  if (value && typeof value === "object") {
    return value.text || value.content || value.value || "";
  }
  return "";
}

function extractSafeReasoningSummary(delta, choice) {
  // Fable 5.1 usa raciocÃ­nio adaptativo. NÃ£o expomos chain-of-thought bruto.
  // Se o gateway/provedor devolver um campo explÃ­cito de resumo de raciocÃ­nio,
  // ele pode ser exibido pela UI do Tato como "pensamento".
  const candidates = [
    delta?.reasoning_summary,
    delta?.reasoning?.summary,
    choice?.reasoning_summary,
    choice?.message?.reasoning_summary
  ];

  for (const candidate of candidates) {
    const text = extractText(candidate);
    if (text.trim()) return text;
  }

  return "";
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    worker: "tato-184m",
    model: MODEL,
    provider: "Experiential Labs",
    reasoning: "low",
    streaming: true,
    tools: true
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: MODEL });
});

app.post("/", async (req, res) => {
  const apiKey = process.env.EXPLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "EXPLABS_API_KEY nÃ£o configurada no Render."
    });
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];

  if (!messages.length) {
    return res.status(400).json({ error: "messages Ã© obrigatÃ³rio." });
  }

  const upstreamBody = {
    model: MODEL,
    messages,
    stream: true,
    reasoning_effort: "low",
    max_tokens: MAX_OUTPUT_TOKENS
  };

  // O Tato jÃ¡ envia as tools no formato OpenAI. Mantemos o contrato exatamente
  // para permitir que o Fable faÃ§a chamadas de ferramenta normalmente.
  if (tools.length) upstreamBody.tools = tools;

  // Campos opcionais que podem ser Ãºteis no futuro, mas nÃ£o sÃ£o necessÃ¡rios
  // para a integraÃ§Ã£o inicial, nÃ£o sÃ£o repassados automaticamente.
  if (body.response_format && typeof body.response_format === "object") {
    upstreamBody.response_format = body.response_format;
  }

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify(upstreamBody)
    });
  } catch (error) {
    return res.status(502).json({
      error: `Falha de conexÃ£o com Experiential Labs: ${error.message}`
    });
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch (_) {}

    return res.status(upstream.status).json({
      error: getErrorMessage(payload, raw || `Experiential Labs respondeu HTTP ${upstream.status}.`),
      upstream_status: upstream.status
    });
  }

  if (!upstream.body) {
    return res.status(502).json({
      error: "Experiential Labs respondeu sem corpo de streaming."
    });
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (res.flushHeaders) res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let finalContent = "";
  let finalReasoningSummary = "";
  let finishReason = null;

  const toolCalls = new Map();

  function mergeToolDelta(toolDelta) {
    if (!toolDelta || !toolDelta.index && toolDelta.index !== 0) return;

    const index = Number(toolDelta.index);
    const current = toolCalls.get(index) || {
      id: "",
      type: "function",
      function: { name: "", arguments: "" }
    };

    if (toolDelta.id) current.id = toolDelta.id;
    if (toolDelta.type) current.type = toolDelta.type;

    const fn = toolDelta.function || {};
    if (fn.name) current.function.name += fn.name;
    if (fn.arguments) current.function.arguments += fn.arguments;

    toolCalls.set(index, current);
  }

  function handleUpstreamEvent(data) {
    if (!data || data === "[DONE]") return;

    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch (_) {
      return;
    }

    if (chunk.error) {
      sendSse(res, { type: "error", error: chunk.error });
      return;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta || {};

    const text = extractText(delta.content);
    if (text) {
      finalContent += text;
      sendSse(res, { type: "delta", text });
    }

    const reasoningSummary = extractSafeReasoningSummary(delta, choice);
    if (reasoningSummary) {
      finalReasoningSummary += reasoningSummary;
      sendSse(res, { type: "thinking", text: reasoningSummary });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const toolDelta of delta.tool_calls) {
        mergeToolDelta(toolDelta);
        sendSse(res, {
          type: "tool_delta",
          index: toolDelta.index,
          id: toolDelta.id || null,
          function: toolDelta.function || null
        });
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLines = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        if (!dataLines.length) continue;

        handleUpstreamEvent(dataLines.join("\n"));
      }
    }

    buffer += decoder.decode();

    // Alguns proxies deixam o Ãºltimo evento sem \n\n.
    if (buffer.trim()) {
      const dataLines = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (dataLines.length) handleUpstreamEvent(dataLines.join("\n"));
    }

    const message = {
      role: "assistant",
      content: finalContent || null
    };

    const orderedToolCalls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);

    if (orderedToolCalls.length) {
      message.tool_calls = orderedToolCalls;
    }

    if (finalReasoningSummary) {
      message.reasoning = finalReasoningSummary;
    }

    sendSse(res, {
      type: "done",
      message,
      finish_reason: finishReason,
      reasoningCheckpoint: false
    });

    res.end();
  } catch (error) {
    sendSse(res, {
      type: "error",
      error: error.message || "Erro durante o streaming."
    });
    res.end();
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Tato-184m worker online na porta ${PORT}`);
});
