'use strict';
// Verifica Firebase ID tokens (RS256) sem dependências externas.
// Sem token => visitante (limites menores). Token PRESENTE mas inválido => 401 (nunca cai para visitante).
const crypto = require('crypto');
const https = require('https');
const cfg = require('./config');

const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certs = null, certsExp = 0;

function fetchCerts() {
  return new Promise((resolve, reject) => {
    https.get(CERT_URL, { timeout: 8000 }, res => {
      let b = ''; res.on('data', c => { b += c; if (b.length > 100000) res.destroy(); });
      res.on('end', () => {
        try {
          const m = /max-age=(\d+)/.exec(res.headers['cache-control'] || '');
          certsExp = Date.now() + (m ? Number(m[1]) * 1000 : 3600000);
          certs = JSON.parse(b); resolve(certs);
        } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
async function getCerts() { if (certs && Date.now() < certsExp) return certs; return fetchCerts(); }
function b64u(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

async function verifyFirebaseToken(token, opts) {
  opts = opts || {};
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('token malformado');
  let header, payload;
  try { header = JSON.parse(b64u(parts[0]).toString('utf8')); payload = JSON.parse(b64u(parts[1]).toString('utf8')); } catch (_) { throw new Error('token malformado'); }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('algoritmo inválido');
  const all = opts.certs || await getCerts();
  const pem = all[header.kid];
  if (!pem) throw new Error('chave desconhecida');
  const ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify(crypto.createPublicKey(pem), b64u(parts[2]));
  if (!ok) throw new Error('assinatura inválida');
  const now = Math.floor((opts.now || Date.now()) / 1000);
  const pid = opts.projectId || cfg.FIREBASE_PROJECT_ID;
  if (payload.aud !== pid) throw new Error('audience inválida');
  if (payload.iss !== 'https://securetoken.google.com/' + pid) throw new Error('issuer inválido');
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('sub ausente');
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('token expirado');
  if (typeof payload.iat === 'number' && payload.iat > now + 300) throw new Error('token do futuro');
  return { uid: payload.sub, email: payload.email || null };
}

function clientIp(req) {
  if (cfg.TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Retorna { tier:'user'|'guest', key }, ou lança { status, message }.
async function authenticate(req) {
  if (cfg.INSECURE_NO_AUTH) return { tier: 'user', key: 'test:' + (req.headers['x-test-principal'] || 'anon') };
  const h = String(req.headers['authorization'] || '');
  if (h) {
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) throw { status: 401, message: 'cabeçalho Authorization inválido' };
    try { const u = await verifyFirebaseToken(m[1]); return { tier: 'user', key: 'u:' + u.uid }; }
    catch (e) { throw { status: 401, message: 'sessão inválida ou expirada; entre de novo no Tato (' + e.message + ')' }; }
  }
  if (!cfg.ALLOW_GUESTS) throw { status: 401, message: 'faça login para usar o Node.js' };
  return { tier: 'guest', key: 'g:' + clientIp(req) };
}

module.exports = { authenticate, verifyFirebaseToken, clientIp };
