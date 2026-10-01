// Chargé par `node -r` dans le conteneur de `mesurer-pics.sh` : échantillonne toutes les 200 ms la mémoire résidente de chaque processus
// du conteneur (le pic de chacun, VmHWM lu tant qu'il vit) et, à la sortie du parent, le pic du groupe de contrôle. Rien ici ne juge :
// c'est une mesure, écrite dans /out/pics.json (`GWAUDIT_PICS_SORTIE` change le dossier : les essais n'ont pas de /out). Le pic du groupe de contrôle est celui qui se compare à `mem_limit` (les pics par
// processus s'additionnent mal : les pages partagées, le binaire de Node, sont comptées dans chacun).
'use strict';
const fs = require('node:fs');
const SORTIE = process.env.GWAUDIT_PICS_SORTIE || '/out';
const CGROUPE = process.env.GWAUDIT_PICS_CGROUPE || '/sys/fs/cgroup';   // les essais y posent de faux fichiers : le vrai dépend de l'hôte
const pics = new Map();
const lire = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
function echantillon() {
  let pids;
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return; }
  for (const pid of pids) {
    const st = lire(`/proc/${pid}/status`);
    if (!st) continue;
    const hwm = Number(/VmHWM:\s+(\d+)/.exec(st)?.[1] ?? 0) / 1024;
    const cmd = (lire(`/proc/${pid}/cmdline`) ?? '').split('\0').join(' ').slice(0, 110);
    const ancien = pics.get(pid) ?? { cmd, hwm: 0 };
    // Le maximum, et non la dernière lecture : VmHWM est déjà un pic, mais un processus qui a fini sans que son parent l'ait encore attendu (zombie)
    // n'a plus de ligne VmHWM, lue 0 ; sans le maximum, son pic disparaîtrait de la liste (vu sur l'enfant de l'analyse, dans l'image).
    ancien.hwm = Math.max(ancien.hwm, hwm);
    ancien.cmd = cmd || ancien.cmd;
    pics.set(pid, ancien);
  }
}
const debut = Date.now();
const minuteur = setInterval(echantillon, 200);
minuteur.unref();   // sans cela, l'intervalle garde le parent en vie et le conteneur ne s'arrête jamais
process.on('exit', () => {
  clearInterval(minuteur);
  echantillon();
  // cgroup v1 : memory/memory.max_usage_in_bytes et memory/memory.failcnt ; cgroup v2 : memory.peak et, dans memory.events, `max` (fois où la
  // limite a été atteinte) et `oom_kill`. Ce que l'hôte ne donne pas est dit `null`, jamais 0 : un pic absent n'est pas un pic nul.
  const octets = (lire(`${CGROUPE}/memory/memory.max_usage_in_bytes`) ?? lire(`${CGROUPE}/memory.peak`))?.trim();
  const cgroupMo = octets && Number.isFinite(Number(octets)) ? Math.round(Number(octets) / 1048576) : null;
  const echecsV1 = lire(`${CGROUPE}/memory/memory.failcnt`);
  const evenements = lire(`${CGROUPE}/memory.events`);
  const echecs = echecsV1 !== null ? echecsV1.trim()
    : evenements !== null ? `max ${/^max (\d+)/m.exec(evenements)?.[1] ?? '?'}, oom_kill ${/^oom_kill (\d+)/m.exec(evenements)?.[1] ?? '?'}` : null;
  fs.writeFileSync(`${SORTIE}/pics.json`, JSON.stringify({
    dureeS: Math.round((Date.now() - debut) / 100) / 10,
    cgroupMo,
    echecsDeLimite: echecs,
    processus: [...pics.values()].filter((p) => p.hwm > 20).map((p) => ({ cmd: p.cmd, hwmMo: Math.round(p.hwm) })),
  }, null, 1));
});
