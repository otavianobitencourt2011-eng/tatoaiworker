'use strict';
// Utilitários de /proc: mata a árvore inteira de um uid e mede RSS somado.
const fs = require('fs');

function pidsOfUid(uid) {
  const out = [];
  let names;
  try { names = fs.readdirSync('/proc'); } catch (_) { return out; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const st = fs.readFileSync('/proc/' + n + '/status', 'utf8');
      const m = st.match(/^Uid:\s+(\d+)/m);
      const z = /^State:\s+Z/m.test(st); // zumbi já está morto (só falta ser colhido)
      if (m && Number(m[1]) === uid && !z) {
        const rss = st.match(/^VmRSS:\s+(\d+)/m);
        out.push({ pid: Number(n), rssKb: rss ? Number(rss[1]) : 0 });
      }
    } catch (_) { /* processo sumiu */ }
  }
  return out;
}
function rssMbOfUid(uid) { return pidsOfUid(uid).reduce((s, p) => s + p.rssKb, 0) / 1024; }
function killUid(uid) {
  for (let i = 0; i < 4; i++) {
    const list = pidsOfUid(uid);
    if (!list.length) return;
    for (const p of list) { try { process.kill(p.pid, 'SIGKILL'); } catch (_) {} }
  }
}
module.exports = { pidsOfUid, rssMbOfUid, killUid };
