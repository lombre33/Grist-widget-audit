# Prompt d'audit — reproduire gwaudit avec un LLM

Ce document est un **prompt à copier-coller** dans un LLM (Fable 5.1 ou
équivalent), avec le code source du widget à auditer joint ou accessible.
Il reproduit **exactement** le référentiel, la notation et le verdict de
l'outil `gwaudit` de ce dépôt, tel qu'il existe au commit indiqué en tête de
rapport — pas une description approximative de ce que fait l'outil.

**Pourquoi ce document existe** : comparer un résultat algorithmique (rapide,
reproductible, mais mécanique) à une analyse par un LLM (plus lente, capable
de jugement contextuel, mais non déterministe). Les deux audits doivent
partir de la même grille pour que l'écart observé soit informatif — un écart
dû à des critères différents ne dirait rien d'utile.

Ne modifie pas les seuils, les poids ou les formules ci-dessous : c'est ce
qui rend la comparaison possible. Si un seuil te semble mal choisi, dis-le en
section 8 (critères additionnels), jamais en le changeant silencieusement en
section 5.

---

## 0. Ta mission

Tu es un auditeur technique et RSSI. On te donne le code source complet d'un
widget personnalisé pour Grist (une page web tierce chargée dans une iframe
d'un document Grist, avec un niveau d'accès `none` / `read table` / `full`
aux données du document). Tu dois :

1. Lire l'intégralité du code fourni (pas un échantillon).
2. Appliquer, une par une, les règles des six axes décrits en section 5 —
   même logique de déclenchement, même sévérité, mêmes conditions
   d'aggravation ou d'atténuation que celles décrites ici.
3. Pour **chaque** règle qui se déclenche, produire un constat qui contient
   les **trois éléments non négociables** de la section 4 : emplacement
   précis, explication, action corrective.
4. Calculer toi-même les pénalités, les scores d'axe et le score global avec
   les formules de la section 3 — ne te contente pas d'une impression
   qualitative, fais le calcul et montre-le.
5. Rendre un rapport dans le format de la section 7.
6. **Séparément**, et seulement après avoir fini les six axes, proposer en
   section 8 tout critère supplémentaire que tu juges pertinent et qui
   n'est couvert par aucune des règles ci-dessous (section 5). Ces critères ne
   comptent JAMAIS dans le score global reproduit : ils forment une annexe
   distincte, justement pour que l'écart entre ton score et le score
   algorithmique reste lisible.

---

## 1. Modèle de menace

Un widget Grist est une page web tierce chargée dans une iframe de la page
du document, à laquelle l'agent (l'utilisateur humain) accorde un niveau
d'accès : `none`, `read table` (lecture d'une table) ou `full` (lecture ET
écriture de tout le document via `grist.docApi`). Le risque dominant n'est
pas la compromission du widget par un tiers extérieur : **c'est le widget
lui-même**, qui dispose légitimement des données et peut les faire sortir —
volontairement, ou parce qu'une dépendance tierce (CDN, bibliothèque) a été
compromise.

D'où l'ordre de priorité implicite du référentiel : sortie de données >
privilège excessif > injection > stockage hors Grist > le reste.

L'objectif final de l'audit est de statuer sur la recevabilité du widget pour
un hébergement sur une instance Grist officielle (DINUM / ANCT), au regard du
guide de contribution Grist.Gouv, de l'ANSSI, du RGPD, du RGAA et de la
doctrine de souveraineté numérique de l'État.

---

## 2. Les six axes et leur poids

| Axe | Titre | Poids |
|---|---|---|
| A | Qualité du code | 20 |
| B | Lisibilité et maintenabilité humaine | 15 |
| C | Sécurité applicative (analyse statique, point de vue RSSI) | 25 |
| D | Sécurité en condition réelle (tests dynamiques) | 25 |
| E | Chaîne d'approvisionnement et dépendances | 10 |
| F | Conformité Grist.Gouv, souveraineté, accessibilité | 5 |

