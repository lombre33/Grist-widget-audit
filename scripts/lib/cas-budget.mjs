/**
 * Le processus d'un cas de budget (scripts/lib/budgets.mjs) : `node cas-budget.mjs <fichier> <indice>`.
 * Charge le fichier (non mesuré), lance `executer` du cas et ne mesure que lui, puis dit `{ "dureeMs": … }` sur sa sortie
 * standard. Un cas dont une partie de `executer` n'est pas ce qui est mesuré (le temps d'un démarrage, avant ce qu'il
 * chronomètre) rend lui-même `{ dureeMs }` : c'est alors cette durée qui compte. Un cas qui lève dit `{ "erreur": … }` et sort en 1 : le budget d'un résultat faux ne prouve rien.
 */
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [fichier, indice] = process.argv.slice(2);
try {
  const cas = (await import(pathToFileURL(fichier).href)).cas[Number(indice)];
  if (!cas) throw new Error(`${fichier} n'a pas de cas ${indice}`);
  const debut = performance.now();
  const rendu = await cas.executer();
  const mesure = performance.now() - debut;
  console.log(JSON.stringify({ dureeMs: Number.isFinite(rendu?.dureeMs) ? rendu.dureeMs : mesure }));
} catch (e) {
  console.log(JSON.stringify({ erreur: String(e?.message ?? e).split('\n')[0].slice(0, 500) }));
  process.exit(1);
}
