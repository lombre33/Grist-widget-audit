// Vérifie qu'un rapport JSON produit par gwaudit dans le conteneur V2 est
// complet, et surtout que l'axe D (navigateur) a réellement tourné : sans
// lui, un conteneur qui ne sait pas démarrer Chromium rendrait quand même
// un verdict, mais amputé du quart de la note. Ne juge PAS le score : il
// bouge avec le référentiel, ce n'est pas l'objet de cette vérification.
import fs from 'node:fs';

const chemin = process.argv[2];
if (!chemin) {
  console.error('usage : verifier-rapport.mjs <rapport.json>');
  process.exit(2);
}

const rapport = JSON.parse(fs.readFileSync(chemin, 'utf8'));
const problemes = [];

if (typeof rapport.verdict !== 'string') problemes.push('aucun verdict dans le rapport');
if (!Array.isArray(rapport.axesNonExecutes)) problemes.push('axesNonExecutes absent du rapport');
else if (rapport.axesNonExecutes.length) problemes.push(`axes non exécutés : ${JSON.stringify(rapport.axesNonExecutes)}`);
if (rapport.axes?.D?.nonExecute !== false) problemes.push("l'axe D n'a pas tourné (Chromium indisponible dans le conteneur ?)");

const resume = `verdict=${rapport.verdict} score=${rapport.scoreGlobal} bloquants=${rapport.bloquants?.length ?? '?'} commit=${rapport.commit ?? 'aucun'}`;
if (problemes.length) {
  console.error(`RAPPORT INCOMPLET (${resume})`);
  for (const p of problemes) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`rapport complet, axe D exécuté (${resume})`);