Le total des poids fait 100 : le score global est une moyenne pondérée des
six scores d'axe (voir section 3).

---

## 3. Sévérités, pénalités et calcul du score

### 3.1 Sévérités

| Sévérité | Pénalité de base (par règle déclenchée) |
|---|---|
| `critique` | 35 |
| `majeur` | 12 |
| `mineur` | 3 |
| `info` | 0 (jamais de pénalité — sert à documenter un point positif ou neutre) |

### 3.2 Effet du nombre d'occurrences

Quand une **même règle** se déclenche plusieurs fois dans le même widget (dix
`innerHTML` dynamiques dans dix fichiers différents, par exemple), ce n'est
pas dix défauts indépendants : c'est un seul défaut de conception, répété.
La pénalité de la règle est donc multipliée par un facteur qui croît en
logarithme et plafonne à 2,5 :

```
facteur(n) = min(1 + ln(n), 2.5)
```

où `n` est le nombre d'occurrences de cette règle précise. Une seule
occurrence donne un facteur de 1 (pas d'aggravation). Calcule ce facteur
toi-même pour chaque règle qui se déclenche plus d'une fois — ne compte
jamais les occurrences comme des pénalités indépendantes additionnées
linéairement.

### 3.3 Score d'un axe

Additionne la pénalité de chaque règle déclenchée sur l'axe (pénalité de base
× facteur d'occurrences) pour obtenir la **pénalité brute de l'axe**. Puis :

```
si penalite <= 92 :
    score_axe = arrondi(100 - penalite)
sinon :
    score_axe = arrondi(8 * exp(-(penalite - 92) / 40))
```

Cette seconde branche (« plancher souple ») évite qu'un widget très mauvais
et un widget catastrophique deviennent tous deux indiscernables à 0 : le
score décroît strictement, sans jamais atteindre 0 exactement, mais reste
toujours plus sévère que la branche linéaire ne l'aurait été. Ne remplace pas
cette formule par un simple `max(0, 100 - pénalité)` : ça change le
classement des cas très dégradés.

### 3.4 Score global

Moyenne des scores d'axe, **pondérée par les poids de la section 2**, en
excluant tout axe que tu n'as pas pu évaluer du tout (voir section 6 pour
l'axe D). N'attribue jamais 100 ou 0 par défaut à un axe non évalué — exclus-
le du calcul et dis-le explicitement.

### 3.5 Verdict

Dans cet ordre :

1. S'il existe au moins un constat marqué **bloquant** (voir section 4, la
   liste des règles qui le sont) → **NON CONFORME**, quel que soit le score.
   Un point bloquant n'est jamais rattrapable par un bon score ailleurs —
   c'est la logique d'un avis RSSI, pas d'une moyenne.
2. Sinon, s'il existe au moins un constat `critique` (non bloquant), ou si le
   score global est inférieur à 60 → **CONFORME SOUS RÉSERVE**.
3. Sinon, si le score global est inférieur à 80 → **CONFORME SOUS RÉSERVE**.
4. Sinon → **CONFORME**.

Si un axe n'a pas pu être évalué (ou seulement partiellement), le verdict ne
peut jamais être un simple « CONFORME » sans réserve : rétrograde-le au moins
à « CONFORME SOUS RÉSERVE » et dis dans ton motif quelle couverture manque.
Un « CONFORME » qui cache un quart de la note jamais mesurée serait
trompeur.

---

## 4. Ce que chaque constat doit contenir — non négociable

Chaque règle déclenchée produit un ou plusieurs constats. Un constat qui n'a
pas ces trois éléments n'est pas exploitable et ne doit pas être produit :

1. **Emplacement précis** : fichier et ligne (ou plage de lignes), avec si
   possible un court extrait du code concerné. Pour un constat qui porte sur
   l'ensemble du dépôt (ex. absence de tests), dis-le explicitement plutôt
   que de laisser le champ vide sans explication.
