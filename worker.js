import { verifyFirebaseIdToken } from "./firebase-verify.js";
import { encryptToken, decryptToken } from "./crypto.js";
import { randomState, pkcePair } from "./pkce.js";
import { handleAgentRequest } from "./agent.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cors(resp, origin) {
  resp.headers.set("Access-Control-Allow-Origin", origin || "*");
  resp.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return resp;
}

async function requireUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const claims = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
    return claims.user_id || claims.sub;
  } catch (err) {
    return null;
  }
}

async function sbFetch(env, path, init = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: init.prefer || "return=representation",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase ${path} -> ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------
// Alguns provedores OAuth (o GitHub é o caso clássico) ignoram o
// Accept: application/json e respondem application/x-www-form-urlencoded
// mesmo assim em certas condições. Em vez de confiar cegamente em
// res.json() (que quebra com "Unexpected token ... is not valid JSON"
// quando o corpo vem form-encoded), tentamos JSON primeiro e caímos
// pra URLSearchParams se falhar.
// ------------------------------------------------------------
async function parseTokenResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    const parsed = Object.fromEntries(new URLSearchParams(text));
    // expires_in vem como string no formato form-urlencoded; normaliza
    // pra número, já que o resto do código espera número.
    if (parsed.expires_in) parsed.expires_in = Number(parsed.expires_in);
    return parsed;
  }
}

async function listConnectors(request, env, uid) {
  const catalog = await sbFetch(env, "/mcp_connectors?enabled=eq.true&select=id,name,description,logo_url,oauth_scopes");
  const tokens = await sbFetch(
    env,
    `/user_connector_tokens?user_id=eq.${encodeURIComponent(uid)}&select=connector_id,connected_at,expires_at`
  );
  const connectedMap = new Map(tokens.map((t) => [t.connector_id, t]));
  const result = catalog.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    logo_url: c.logo_url,
    connected: connectedMap.has(c.id),
    connected_at: connectedMap.get(c.id)?.connected_at || null,
  }));
  return json({ connectors: result });
}

async function startAuthorize(request, env, uid, connectorId) {
  const [connector] = await sbFetch(env, `/mcp_connectors?id=eq.${connectorId}&select=*`);
  if (!connector) return json({ error: "connector_not_found" }, 404);

  const state = randomState();
  const { verifier, challenge } = await pkcePair();

  await sbFetch(env, "/oauth_states", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify({
      state,
      user_id: uid,
      connector_id: connectorId,
      code_verifier: verifier,
    }),
  });

  const redirectUri = `${env.OAUTH_REDIRECT_BASE}/connectors/${connectorId}/callback`;
  const url = new URL(connector.oauth_authorize_url);
  url.searchParams.set("client_id", connector.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", connector.oauth_scopes || "");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  // Parâmetros extras específicos de provedor (ex: o Google só manda
  // refresh_token se access_type=offline&prompt=consent forem passados
  // na URL de autorização). Guardado como jsonb genérico na tabela, então
  // qualquer conector futuro com uma exigência parecida só precisa
  // preencher essa coluna, sem código novo aqui.
  if (connector.oauth_extra_params) {
    for (const [key, value] of Object.entries(connector.oauth_extra_params)) {
      url.searchParams.set(key, String(value));
    }
  }

  const asJson = new URL(request.url).searchParams.get("as") === "json";
  if (asJson) return json({ url: url.toString() });

  return Response.redirect(url.toString(), 302);
}

