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
// --axe-d-bloque : le widget audité empêche lui-même la mesure (page qui ne
// finit jamais de charger). Le rapport doit alors porter D-TIMEOUT-01, bloquant,
// l'axe D exécuté mais partiel, et un verdict NON CONFORME — jamais « axe non
// exécuté », qui ferait mieux noter le widget qui bloque que celui qui laisse
// mesurer.
const axeDBloque = process.argv.includes('--axe-d-bloque');
const chemin = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!chemin) {
  console.error('usage : verifier-rapport.mjs [--axe-d-libre] <rapport.json>');
  process.exit(2);
}

const rapport = JSON.parse(fs.readFileSync(chemin, 'utf8'));
const problemes = [];

if (axeDBloque) {
  const timeout = (rapport.axes?.D?.constats ?? []).find((c) => c.regle === 'D-TIMEOUT-01');
  if (!timeout) problemes.push('aucun D-TIMEOUT-01 : le blocage du widget n\'est pas dit');
  else if (!timeout.bloquant) problemes.push('D-TIMEOUT-01 n\'est pas bloquant : bloquer la mesure ne doit pas rapporter plus que la laisser tourner');
  if (rapport.axes?.D?.nonExecute !== false) problemes.push("l'axe D est « non exécuté » : le blocage doit être rapporté comme un constat de l'axe, pas comme une panne");
  if (!rapport.axesPartiels?.includes('D')) problemes.push("l'axe D n'est pas signalé partiel");
  if (rapport.verdict !== 'NON CONFORME') problemes.push(`verdict ${rapport.verdict} au lieu de NON CONFORME`);
  if (typeof rapport.scoreGlobal !== 'number') problemes.push('aucun score global');
  if (problemes.length) {
    console.error('RAPPORT DU WIDGET BLOQUANT INCORRECT');
    for (const p of problemes) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`rapport conforme : blocage dit par D-TIMEOUT-01 (bloquant), axe D partiel, verdict ${rapport.verdict}, score ${rapport.scoreGlobal}`);
  process.exit(0);
}

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
