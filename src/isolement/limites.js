/**
 * Les limites de l'analyse isolée (voir enfant.js) : mémoire du tas, pile du fil de
 * travail, durée. Une variable d'environnement les fixe, sinon la mémoire suit celle du
 * conteneur, sinon (poste de travail : V1) Node décide et il n'y a pas de limite de temps.
 *
 *   GWAUDIT_MEMOIRE_ANALYSE_MO   tas de l'enfant, en Mio (entier ≥ 64)
 *   GWAUDIT_PILE_ANALYSE_MO      pile du fil de travail, en Mio (entier ≥ 1)
 *   GWAUDIT_DELAI_ANALYSE_S      durée de l'analyse, en secondes (entier ≥ 1)
 */
import fs from 'node:fs';

/**
 * Ce que le tas de l'enfant laisse dans la mémoire du conteneur : le processus parent (qui
 * écrit le repli, joue l'axe D et les rapports), ce que l'enfant occupe hors tas (jeune
 * génération, code, contenu des fichiers lus), et une marge. Mesuré sur `chart` (6,1 Mio de
 * code) : la résidente de l'enfant dépasse son tas plafonné de 60 à 100 Mo, et le parent tient
 * en 70 Mo. Voir docs/ARCHITECTURE-V2.md pour les valeurs retenues et leur mesure.
 */
export const RESERVE_HORS_TAS_MO = 210;
export const TAS_MINIMUM_MO = 128;

/** La limite de mémoire du groupe de contrôle dont ce processus fait partie, en Mio ; null s'il n'y en a pas (ou si elle est celle de la machine). */
export function limiteMemoireDuConteneurMo(lire = (chemin) => fs.readFileSync(chemin, 'utf8')) {
  for (const chemin of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    let brut;
    try { brut = String(lire(chemin)).trim(); } catch { continue; }
    if (!/^\d+$/.test(brut)) continue; // « max » : pas de limite
    const octets = Number(brut);
    if (octets > 0 && octets < 2 ** 40) return Math.floor(octets / 1048576); // au-delà de 1 Tio, c'est « illimité » à la façon cgroup v1
  }
  return null;
}

function entier(env, nom, minimum, avertir) {
  const brut = env[nom];
  if (brut === undefined || brut === '') return null;
  if (/^\d+$/.test(brut) && Number(brut) >= minimum) return Number(brut);
  avertir(`⚠ ${nom}=${JSON.stringify(brut)} ignorée : un entier d'au moins ${minimum} est attendu.`);
  return null;
}

/**
 * @returns {{limiteMo: ?number, pileMo: ?number, delaiMs: ?number}}
 */
export function limitesDeLAnalyse({ env = process.env, memoireConteneurMo = limiteMemoireDuConteneurMo(), avertir = (m) => console.error(m) } = {}) {
  let limiteMo = entier(env, 'GWAUDIT_MEMOIRE_ANALYSE_MO', 64, avertir);
  if (limiteMo === null && memoireConteneurMo !== null) limiteMo = Math.max(TAS_MINIMUM_MO, memoireConteneurMo - RESERVE_HORS_TAS_MO);
  const pileMo = entier(env, 'GWAUDIT_PILE_ANALYSE_MO', 1, avertir);
  const delaiS = entier(env, 'GWAUDIT_DELAI_ANALYSE_S', 1, avertir);
  return { limiteMo, pileMo, delaiMs: delaiS === null ? null : delaiS * 1000 };
}
