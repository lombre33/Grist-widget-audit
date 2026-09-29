// Vérifie qu'un rapport JSON produit par gwaudit dans le conteneur V2 est
// complet, et surtout que l'axe D (navigateur) a réellement tourné : sans
// lui, un conteneur qui ne sait pas démarrer Chromium rendrait quand même
// un verdict, mais amputé du quart de la note. Ne juge PAS le score : il
// bouge avec le référentiel, ce n'est pas l'objet de cette vérification.
import fs from 'node:fs';

// --axe-d-libre : ne pas exiger que l'axe D ait tourné (widget qui empêche
// lui-même la mesure, par exemple en bloquant la page : l'objet du contrôle
// est alors que le rapport existe et dise ce qu'il n'a pas pu mesurer).
const axeDLibre = process.argv.includes('--axe-d-libre');
const chemin = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!chemin) {
  console.error('usage : verifier-rapport.mjs [--axe-d-libre] <rapport.json>');
  process.exit(2);
}

const rapport = JSON.parse(fs.readFileSync(chemin, 'utf8'));
const problemes = [];

if (typeof rapport.verdict !== 'string') problemes.push('aucun verdict dans le rapport');
if (!Array.isArray(rapport.axesNonExecutes)) problemes.push('axesNonExecutes absent du rapport');
else if (!axeDLibre && rapport.axesNonExecutes.length) problemes.push(`axes non exécutés : ${JSON.stringify(rapport.axesNonExecutes)}`);
if (!axeDLibre && Array.isArray(rapport.axesPartiels) && rapport.axesPartiels.length) problemes.push(`axes partiels : ${JSON.stringify(rapport.axesPartiels)}`);
if (!axeDLibre && rapport.axes?.D?.nonExecute !== false) problemes.push("l'axe D n'a pas tourné (Chromium indisponible dans le conteneur ?)");

const resume = `verdict=${rapport.verdict} score=${rapport.scoreGlobal} bloquants=${rapport.bloquants?.length ?? '?'} commit=${rapport.commit ?? 'aucun'}`;
if (problemes.length) {
  console.error(`RAPPORT INCOMPLET (${resume})`);
  for (const p of problemes) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(axeDLibre
  ? `rapport complet (${resume}, axes non exécutés : ${JSON.stringify(rapport.axesNonExecutes)})`
  : `rapport complet, axe D exécuté (${resume})`);
