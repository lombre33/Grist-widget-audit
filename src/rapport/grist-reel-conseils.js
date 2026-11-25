/**
 * Pour chaque essai de la section « Grist réel », en langage de tous les jours : le widget a-t-il fait quelque chose de mal ? que faire ?
 *
 * La grille (la même pour tous les essais, voir `classeEssai`) :
 *  - `faille`      : une faute du widget a été constatée. Elle s'affiche « Pas bien », même quand une autre règle la compte déjà (essais 21, 22) ou qu'elle ne
 *                    coûte aucun point (essai 5) : « sans pénalité » dit seulement qu'elle n'est pas comptée deux fois ;
 *  - `rayon`       : une exposition due au niveau d'accès ou au navigateur, sans faute du widget (essais 8, 9, 10, 17, 18) ; libellé neutre « Exposé » ;
 *  - `grist`       : un comportement de Grist ou de sa configuration, pas du widget (essais 7, 14, 19, 20) ; libellé neutre « Côté Grist » ;
 *  - `a_verifier`  : un comportement du widget qui n'est pas forcément une faute (essai 24) ;
 *  - `bloque`, `rien`, `non_teste`, `sans_objet` : les autres résultats.
 */

/** La classe d'un essai dans la grille ci-dessus. */
export function classeEssai(e) {
  if (e.resultat === 'non_teste') return 'non_teste';
  if (e.resultat === 'sans_objet') return 'sans_objet';
  if (e.resultat === 'bloque') return 'bloque';
  if (e.resultat !== 'reussi') return 'rien';
  if (e.severite !== 'info') return 'faille';
  if (e.nature === 'confirmation' || e.nature === 'faiblesse') return 'faille';
  if (e.nature === 'rayon') return 'rayon';
  if (e.nature === 'comportement') return 'a_verifier';
  return 'grist';
}

const FIGER = "Figer chaque bibliothèque (version exacte et empreinte `integrity`, avec `crossorigin=\"anonymous\"`) ou, mieux, les embarquer dans le dépôt du widget (bundle local avec esbuild ou Vite) plutôt que les charger depuis esm.sh ou un CDN.";
const MOINS_D_ACCES = (e) => (e.niveau === 'full' ? ["Demander « read table » plutôt que « full » si le widget ne fait que lire le document."] : []);
const NOMBRE_DE_DEPENDANCES = "Limiter le nombre de dépendances : chacune est un code étranger de plus qui s'exécute avec les droits du widget.";