2. **Explication** : ce qui a été observé (le fait), et son impact concret —
   pourquoi c'est un problème, pour qui, dans quel scénario. Pas une
   reformulation du nom de la règle.
3. **Action corrective** : quoi faire concrètement pour corriger, assez
   précis pour qu'un contributeur puisse agir sans deviner.

Ajoute pour chacun :
- **la sévérité** (`critique` / `majeur` / `mineur` / `info`) selon les
  règles de la section 5 ;
- **si le constat est bloquant** (oui/non) ;
- **ta confiance** : `certain` (motif non ambigu dans le code lu),
  `probable` (heuristique, à confirmer par un relecteur humain), ou
  `à vérifier` (tu ne peux pas trancher depuis le code seul). Réserve
  `prouvé` aux seules règles de l'axe D où quelque chose a réellement été
  exécuté sous tes yeux (impossible pour toi en pratique — voir section 6) ;
  jamais pour ce que tu déduis d'une lecture de code, même certaine.
- **l'identifiant de la règle** (ex. `C-XSS-03`) quand ton constat
  correspond à une des règles de la section 5, pour permettre une comparaison
  ligne à ligne avec le rapport algorithmique. Un vrai problème qui ne
  correspond à aucune de ces règles va en section 8, jamais forcé dans une
  case existante qui ne lui correspond pas.

---

## 5. Référentiel détaillé, axe par axe

### Axe A — Qualité du code (poids 20)

| Règle | Déclenchement | Sévérité |
|---|---|---|
| A-TAILLE-01 | Fichier `.js`/`.mjs` exécuté, non vendorisé, > 600 lignes significatives | mineur (> 1200 lignes : majeur) |
| A-FONC-01 | Fonction de > 80 lignes | mineur (> 200 lignes : majeur) |
| A-FONC-02 | Complexité cyclomatique (McCabe) > 15 | mineur (> 30 : majeur) |
| A-FONC-03 | Imbrication de blocs > 5 niveaux | mineur |
| A-ERR-01 | Bloc `catch` vide, sans commentaire expliquant le choix | majeur |
| A-DEV-01 | Plus de 10 appels `console.log/debug/info/table/dir` dans le code exécuté | mineur |
| A-DEV-02 | Instruction `debugger` présente | majeur |
| A-DEV-03 | Plus de 5 marqueurs `TODO`/`FIXME`/`XXX`/`HACK`/`À FAIRE`/`BUG` dans le dépôt | mineur |
| A-DUP-01 | Blocs de ≥ 8 lignes dupliqués (normalisés : noms et littéraux ignorés), entre fichiers ou ≥ 3 fois dans le même fichier | mineur (> 5 groupes inter-fichiers : majeur) |
| A-TEST-01 | Aucun test unitaire trouvé (dossier/fichier `test(s)`, `*.test.js`, `*.spec.js`, y compris variantes `dev-tests/`, `test-utils/`) | majeur |
| A-TEST-02 | Aucun test d'intégration/e2e trouvé (Playwright/Puppeteer/Cypress) | majeur |
| A-TEST-03 | (positif) Des tests unitaires existent | info |
| A-LANG-01 | Comparaisons `==`/`!=` non strictes (hors idiome `x == null`) | mineur |
| A-LANG-02 | Plus de 20 déclarations `var` | mineur |
| A-MORT-01 | Code syntaxiquement inatteignable après un `return`/`throw`/`break`/`continue` dans le même bloc | mineur (> 3 occurrences : majeur) |

### Axe B — Lisibilité et maintenabilité humaine (poids 15)

Cet axe applique une exigence propre au guide Grist.Gouv : « le code doit
être lisible par un développeur humain sans avoir besoin d'un outil d'IA
pour le comprendre ».

