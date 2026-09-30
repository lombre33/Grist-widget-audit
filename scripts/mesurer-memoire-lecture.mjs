/**
 * Mémoire de la lecture d'un fichier que ni le mode module ni le mode script d'acorn ne lisent (du TypeScript à la dernière ligne d'un
 * gros paquet), sous un tas plafonné : le conteneur de la V2 limite la mémoire, et c'est là qu'une lecture qui garde trop plante. Chaque essai se fait dans un processus neuf, avec son plafond de tas (`--max-old-space-size`) : il dit s'il passe, ce
 * qu'il a consommé, combien de temps il a pris.
 *
 * Deux structures de lecture : `lire` (celle de `src/moteur/analyse-js.js`, chaque lecture dans son propre appel) et `boucle` (l'ancienne,
 * copiée ici pour la comparaison : la vérification de l'erreur se fait dans le cadre qui enchaîne les deux modes). La cause exacte dans
 * V8 n'est pas établie (une chronologie avec traces de ramasse-miettes ne reproduit pas le plantage à chaque variante) : la structure
 * `lire` est celle que la mesure départage. Le résultat dépend de la version de Node et de la machine : l'essai se rejoue, il ne se
 * fige pas dans la suite.
 *
 * Usage : node scripts/mesurer-memoire-lecture.mjs [--taille=<Mio>] [--tas=<Mio>,<Mio>…] [--structure=lire|boucle|toutes]
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ICI = fileURLToPath(import.meta.url);
const RACINE = path.resolve(path.dirname(ICI), '..');
const LIGNE = 'var a = [1, 2, 3].map(function (x) { return x * 2; });\n';

/** La source : du JavaScript lisible, puis une annotation TypeScript que les deux modes refusent, à la dernière ligne. */
const source = (mio) => `${LIGNE.repeat(Math.ceil((mio * 1024 * 1024) / LIGNE.length))}let x: number = 1;\n`;

/** L'ancienne structure : les deux modes dans une boucle, l'erreur examinée dans le cadre de la boucle. */
async function boucle(texte) {
  const { parse } = await import('acorn');
  const { depassementDePile } = await import(pathToFileURL(path.join(RACINE, 'src/moteur/analyse-js.js')).href);
  let erreur = null;
  for (const sourceType of ['module', 'script']) {
    try {
      const commentaires = [];
      const ast = parse(texte, { ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true, onComment: (_b, _t, debut, fin) => commentaires.push({ debut, fin }) });
      return { ast, erreur: null };
    } catch (e) {
      erreur = { profond: depassementDePile(e), position: e?.pos };
    }
  }
  return { ast: null, erreur };
}

const args = process.argv.slice(2);
const valeur = (nom) => args.find((a) => a.startsWith(`--${nom}=`))?.slice(nom.length + 3);

if (valeur('enfant')) {
  const mio = Number(valeur('taille'));
  const texte = source(mio);
  const debut = performance.now();
  let lecture;
  if (valeur('enfant') === 'lire') {
    const { lire } = await import(pathToFileURL(path.join(RACINE, 'src/moteur/analyse-js.js')).href);
    lecture = lire(texte);
  } else {
    lecture = await boucle(texte);
  }
  process.stdout.write(JSON.stringify({ lue: Boolean(lecture.ast), ms: Math.round(performance.now() - debut), residentMo: Math.round(process.resourceUsage().maxRSS / 1024) }));
  process.exit(0);
}

const USAGE = 'Usage : node scripts/mesurer-memoire-lecture.mjs [--taille=<Mio>] [--tas=<Mio>,<Mio>…] [--structure=lire|boucle|toutes]';
const connues = ['taille', 'tas', 'structure'];
const inconnues = args.filter((a) => !connues.some((n) => a.startsWith(`--${n}=`)));
if (inconnues.length) { console.error(`Option inconnue : ${inconnues.join(' ')}\n${USAGE}`); process.exit(2); }
const taille = valeur('taille') === undefined ? 6 : Number(valeur('taille'));
const tas = (valeur('tas') ?? '640,720,768,820').split(',').map(Number);
const dite = valeur('structure') ?? 'toutes';
if (!(taille > 0) || tas.some((n) => !(n > 0)) || !['lire', 'boucle', 'toutes'].includes(dite)) { console.error(`Valeur invalide.\n${USAGE}`); process.exit(2); }
const structures = dite === 'toutes' ? ['boucle', 'lire'] : [dite];

console.log(`Node ${process.version} ; source de ${taille} Mio illisible dans les deux modes, une lecture par processus neuf`);
console.log(`${'structure'.padEnd(10)} ${'tas (Mio)'.padStart(10)}  résultat`);
for (const structure of structures) {
  for (const limite of tas) {
    const r = spawnSync(process.execPath, [`--max-old-space-size=${limite}`, ICI, `--enfant=${structure}`, `--taille=${taille}`], { encoding: 'utf8', timeout: 300_000 });
    let dit;
    if (r.signal || r.status !== 0) dit = `plantage (${r.signal ?? `code ${r.status}`})`;
    else { const m = JSON.parse(r.stdout); dit = `passe : ${m.lue ? 'lue' : 'non lue'}, ${m.residentMo} Mo résidents, ${m.ms} ms`; }
    console.log(`${structure.padEnd(10)} ${String(limite).padStart(10)}  ${dit}`);
  }
}
