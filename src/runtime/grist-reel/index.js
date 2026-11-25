/**
 * Mode « Grist réel » (`gwaudit … --grist-reel`) : le widget est joué par un vrai Grist (Grist Desktop,
 * lancé tout seul dans un profil jetable) et un vrai Chromium, au lieu du faux hôte de la V1.
 *
 * Périmètre : cette machine, cette instance jetable, ce widget. Rien ne vise un autre serveur.
 * Tout ce qui est installé, lancé ou créé ici est défait à la fin (`finally`).
 *
 * Déroulé : 1) installer Grist Desktop si besoin (installateur.js) ; 2) lancer l'instance isolée
 * (instance.js) ; 3) y créer un document de test et une section « Custom » qui charge le widget
 * (donnees.js) ; 4) jouer le widget à « none », puis au niveau qu'il demande (navigateur.js) ;
 * 5) tirer les constats (essais.js).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demarrerServeur } from '../serveur.js';
import { resoudreBibliotheques, alterer } from './bibliotheques.js';
import { assurerGristDesktop, EPINGLE, InstallationImpossible } from './installateur.js';
import { lancerInstance, InstanceImpossible } from './instance.js';
import { creerClient } from './client.js';
import { construireJeu, creerDocument, creerDocumentVoisin, creerSectionCustom, reglerSection, proposerCorrespondance, HOTE_PUITS, HOTE_CANAUX } from './donnees.js';
import { lancerChromium, jouerPhase } from './navigateur.js';
import { evaluerEssais, constatIndisponible, ESSAIS_JOUES, ESSAIS_PAS_ENCORE } from './essais.js';
import { bacASableChromium, resumerCauseErreur } from '../dynamique.js';

const NIVEAUX = new Set(['read table', 'full']);

/** Ce que le widget a déclaré demander, ramené à un niveau jouable ; `null` si le widget ne veut aucun accès aux données. */
export function choisirNiveau(configure) {
  const demande = configure?.requiredAccess;
  if (demande === 'none') return { niveau: null, parDefaut: false };
  if (NIVEAUX.has(demande)) return { niveau: demande, parDefaut: false };
  // Aucune déclaration : un widget qui veut des données doit au moins lire sa table ; c'est le niveau usuel qu'une personne lui accorde.
  return { niveau: 'read table', parDefaut: true };
}

/**
 * @param {object} ctx  contexte construit par construireContexte()
 * @param {{scenario?: object, journal?: (ligne: string) => void}} [options]
 * @returns {Promise<{constats: Array, resume: object, nonExecute?: boolean}>}
 */
