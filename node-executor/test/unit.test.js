'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { validateRequest, safePath } = require('../lib/validate');
const { verifyFirebaseToken } = require('../lib/auth');
const U = { tier: 'user' }, G = { tier: 'guest' };

test('safePath bloqueia traversal, absoluto, reservados e barra invertida', () => {
  for (const bad of ['../x.js', 'a/../../x.js', '/etc/passwd', 'C:/x.js', 'a\\b.js', 'node_modules/x.js', '', 'a\0b.js']) assert.throws(() => safePath(bad), undefined, bad);
  assert.strictEqual(safePath('./src//a.js'), 'src/a.js');
});
test('validateRequest descarta metadados internos do Tato', () => {
  const r = validateRequest({ version: 1, op: 'run', entrypoint: 'a.js', files: [
    { path: 'a.js', content: '1' }, { path: '.tato_bug_history.json', content: '{}' }, { path: '.tato_file_signatures.json', content: '{}' },
    { path: '.tato_runtime_profile.json', content: '{}' }, { path: '.tato_notes_internas.md', content: 'x' }] }, U);
  assert.deepStrictEqual(r.files.map(f => f.path), ['a.js']);
});
test('validateRequest: versão, op, tamanhos, duplicados e entrypoint', () => {
  assert.throws(() => validateRequest({ version: 2, op: 'run' }, U), /versão/);
  assert.throws(() => validateRequest({ version: 1, op: 'rm' }, U), /operação/);
  assert.throws(() => validateRequest({ version: 1, op: 'run', entrypoint: 'a.js', files: [] }, U), /não existe/);
  assert.throws(() => validateRequest({ version: 1, op: 'run', entrypoint: 'a.txt', files: [{ path: 'a.txt', content: '' }] }, U), /entrypoint/);
  assert.throws(() => validateRequest({ version: 1, op: 'run', entrypoint: 'a.js', files: [{ path: 'a.js', content: 'x'.repeat(1048577) }] }, U), /1 MiB/);
  assert.throws(() => validateRequest({ version: 1, op: 'run', entrypoint: 'a.js', files: [{ path: 'a.js', content: '' }, { path: 'A.js', content: '' }] }, U), /duplicado/);
  assert.throws(() => validateRequest({ version: 1, op: 'eval', eval: 'x', stdin: 'y'.repeat(100001) }, U), /stdin/);
  assert.throws(() => validateRequest({ version: 1, op: 'npm', npm: { subcommand: 'publish' } }, U), /subcomando/);
  assert.throws(() => validateRequest({ version: 1, op: 'npm', npm: { subcommand: 'run', script: 'a; rm -rf /' } }, U), /script/);
});
test('visitante não usa npm e recebe tetos menores', () => {
  assert.throws(() => validateRequest({ version: 1, op: 'npm', npm: { subcommand: 'install' } }, G), /visitantes/);
  const r = validateRequest({ version: 1, op: 'eval', eval: '1', limits: { timeout_ms: 600000, memory_mb: 9999 } }, G);
  assert.ok(r.limits.timeout_ms <= 10000 && r.limits.memory_mb <= 128);
  const u = validateRequest({ version: 1, op: 'eval', eval: '1', limits: { timeout_ms: 600000, memory_mb: 9999 } }, U);
  assert.ok(u.limits.timeout_ms <= 60000 && u.limits.memory_mb <= 512);
});

// --- verificação de Firebase ID token com chave/cert de teste ---
function mkCert() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fbt-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', d + '/k.pem', '-out', d + '/c.pem', '-subj', '/CN=t', '-days', '2'], { stdio: 'ignore' });
  return { key: fs.readFileSync(d + '/k.pem', 'utf8'), cert: fs.readFileSync(d + '/c.pem', 'utf8') };
}
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mkToken(key, over, hdr) {
  const now = Math.floor(Date.now() / 1000);
  const h = Object.assign({ alg: 'RS256', kid: 'k1', typ: 'JWT' }, hdr || {});
  const p = Object.assign({ aud: 'tatoiapro', iss: 'https://securetoken.google.com/tatoiapro', sub: 'user123', iat: now - 10, exp: now + 3600 }, over || {});
  const s = b64u(JSON.stringify(h)) + '.' + b64u(JSON.stringify(p));
  return s + '.' + b64u(crypto.createSign('RSA-SHA256').update(s).sign(key));
}
test('Firebase token: válido passa; expirado, aud/iss errados, assinatura e alg inválidos falham', async () => {
  const { key, cert } = mkCert(); const other = mkCert();
  const opts = { certs: { k1: cert }, projectId: 'tatoiapro' };
  assert.strictEqual((await verifyFirebaseToken(mkToken(key), opts)).uid, 'user123');
  await assert.rejects(verifyFirebaseToken(mkToken(key, { exp: Math.floor(Date.now() / 1000) - 5 }), opts), /expirado/);
  await assert.rejects(verifyFirebaseToken(mkToken(key, { aud: 'outro' }), opts), /audience/);
  await assert.rejects(verifyFirebaseToken(mkToken(key, { iss: 'https://x' }), opts), /issuer/);
  await assert.rejects(verifyFirebaseToken(mkToken(other.key), opts), /assinatura/);
  await assert.rejects(verifyFirebaseToken(mkToken(key, {}, { alg: 'none' }), opts), /algoritmo/);
  await assert.rejects(verifyFirebaseToken('abc', opts), /malformado/);
});
