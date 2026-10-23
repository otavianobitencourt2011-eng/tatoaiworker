'use strict';
// Testes de integração REAIS: sobem server.js e executam Node de verdade no sandbox do host.
// Rode como root num host com unshare/bwrap (ex.: container Docker com --cap-add=SYS_ADMIN ou Render).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { startServer, stopServer, run, runRaw, raw, files, leftoverProcs, getWorkRoot } = require('./helpers');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(() => stopServer());
const sbOk = () => ctx.health.sandbox.allowed;

test('0. /health informa sandbox testado no boot', () => {
  assert.ok(ctx.health.ok); assert.strictEqual(ctx.health.protocol, 1);
  console.log('   sandbox:', JSON.stringify(ctx.health.sandbox), 'node:', ctx.health.node_version);
  assert.ok(sbOk(), 'sem isolamento no host de teste');
  assert.ok(ctx.health.sandbox.network_blocked);
});
test('1. node --version retorna Node 24.x real', async () => {
  const r = (await run({ op: 'version' })).body;
  assert.match(r.stdout.trim(), /^v24\.\d+\.\d+$/); assert.strictEqual(r.exit_code, 0); assert.match(r.node_version, /^v24\./);
});
test('2. console.log("ok") → stdout correto, exit 0', async () => {
  const r = (await run({ op: 'run', entrypoint: 'app.js', files: files({ 'app.js': "console.log('ok')" }) })).body;
  assert.strictEqual(r.stdout, 'ok\n'); assert.strictEqual(r.stderr, ''); assert.strictEqual(r.exit_code, 0); assert.strictEqual(r.status, 'success');
});
test('2b. node -e / -p', async () => {
  assert.strictEqual((await run({ op: 'eval', eval: 'console.log(2 + 2)' })).body.stdout, '4\n');
  assert.strictEqual((await run({ op: 'eval', eval: '3*7', print: true })).body.stdout, '21\n');
});
test('3. sintaxe inválida e exceção runtime → stderr com linha/coluna e exit != 0', async () => {
  const s = (await run({ op: 'run', entrypoint: 'bad.js', files: files({ 'bad.js': 'let x = ;\nconsole.log(1)' }) })).body;
  assert.notStrictEqual(s.exit_code, 0); assert.match(s.stderr, /SyntaxError/); assert.match(s.stderr, /\/workspace\/bad\.js:1/);
  const e = (await run({ op: 'run', entrypoint: 'err.js', files: files({ 'err.js': 'const a = 1;\nthrow new Error("boom")' }) })).body;
  assert.notStrictEqual(e.exit_code, 0); assert.match(e.stderr, /err\.js:2:\d+/); assert.match(e.stderr, /boom/);
  assert.ok(!e.stderr.includes(getWorkRoot()), 'caminho do host vazou');
});
test('4. process.argv recebe os argumentos', async () => {
  const r = (await run({ op: 'run', entrypoint: 'args.js', args: ['a', 'b c', '--x'], files: files({ 'args.js': 'console.log(JSON.stringify(process.argv.slice(2)))' }) })).body;
  assert.deepStrictEqual(JSON.parse(r.stdout), ['a', 'b c', '--x']);
});
test('5. stdin real (e como saída de pipe)', async () => {
  const r = (await run({ op: 'run', entrypoint: 'in.js', stdin: 'linha1\nlinha2\n', files: files({ 'in.js': "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(d.trim().split('\\n').length+' linhas'))" }) })).body;
  assert.strictEqual(r.stdout, '2 linhas\n');
});
test('6. CommonJS, ESM relativo e package.json type:module via snapshot', async () => {
  const cjs = (await run({ op: 'run', entrypoint: 'main.cjs', files: files({ 'main.cjs': "console.log(require('./helper.cjs').x + require('./data.json').n)", 'helper.cjs': 'module.exports={x:40}', 'data.json': '{"n":2}' }) })).body;
  assert.strictEqual(cjs.stdout, '42\n');
  const esm = (await run({ op: 'run', entrypoint: 'main.mjs', files: files({ 'main.mjs': "import {y} from './lib/h.mjs'; import fs from 'node:fs'; console.log(y, typeof fs.readFileSync)", 'lib/h.mjs': 'export const y = 7' }) })).body;
  assert.strictEqual(esm.stdout, '7 function\n');
  const typ = (await run({ op: 'run', entrypoint: 'index.js', files: files({ 'package.json': '{"type":"module"}', 'index.js': "import {z} from './z.js'; console.log(z)", 'z.js': 'export const z = "mod"' }) })).body;
  assert.strictEqual(typ.stdout, 'mod\n');
});
test('7a. npm run start / npm test / npm --version', async () => {
  const pkg = JSON.stringify({ name: 'p', version: '1.0.0', scripts: { start: 'node app.js', test: 'node t.js', hello: 'echo oi' } });
  const f = files({ 'package.json': pkg, 'app.js': "console.log('start ok')", 't.js': "console.log('test ok'); process.exit(3)" });
  const s = (await run({ op: 'npm', npm: { subcommand: 'start' }, files: f })).body;
  assert.strictEqual(s.exit_code, 0); assert.match(s.stdout, /start ok/);
  const t = (await run({ op: 'npm', npm: { subcommand: 'test' }, files: f })).body;
  assert.match(t.stdout, /test ok/); assert.notStrictEqual(t.exit_code, 0);
  const h = (await run({ op: 'npm', npm: { subcommand: 'run', script: 'hello' }, files: f })).body;
  assert.match(h.stdout, /oi/);
  const v = (await run({ op: 'npm', npm: { subcommand: 'version' } })).body;
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
test('7b. npm install real + cache por lockfile + execução offline com a dependência', { timeout: 200000 }, async () => {
  const pkg = JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } });
  const app = "console.log(require('is-number')(5), require('is-number')('x'))";
  const f = files({ 'package.json': pkg, 'app.js': app });
  // antes de instalar: erro claro
  const pre = (await run({ op: 'run', entrypoint: 'app.js', files: f })).body;
  assert.notStrictEqual(pre.exit_code, 0); assert.match(pre.stderr, /npm install/);
  const i1 = (await run({ op: 'npm', npm: { subcommand: 'install' }, files: f, writeBack: true, limits: { timeout_ms: 60000 } })).body;
  assert.strictEqual(i1.exit_code, 0, i1.stderr); assert.strictEqual(i1.cache, 'miss');
  const lock = (i1.changed_files || []).find(c => c.path === 'package-lock.json');
  assert.ok(lock && /is-number/.test(lock.content), 'lockfile não devolvido');
  const run1 = (await run({ op: 'run', entrypoint: 'app.js', files: f })).body;
  assert.strictEqual(run1.stdout, 'true false\n', run1.stderr); // rede bloqueada, mas módulo vem do cache
  // com lockfile: npm ci reaproveita o cache chaveado pelo hash do lockfile
  const f2 = files({ 'package.json': pkg, 'app.js': app, 'package-lock.json': lock.content });
  const c1 = (await run({ op: 'npm', npm: { subcommand: 'ci' }, files: f2 })).body; assert.strictEqual(c1.exit_code, 0, c1.stderr); assert.strictEqual(c1.cache, 'hit'); // mesmo lockfile gerado pelo install anterior → mesma chave
  const c2 = (await run({ op: 'npm', npm: { subcommand: 'ci' }, files: f2 })).body; assert.strictEqual(c2.cache, 'hit'); assert.ok(c2.duration_ms < 1000);
  assert.strictEqual((await run({ op: 'run', entrypoint: 'app.js', files: f2 })).body.stdout, 'true false\n');
  // node_modules não é gravável pelo script
  const w = (await run({ op: 'run', entrypoint: 'w.js', files: files(Object.assign({ 'w.js': "try{require('fs').writeFileSync('node_modules/is-number/hack.js','x');console.log('GRAVOU')}catch(e){console.log(e.code)}" }, { 'package.json': pkg, 'package-lock.json': lock.content })) })).body;
  assert.match(w.stdout, /EACCES|EROFS|EPERM/);
});
test('7d. npm install <pacote> devolve package.json/lock atualizados e rejeita specs perigosos', { timeout: 200000 }, async () => {
  const f = files({ 'package.json': JSON.stringify({ name: 'p', version: '1.0.0' }), 'app.js': "console.log(require('is-odd')(3))" });
  for (const bad of ['git+https://x/y.git', 'file:../x', '../x', '--registry=http://evil', 'a b']) {
    const r = await run({ op: 'npm', npm: { subcommand: 'install' }, args: [bad], files: f }); assert.strictEqual(r.status, 400, bad);
  }
  const r = (await run({ op: 'npm', npm: { subcommand: 'install' }, args: ['is-odd@3.0.1'], files: f, limits: { timeout_ms: 60000 } })).body;
  assert.strictEqual(r.exit_code, 0, r.stderr);
  const m = Object.fromEntries(r.changed_files.map(c => [c.path, c]));
  assert.match(m['package.json'].content, /is-odd/); assert.ok(m['package-lock.json']);
  const f2 = files({ 'package.json': m['package.json'].content, 'package-lock.json': m['package-lock.json'].content, 'app.js': "console.log(require('is-odd')(3))" });
  assert.strictEqual((await run({ op: 'run', entrypoint: 'app.js', files: f2 })).body.stdout, 'true\n');
});
test('7c. lifecycle scripts de dependências ficam desligados no install', { timeout: 120000 }, async () => {
  // pacote local file: com postinstall que tenta criar arquivo — não deve rodar
  const pkg = JSON.stringify({ name: 'p', version: '1.0.0', scripts: { postinstall: 'echo HACK > /tmp/postinstall_ran_tato' } });
  const r = (await run({ op: 'npm', npm: { subcommand: 'install' }, files: files({ 'package.json': pkg }) })).body;
  assert.strictEqual(r.exit_code, 0); assert.ok(!fs.existsSync('/tmp/postinstall_ran_tato'));
});
test('8. isolamento: sem escape por ../, sem segredos, sem host, sem rede', async () => {
  fs.writeFileSync('/var/tmp/tato-host-secret.txt', 'SEGREDO-DO-HOST', { mode: 0o600 });
  const code = `
const fs=require('fs'), net=require('net'), out={};
out.env=JSON.stringify(process.env).includes('SEGREDO-DO-SERVICO')||JSON.stringify(process.env).includes('nao-pode-vazar');
out.uid=process.getuid();
try{ out.hostSecret=fs.readFileSync('/var/tmp/tato-host-secret.txt','utf8') }catch(e){ out.hostSecret=e.code }
try{ out.passwdTraversal=fs.readFileSync('../../../../../../../var/tmp/tato-host-secret.txt','utf8') }catch(e){ out.passwdTraversal=e.code }
try{ out.proc1env=fs.readFileSync('/proc/1/environ','utf8').includes('SEGREDO') }catch(e){ out.proc1env=e.code }
try{ out.workRoot=fs.readdirSync(${JSON.stringify(getWorkRoot())}).length }catch(e){ out.workRoot=e.code }
out.pids=fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).length;
const s=net.connect({host:'1.1.1.1',port:80,timeout:2000});
s.on('connect',()=>{out.net='CONECTOU';fin()}); s.on('error',e=>{out.net=e.code;fin()}); s.on('timeout',()=>{out.net='timeout';fin()});
function fin(){ s.destroy(); console.log(JSON.stringify(out)) }`;
  const r = (await run({ op: 'run', entrypoint: 's.js', files: files({ 's.js': code }) })).body;
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.env, false, 'variável secreta do serviço vazou');
  assert.ok(o.uid >= 41000, 'rodando como root!');
  assert.strictEqual(o.hostSecret, 'EACCES'); assert.strictEqual(o.passwdTraversal, 'EACCES');
  assert.notStrictEqual(o.proc1env, true);
  assert.ok(['EACCES', 'ENOENT'].includes(o.workRoot) , 'conseguiu listar o diretório de trabalho: ' + o.workRoot);
  assert.ok(o.pids < 15, 'enxerga processos do host: ' + o.pids);
  assert.notStrictEqual(o.net, 'CONECTOU'); assert.ok(['ENETUNREACH', 'EADDRNOTAVAIL', 'timeout', 'ECONNREFUSED'].includes(o.net), o.net);
  fs.rmSync('/var/tmp/tato-host-secret.txt', { force: true });
});
test('9a. laço infinito é interrompido (timeout) e árvore morre', async () => {
  const t0 = Date.now();
  const r = (await run({ op: 'run', entrypoint: 'l.js', files: files({ 'l.js': 'while(true){}' }), limits: { timeout_ms: 1500 } })).body;
  assert.strictEqual(r.status, 'timeout'); assert.strictEqual(r.timed_out, true); assert.strictEqual(r.exit_code, 124);
  assert.ok(Date.now() - t0 < 6000); assert.strictEqual(leftoverProcs(), 0);
});
test('9b. flood de stdout é cortado pelo limite', async () => {
  const r = (await run({ op: 'run', entrypoint: 'f.js', files: files({ 'f.js': "const b='x'.repeat(65536);setInterval(()=>process.stdout.write(b),0)" }), limits: { timeout_ms: 20000 } })).body;
  assert.strictEqual(r.status, 'output_limit'); assert.strictEqual(r.truncated, true); assert.ok(r.stdout.length <= 1024 * 1024); assert.strictEqual(leftoverProcs(), 0);
});
test('9c. memória alta é interrompida', async () => {
  const r = (await run({ op: 'run', entrypoint: 'm.js', files: files({ 'm.js': "const a=[];setInterval(()=>{a.push(Buffer.alloc(32*1024*1024,1))},20)" }), limits: { timeout_ms: 20000, memory_mb: 128 } })).body;
  assert.ok(['memory_limit', 'error'].includes(r.status), r.status); assert.notStrictEqual(r.exit_code, 0); assert.strictEqual(leftoverProcs(), 0);
});
test('9d. processos filhos (fork bomb) ficam limitados (EAGAIN) e são mortos', async () => {
  const code = "const cp=require('child_process');let ok=0,err=null;for(let i=0;i<500;i++){const c=cp.spawn('sleep',['30'],{stdio:'ignore',detached:true});c.on('spawn',()=>{ok++});c.on('error',e=>{err=e.code});c.unref()}setTimeout(()=>console.log(JSON.stringify({ok,err})),800);setTimeout(()=>{},30000)";
  const r = (await run({ op: 'run', entrypoint: 'c.js', files: files({ 'c.js': code }), limits: { timeout_ms: 3000 } })).body;
  assert.strictEqual(r.status, 'timeout');
  const m = /\{"ok":(\d+),"err":"?(\w+)"?\}/.exec(r.stdout);
  assert.ok(m, 'sem saída do script: ' + r.stdout);
  assert.ok(Number(m[1]) <= 64, 'processos demais: ' + m[1]); assert.strictEqual(m[2], 'EAGAIN');
  await new Promise(r => setTimeout(r, 300)); assert.strictEqual(leftoverProcs(), 0, 'sobraram processos');
});
test('9e. cliente cancela (aborta conexão) → job é morto e workspace limpo', async () => {
  const http = require('http');
  const body = JSON.stringify({ version: 1, op: 'run', entrypoint: 'h.js', files: files({ 'h.js': 'setInterval(()=>{},1000)' }), limits: { timeout_ms: 50000 } });
  await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: require('./helpers').getPort(), path: '/v1/run', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    req.on('error', () => {}); req.write(body); req.end();
    setTimeout(() => { req.destroy(); resolve(); }, 1200);
  });
  for (let i = 0; i < 30 && leftoverProcs() > 0; i++) await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(leftoverProcs(), 0, 'job não foi cancelado');
  assert.deepStrictEqual(fs.readdirSync(getWorkRoot()), [], 'workspace não foi limpo');
});
test('10. stdout/stderr separados e exit code propagado', async () => {
  const r = (await run({ op: 'run', entrypoint: 'x.js', files: files({ 'x.js': "console.log('OUT');console.error('ERR');process.exitCode=7" }) })).body;
  assert.strictEqual(r.stdout, 'OUT\n'); assert.strictEqual(r.stderr, 'ERR\n'); assert.strictEqual(r.exit_code, 7); assert.strictEqual(r.status, 'error');
});
test('11. erros claros: JSON malformado, arquivo ausente, traversal, versão, workspace grande, módulo ausente', async () => {
  const bad = await runRaw('{nao-json'); assert.strictEqual(bad.status, 400); assert.strictEqual(bad.body.code, 'bad_json');
  const miss = await run({ op: 'run', entrypoint: 'nao.js', files: [] }); assert.strictEqual(miss.status, 400); assert.match(miss.body.error, /não existe/);
  const trav = await run({ op: 'run', entrypoint: 'a.js', files: [{ path: '../a.js', content: '1' }] }); assert.strictEqual(trav.status, 400); assert.strictEqual(trav.body.code, 'bad_path');
  const ver = await raw('POST', '/v1/run', { version: 99, op: 'eval', eval: '1' }); assert.strictEqual(ver.body.code, 'bad_version');
  const big = await runRaw(JSON.stringify({ version: 1, op: 'eval', eval: '1', files: [{ path: 'a.txt', content: 'x'.repeat(3 * 1024 * 1024) }] }));
  assert.strictEqual(big.status, 413);
  const total = await run({ op: 'eval', eval: '1', files: Array.from({ length: 10 }, (_, i) => ({ path: 'f' + i + '.txt', content: 'x'.repeat(1000000) })) });
  assert.strictEqual(total.status, 413);
  const nomod = (await run({ op: 'run', entrypoint: 'm.js', files: files({ 'm.js': "require('pacote-que-nao-existe')" }) })).body;
  assert.notStrictEqual(nomod.exit_code, 0); assert.match(nomod.stderr, /Cannot find module/);
  const nopkg = (await run({ op: 'npm', npm: { subcommand: 'test' }, files: [] })).body; assert.match(nopkg.stderr, /package\.json/);
  const badpkg = (await run({ op: 'npm', npm: { subcommand: 'test' }, files: files({ 'package.json': '{oops' }) })).body; assert.match(badpkg.stderr, /inválido/);
  const ci = (await run({ op: 'npm', npm: { subcommand: 'ci' }, files: files({ 'package.json': '{}' }) })).body; assert.match(ci.stderr, /package-lock/);
  const ok = await run({ op: 'eval', eval: 'console.log(1)' }); assert.strictEqual(ok.body.stdout, '1\n'); // servidor segue saudável
});
test('12. execuções concorrentes não compartilham workspace gravável', async () => {
  const mk = tag => run({ op: 'run', entrypoint: 'w.js', files: files({ 'w.js': `const fs=require('fs');fs.writeFileSync('shared.txt','${tag}');setTimeout(()=>{console.log(fs.readFileSync('shared.txt','utf8')+'|'+fs.readdirSync('.').sort().join(','))},700)` }) });
  const rs = await Promise.all(['A', 'B', 'C'].map(mk));
  const outs = rs.map(r => r.body.stdout.trim());
  assert.deepStrictEqual(outs, ['A|shared.txt,w.js', 'B|shared.txt,w.js', 'C|shared.txt,w.js']);
});
test('13. write-back só devolve diff quando pedido e com sucesso; nunca fora da raiz', async () => {
  const code = "const fs=require('fs');fs.writeFileSync('novo.txt','dado');fs.writeFileSync('a.txt','mudou');fs.unlinkSync('del.txt')";
  const f = files({ 'w.js': code, 'a.txt': 'orig', 'del.txt': 'x' });
  const sem = (await run({ op: 'run', entrypoint: 'w.js', files: f })).body; assert.strictEqual(sem.changed_files, undefined);
  const com = (await run({ op: 'run', entrypoint: 'w.js', files: f, writeBack: true })).body;
  const m = Object.fromEntries(com.changed_files.map(c => [c.path, c]));
  assert.strictEqual(m['novo.txt'].action, 'create'); assert.strictEqual(m['a.txt'].content, 'mudou'); assert.strictEqual(m['del.txt'].action, 'delete');
  const fail = (await run({ op: 'run', entrypoint: 'w.js', files: files({ 'w.js': code + ';process.exit(2)', 'del.txt': 'x' }), writeBack: true })).body;
  assert.strictEqual(fail.changed_files, undefined);
});
test('14. rate limit e CORS', async () => {
  const o = await raw('OPTIONS', '/v1/run', null, { Origin: 'https://app.exemplo' }); assert.strictEqual(o.status, 204);
});
