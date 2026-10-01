// Fabrique, dans <dossier>, le fichier le plus coûteux que Règles a chronométré pour l'inventaire et l'analyse (le « point 4 » du
// message de e42a8a6 : des accents graves à la suite, linéaire à constante haute) : une page et un `app.js` de <octets> accents
// graves. Sert à mesurer ce que ce fichier coûte dans l'image et hors de l'image (docs/ARCHITECTURE-V2.md, « Hors de l'image »).
//
// Usage : node docker/ci/fabriquer-widget-accents-graves.mjs <dossier> <octets> [--coupe | --temoin]
//   (rien)   <octets> accents graves à la suite : 819200 (800 Kio), 1677722 (1,6 Mio), 3355443 (3,2 Mio) et 16777216 (le plafond
//            de 16 Mio par fichier) sont les tailles mesurées.
//   --coupe  la même longueur, coupée en deux moitiés égales par un « ; » (deux chaînes au lieu d'une) : 1 677 721 octets pour 1677722.
//   --temoin un appel réseau au cœur du fichier, entre deux « ; » (`fetch("https://temoin-coeur.invalid/c")`) : ce que l'audit dit
//            d'un fichier qu'il ne lit pas en entier quand ce qu'il cherche en occupe le milieu.
import fs from 'node:fs';
import path from 'node:path';

const USAGE = 'usage : fabriquer-widget-accents-graves.mjs <dossier> <octets> [--coupe | --temoin]';
const TEMOIN = 'fetch("https://temoin-coeur.invalid/c")';

const arguments_ = process.argv.slice(2);
const options = arguments_.filter((a) => a.startsWith('--'));
const [dossier, octets] = arguments_.filter((a) => !a.startsWith('--'));
const n = Number(octets);
if (!dossier || !Number.isInteger(n) || n < 1 || options.length > 1 || options.some((o) => o !== '--coupe' && o !== '--temoin')) {
  console.error(USAGE);
  process.exit(2);
}

/** Le nombre d'accents graves de chaque moitié : la longueur demandée moins ce qui s'y ajoute, arrondie au multiple de 4 inférieur. */
const moitie = (ajoute) => {
  const total = n - ajoute;
  return (total - (total % 4)) / 2;
};
// Le nombre d'accents graves de chaque moitié, pour les deux formes coupées (1 accent grave au moins de chaque côté).
const m = options[0] === '--coupe' ? moitie(1) : options[0] === '--temoin' ? moitie(TEMOIN.length + 2) : 0;
if (options.length === 1 && m < 1) {
  console.error(`${USAGE}\n<octets> est trop petit pour cette forme`);
  process.exit(2);
}
let contenu;
if (options[0] === '--coupe') {
  contenu = '`'.repeat(m) + ';' + '`'.repeat(m);
} else if (options[0] === '--temoin') {
  contenu = '`'.repeat(m) + ';' + TEMOIN + ';' + '`'.repeat(m);
} else {
  contenu = '`'.repeat(n);
}
fs.mkdirSync(dossier, { recursive: true });
fs.writeFileSync(path.join(dossier, 'index.html'), '<!doctype html><html lang="fr"><title>t</title><script src="app.js"></script>');
fs.writeFileSync(path.join(dossier, 'app.js'), contenu);
console.log(`${dossier} : app.js de ${fs.statSync(path.join(dossier, 'app.js')).size} octets`);
