'use strict';
// Camada de isolamento por execução.
//  - modo "unshare": namespaces de rede+PID+mount(/proc) via util-linux, uid exclusivo por slot (setpriv),
//    rlimits (prlimit) e árvore morta por uid. Exige root com CAP_SYS_ADMIN no container.
//  - modo "bwrap": igual, mais filesystem raiz mínimo (bubblewrap) quando o host permitir.
//  - modo "none": sem namespaces (só uid + rlimits). Só roda com TATO_ALLOW_UNSANDBOXED=1 (NÃO recomendado).
// O modo é descoberto e TESTADO em tempo de execução; nada é "presumido".
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cfg = require('./config');

let detected = null;

function has(bin) { return spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).status === 0; }

function tryRun(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 8000 });
  return r.status === 0 ? (r.stdout || '') : null;
}

function bwrapArgs(job, net) {
  const a = ['bwrap', '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts'];
  if (!net) a.push('--unshare-net');
  for (const d of ['/usr', '/bin', '/lib', '/lib64', '/sbin', '/opt']) {
    if (!fs.existsSync(d)) continue;
    let st; try { st = fs.lstatSync(d); } catch (_) { continue; }
    if (st.isSymbolicLink()) a.push('--symlink', fs.readlinkSync(d), d);
    else a.push('--ro-bind', d, d);
  }
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  const nodeDir = path.dirname(fs.realpathSync(cfg.NODE_BIN));
  if (!/^\/(usr|bin|opt)(\/|$)/.test(nodeDir)) a.push('--ro-bind', path.resolve(nodeDir, '..'), path.resolve(nodeDir, '..'));
  if (net) for (const f of ['/etc/resolv.conf', '/etc/ssl', '/etc/ca-certificates', '/etc/hosts', '/etc/nsswitch.conf']) if (fs.existsSync(f)) a.push('--ro-bind', f, f);
  a.push('--bind', job.dir, job.dir, '--chdir', job.ws);
  if (job.depsDir) a.push('--ro-bind', job.depsDir, job.depsDir);
  return a;
}

// Monta o argv completo: [bin, ...args] que o servidor spawna como root.
function wrap(mode, job, inner, opts) {
  opts = opts || {};
  const net = !!opts.network;
  const uid = String(job.uid);
  const lim = [
    'prlimit',
    '--nproc=' + (opts.maxProcs || cfg.MAX_PROCS),
    '--nofile=512',
    '--fsize=' + (64 * 1024 * 1024),
    '--core=0',
    '--cpu=' + Math.ceil(((opts.timeoutMs || cfg.DEFAULT_TIMEOUT_MS) / 1000) * 1.5 + 2)
  ];
  const drop = ['setpriv', '--reuid', uid, '--regid', uid, '--clear-groups', '--no-new-privs'];
  const core = drop.concat(lim, ['--'], inner);
  if (mode === 'bwrap') return bwrapArgs(job, net).concat(['--'], core);
  if (mode === 'unshare') {
    const u = ['unshare', '--pid', '--fork', '--kill-child', '--mount-proc'];
    if (!net) u.push('--net');
    return u.concat(core);
  }
  return core; // none
}

function detect() {
  if (detected) return detected;
  const res = { mode: 'none', netBlocked: false, filesystem: 'permissões de arquivo (uid exclusivo por execução)', notes: [] };
  const forced = cfg.SANDBOX_MODE;
  const need = ['setpriv', 'prlimit'].filter(b => !has(b));
  if (need.length) { res.notes.push('faltam binários: ' + need.join(', ')); detected = res; return res; }
  if (process.getuid && process.getuid() !== 0) { res.notes.push('o serviço não está rodando como root; não é possível trocar de uid por execução'); detected = res; return res; }

  const probe = (mode) => {
    const job = { uid: cfg.UID_BASE + 900, dir: '/tmp', ws: '/tmp', depsDir: null };
    const argv = wrap(mode, job, [cfg.NODE_BIN, '-e', 'const os=require("os");console.log(process.getuid())'], { network: false, timeoutMs: 5000 });
    const out = tryRun(argv);
    return out !== null && out.trim() === String(job.uid);
  };
  if ((forced === 'auto' || forced === 'bwrap') && has('bwrap') && probe('bwrap')) { res.mode = 'bwrap'; res.netBlocked = true; res.filesystem = 'raiz mínima somente-leitura (bubblewrap) + workspace próprio'; }
  else if ((forced === 'auto' || forced === 'unshare') && has('unshare') && probe('unshare')) { res.mode = 'unshare'; res.netBlocked = true; }
  else if (forced !== 'none') res.notes.push('namespaces indisponíveis neste host (unshare/bwrap falharam no auto-teste)');
  if (res.mode === 'none' && cfg.ALLOW_UNSANDBOXED) { res.notes.push('MODO SEM NAMESPACES habilitado por TATO_ALLOW_UNSANDBOXED=1: rede NÃO é bloqueada'); res.mode = 'none'; res.allowed = true; }
  else res.allowed = res.mode !== 'none';
  detected = res;
  return res;
}

function reset() { detected = null; }
module.exports = { detect, wrap, reset };
