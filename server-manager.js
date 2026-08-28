import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

const SEEKAI_API_KEY = process.env.SEEKAI_API_KEY;
const SEEKAI_BASE_URL = "https://seekai.cc/v1";
const MODEL = "deepseek-v4-pro";

const MAX_BODY_BYTES = 25 * 1024 * 1024;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  });
  res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  });
  res.end(text);
}

async function readJsonBody(req) {
  let total = 0;
  const chunks = [];

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error("Payload too large.");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body.");
    err.statusCode = 400;
    throw err;
  }
}

function buildSeekAiPayload(input) {
  if (!input || typeof input !== "object") {
    throw Object.assign(new Error("Request body must be a JSON object."), {
      statusCode: 400,
    });
  }

  if (!Array.isArray(input.messages)) {
    throw Object.assign(new Error('"messages" must be an array.'), {
      statusCode: 400,
    });
  }

  // The worker owns the model and the reasoning mode.
  // Client-supplied model/thinking values are intentionally ignored.
  const payload = {
    model: MODEL,
    messages: input.messages,
    thinking: { type: "disabled" },
  };

  // Tool access: forward the tool definitions and optional tool-choice exactly
  // as received from the caller. The worker itself does not execute tools.
  if (Array.isArray(input.tools)) payload.tools = input.tools;
  if (input.tool_choice !== undefined) payload.tool_choice = input.tool_choice;

  // Standard OpenAI-compatible generation controls.
  const passThroughKeys = [
    "stream",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "stop",
    "response_format",
    "seed",
    "n",
    "user",
  ];

  for (const key of passThroughKeys) {
    if (input[key] !== undefined) payload[key] = input[key];
  }

  // Keep thinking disabled even if a client tries to override it through
  // another field.
  payload.thinking = { type: "disabled" };

  // SeekAi/OpenAI-compatible gateways may accept additional provider-specific
  // fields. We deliberately do not forward arbitrary keys so the worker keeps
  // a predictable contract.
  return payload;
}

async function proxyToSeekAi(req, res) {
  if (!SEEKAI_API_KEY) {
    return sendJson(res, 500, {
      error: {
        type: "configuration_error",
        message: "SEEKAI_API_KEY is not configured on the worker.",
      },
    });
  }

  let input;
  try {
    input = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, {
      error: {
        type: "invalid_request",
        message: error.message || "Invalid request.",
      },
    });
  }

  let payload;
  try {
    payload = buildSeekAiPayload(input);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, {
      error: {
        type: "invalid_request",
        message: error.message || "Invalid request.",
      },
    });
  }

  let upstream;
  try {
    upstream = await fetch(`${SEEKAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SEEKAI_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": payload.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(payload),
      signal: req.signal,
    });
  } catch (error) {
    return sendJson(res, 502, {
      error: {
        type: "upstream_connection_error",
        message: `Could not connect to SeekAi: ${error?.message || String(error)}`,
      },
    });
  }

  const contentType = upstream.headers.get("content-type") || "application/json";

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    let parsed = null;

    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // Keep raw upstream response.
    }

    const upstreamError =
      parsed?.error ??
      parsed?.message ??
      (raw || `SeekAi returned HTTP ${upstream.status}.`);

    return sendJson(res, upstream.status, {
      error:
        typeof upstreamError === "object"
          ? upstreamError
          : {
              type: "seekai_upstream_error",
              message: String(upstreamError),
            },
    });
  }

  // Streaming: relay SeekAi SSE byte-for-byte.
  if (
    contentType.includes("text/event-stream") ||
    payload.stream === true
  ) {
    res.writeHead(upstream.status, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    });

    if (!upstream.body) {
      return res.end();
    }

    try {
      for await (const chunk of upstream.body) {
        res.write(chunk);
      }
    } catch (error) {
      // Client disconnects and aborted streams are normal termination cases.
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // Ignore failed socket writes.
        }
      }
    }
    return;
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());

  res.writeHead(upstream.status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  });
  res.end(buffer);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  if (req.method === "GET" && req.url === "/") {
    return sendJson(res, 200, {
      ok: true,
      service: "package-manager",
      model: MODEL,
      reasoning: "disabled",
    });
  }

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      ok: true,
      model: MODEL,
      reasoning: "disabled",
      configured: Boolean(SEEKAI_API_KEY),
    });
  }

  if (req.method === "POST" && req.url === "/") {
    return proxyToSeekAi(req, res);
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    return proxyToSeekAi(req, res);
  }

  return sendJson(res, 404, {
    error: {
      type: "not_found",
      message: "Route not found.",
    },
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    `[package-manager] listening on http://${HOST}:${PORT} | model=${MODEL} | thinking=disabled`
  );
});