/** Réponse à « le widget a-t-il fait quelque chose de mal ? » et actions, par essai et par classe. Une fonction reçoit l'essai. */
const PAR_ESSAI = {
  1: { faille: {
    mal: "Oui : le widget exécute comme du code un texte qui vient d'une cellule du document.",
    faire: ["Afficher les valeurs avec `textContent` (jamais `innerHTML`) ; si du HTML est voulu, le nettoyer avec une bibliothèque dédiée (DOMPurify).", "Poser une politique de sécurité (CSP) stricte dans la page du widget.", "Ne demander que le niveau d'accès nécessaire (« read table » si le widget ne fait que lire)."] } },
  2: { faille: {
    mal: "Oui, un peu : avec des valeurs limites dans la table, le widget lève des erreurs non rattrapées ou se fige.",
    faire: ["Tester `null`, le texte vide et les types inattendus (liste, erreur) avant de s'en servir.", "Entourer le décodage et l'analyse (`decodeURIComponent`, `JSON.parse`, dates) de `try/catch`.", "Limiter ce qui est affiché d'une cellule très longue et afficher les grandes tables par morceaux."] } },
  3: { faille: {
    mal: "Oui : en lisant des cellules piégées, le widget modifie les objets de base de JavaScript (pollution de prototype).",
    faire: ["Ne pas fusionner ni copier des données du document dans un objet (`Object.assign`, fusion récursive, affectation par chemin `a.b.c`) sans écarter les clés `__proto__`, `constructor` et `prototype`.", "Ranger les données dont les clés viennent du document dans une `Map` ou un `Object.create(null)`.", "Mettre à jour la bibliothèque de fusion ou de chemin si c'est elle qui est en cause."] } },
  4: { faille: {
    mal: "Oui : le widget obéit à des messages `postMessage` sans vérifier qui les envoie.",
    faire: ["Dans l'écouteur `message`, vérifier `event.source` (la fenêtre parente) et `event.origin` avant tout.", "Ne jamais insérer un champ de message dans la page en HTML, ni s'en servir comme adresse à appeler.", "Ignorer les messages qui n'ont pas exactement la forme attendue."] } },
  5: { faille: {
    mal: "Oui, un peu : le widget règle sa conduite sur ce que dit son adresse (`access`, `readonly`) plutôt que sur ce que Grist lui accorde. Il n'obtient pas plus d'accès pour autant : Grist fixe le niveau réel.",
    faire: ["Ne pas lire `access` ni `readonly` dans l'adresse du widget.", "Demander son niveau avec `grist.ready({ requiredAccess })` et se fier aux refus de Grist."] } },
  6: { faille: {
    mal: "Oui, un peu : quand le document change beaucoup et vite, le widget lève de nouvelles erreurs non rattrapées ou se fige.",
    faire: ["Rendre le traitement d'une mise à jour rapide et réentrant (ne pas empiler d'écouteurs ni de minuteries à chaque mise à jour).", "Regrouper les mises à jour fréquentes (anti-rebond) et rattraper les erreurs de chaque rappel."] } },
  7: { grist: {
    mal: "Non, ce n'est pas le widget : Grist a transmis des données alors que le niveau était « none ».",
    faire: ["Rien à changer dans le widget.", "Signaler le point à l'éditeur de Grist."] } },
  8: { rayon: {
    mal: (e) => `Non, le widget n'a rien fait de mal. Mais avec le niveau « ${e.niveau} », toute bibliothèque qu'il charge pourrait lire bien plus que sa table : tout le document.`,
    faire: (e) => [...MOINS_D_ACCES(e), `Sinon, ${FIGER[0].toLowerCase()}${FIGER.slice(1)}`, NOMBRE_DE_DEPENDANCES] } },
  9: { rayon: {
    mal: (e) => `Non, le widget n'a rien fait de mal. Mais avec le niveau « ${e.niveau} », du code étranger dans le widget obtiendrait un jeton d'accès et pourrait appeler directement l'API du document.`,
    faire: (e) => [...MOINS_D_ACCES(e), `Sinon, ${FIGER[0].toLowerCase()}${FIGER.slice(1)}`, NOMBRE_DE_DEPENDANCES] },
    grist: {
    mal: "Non, ce n'est pas le widget : Grist a laissé un jeton d'accès ouvrir un autre document.",
    faire: ["Rien à changer dans le widget.", "Signaler le point à l'éditeur de Grist."] } },
  10: { rayon: {
    mal: (e) => `Non, le widget n'a rien fait de mal. Mais avec le niveau « ${e.niveau} », du code étranger dans le widget pourrait modifier ou détruire le document.`,
    faire: (e) => [...MOINS_D_ACCES(e), `Sinon, ${FIGER[0].toLowerCase()}${FIGER.slice(1)}`, "Garder des sauvegardes du document : elles seules permettent de revenir en arrière."] } },
  12: { faille: {
    mal: "Pas le widget lui-même, mais le niveau qu'il demande : du code étranger dans le widget a pu créer une sortie permanente de données, qui resterait après le retrait du widget.",
    faire: ["Demander « read table » plutôt que « full » si le widget ne fait que lire.", "Vérifier les webhooks du document (paramètres du document, onglet Webhooks) et supprimer ceux qu'on ne reconnaît pas.", FIGER] } },
  13: { faille: {
    mal: "Oui : des données du document sortent du widget vers un site extérieur.",
    faire: ["Repérer l'appel dans le détail (adresse et valeur) puis le supprimer, ou le remplacer par un traitement local.", "Si l'envoi est voulu (service externe), le dire dans la documentation du widget et à ses utilisateurs, et n'envoyer que le nécessaire.", "Voir la section « Dépendances et appels externes » en bas du rapport."] },
    rien: {
    mal: (e) => (e.sorties > 0 ? "Non : aucune valeur du document n'est sortie en clair. Mais le widget a tenté des appels vers l'extérieur." : "Non : le widget n'a contacté aucun site extérieur pendant l'essai."),
    faire: (e) => (e.sorties > 0 ? ["Examiner ces appels comme des dépendances (section « Dépendances et appels externes » en bas du rapport) : qui les reçoit, et que contiennent-ils ?"] : ["Rien à faire pour cet essai."]) } },
  14: { grist: {
    mal: "Non, ce n'est pas le widget : Grist sert une pièce jointe HTML comme une page de sa propre origine, ce qui permettrait de faire agir du code avec les droits de la personne qui l'ouvre.",
    faire: ["Sur l'instance où le widget sera installé, servir les pièces jointes en téléchargement (`Content-Disposition: attachment`) ou depuis une autre origine, avec `Content-Security-Policy: sandbox`.", "Signaler le point à l'éditeur de Grist."] } },
  15: { faille: {
    mal: "Oui : le widget peut rediriger la page Grist qui l'héberge (de quoi afficher une fausse page de connexion).",
    faire: ["Supprimer `window.top.location`, `target=\"_top\"` et les formulaires vers `_top`.", "Ouvrir les liens dans un nouvel onglet avec `target=\"_blank\" rel=\"noopener noreferrer\"`."] } },
  16: { faille: {
    mal: "Oui : le widget ouvre des fenêtres, des boîtes de dialogue ou des téléchargements sans qu'on le lui demande.",
    faire: ["Ne rien ouvrir tant que la personne n'a pas cliqué.", "Remplacer `alert`, `confirm` et `prompt` par des éléments de la page."] } },
  17: { rayon: {
    mal: "Non, le widget n'a rien fait de mal : Grist donne le droit d'écrire dans le presse-papier à tous les widgets. Mais du code étranger dans le widget pourrait remplacer ce que la personne a copié (une commande à coller dans un terminal, par exemple).",
    faire: ["Rien à changer dans le widget lui-même.", FIGER] } },
  18: { rayon: {
    mal: "Non, le widget n'a rien fait de mal : ce sont les droits que Grist laisse au cadre du widget sur cette instance. Du code étranger dans le widget pourrait s'en servir pour les demander à la personne.",
    faire: ["Rien à changer dans le widget lui-même.", "Signaler à l'éditeur de Grist les droits qui ne devraient pas être donnés."] } },
  19: { grist: {
    mal: "Non, ce n'est pas le widget : c'est la page Grist qui n'envoie pas tous ses en-têtes de sécurité.",
    faire: ["Sur l'instance où le widget sera installé, vérifier ces en-têtes (outils du navigateur, onglet Réseau) et les poser au niveau du reverse proxy : `Content-Security-Policy` avec `frame-ancestors`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`.", "Sinon, le signaler à l'éditeur de Grist."] } },
  20: { grist: {
    mal: "Non, ce n'est pas le widget : Grist (ou son déploiement) laisse le code du widget lire le document avec la session de la personne, quel que soit le niveau d'accès accordé.",
    faire: ["Rien à changer dans le widget.", "Signaler le point à l'éditeur de Grist et vérifier la configuration de l'instance (CORS, cookies de session)."] } },
  21: { faille: {
    mal: (e) => (e.severite === 'critique'
      ? "Oui : le widget déclare une empreinte (`integrity`) pour protéger ses bibliothèques, mais le navigateur exécute quand même le fichier modifié : l'empreinte ne protège pas."
      : "Oui : le widget charge ses bibliothèques sans rien vérifier de ce que le CDN sert. Un CDN compromis, ou une version publiée de travers, ferait exécuter n'importe quel code dans le widget, avec son niveau d'accès."),
    faire: (e) => (e.severite === 'critique'
      ? ["Vérifier que l'attribut `integrity` est bien posé sur la balise qui charge le fichier, avec une empreinte valide (sha384 ou sha256) et `crossorigin=\"anonymous\"`.", "Ou, mieux, embarquer la bibliothèque dans le dépôt du widget (bundle local avec esbuild ou Vite)."]
      : ["Embarquer les bibliothèques dans le dépôt du widget (bundle local avec esbuild ou Vite) plutôt que les charger depuis esm.sh ou un CDN.", "À défaut, figer chacune : version exacte et empreinte `integrity` (avec `crossorigin=\"anonymous\"`).", ...MOINS_D_ACCES(e)]) } },
  22: { faille: {
    mal: "Oui, par omission : la page du widget n'a pas de politique de sécurité (CSP) qui ferme les voies d'envoi. Le widget n'a rien envoyé, mais du code piégé dans une de ses bibliothèques pourrait envoyer ce qu'il lit.",
    faire: ["Poser dans la page du widget une CSP stricte (`default-src 'none'`, puis n'autoriser que le nécessaire : `script-src 'self'`, `connect-src 'self'`, `img-src 'self' data:`), à adapter à ce que le widget charge vraiment.", "Une CSP posée seulement par un en-tête HTTP de l'hébergement n'est pas vue par l'audit : la mettre aussi dans la page.", FIGER] } },
  23: { faille: {
    mal: "Oui, un peu : le widget garde des données du document dans le navigateur, où elles restent après la fermeture du document.",
    faire: ["Ne pas ranger de données du document dans `localStorage`, `sessionStorage`, `IndexedDB` ni cookies : les relire depuis Grist à chaque ouverture.", "Si un cache est indispensable : ne garder que le strict nécessaire, le purger à la fermeture, et jamais de données personnelles (RGPD)."] } },
  24: { a_verifier: {
    mal: "À vérifier : le widget modifie le document dès son chargement, sans action de la personne. C'est parfois voulu (initialiser une colonne), parfois une erreur ou une boucle.",
    faire: ["N'écrire que sur une action de la personne (clic, saisie).", "Si une initialisation est nécessaire, la documenter et la faire une seule fois, en vérifiant d'abord que la donnée n'existe pas déjà."] } },
};