async function handleCallback(request, env, connectorId) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  // Fallback via localStorage: alguns provedores OAuth (ex: o Google, em
  // accounts.google.com) respondem com Cross-Origin-Opener-Policy: same-origin
  // nas telas de login/consentimento. Quando o popup navega por essa página,
  // o navegador corta em definitivo a relação com a janela que abriu o popup
  // — window.opener vira null e popup.closed deixa de ser confiável, mesmo
  // depois do redirect de volta pra cá (é a causa do aviso "Cross-Origin-
  // -Opener-Policy policy would block the window.closed call." no console
  // e do "conectei mas o app acha que não conectou").
  // localStorage/evento 'storage' são isolados por origem, não por
  // referência de janela, então continuam funcionando mesmo com esse corte
  // — por isso gravamos o resultado ali além de tentar o postMessage.
  const closePopupHtml = (ok, message) => `<!doctype html><html><body>
<script>
  try {
    localStorage.setItem('tato-mcp-oauth-result', JSON.stringify({
      connector: ${JSON.stringify(connectorId)}, ok: ${ok}, message: ${JSON.stringify(message || "")}, ts: Date.now()
    }));
  } catch (e) {}
  window.opener && window.opener.postMessage({ source: "tato-mcp-oauth", ok: ${ok}, connector: ${JSON.stringify(connectorId)}, message: ${JSON.stringify(message || "")} }, "*");
  window.close();
</script>
${ok ? "Conectado! Pode fechar esta aba." : "Falha ao conectar: " + (message || "")}
</body></html>`;

  if (errorParam) {
    return new Response(closePopupHtml(false, errorParam), { headers: { "Content-Type": "text/html" } });
  }

  const [stateRow] = await sbFetch(env, `/oauth_states?state=eq.${encodeURIComponent(state)}&select=*`);
  if (!stateRow || stateRow.connector_id !== connectorId) {
    return new Response(closePopupHtml(false, "invalid_state"), { headers: { "Content-Type": "text/html" } });
  }
  await sbFetch(env, `/oauth_states?state=eq.${encodeURIComponent(state)}`, { method: "DELETE", prefer: "return=minimal" });

  const [connector] = await sbFetch(env, `/mcp_connectors?id=eq.${connectorId}&select=*`);
  const redirectUri = `${env.OAUTH_REDIRECT_BASE}/connectors/${connectorId}/callback`;

  const tokenRes = await fetch(connector.oauth_token_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Sem isso, o GitHub (e alguns outros provedores) respondem em
      // application/x-www-form-urlencoded em vez de JSON, e o parse
      // quebra com "Unexpected token ... is not valid JSON".
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: connector.client_id,
      client_secret: connector.client_secret,
      code_verifier: stateRow.code_verifier,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    return new Response(closePopupHtml(false, `token_exchange_failed: ${body}`), { headers: { "Content-Type": "text/html" } });
  }

  const tokenData = await parseTokenResponse(tokenRes);
  if (!tokenData.access_token) {
    return new Response(closePopupHtml(false, `token_exchange_no_access_token: ${JSON.stringify(tokenData).slice(0, 500)}`), { headers: { "Content-Type": "text/html" } });
  }

  const encAccess = await encryptToken(tokenData.access_token, env.TOKEN_ENC_KEY);
  const encRefresh = tokenData.refresh_token ? await encryptToken(tokenData.refresh_token, env.TOKEN_ENC_KEY) : null;
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  await sbFetch(env, "/user_connector_tokens?on_conflict=user_id,connector_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({
      user_id: stateRow.user_id,
      connector_id: connectorId,
      access_token: encAccess,
      refresh_token: encRefresh,
      expires_at: expiresAt,
      scope: tokenData.scope || connector.oauth_scopes,
      updated_at: new Date().toISOString(),
    }),
  });

  return new Response(closePopupHtml(true), { headers: { "Content-Type": "text/html" } });
}

async function disconnect(request, env, uid, connectorId) {
  await sbFetch(
    env,
    `/user_connector_tokens?user_id=eq.${encodeURIComponent(uid)}&connector_id=eq.${connectorId}`,
    { method: "DELETE", prefer: "return=minimal" }
  );
  return json({ ok: true });
}

