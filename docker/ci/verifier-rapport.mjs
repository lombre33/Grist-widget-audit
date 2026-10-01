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
// --interruption <genre> : l'analyse du code s'est interrompue (mémoire, délai, noyau) : le rapport de repli doit
// porter C-SURFACE-03 (cause « interruption », du genre donné), critique et bloquant, les axes A B C E F notés 0 et dits
// empêchés, le verdict NON CONFORME. --etape <étape> : l'étape dite par le constat (inventaire, regles).
// --sans-interruption : l'analyse a abouti, aucun axe n'est dit empêché, l'axe D a tourné.
// --profondeur : le code est imbriqué plus profondément que la pile ne le porte (le piège de la pile pleine, 20 000 « x=>{ »). Depuis b3d12ba la lecture
// rattrape ce dépassement sans expression régulière et V8 n'abandonne plus : l'analyse n'est PAS interrompue, le rapport porte C-SURFACE-03 de cause
// « profondeur », critique et bloquant, jamais de cause « interruption », et le verdict est NON CONFORME.
const interruption = process.argv.includes('--interruption') ? process.argv[process.argv.indexOf('--interruption') + 1] : null;
const etapeAttendue = process.argv.includes('--etape') ? process.argv[process.argv.indexOf('--etape') + 1] : null;
const sansInterruption = process.argv.includes('--sans-interruption');
const profondeur = process.argv.includes('--profondeur');
const valeursDesOptions = new Set([interruption, etapeAttendue].filter(Boolean));
const chemin = process.argv.slice(2).find((a) => !a.startsWith('--') && !valeursDesOptions.has(a));
if (!chemin) {
  console.error('usage : verifier-rapport.mjs [--axe-d-libre | --axe-d-bloque | --interruption <genre> [--etape <étape>] | --sans-interruption | --profondeur] <rapport.json>');
  process.exit(2);
}

const rapport = JSON.parse(fs.readFileSync(chemin, 'utf8'));
const problemes = [];

const CONSTAT_INTERRUPTION = (rapport) => Object.values(rapport.axes ?? {}).flatMap((a) => a.constats ?? []).filter((c) => c.regle === 'C-SURFACE-03' && c.preuve?.cause === 'interruption');

if (interruption) {
  const constats = CONSTAT_INTERRUPTION(rapport);
  if (constats.length !== 1) problemes.push(`${constats.length} constat(s) C-SURFACE-03 d'interruption au lieu d'un seul`);
  else {
    const c = constats[0];
    if (c.preuve.genre !== interruption) problemes.push(`genre de l'interruption « ${c.preuve.genre} » au lieu de « ${interruption} »`);
    if (etapeAttendue && c.preuve.etape !== etapeAttendue) problemes.push(`étape « ${c.preuve.etape} » au lieu de « ${etapeAttendue} »`);
    if (!c.bloquant || c.severite !== 'critique') problemes.push('le constat de repli n\'est pas un critique bloquant');
    if (JSON.stringify(c.axesEmpeches) !== JSON.stringify(['A', 'B', 'C', 'E', 'F'])) problemes.push(`axes empêchés ${JSON.stringify(c.axesEmpeches)} au lieu de A B C E F`);
    if (typeof c.preuve.message !== 'string' || !c.preuve.message) problemes.push('la preuve ne dit pas la raison');
  }
  for (const axe of ['A', 'B', 'C', 'E', 'F']) {
    if (rapport.axes?.[axe]?.score !== 0 || rapport.axes?.[axe]?.empeche !== true) problemes.push(`l'axe ${axe} n'est pas noté 0 et dit empêché`);
  }
  if (rapport.verdict !== 'NON CONFORME') problemes.push(`verdict ${rapport.verdict} au lieu de NON CONFORME`);
  if (problemes.length) {
    console.error('RAPPORT DE REPLI INCORRECT');
    for (const p of problemes) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`rapport de repli conforme : interruption « ${interruption} » (${constats[0].preuve.etape ?? 'étape inconnue'}), critique bloquant, axes A B C E F à 0, verdict ${rapport.verdict}`);
  process.exit(0);
}

if (profondeur) {
  const constats = Object.values(rapport.axes ?? {}).flatMap((a) => a.constats ?? []).filter((c) => c.regle === 'C-SURFACE-03');
  if (constats.length !== 1) problemes.push(`${constats.length} constat(s) C-SURFACE-03 au lieu d'un seul`);
  else {
    const c = constats[0];
    if (c.preuve?.cause !== 'profondeur') problemes.push(`cause « ${c.preuve?.cause} » au lieu de « profondeur » : ${c.preuve?.cause === 'interruption' ? "l'analyse s'est interrompue (V8 a abandonné, ou la limite de l'enfant a joué)" : 'ce n\'est pas la pile qui déborde'}`);
    if (!c.bloquant || c.severite !== 'critique') problemes.push('le constat n\'est pas un critique bloquant');
  }
  if (CONSTAT_INTERRUPTION(rapport).length) problemes.push('l\'analyse du code est dite interrompue : le rapport de repli ne doit plus servir ici');
  if (rapport.verdict !== 'NON CONFORME') problemes.push(`verdict ${rapport.verdict} au lieu de NON CONFORME`);
  if (problemes.length) {
    console.error('RAPPORT DE LA PILE PLEINE INCORRECT');
    for (const p of problemes) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`rapport conforme : pile pleine dite par C-SURFACE-03 (cause « profondeur », critique bloquant), analyse non interrompue, verdict ${rapport.verdict}`);
  process.exit(0);
}

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

if (sansInterruption) {
  if (CONSTAT_INTERRUPTION(rapport).length) problemes.push('l\'analyse du code est dite interrompue : elle devait aboutir');
  for (const axe of ['A', 'B', 'C', 'E', 'F']) if (rapport.axes?.[axe]?.empeche) problemes.push(`l'axe ${axe} est dit empêché`);
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