const GENERIQUE = {
  bloque: { mal: "Non : Grist ou le navigateur a arrêté la tentative, le garde-fou a fonctionné.", faire: ["Rien à faire pour cet essai."] },
  rien: { mal: "Non : l'essai n'a rien révélé d'anormal (cela ne prouve pas que le widget est sûr, seulement que cet essai-là n'a rien trouvé).", faire: ["Rien à faire pour cet essai."] },
  non_teste: { mal: "On ne sait pas : l'essai n'a pas pu être joué. Ce n'est pas un échec du widget.", faire: ["Lire la raison dans « Observé », la corriger si elle vient du widget ou de sa configuration, puis relancer l'audit.", "Refaire l'essai à la main dans un Grist de test si le point préoccupe."] },
  sans_objet: { mal: "Sans objet : cet essai ne s'applique pas à ce widget (raison dans « Observé »). Ce n'est ni une réussite ni un échec.", faire: ["Rien à faire."] },
  grist: { mal: "Non, ce n'est pas le widget : c'est un comportement de Grist ou de la configuration de l'instance.", faire: ["Rien à changer dans le widget.", "Signaler le point à l'éditeur de Grist, ou le régler sur l'instance où le widget sera installé."] },
  rayon: { mal: "Non, le widget n'a rien fait de mal : c'est une exposition due au niveau d'accès.", faire: ["Ne demander que le niveau d'accès nécessaire.", FIGER] },
  faille: { mal: "Oui : un défaut du widget a été constaté (voir « Observé »).", faire: ["Voir la remédiation du constat correspondant dans le rapport."] },
  a_verifier: { mal: "À vérifier : le widget a un comportement qui n'est pas forcément une faute (voir « Observé »).", faire: ["Vérifier que ce comportement est voulu."] },
};

const resoudre = (v, e) => (typeof v === 'function' ? v(e) : v);

/**
 * @param {object} e  un essai (voir essais.js)
 * @returns {{classe: string, mal: string, faire: string[]}}
 */
export function conseilEssai(e) {
  const classe = classeEssai(e);
  const c = PAR_ESSAI[e.id]?.[classe] ?? GENERIQUE[classe];
  return { classe, mal: String(resoudre(c.mal, e)), faire: resoudre(c.faire, e).filter(Boolean).map(String) };
}