async function ensureFreshToken(env, connectorId, row) {
  if (!row.expires_at || new Date(row.expires_at) > new Date(Date.now() + 60_000)) {
    return row;
  }
  if (!row.refresh_token) return row;

  const [connector] = await sbFetch(env, `/mcp_connectors?id=eq.${connectorId}&select=*`);
  const refreshToken = await decryptToken(row.refresh_token, env.TOKEN_ENC_KEY);

  const res = await fetch(connector.oauth_token_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Mesmo motivo do handleCallback: garante resposta em JSON.
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: connector.client_id,
      client_secret: connector.client_secret,
    }),
  });
  if (!res.ok) return row;

  const data = await parseTokenResponse(res);
  if (!data.access_token) return row;

  const encAccess = await encryptToken(data.access_token, env.TOKEN_ENC_KEY);
  const encRefresh = data.refresh_token ? await encryptToken(data.refresh_token, env.TOKEN_ENC_KEY) : row.refresh_token;
  const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null;

  await sbFetch(env, `/user_connector_tokens?user_id=eq.${row.user_id}&connector_id=eq.${connectorId}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ access_token: encAccess, refresh_token: encRefresh, expires_at: expiresAt, updated_at: new Date().toISOString() }),
  });

  return { ...row, access_token: encAccess, expires_at: expiresAt };
}

async function internalGetToken(request, env) {
  const secret = request.headers.get("X-Internal-Secret");
  if (secret !== env.INTERNAL_GATEWAY_SECRET) return json({ error: "forbidden" }, 403);

  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id");
  const connectorId = url.searchParams.get("connector_id");
  if (!userId || !connectorId) return json({ error: "missing_params" }, 400);

  const [row] = await sbFetch(
    env,
    `/user_connector_tokens?user_id=eq.${encodeURIComponent(userId)}&connector_id=eq.${connectorId}&select=*`
  );
  if (!row) return json({ connected: false });

  const fresh = await ensureFreshToken(env, connectorId, row);
  const accessToken = await decryptToken(fresh.access_token, env.TOKEN_ENC_KEY);
  const [connector] = await sbFetch(env, `/mcp_connectors?id=eq.${connectorId}&select=mcp_url,name`);

  return json({ connected: true, access_token: accessToken, mcp_url: connector.mcp_url, name: connector.name });
}

// ------------------------------------------------------------
// Proxy MCP: o client (tato-10.html) manda só { tool, arguments },
// autenticado com o Firebase token normal do usuário (mesmo esquema
// das outras rotas /connectors/*). O access_token do conector nunca
// sai deste Worker — é buscado, descriptografado e usado aqui pra
// falar com o servidor MCP remoto via JSON-RPC (protocolo MCP padrão
// sobre HTTP: POST {jsonrpc:"2.0", method:"tools/call"|"tools/list"}).
// ------------------------------------------------------------
async function mcpRpcCall(env, uid, connectorId, method, params) {
  const [row] = await sbFetch(
    env,
    `/user_connector_tokens?user_id=eq.${encodeURIComponent(uid)}&connector_id=eq.${connectorId}&select=*`
  );
  if (!row) return { error: json({ error: "not_connected" }, 409) };

  const fresh = await ensureFreshToken(env, connectorId, row);
  const accessToken = await decryptToken(fresh.access_token, env.TOKEN_ENC_KEY);
  const [connector] = await sbFetch(env, `/mcp_connectors?id=eq.${connectorId}&select=mcp_url,name`);
  if (!connector || !connector.mcp_url) return { error: json({ error: "connector_missing_mcp_url" }, 500) };

  const baseHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    // Alguns servidores MCP HTTP (inclusive o do Supabase) exigem esse
    // header em toda requisição, não só o protocolVersion no body.
    "MCP-Protocol-Version": "2024-11-05",
  };

  // ---- Passo 1: handshake MCP (Streamable HTTP) ----
  // O servidor exige um Mcp-Session-Id em toda chamada que não seja a
  // de inicialização; então toda vez fazemos initialize primeiro pra
  // abrir uma sessão nova e pegar esse header antes do método real.
  let initRes;
  try {
    initRes = await fetch(connector.mcp_url, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "tato-ia", version: "1.0.0" },
        },
      }),
    });
  } catch (err) {
    return { error: json({ error: "mcp_network_error", message: String(err.message || err) }, 502) };
  }
  if (!initRes.ok) {
    const rawInit = await initRes.text().catch(() => "");
    return { error: json({ error: "mcp_init_failed", status: initRes.status, message: rawInit.slice(0, 2000) }, 502) };
  }

  const sessionId = initRes.headers.get("Mcp-Session-Id") || initRes.headers.get("mcp-session-id");
  // Consome o corpo (precisamos ler de qualquer forma pra não deixar a
  // stream presa), e guardamos pra debug caso a sessão não venha.
  const initBody = await initRes.text().catch(() => "");

  // DEBUG: se não veio session id, devolve pra você ver o que o servidor
  // realmente respondeu (headers + corpo) em vez de só falhar depois.
  if (!sessionId) {
    const headerDump = {};
    for (const [k, v] of initRes.headers.entries()) headerDump[k] = v;
    return {
      error: json(
        {
          error: "no_session_id",
          status: initRes.status,
          headers: headerDump,
          body: initBody.slice(0, 1500),
        },
        502
      ),
    };
  }

  const callHeaders = { ...baseHeaders, "Mcp-Session-Id": sessionId };

  // Servidores MCP Streamable HTTP também esperam a notificação
  // "notifications/initialized" logo após o initialize, antes de
  // qualquer outra chamada — mandamos e ignoramos a resposta.
  try {
    await fetch(connector.mcp_url, {
      method: "POST",
      headers: callHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
  } catch (e) { /* best-effort */ }

  // ---- Passo 2: a chamada de verdade, já com a sessão aberta ----
  let mcpRes;
  try {
    mcpRes = await fetch(connector.mcp_url, {
      method: "POST",
      headers: callHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params: params || {} }),
    });
  } catch (err) {
    return { error: json({ error: "mcp_network_error", message: String(err.message || err) }, 502) };
  }

  const rawText = await mcpRes.text();
  if (!mcpRes.ok) {
    return { error: json({ error: "mcp_call_failed", status: mcpRes.status, message: rawText.slice(0, 2000) }, 502) };
  }

  // Servidores MCP HTTP podem responder JSON puro ou um pequeno stream
  // SSE com um evento "message" contendo o JSON-RPC — tratamos os dois.
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    const dataLine = rawText.split("\n").find((l) => l.indexOf("data:") === 0);
    if (dataLine) {
      try { parsed = JSON.parse(dataLine.slice(5).trim()); } catch (e2) { /* segue null */ }
    }
  }
  if (!parsed) return { error: json({ error: "mcp_bad_response", raw: rawText.slice(0, 2000) }, 502) };
  if (parsed.error) return { error: json({ error: "mcp_tool_error", message: parsed.error.message || parsed.error }, 502) };

  return { result: parsed.result };
}

async function listConnectorMcpTools(request, env, uid, connectorId) {
  const { error, result } = await mcpRpcCall(env, uid, connectorId, "tools/list", {});
  if (error) return error;
  return json({ tools: (result && result.tools) || [] });
}

async function callConnectorTool(request, env, uid, connectorId) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json" }, 400);
  }
  const toolName = body && body.tool;
  const toolArgs = (body && body.arguments) || {};
  if (!toolName || typeof toolName !== "string") {
    return json({ error: "missing_tool_name" }, 400);
  }

  const { error, result } = await mcpRpcCall(env, uid, connectorId, "tools/call", { name: toolName, arguments: toolArgs });
  if (error) return error;
  return json({ result });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin);

    const url = new URL(request.url);

    // --- Rotas do agente de navegador (Browser Run / Puppeteer) ---
    // Protegidas pelo mesmo login Firebase das rotas de conector.
    if (url.pathname.startsWith("/agent/")) {
      const agentUid = await requireUser(request, env);
      if (!agentUid) return cors(json({ error: "unauthorized" }, 401), origin);
      return cors(await handleAgentRequest(request, env, url), origin);
    }

    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (parts[0] === "internal" && parts[1] === "token" && request.method === "GET") {
        return cors(await internalGetToken(request, env), origin);
      }

      if (parts[0] === "connectors" && parts[2] === "callback" && request.method === "GET") {
        return cors(await handleCallback(request, env, parts[1]), origin);
      }

      // Antes: "const uid = await requireUser(request, env);" engolia o erro
      // dentro de requireUser e sempre virava um 401 genérico sem motivo.
      // Agora capturamos aqui e devolvemos o motivo real em "debug" pra
      // conseguirmos diagnosticar problemas de token/variáveis de ambiente.
      const uid = await requireUser(request, env);
      if (!uid) return cors(json({ error: "unauthorized" }, 401), origin);

      if (parts[0] === "connectors" && parts.length === 1 && request.method === "GET") {
        return cors(await listConnectors(request, env, uid), origin);
      }
      if (parts[0] === "connectors" && parts[2] === "authorize" && request.method === "GET") {
        return cors(await startAuthorize(request, env, uid, parts[1]), origin);
      }
      if (parts[0] === "connectors" && parts[2] === "disconnect" && request.method === "POST") {
        return cors(await disconnect(request, env, uid, parts[1]), origin);
      }
      if (parts[0] === "connectors" && parts[2] === "mcp-tools" && request.method === "GET") {
        return cors(await listConnectorMcpTools(request, env, uid, parts[1]), origin);
      }
      if (parts[0] === "connectors" && parts[2] === "mcp-call" && request.method === "POST") {
        return cors(await callConnectorTool(request, env, uid, parts[1]), origin);
      }

      return cors(json({ error: "not_found" }, 404), origin);
    } catch (err) {
      return cors(json({ error: "internal_error", message: String(err.message || err) }, 500), origin);
    }
  },
};