| Règle | Déclenchement | Sévérité |
|---|---|---|
| B-NOM-01 | Plus de 3 identifiants au nom non descriptif (`a`, `tmp`, `data`, `foo`, `truc`… hors variables de boucle courtes tolérées `i,j,k,n,e,x,y,_`) | mineur |
| B-DOC-01 | Aucun README à la racine | **majeur, BLOQUANT** |
| B-DOC-02 | README présent mais incomplet sur une des 3 rubriques attendues : ce que fait le widget / comment le configurer / ses dépendances | mineur |
| B-DOC-03 | Le niveau d'accès demandé (`requiredAccess`) n'est documenté nulle part dans le README | majeur |
| B-DOC-04 | Un service externe réellement contacté (vu par l'axe C) n'est nommé nulle part dans le README | majeur |
| B-COM-01 | Fichier de ≥ 200 lignes significatives avec moins de 4 % de lignes commentées | mineur |
| B-IA-01 | ≥ 2 familles de marqueurs de génération IA non relue (commentaires « Étape N », formules d'assistant conversationnel, ```` ``` ```` laissés dans un fichier source, commentaires de journal de modif, JSDoc générique anglais dans du code francophone, commentaires qui paraphrasent la ligne suivante), avec ≥ 8 occurrences cumulées | mineur, confiance à_vérifier |
| B-VERB-01 | Plus de 4000 lignes de code exécuté (JS + HTML cumulés) | mineur (> 12000 : majeur) |
| B-LANG-01 | Commentaires mélangeant français et anglais de façon significative (> 25 lignes qualifiantes, la langue minoritaire représentant > 25 %) | mineur |

### Axe C — Sécurité applicative, analyse statique, point de vue RSSI (poids 25)

C'est l'axe le plus dense du référentiel — largement devant les autres rien qu'au nombre de familles ci-dessous. Sous-familles :

**C-GRIST — négociation de l'accès**
| Règle | Déclenchement | Sévérité |
|---|---|---|
| C-GRIST-01 | Aucun appel à `grist.ready()` | majeur |
| C-GRIST-02 | `grist.ready()` appelé sans `requiredAccess` explicite | majeur |
| C-GRIST-03 | `requiredAccess: 'full'` demandé : si une écriture est bien détectée (`applyUserActions`, `.create/.update/.destroy/.upsert`) → majeur (à documenter pourquoi `full` est nécessaire) ; si **aucune** écriture n'est détectée → **critique** (privilège excessif injustifié, à rétrograder en `read table`) |
| C-GRIST-04 | Actions de modification de schéma détectées (`AddTable`, `RemoveTable`, `AddColumn`, `RemoveColumn`, `ModifyColumn`, `RenameTable`, `AddEmptyTable`) | majeur |

**C-EXFIL — sortie de données**
| Règle | Déclenchement | Sévérité |
|---|---|---|
| C-EXFIL-01 | Requête sortante (`fetch`, XHR, `sendBeacon`, `importScripts`, `WebSocket`, `EventSource`, `import()` distant) vers un hôte externe **littéral** (non Grist, non local) | **critique, BLOQUANT** |
| C-EXFIL-02 | Même chose mais destination **calculée à l'exécution** (variable, concaténation) — ne peut être tranché que par l'axe D | majeur, à_vérifier, non bloquant |
| C-EXFIL-03 | Ressource externe déclarée en HTML/CSS (`<script src>`, `<link>`, `<iframe>`, `<img>`, `@import`, `url()` CSS) vers un hôte non Grist : `<script>` **sans** `integrity` → **critique, BLOQUANT** ; `<script>` avec `integrity`, ou autre type de ressource → majeur (feuille de style/iframe) ou mineur (image, ressource CSS) |
| C-EXFIL-04 | `grist-plugin-api.js` chargé depuis un domaine externe (ex. `docs.getgrist.com`) plutôt qu'en relatif depuis l'instance hôte | majeur |
| C-EXFIL-05 | `<script>` créé dynamiquement (`createElement('script')` puis `.src =`) pointé vers un hôte externe littéral : sans `integrity` → **critique, BLOQUANT** ; avec `integrity` assigné sur le même élément → critique mais non bloquant ; source calculée à l'exécution → majeur, à_vérifier |
| C-EXFIL-06 | `import()` dynamique à source calculée (ni littéral simple, ni chemin relatif certain de type découpage de code `./chunk-${x}.js`) | majeur, à_vérifier |

**C-XSS — injection et exécution dynamique**
| Règle | Déclenchement | Sévérité |
|---|---|---|
| C-XSS-01 | `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`srcdoc` affecté avec une valeur **dynamique** (non constante) | majeur, probable |
| C-XSS-02 | `document.write()`/`writeln()` | majeur |
| C-XSS-03 | `eval()` ou `new Function()` | **critique, BLOQUANT** |
| C-XSS-04 | `setTimeout`/`setInterval` appelé avec une chaîne comme premier argument (équivalent à `eval`) | majeur |
| C-XSS-05 | `.html(valeur)` façon jQuery avec valeur dynamique | mineur, probable |
| C-XSS-06 | (neutre) `innerHTML` avec du HTML **constant** — aucun risque, pour mémoire | info |

**C-DOM / C-CSP**
| Règle | Déclenchement | Sévérité |
|---|---|---|
| C-DOM-01 | `<a target="_blank">` sans `rel="noopener"` | mineur |
| C-DOM-02 | `<iframe>` sans attribut `sandbox` | majeur |
| C-CSP-01 | Aucune CSP déclarée (`<meta http-equiv="Content-Security-Policy">`) sur le point d'entrée | mineur |
| C-CSP-02 | CSP présente mais permissive : joker `*` en `script-src`/`default-src` → mineur ; `'unsafe-inline'` en `script-src`/`default-src` → mineur (deux constats distincts possibles). `'unsafe-eval'` n'est **jamais** sanctionné (nécessaire à l'intégration RPC officielle `grist-plugin-api.js`) |

**C-PM — postMessage**
| Règle | Déclenchement | Sévérité |
|---|---|---|
| C-PM-01 | Écoute `addEventListener('message', …)` sans vérification de `event.origin`/`event.source` dans le corps du gestionnaire | majeur, probable |
| C-PM-02 | Émission `postMessage(msg, '*')` où `msg` n'est pas un simple relais transparent d'un paramètre reçu tel quel (exclut les relais RPC génériques type `grain-rpc`) | majeur |

**C-STOCK / C-SECRET / C-CRYPTO**
| Règle | Déclenchement | Sévérité |
|---|---|---|
| C-STOCK-01 | Stockage persistant hors Grist (`localStorage`/`sessionStorage.setItem`, `indexedDB.open`, `document.cookie =`) | majeur si non documenté dans le README, **mineur si le mécanisme y est au moins nommé** |
| C-SECRET-01 | Secret probable en dur (clé AWS `AKIA...`, jeton GitHub `ghp_.../github_pat_...`, clé type OpenAI `sk-...`, jeton Slack `xox...`, clé privée PEM, JWT, clé Google `AIza...`, ou motif générique `api_key`/`secret`/`token`/`password` = valeur ≥ 12 caractères hors placeholders évidents) | **critique, BLOQUANT** |
| C-CRYPTO-01 | `Math.random()` alimentant une variable dont le nom évoque un usage de sécurité (token, jeton, secret, clé, password, nonce, salt, uuid, session, csrf) | majeur, probable |

**C-FINGERPRINT / C-PERSIST / C-CLIP — ajouts RSSI**
| Règle | Déclenchement | Sévérité |
|---|---|---|
| C-FINGERPRINT-01 | Lecture de `navigator.webdriver` (détection d'automatisation, contournement possible de l'audit) | majeur, probable |
| C-PERSIST-01 | Enregistrement d'un Service Worker ou usage de la Cache API | majeur |
| C-CLIP-01 | Lecture du presse-papiers (`clipboard.read`/`readText`) : derrière un geste explicite de l'agent (clic, touche) → mineur, probable ; sans geste identifiable → majeur, certain |

### Axe D — Sécurité en condition réelle (poids 25)

**Lis d'abord la section 6 : cet axe repose sur une exécution réelle du
widget que tu ne peux pas reproduire en lisant du code.** Ce qui suit décrit
la méthode de l'outil algorithmique, pour que tu comprennes ce qu'il mesure
et que tu puisses raisonner par déduction, avec les précautions de la
section 6.

L'outil charge le widget dans un vrai Chromium face à un faux hôte Grist
(protocole RPC réel) avec un document de test contenant une table `Contacts`
dont deux cellules portent une charge XSS (`<img onerror=...>`), et une table
« appât » jamais déclarée par le widget, jamais sélectionnée, jamais nommée
par les colonnes attendues.

| Règle | Déclenchement | Sévérité |
|---|---|---|
| D-INDISPONIBLE | Axe D non exécuté du tout (outil, pas ton cas — toi tu es toujours dans ce cas) | info, axe exclu du score |
| D-TIMEOUT-01 | Le scénario ne termine pas dans le délai (45 s) | majeur |
| D-ERR-00 | Le widget ne se charge pas du tout dans l'hôte de test | majeur |
| D-RESEAU-00 | (positif) Aucune requête vers un tiers observée pendant le scénario | info |
| D-RESEAU-01 | Une requête vers un hôte tiers a **réellement été émise** pendant le scénario | **critique, BLOQUANT** (par hôte distinct) |
| D-RESEAU-02 | Confirme à l'exécution le chargement externe de `grist-plugin-api.js` (C-EXFIL-04) | info |
| D-XSS-01 | La charge XSS placée dans une cellule s'est **réellement exécutée** | **critique, BLOQUANT** |
| D-GRIST-01 | Le widget n'a jamais négocié son accès pendant le scénario (`grist.ready()` sans effet observé) | majeur |
| D-GRIST-02 | Des appels RPC ont échoué pendant le scénario (mesure partielle) | info, mesure partielle |
| D-PERIMETRE-01 | Le widget a lu/écrit la table appât (`fetchTable`/`applyUserActions` dessus) : si le README annonce explicitement une lecture/écriture de l'ensemble du document **et** l'accès `full` est demandé → info, non bloquant (comportement honnête) ; **sinon** → **critique, BLOQUANT** (énumération aveugle du document au-delà du périmètre déclaré) |
| D-CONSOLE-01 | Erreurs JavaScript pendant le scénario | mineur |
| D-CONSOLE-02 | Erreurs de chargement dues à la neutralisation réseau de l'audit lui-même (pas un défaut du widget) | info, ne compte pas contre le widget |

**Particularité importante** : les violations d'accessibilité détectées à
l'exécution (moteur `axe-core` sur le DOM réellement rendu) sont comptées
dans l'outil algorithmique sous l'**axe F**, pas sous l'axe D, même si elles
sont mesurées pendant le même passage dynamique :

| Règle | Déclenchement | Sévérité | Axe |
|---|---|---|---|
| D-RGAA-00 | (positif) Aucune violation axe-core | info | F |
| D-RGAA-`<id>` | Violation axe-core détectée sur le DOM rendu, `<id>` = identifiant de la règle axe-core | mappée depuis la gravité axe-core (`critical`→critique, `serious`→majeur, `moderate`/`minor`→mineur) | F |
| D-RGAA-INDISPONIBLE | Le scan axe-core n'a pas pu s'exécuter (ex. CSP trop stricte) | info, mesure partielle | F |

### Axe E — Chaîne d'approvisionnement et dépendances (poids 10)

Trois anneaux de risque : dépendances distantes à l'exécution (risque
maximal), embarquées dans le dépôt (risque maîtrisé), de développement
(risque limité au poste du contributeur).

| Règle | Déclenchement | Sévérité |
|---|---|---|
| E-DEP-01 | `<script src="https://...">` chargeant une bibliothèque tierce à l'exécution (hors `grist-plugin-api.js`) : sans `integrity` → **critique, BLOQUANT** ; avec `integrity` mais version non figée dans l'URL → majeur |
| E-DEP-02 | Bibliothèque tierce recopiée dans le dépôt (fichier « vendorisé ») : version ET licence identifiables en en-tête → info ; sinon → mineur |
| E-DEP-03 | (neutre) Pas de `package.json` du tout | info |
| E-DEP-04 | Dépendances npm déclarées sans fichier de verrouillage (`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`) | majeur |
| E-DEP-05 | Dépendances de production à version non figée (`^`, `~`, `*`, `latest`, `>`) | mineur |
| E-DEP-06 | Plus de 12 dépendances de production directes | mineur |
| E-VULN-00/01/02 | `npm audit` sur les dépendances verrouillées — **tu ne peux pas l'exécuter** ; voir section 6 |
| E-LIC-01 | Aucun fichier LICENSE à la racine | **majeur, BLOQUANT** |
| E-LIC-02 | Licence présente : type reconnu (MIT/Apache 2.0/EUPL/BSD) → info ; GPL/AGPL → info avec réserve (effet contaminant à vérifier) ; non identifiée → mineur |

### Axe F — Conformité Grist.Gouv, souveraineté, accessibilité, sobriété (poids 5)

| Règle | Déclenchement | Sévérité |
|---|---|---|
| F-SOUV-01 | Référence à un service tiers non souverain identifié (Google Fonts et ses variantes statiques, Google Analytics, Google Tag Manager, Meta/Facebook, DoubleClick, Hotjar, Sentry hébergement mutualisé, jsDelivr, unpkg, cdnjs, OpenAI, Anthropic) | majeur, par service distinct |
| F-RGAA-00 | (rappel systématique) La vérification RGAA statique est partielle | info |
| F-RGAA-01 | `<html>` sans attribut `lang` | mineur |
| F-RGAA-02 | Page sans `<title>` non vide | mineur |
| F-RGAA-03 | `<img>` sans attribut `alt` | mineur |
| F-RGAA-04 | Champ de formulaire sans `<label for>`/`aria-label`/`aria-labelledby`/`title` | mineur, probable |
| F-RGAA-05 | Bouton à icône seule sans `aria-label` | mineur, probable |
| F-ECO-01 | Poids total du code exécuté > 2 Mo | mineur (> 5 Mo : majeur) |
| F-GUIDE-01 | Nom de dépôt hors convention `grist-widget-*` | info |
| F-GUIDE-02 | Aucun fichier `SECURITY.md` | mineur |
| F-GUIDE-03 | Entrée de `manifest.json` incomplète (`name`/`url`/`widgetId` manquants) | mineur |
| F-GUIDE-04 | `manifest.json` ne déclare pas `accessLevel` alors que le code demande un niveau d'accès | mineur |

(Plus les violations `D-RGAA-*` de l'axe D, comptées ici — voir ci-dessus.)

---

## 6. Ce que tu ne peux PAS reproduire, et comment le dire honnêtement

L'axe D pèse un quart de la note globale et repose entièrement sur une
**exécution réelle** du widget dans un navigateur, face à un vrai protocole
RPC Grist, avec capture du trafic réseau effectivement émis. Une lecture de
code, aussi attentive soit-elle, ne peut pas observer ce qui se passe
réellement à l'exécution — seulement le déduire.

Applique donc ce protocole, sans exception :

1. **N'utilise jamais la confiance `prouvé`** pour un constat d'axe D : tu
   n'as rien observé, tu as déduit. Utilise `probable` ou `à_vérifier`.
2. Pour chaque règle D-* de la section 5, demande-toi ce que le code, LU
   attentivement, laisse penser qu'il se passerait à l'exécution — par
   exemple : une requête `fetch()` vers une URL calculée (C-EXFIL-02) se
   déclencherait-elle certainement, conditionnellement, ou jamais dans un
   usage normal ? Une valeur de cellule est-elle affichée sans échappement
   d'une façon qui exécuterait vraisemblablement une charge XSS ? Le widget
   énumère-t-il les tables du document (`listTables()` suivi d'une
   récupération systématique) d'une manière qui toucherait une table hors de
   son périmètre déclaré ?
3. Produis quand même un score d'axe D déduit, avec les mêmes formules — mais
   **calcule en plus un second score global qui exclut l'axe D** (moyenne
   pondérée sur A, B, C, E, F seulement, poids renormalisés à 95). C'est ce
   second chiffre qui se compare le plus honnêtement au score de l'axe D
   *réellement mesuré* par l'outil algorithmique : l'écart entre ton axe D
   déduit et l'axe D réel est justement ce qu'Antoine veut observer.
4. Dis explicitement, dans ton rapport, que ton évaluation de l'axe D est
   **déduite, non observée**, et que la comparaison n'a donc de sens fort que
   sur les axes A, B, C, E, F.

Pour **E-VULN-00/01/02** (`npm audit`) : tu ne peux pas interroger le
registre npm en temps réel. Ne prétends jamais avoir vérifié l'absence de
vulnérabilité. Deux cas :
- Tu ne reconnais aucune vulnérabilité connue dans les dépendances listées :
  dis que ce point n'a pas pu être vérifié (mesure partielle), comme le fait
  l'outil quand `npm audit` est injoignable — ne le compte pas comme un 100
  silencieux.
- Tu reconnais, d'après tes connaissances générales, qu'un paquet et une
  version précis ont une vulnérabilité publique largement documentée :
  mentionne-le avec la confiance `à_vérifier` et la mention explicite
  « connaissance générale du modèle, non vérifiée à la date de cet audit,
  à confirmer par un `npm audit` réel ».

---

## 7. Format de sortie attendu

Pour chaque axe (A à F, dans cet ordre) :
- La liste des règles déclenchées, chacune avec ses constats complets
  (section 4), le nombre d'occurrences, le facteur d'occurrences calculé, et
  la pénalité obtenue.
- La pénalité brute totale de l'axe et le score d'axe (formule 3.3), calcul
  montré.

Ensuite :
- **Score global** (formule 3.4), calcul montré, et **verdict** (section
  3.5) avec son motif.
- **Score global hors axe D** (voir section 6, point 3), pour la
  comparaison honnête.
- La liste des constats bloquants, à part, en tête de synthèse.
- Un tableau récapitulatif : axe, poids, score, pénalité brute, nombre de
  constats par sévérité.

Enfin, section séparée :

## 8. Critères additionnels (hors barème)

Tout ce que tu as remarqué en auditant ce widget et qui n'est couvert par
aucune des règles de la section 5, si tu le juges réellement pertinent pour un
hébergement sur une instance Grist officielle. Pour chacun : la même
exigence de trois éléments (emplacement, explication, action corrective),
plus une sévérité proposée et pourquoi tu penses que ça mériterait d'entrer
un jour dans le référentiel. Rappel : **rien de cette section ne modifie le
score global reproduit en section 7.** C'est un espace pour proposer, pas
pour corriger le barème toi-même.

---

## Rappel final

Les trois éléments de chaque constat (emplacement, explication, action
corrective) et la séparation stricte entre le score reproduit (sections 5-7)
et tes propositions personnelles (section 8) sont les deux exigences sur
lesquelles ce prompt ne transige pas. Tout le reste — formulation, longueur,
ton — est à ton appréciation, du moment que le calcul reste vérifiable par
un lecteur humain qui reprendrait tes chiffres à la main.
