// Résume ce que `mesurer-pics.sh` a relevé dans son dossier de sortie : une ligne, ou le code 3 quand le parent est mort avant d'écrire ses pics.
// Usage : node resumer-pics.cjs <dossier> <code de sortie du conteneur> <secondes> <--memory>
'use strict';
const fs = require('node:fs');
const [, , dossier, code, secondes, memoire] = process.argv;
let p;
try {
  p = JSON.parse(fs.readFileSync(`${dossier}/pics.json`, 'utf8'));
} catch {
  console.log(`code ${code} : aucun pics.json (le parent est mort avant d'écrire, ou le conteneur n'a pas démarré) : ${dossier}`);
  process.exit(3);
}
const pic = (motif) => p.processus.filter((x) => motif.test(x.cmd)).map((x) => x.hwmMo)[0] ?? '?';
let issue = '?';
try {
  const r = JSON.parse(fs.readFileSync(`${dossier}/rapport.json`, 'utf8'));
  issue = JSON.stringify(r).includes('"cause":"interruption"') ? 'REPLI (interruption)' : "analysé jusqu'au bout";
} catch { /* pas de rapport : l'issue reste « ? », dite telle quelle */ }
console.log(`code ${code}, ${secondes} s, --memory ${memoire} : groupe de contrôle ${p.cgroupMo ?? '?'} Mo, enfant ${pic(/enfant-travail/)} Mo, parent ${pic(/gwaudit\.js/)} Mo, refus de mémoire ${p.echecsDeLimite ?? '?'} ; ${issue} ; détail : ${dossier}`);