export async function auditGristReel(ctx, options = {}) {
  const journal = options.journal ?? (() => {});
  const resume = { execute: false, produit: 'Grist Desktop', version: EPINGLE.version, plateforme: `${process.platform}-${process.arch}`, date: new Date().toISOString(), sansBacASable: !bacASableChromium() };
  const nonExecute = (cause) => ({ constats: [constatIndisponible(cause)], resume: { ...resume, cause: String(cause).slice(0, 500) }, nonExecute: true });

  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return nonExecute("le paquet optionnel `playwright` n'est pas installé (`npm install`)"); }
  const entree = ctx.entrees[0];
  if (!entree) return nonExecute("aucun point d'entrée HTML trouvé dans le dépôt");

  let instance; let serveur; let navigateur; let dossierVide;
  try {
    journal('  Installation de Grist Desktop si besoin…');
    const desktop = await assurerGristDesktop({ journal });
    resume.version = desktop.version; resume.source = desktop.source;

    dossierVide = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-reel-'));
    serveur = await demarrerServeur({ widgetRacine: ctx.racine, harnaisRacine: dossierVide });
    instance = await lancerInstance(desktop.executable, { journal });
    const client = creerClient(instance.base);
    await client.ouvrirSession();
    const connus = await client.documentsConnus();
    if (connus.length) throw new Error(`Isolation refusée : l'instance contient déjà ${connus.length} document(s) qu'elle n'a pas créé(s) pour cet audit. Rien n'est joué.`);

    const jeu = construireJeu(options.scenario);
    const doc = await creerDocument(client, jeu);
    const section = await creerSectionCustom(client, doc);
    const voisin = await creerDocumentVoisin(client, jeu).catch(() => null);
    const urlWidget = `${serveur.origine}/widget/${entree}`;
    navigateur = await lancerChromium(chromium);
    // Les bibliothèques que le widget déclare (esm.sh, CDN…) sont téléchargées par l'outil et servies au navigateur, qui reste coupé d'Internet.
    let bibliotheques = null;
    try { bibliotheques = await (options.resoudreBibliotheques ?? resoudreBibliotheques)(ctx, { journal }); }
    catch (e) { journal(`  Bibliothèques du widget : non téléchargées (${resumerCauseErreur(e)}).`); }
    resume.bibliotheques = bibliotheques?.resume ?? null;
    const commun = { navigateur, base: instance.base, cookies: client.cookiesNavigateur(), chemin: section.chemin, origineWidget: serveur.origine, jeu, servies: bibliotheques?.servies,
      // Le kit de la dépendance piégée (kit.js) : joué dans le cadre du widget, à chaque phase ; ce qui compte est la phase du niveau que le widget demande.
      kit: { appat: jeu.appat.id, table: jeu.table.id, prefixe: jeu.prefixe, autreDoc: voisin?.docId ?? null, canariAutre: voisin?.canari ?? null, puits: `https://${HOTE_PUITS}/webhook` } };

    journal('  Phase 1 : le widget chargé dans Grist au niveau « none »…');
    await reglerSection(client, doc, section, { url: urlWidget, access: 'none' });
    const obsNone = await jouerPhase(commun);

    const phases = { none: obsNone, demande: null };
    if (obsNone.charge) {
      const { niveau, parDefaut } = choisirNiveau(obsNone.configure);
      resume.niveauParDefaut = parDefaut;
      if (niveau) {
        const mapping = proposerCorrespondance(obsNone.configure?.columns, doc, jeu);
        resume.correspondanceColonnes = mapping ? Object.keys(mapping) : null;
        journal(`  Phase 2 : le widget au niveau « ${niveau} »${parDefaut ? ' (niveau usuel, le widget n\'en déclare pas)' : ' (celui qu\'il demande)'}…`);
        await reglerSection(client, doc, section, { url: urlWidget, access: niveau, columnsMapping: mapping ?? undefined });
        phases.demande = { niveau, obs: await jouerPhase(commun) };
      }
    }

    // Essai d'altération (essai 21) : les mêmes bibliothèques, modifiées, servies à la même adresse que ce que le widget déclare.
    if (obsNone.charge && bibliotheques?.resume.declarees) {
      const fichiers = bibliotheques.resume.chargees;
      if (fichiers.length) {
        const niveau = phases.demande?.niveau ?? 'none';
        journal(`  Phase 3 : les bibliothèques du widget, modifiées à la source, au niveau « ${niveau} »…`);
        const { servies: alterees, marqueurs } = alterer(bibliotheques.servies);
        phases.alteration = { niveau, marqueurs, fichiers, obs: await jouerPhase({ ...commun, kit: undefined, servies: alterees, lireMarqueurs: true }) };
      } else phases.alteration = { indisponible: "aucune des bibliothèques déclarées par le widget n'a pu être téléchargée (voir la liste des bibliothèques du rapport)" };
    }

    // Essai 22 : par quelles voies du navigateur du code étranger dans le widget pourrait envoyer ce qu'il a lu ? Passe à part, au niveau que le widget demande.
    if (obsNone.charge) {
      const niveau = phases.demande?.niveau ?? 'none';
      journal(`  Phase ${phases.alteration ? 4 : 3} : les voies de sortie ouvertes à du code piégé dans le widget, au niveau « ${niveau} »…`);
      phases.canaux = { niveau, obs: await jouerPhase({ ...commun, kit: undefined, canaux: { hote: HOTE_CANAUX, prefixe: jeu.prefixe } }) };
    }

    const { essais, constats } = evaluerEssais(phases, jeu);
    Object.assign(resume, {
      execute: true, niveauDemande: phases.demande?.niveau ?? null, essais, essaisJoues: ESSAIS_JOUES, essaisPasEncore: ESSAIS_PAS_ENCORE,
      colonnesRenommees: jeu.colonnesRenommees,
      phases: [['none', phases.none], ...(phases.demande ? [[phases.demande.niveau, phases.demande.obs]] : [])].map(([niveau, o]) => ({
        niveau, charge: o.charge, appelsRpc: o.appelsRpc.length, appelsRefuses: o.appelsRpc.filter((a) => a.issue === 'refuse').length,
        donneesArrivees: o.canariRecu, requetesExternes: o.requetesExternes.length, bibliothequesServies: o.bibliothequesServies, bibliothequesManquantes: o.dependancesNonResolues.length, erreur: o.erreur,
      })),
    });
    return { constats, resume };
  } catch (e) {
    return nonExecute(e instanceof InstallationImpossible || e instanceof InstanceImpossible || e?.message?.startsWith?.('Isolation refusée') ? e.message : resumerCauseErreur(e));
  } finally {
    await navigateur?.close().catch(() => {});
    await instance?.arreter().catch(() => {});
    await serveur?.fermer().catch(() => {});
    if (dossierVide) fs.rmSync(dossierVide, { recursive: true, force: true });
  }
}
