# Prompt d'audit — reproduire gwaudit avec un LLM

Ce document est un **prompt à copier-coller** dans un LLM (Opus 5.5 ou
équivalent), avec le code source du widget à auditer joint ou accessible.
Il reproduit **exactement** le référentiel, la notation et le verdict de
l'outil `gwaudit` de ce dépôt, tel qu'il existe au commit indiqué en tête de
rapport — pas une description approximative de ce que fait l'outil.

**Pourquoi ce document existe** : comparer un résultat algorithmique (rapide,
reproductible, mais mécanique) à une analyse par un LLM (plus lente, capable
de jugement contextuel, mais non déterministe). Les deux audits doivent
partir de la même grille pour que l'écart observé soit informatif — un écart
dû à des critères différents ne dirait rien d'utile.

**Deux usages, un seul texte.** En *reproduction*, tu n'as que le code et tu
refais l'audit de bout en bout (sections 3 à 7), puis les jugements de la
section 8. En *complément*, on te donne aussi le rapport de l'outil : tu ne
refais pas ce qu'il a mesuré, tu tranches ce qu'il laisse ouvert et tu fais les
jugements de la section 8 (8.1 dit comment).

Ne modifie pas les seuils, les poids ou les formules ci-dessous : c'est ce
qui rend la comparaison possible. Si un seuil te semble mal choisi, dis-le en
section 8.4 (critères additionnels), jamais en le changeant silencieusement
en section 5.

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
6. **Séparément**, et seulement après avoir fini les six axes, faire en
   section 8 les jugements que l'outil ne fait pas (périmètre fonctionnel,
   efficience, code mort et dupliqué au-delà de la mesure, clarté des
   fonctions et des noms), et proposer tout critère supplémentaire que tu juges
   pertinent et qui n'est couvert par aucune des règles ci-dessous
   (section 5). Ces jugements et ces critères ne comptent JAMAIS dans le score
   global reproduit : ils forment une annexe distincte, justement pour que
   l'écart entre ton score et le score algorithmique reste lisible.

En usage *complément* (voir en tête, et 8.1), l'outil a déjà fait les points 2
à 5 : tu ne les refais pas, tu fais le point 6 et tu tranches les signaux que
son rapport laisse ouverts.

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
Les occurrences d'une règle sont donc triées de la plus grave à la plus
légère, et la k-ième pèse sa propre pénalité de base multipliée par ce que le
facteur ajoute à ce rang :

```
facteur(n) = min(1 + ln(n), 2.5)          facteur(0) = 0
pénalité de la règle = somme, pour k = 1..n, de base(k-ième) × (facteur(k) − facteur(k−1))
```

où `n` est le nombre d'occurrences **pénalisantes** de cette règle précise.
À sévérités égales, la somme vaut base × facteur(n) : trois `mineur` pèsent
3 × (1 + ln 3) = 6,3. Un `majeur` et deux `mineur` pèsent
12 + 3 × 0,693 + 3 × 0,405 = 15,3 : une occurrence légère ne paie jamais au
prix de la plus grave, et en ajouter une ne fait jamais baisser la pénalité.
Une `info` n'est jamais comptée, ni dans `n` ni dans la pénalité. Fais ce
calcul toi-même pour chaque règle qui se déclenche plus d'une fois — ne compte
jamais les occurrences comme des pénalités indépendantes additionnées
linéairement. Un constat qui regroupe tout le dépôt en un seul (A-DUP-01) n'a
qu'une occurrence.

### 3.3 Score d'un axe

Additionne la pénalité de chaque règle déclenchée sur l'axe (calculée comme en
3.2) pour obtenir la **pénalité brute de l'axe**. Puis :

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

Moyenne des scores d'axe, **pondérée par les poids de la section 2**. Trois
situations se distinguent, que le rapport dit toujours :

- **Axe non exécuté** (l'axe D que l'utilisateur a désactivé, ou que l'outil n'a
  pas pu jouer ; pour toi, l'axe D est déduit et non exécuté : voir la
  section 6) : il est exclu du calcul. N'attribue jamais 100 ou 0 par défaut à
  un axe non évalué : exclus-le du calcul et dis-le explicitement.
- **Axe partiel** (l'axe a tourné, mais une vérification en son sein n'a pas pu
  se faire : `npm audit` injoignable, code exécuté que la recherche de
  duplication n'a pas comparé…) : il garde sa note et reste dans la moyenne,
  mais le verdict ne peut plus être « CONFORME » sans réserve (3.5).
- **Axe empêché par le widget** (il bloque le navigateur — D-TIMEOUT-01 —, ou
  du code qu'il exécute ne peut pas être lu — C-SURFACE-01 à 03) : l'axe est
  noté **0**, le rapport dit ce qu'il vaut sur ce qui a pu être lu et quel
  constat l'en empêche, et ce constat est toujours bloquant. Un widget qui
  empêche une mesure ne note jamais mieux que s'il la laissait se faire ; ce 0
  dit que la mesure n'a pas pu se faire, non que le code est mauvais.

### 3.5 Verdict

Dans cet ordre :

1. S'il existe au moins un constat marqué **bloquant** (les règles qui le
   sont portent la mention BLOQUANT dans la section 5) → **NON CONFORME**,
   quel que soit le score.
   Un point bloquant n'est jamais rattrapable par un bon score ailleurs —
   c'est la logique d'un avis RSSI, pas d'une moyenne.
2. Sinon, s'il existe au moins un constat `critique` (non bloquant), ou si le
   score global est inférieur à 60 → **CONFORME SOUS RÉSERVE**.
3. Sinon, si le score global est inférieur à 80 → **CONFORME SOUS RÉSERVE**.
4. Sinon → **CONFORME**.

Si un axe est non exécuté ou partiel (3.4), le verdict ne peut jamais être un
simple « CONFORME » sans réserve : rétrograde-le au moins à « CONFORME SOUS
RÉSERVE » et dis dans ton motif quelle couverture manque. Un « CONFORME » qui
cache un quart de la note jamais mesurée serait trompeur. Si un axe est
empêché, dis-le en tête du motif, avec sa cause.

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
  correspond à aucune de ces règles va en section 8 (8.3 ou 8.4), jamais forcé
  dans une case existante qui ne lui correspond pas.

---

## 5. Référentiel détaillé, axe par axe

### Périmètre : la surface exécutée

Le référentiel ne juge pas tout le contenu du dépôt de la même façon. La
plupart des règles ci-dessous qui portent sur du code JS/HTML/CSS (celles qui
parlent de fichier « exécuté », ainsi que E-DEP-01) ne s'appliquent qu'à la
**surface exécutée** : ce qu'un navigateur exécute ou charge en ouvrant le
widget, c'est-à-dire les fichiers réellement atteignables depuis un point
d'entrée — pas l'intégralité du dépôt. Un script de développement, un
prototype jamais branché, ou une ancienne version gardée à côté n'en font
pas partie.

**Points d'entrée** : tous les `index.html` à la racine du dépôt ou un niveau
en dessous, **et** chaque page HTML qu'un `manifest.json` désigne par une `url`
relative (pas une URL absolue), même rangée dans un dossier comme `dist/` ; à
défaut des deux, la page HTML au chemin le plus court du dépôt.

**Fermeture transitive** depuis ces points d'entrée, en suivant toute
référence **locale** (jamais une URL absolue `http(s):`, `data:` ou
`blob:`, qui sort du dépôt et n'entre donc jamais dans la surface) :
- HTML : `<script src="...">`, `<link href="...">`, et ce que le code de chaque
  `<script>` inline référence. Le CSS de la page (`<style>`, attributs
  `style`) se lit comme une feuille de style. Un script placé dans un
  `<template>` ne s'exécute qu'une fois le gabarit cloné : le constat le dit.
- Import map (`<script type="importmap">`) : tout fichier local qu'une entrée
  désigne est du code que le navigateur charge, sans qu'aucun `<script src>`
  ni `import` de chemin ne le nomme. Une adresse qui finit par `/`
  (`"lib/": "./libs/"`) désigne tout module du dossier.
- CSS : `@import`, `url(...)`.
- JS/TS (`.js`, `.mjs`, `.cjs`, `.ts`, `.jsx`, `.tsx`) : `import ... from
  '...'`, `export ... from '...'`, `import('...')` à littéral. Un import
  avec `with { type: 'json' }` (ou `'css'`) charge une donnée, non du code.
  Un fichier qu'une balise script, un import ou un worker désigne par son
  adresse est du code, quelle que soit son extension (`<script
  src="logique.txt">`).
- Dans un fichier HTML (y compris un `<script>` inline) ou JS : `new
  Worker('./x.js')` / `new SharedWorker('./x.js')` — source littérale, ou
  gabarit sans interpolation (`` `./x.js` `` mais jamais `` `./${x}.js` ``)
  — et la forme que produisent les empaqueteurs, `new Worker(new
  URL('./x.js', <base quelconque>))` (idem `SharedWorker`) : seul compte le
  premier argument littéral de `URL(...)`, la base n'est jamais vérifiée.
  Un alias global de tête (`window.Worker`, `self.SharedWorker`,
  `globalThis.URL`…) est reconnu au même titre que la forme nue.
  `navigator.serviceWorker.register('./sw.js')` et
  `audioWorklet.addModule('./m.js')` se lisent de la même façon.
- Dans un fichier de worker atteint : `importScripts(...)` — **tous** ses
  arguments littéraux, pas seulement le premier.
- Résolution tolérante : le chemin cité tel quel, puis avec `.js`, `.mjs`,
  ou `index.js` dans un dossier — en cas de doute le fichier entre dans la
  surface (un faux positif ici coûte moins cher qu'un angle mort de
  sécurité).

**Dossiers de bibliothèques et de sortie de construction** (`node_modules`,
`dist`, `build`, `vendor`, `.next`, `coverage`, `.venv`, `__pycache__`) : ils
ne sont pas parcourus en entier, mais ce qu'une page, un import ou une import
map y désigne entre dans la surface, ouvert à la demande. Un widget dont le
code vit dans `dist/` n'est donc pas moins audité : ce code se juge pour tous
les axes sauf A et B, qui ne jugent que le code que le contributeur a écrit
(voir l'axe A).

**Exceptions qui lisent tout le dépôt, sans se limiter à cette surface** :
C-GRIST-01 à 04 (la négociation d'accès Grist peut apparaître n'importe où
dans le code JS du dépôt, pas seulement dans ce qui est chargé au premier
écran) et C-SECRET-01 (un secret versionné est un risque même dans un
fichier que le navigateur ne charge jamais : elle lit tout texte, README,
cartes de sources et fichiers de configuration compris). Les règles qui
portent sur un document plutôt que sur du code exécuté (README pour B-DOC-*,
LICENSE pour E-LIC-*) lisent aussi tout le dépôt, par construction, sans
notion de surface.

Applique donc une règle « surface » **seulement** aux fichiers qui en font
partie, comme le fait l'outil. Un motif que tu repères ailleurs dans le
dépôt (script de dev non branché, prototype) ne compte pas dans le score
reproduit — note-le en section 8.4 si tu le juges digne d'attention.

**Ce que tu n'as pas pu lire n'est pas absous.** Du code que la page exécute
et que tu n'as pas pu lire (fichier tronqué ou trop gros pour toi, code
illisible), ou un dépôt dont tu n'as vu qu'une partie, se déclare comme un
constat C-SURFACE (axe C, plus bas) : l'absence de constat ne vaut que sur ce
qui a été lu, et ne se présente jamais comme une preuve.

### Cas particulier : code fourni sous forme de chaîne (eval, Function, Worker)

`eval()`, `Function(...)`/`new Function(...)`, `setTimeout`/`setInterval`
avec une chaîne, et un `Worker`/`SharedWorker` construit depuis une chaîne
(`data:`, ou `Blob([...])` via `URL.createObjectURL`) sont tous jugés selon
le **même modèle**, détaillé une seule fois ici et référencé depuis les
règles C-XSS-03/04/07 :

- Si l'argument est **calculé** (variable, concaténation avec une variable,
  `atob()`…), ou un littéral qui **ne se parse pas** comme du JS valide :
  c'est LE risque, sévérité maximale de la règle concernée, inchangée par
  ce qui suit. Pour `eval` et `Function`, un identifiant ne vaut son littéral
  que si le langage garantit sa valeur à l'endroit de l'appel (`const code =
  "…"; eval(code)` se juge comme le littéral écrit en place) ; tout autre
  identifiant est une valeur non garantie, donc calculée. Les minuteurs ont
  leur propre palier pour une source que l'analyse ne résout pas (C-XSS-04).
- Si l'argument est un littéral (chaîne, gabarit sans interpolation, ou —
  pour un Worker en `data:` base64 ou en `Blob([...])` — un contenu
  entièrement composé de littéraux) qui **SE PARSE comme du JS valide** :
  ce contenu n'est plus une boîte noire. Il devient un fichier de plus dans
  la surface analysée, et **chaque règle de l'axe C s'y applique à sa
  propre sévérité** — un `eval()` ou un `fetch()` externe imbriqué dedans
  redevient critique, exactement comme s'il était écrit dans un fichier du
  dépôt. Seules C-GRIST-01 à 04 sont exclues de cette analyse imbriquée
  (elles portent sur le widget entier, pas sur un fragment isolé). La
  construction elle-même (`eval`, `Function`, ou le Worker en chaîne) ne
  reste alors qu'un rappel **mineur, non bloquant** : un obstacle inutile à
  une CSP stricte et à la lisibilité, pas un risque en soi puisque le
  contenu a pu être lu. Pour `Function`/`new Function`, enveloppe
  mentalement le texte dans `(function(){ ... })` avant de l'analyser (son
  `return` s'y exécute comme dans un corps de fonction).
- Borne : au-delà de 5 niveaux d'imbrication (un littéral contenant lui-même
  un `eval()` d'un littéral, etc.), n'analyse pas plus profond — signale un
  constat séparé (C-XSS-03), **critique, BLOQUANT**, certain : ce qui est
  au-delà n'est pas lu, et un widget qui s'arrange pour qu'on ne le lise pas
  ne note jamais mieux que s'il s'était laissé lire. Les axes B, C, E et F sont
  alors empêchés (3.4).

### Axe A — Qualité du code (poids 20)

Les axes A et B ne jugent que le code que le contributeur a écrit : une
bibliothèque tierce recopiée (`vendor/`, `lib/`, `libs/`, `third-party/`,
`*.min.js`), un fichier minifié ou empaqueté par un outil de build et le
contenu d'un dossier exclu (`dist/`, `build/`…) en sont exemptés. Ils restent
jugés par C, D, E et F.

| Règle | Déclenchement | Sévérité |
|---|---|---|
| A-TAILLE-01 | Fichier `.js`/`.mjs` exécuté, non vendorisé, > 600 lignes de code (ni lignes vides, ni commentaires seuls) | mineur (> 1200 lignes : majeur) |
| A-FONC-01 | Fonction de > 80 lignes (de sa première à sa dernière ligne ; une fonction appelée là où elle est écrite, `(function () { … })()`, ne compte que ses lignes propres) | mineur (> 200 lignes : majeur) |
| A-FONC-02 | Complexité cyclomatique (McCabe) > 15, sur le corps propre de la fonction | mineur (> 30 : majeur) |
| A-FONC-03 | Imbrication de blocs > 5 niveaux, sur le corps propre de la fonction (un `else if` prolonge la chaîne du `if` au même niveau) | mineur |
| A-ERR-01 | Bloc `catch` vide, sans commentaire expliquant le choix | majeur |
| A-DEV-01 | Plus de 10 appels `console.log/debug/info/table/dir` dans le code exécuté | mineur |
| A-DEV-02 | Instruction `debugger` présente | majeur |
| A-DEV-03 | Plus de 5 marqueurs `TODO`/`FIXME`/`XXX`/`HACK`/`À FAIRE`/`BUG` dans le dépôt | mineur |
| A-DUP-01 | Code dupliqué, cherché sur la structure du code et non sur son texte : au moins deux exemplaires disjoints de même forme (fonction, bloc, suite d'instructions) d'**au moins 50 nœuds d'arbre dont 6 de logique** (appels, affectations, contrôle de flux, fonctions), identiques ou aux noms et aux valeurs près si le renommage est cohérent (`a + b * a` et `x + y * x` sont des copies, `x + y * y` n'en est pas une). Ne comptent pas : les données (tableaux, objets), les suites d'appels du même appelé ou d'affectations de littéraux (la répétition y est l'idiome), ce qu'un clone plus gros couvre déjà. Tout le code du contributeur se compare, qu'une page l'exécute ou non, tests compris. Un seul constat pour tout le dépôt, qui cite les plus gros | mineur ; majeur au-delà de 5 clones entre fichiers différents, ou pour un clone répété plus de 5 000 fois |
| A-DUP-00 | Ce que la recherche de A-DUP-01 n'a pas comparé : code d'un autre, code minifié ou empaqueté, code généré que la page n'exécute pas, ce qu'un plafond de travail ou une erreur de l'outil a laissé de côté. Dis ce que tu n'as pas comparé, pour que l'absence de A-DUP-01 ne passe pas pour une preuve | info ; mesure partielle (3.4) quand le code laissé de côté est du code que la page exécute |
| A-TEST-01 | Aucun test unitaire trouvé (dossier/fichier `test(s)`, `*.test.js`, `*.spec.js`, y compris variantes `dev-tests/`, `test-utils/`) | majeur |
| A-TEST-02 | Aucun test d'intégration/e2e trouvé (Playwright/Puppeteer/Cypress) | majeur |
| A-TEST-03 | (positif) Des tests unitaires existent | info |
| A-LANG-01 | Comparaisons `==`/`!=` non strictes (hors idiome `x == null`) | mineur |
| A-LANG-02 | Plus de 20 déclarations `var` | mineur |
| A-MORT-01 | Code syntaxiquement inatteignable après un `return`/`throw`/`break`/`continue` dans le même bloc | mineur (> 3 occurrences : majeur) |
| A-PERF-01 | Un appel à l'API de Grist (`grist.…`, `applyUserActions`, `fetchTable`) ou à `fetch` est attendu (`await`) dans le corps d'une boucle (`for`, `for…of`, `for await`, `while`, `do…while`) : les allers-retours s'enchaînent un à un. Un constat pour tout le dépôt, qui compte les occurrences. Rien pour un appel hors boucle, dans l'en-tête d'un `for…of` (évalué une fois), ni dans un rappel que la boucle ne fait pas tourner (`Promise.all(l.map(async …))`) | info, probable |
| A-PERF-02 | `innerHTML +=` dans une boucle ou dans le rappel d'un parcours de tableau (`forEach`, `map`, `filter`, `reduce`…) : le navigateur reconstruit à chaque tour tout le contenu déjà posé. Un constat pour tout le dépôt | info, probable |

Le code qui n'est dans aucune fonction (le niveau supérieur d'un fichier ou d'un
script de page) se mesure comme une fonction pour A-FONC-02 et A-FONC-03 ; sa
longueur est dite par A-TAILLE-01. A-PERF-01 et A-PERF-02 ne notent rien : ce
que coûte une boucle dépend de la taille de la table, que le code ne dit pas.
Le reste de l'efficience est un jugement (8.3).

### Axe B — Lisibilité et maintenabilité humaine (poids 15)

Cet axe applique une exigence propre au guide Grist.Gouv : « le code doit
être lisible par un développeur humain sans avoir besoin d'un outil d'IA
pour le comprendre ».

| Règle | Déclenchement | Sévérité |
|---|---|---|
| B-NOM-01 | Plus de 3 identifiants au nom non descriptif (`a`, `tmp`, `data`, `foo`, `truc`… hors variables de boucle courtes tolérées `i,j,k,n,e,x,y,_`) | mineur |
| B-DOC-01 | Aucun README à la racine : `README` ou `LISEZMOI` (`LISEZ-MOI`, `LISEZ_MOI`), avec une langue facultative (`README.fr.md`) et une extension de texte facultative (`.md`, `.rst`, `.adoc`, `.txt`…) ; `docs/README.md` ne compte pas | **majeur, BLOQUANT** |
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
| C-EXFIL-01 | Requête sortante (`fetch`, XHR, `sendBeacon`, `importScripts`, `WebSocket`, `EventSource`, `import`, `export … from` ou `import()` d'une adresse distante littérale) vers un hôte externe **littéral** (non Grist, non local). `importScripts(a, b, c)` charge **tous** ses arguments, pas seulement le premier : chaque argument littéral externe compte comme une occurrence distincte de cette règle. Un module chargé par son adresse que la clé `integrity` d'une import map de la page fige (jamais dans un worker, ni quand la carte est lue après le script qui le charge) → majeur, non bloquant | **critique, BLOQUANT** (majeur pour un module figé par `integrity`) |
| C-EXFIL-02 | Même chose mais destination **calculée à l'exécution** (variable, concaténation) — ne peut être tranché que par l'axe D. Même règle pour `importScripts` : chaque argument calculé compte séparément | majeur, à_vérifier, non bloquant |
| C-EXFIL-03 | Ressource externe déclarée en HTML/CSS (`<script src>`, `<link>`, `<iframe>`, `<img>`, `<object data>`, `<embed src>`, `@import`, `url()` CSS) vers un hôte non Grist : `<script>` **sans** `integrity` → **critique, BLOQUANT** ; `<script>` avec `integrity`, ou autre type de ressource → majeur (feuille de style/iframe) ou mineur (image, objet, contenu embarqué, ressource CSS). S'applique aussi à une entrée d'un `<script type="importmap">` (clés `imports` et `scopes`) résolue vers un hôte externe : sans couverture par la clé `integrity` de premier niveau de l'import map → **critique, BLOQUANT** ; couverte → majeur (même logique qu'un `<script>` classique, l'import map n'étant jamais lue par les motifs HTML ci-dessus puisque son contenu est du JSON) |
| C-EXFIL-04 | `grist-plugin-api.js` chargé depuis un domaine externe (ex. `docs.getgrist.com`) plutôt qu'en relatif depuis l'instance hôte | majeur |
| C-EXFIL-05 | `<script>` ou `<link>` créé dynamiquement (`createElement('script'\|'link')`, puis `.src`/`.href` affecté **ou** passé à `setAttribute`, peu importe l'ordre avec un éventuel `integrity`) pointé vers un hôte externe : `<script>` statique externe sans `integrity` → **critique, BLOQUANT** ; `<script>` statique externe avec `integrity` (affecté ou via `setAttribute('integrity', ...)`) → critique, non bloquant ; `<script>` à destination calculée → majeur, à_vérifier, non bloquant ; `<link>` statique externe → majeur, jamais bloquant ; `<link>` à destination calculée → mineur, à_vérifier |
| C-EXFIL-06 | `import()` dynamique à source calculée (ni littéral simple, ni chemin relatif certain de type découpage de code `./chunk-${x}.js`) | majeur, à_vérifier |

**C-XSS — injection et exécution dynamique**
| Règle | Déclenchement | Sévérité |
|---|---|---|
| C-XSS-01 | `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`srcdoc` affecté avec une valeur **dynamique** (non constante), ou `createContextualFragment()` appelé avec un argument dynamique (même risque) | majeur, probable |
| C-XSS-02 | `document.write()`/`writeln()` | majeur |
| C-XSS-03 | `eval()` (direct, ou indirect via `(0, eval)(...)`), `Function(...)`/`new Function(...)` (avec ou sans `new`, alias `window.`/`self.`/`globalThis.` reconnus), ou une URL `javascript:` donnée à `href`/`src`/`action`/`formaction` (par affectation ou `setAttribute`). Voir le modèle « code fourni sous forme de chaîne » ci-dessus pour `eval`/`Function` : calculé ou illisible → **critique, BLOQUANT** ; littéral qui se parse → mineur, non bloquant (contenu audité comme un fichier de plus). Une URL `javascript:` reste toujours **critique, BLOQUANT**, quel que soit son contenu | **critique, BLOQUANT** (sauf littéral audité pour eval/Function, voir ci-dessus) |
| C-XSS-04 | `setTimeout`/`setInterval` dont le premier argument n'est pas une fonction. Même modèle « code fourni sous forme de chaîne » : chaîne ou gabarit calculé, concaténation, donnée reçue par le widget (valeur de cellule, adresse de la page, stockage local) ou contenu illisible → **critique, BLOQUANT** ; littéral qui se parse (un nombre ou `null` aussi) → mineur, non bloquant (contenu audité comme un fichier de plus) ; valeur que l'analyse ne résout pas (identifiant non lié, appel de fonction, accès de membre, ternaire) → info, à_vérifier. Rien pour une fonction (fléchée, ou un identifiant qui en résout une), pour `setTimeout(location.reload, 0)` ni pour un nombre (`location.hash.length`) | voir déclenchement |
| C-XSS-05 | `.html(valeur)` façon jQuery avec valeur dynamique | mineur, probable |
| C-XSS-06 | (neutre) `innerHTML` avec du HTML **constant** — aucun risque, pour mémoire | info |
| C-XSS-07 | `new Worker(...)`/`new SharedWorker(...)` (alias globaux reconnus) construit depuis du code fourni en chaîne plutôt qu'un fichier séparé : une URL `data:` littérale (base64 ou non), ou `URL.createObjectURL(new Blob([...]))` où tous les éléments du tableau sont littéraux. Même modèle « code fourni sous forme de chaîne » : contenu entièrement littéral qui se parse → mineur, non bloquant (audité comme un fichier de plus) ; contenu partiellement calculé ou illisible (variable, `atob()`, concaténation) → **critique, BLOQUANT** ; source du Worker elle-même non résolue par l'analyse statique (variable, gabarit interpolé) → majeur, non bloquant, à_vérifier | voir déclenchement |

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
| C-SECRET-01 | Secret en dur dans un fichier versionné, trois paliers. (1) Valeur au format d'un fournisseur, dans tout texte du dépôt, README et cartes de sources compris (clé AWS `AKIA...`, jeton GitHub `ghp_.../github_pat_...`, clé type OpenAI `sk-...`, jeton Slack `xox...`, clé privée PEM, JWT, clé Google `AIza...`…) → **critique, BLOQUANT**, probable. (2) `nom = valeur` dont le nom évoque un secret (`api_key`, `secret`, `token`, `password`…), en configuration (`.env`, `.json`, `.yml`, `.toml`, `.ini`, `.npmrc`…) ou en JS, et dont la valeur a l'allure d'une valeur tirée au hasard (plusieurs classes de caractères, entropie élevée) → **critique, BLOQUANT**, probable. (3) Même forme, valeur d'au moins 8 caractères sans cette allure, qui n'est ni un texte de remplacement (`YOUR_…`, `changeme`…), ni une phrase, une adresse, un chemin ou un libellé → **majeur**, à_vérifier, non bloquant. Une clé que son fournisseur publie pour être embarquée dans une page (clé publique par conception) → info. Dans un fichier d'exemple (`.env.example`…), seuls un format de fournisseur et l'allure générée comptent | voir déclenchement |
| C-CRYPTO-01 | `Math.random()` alimentant une variable dont le nom évoque un usage de sécurité (token, jeton, secret, clé, password, nonce, salt, uuid, session, csrf) | majeur, probable |

**C-FINGERPRINT / C-PERSIST / C-CLIP — ajouts RSSI**
| Règle | Déclenchement | Sévérité |
|---|---|---|
| C-FINGERPRINT-01 | Lecture de `navigator.webdriver` (détection d'automatisation, contournement possible de l'audit) | majeur, probable |
| C-PERSIST-01 | Enregistrement d'un Service Worker ou usage de la Cache API | majeur |
| C-CLIP-01 | Lecture du presse-papiers (`clipboard.read`/`readText`) : derrière un geste explicite de l'agent (clic, touche) → mineur, probable ; sans geste identifiable → majeur, certain |

**C-SURFACE — ce que l'audit n'a pas pu lire**

Un audit qui ne dit pas ce qu'il n'a pas vu se lit comme un audit qui n'a rien
trouvé. Tout code que la page exécute et que tu n'as pas pu lire se déclare
ici, avec le fichier et la cause, plutôt que d'être supposé sain. Chacun de ces
constats est bloquant et empêche les axes que le code non lu aurait nourris
(3.4) : un widget qui s'arrange pour qu'on ne le lise pas ne note jamais mieux
que s'il s'était laissé lire.

| Règle | Déclenchement | Sévérité |
|---|---|---|
| C-SURFACE-01 | Un plafond de l'inventaire est atteint (nombre de fichiers, volume de texte lu, entrées de dossier parcourues, résolutions d'adresse ou arêtes de document de la fermeture) : ce qui est au-delà n'a été ni inventorié ni lu | **critique, BLOQUANT** ; axes A, B, C, E, F empêchés |
| C-SURFACE-02 | Un fichier de code que la page atteint n'a pas été lu (trop gros, plafond cumulé atteint, lecture refusée, extension de binaire chargée comme du code) : un constat par fichier, les plus gros d'abord, puis un constat qui regroupe les autres. Un fichier non lu que la page n'exécute pas (donnée, code qu'aucune page ne charge) : un seul constat groupé | **critique, BLOQUANT** ; axes B, C, E, F empêchés, et A aussi sauf pour un fichier de bibliothèque tierce ou d'un dossier exclu ; info pour le fichier que la page n'exécute pas |
| C-SURFACE-03 | Du code que le navigateur exécute et qu'aucune règle n'a pu lire : syntaxe que l'analyseur refuse (TypeScript, JSX que la page charge), imbrication que l'analyse ne porte pas, parcours qui déborde, règle qui échoue sur un code piégé. Un constat par fichier ou par script de page. Un fichier qu'aucune page n'exécute, ou que seule une import map désigne sans qu'il se lise comme du JavaScript (peut-être de la donnée) : information groupée | comme C-SURFACE-02 |

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
| D-INDISPONIBLE | Axe D non exécuté faute de pouvoir l'être (Chromium absent, bac à sable qui ne démarre pas…), la cause est dite (outil, pas ton cas — toi tu es toujours dans ce cas) | info, axe exclu du score |
| D-INDISPONIBLE-OPTION | Axe D non exécuté parce que l'utilisateur l'a demandé (`--sans-dynamique`) : une absence de mesure, non une absence de risque ; le verdict ne peut pas être « CONFORME » | info, axe exclu du score |
| D-INDISPONIBLE-BAC-A-SABLE | Axe D exécuté dans un Chromium sans bac à sable, par dérogation explicite : l'isolation de la machine est réduite, la mesure reste valable | info, n'entre pas dans le verdict |
| D-TIMEOUT-01 | Le widget ne finit pas de charger (30 s) ou le scénario ne termine pas (45 s) : un widget qui bloque le navigateur empêche la mesure | **critique, BLOQUANT**, confiance « prouvé » ; axes D et F empêchés |
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
| E-DEP-01 | `<script src="https://...">` chargeant une bibliothèque tierce à l'exécution (hors `grist-plugin-api.js`), **ou** entrée d'un `<script type="importmap">` (clés `imports`/`scopes`) résolue vers un hôte externe, **ou** module que le code JS charge par son adresse (`import`, `export … from`, `import()` à littéral : seule la clé `integrity` d'une import map de la page le protège, jamais dans un worker ni quand la carte est lue après le script) : la sévérité dépend **uniquement** de `integrity` (attribut de balise, ou clé `integrity` de premier niveau de l'import map pour ces cas) — absent → **critique, BLOQUANT** ; présent → majeur, **que la version soit figée dans l'URL ou non**. Une version non figée n'apparaît que dans le texte du constat, jamais dans la sévérité |
| E-DEP-02 | Bibliothèque tierce recopiée dans le dépôt (fichier « vendorisé ») : version ET licence identifiables en en-tête → info ; sinon → mineur |
| E-DEP-03 | (neutre) Pas de `package.json` du tout | info |
| E-DEP-04 | Dépendances npm déclarées sans fichier de verrouillage (`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`) | majeur |
| E-DEP-05 | Dépendances de production à version non figée (`^`, `~`, `*`, `latest`, `>`) | mineur |
| E-DEP-06 | Plus de 12 dépendances de production directes | mineur |
| E-VULN-00/01/02 | `npm audit` sur les dépendances verrouillées — **tu ne peux pas l'exécuter** ; voir section 6 |
| E-LIC-01 | Aucun fichier de licence à la racine : `LICENSE`, `LICENCE`, `COPYING` ou `UNLICENSE` (extension de texte facultative), `LICENSE-MIT`, `LICENSE_APACHE`, `COPYING-GPL`…, ou un fichier sous `LICENSES/` | **majeur, BLOQUANT** |
| E-LIC-02 | Licence présente : type reconnu (MIT/Apache 2.0/EUPL/BSD) → info ; GPL/AGPL → info avec réserve (effet contaminant à vérifier) ; LGPL → info avec réserve (copyleft faible, à vérifier) ; non identifiée, ou texte que tu n'as pas pu lire (trop gros, binaire) → mineur |

### Axe F — Conformité Grist.Gouv, souveraineté, accessibilité, sobriété (poids 5)

| Règle | Déclenchement | Sévérité |
|---|---|---|
| F-SOUV-01 | Référence à un service tiers non souverain identifié (Google Fonts et ses variantes statiques, Google Analytics, Google Tag Manager, Meta/Facebook, DoubleClick, Hotjar, Sentry hébergement mutualisé, jsDelivr, unpkg, cdnjs, OpenAI, Anthropic) | majeur, par service distinct |
| F-RGAA-00 | (rappel systématique) La vérification RGAA statique est partielle | info |
| F-RGAA-01 | `<html>` sans attribut `lang` | mineur |
| F-RGAA-02 | Page sans `<title>` non vide | mineur |
| F-RGAA-03 | `<img>` sans attribut `alt` | mineur |
| F-RGAA-04 | Champ de formulaire sans `<label for>`/`aria-label`/`aria-labelledby`/`title` | mineur, probable |
| F-RGAA-05 | Bouton sans intitulé accessible (ni texte lu par un lecteur d'écran, ni `aria-label`, `aria-labelledby` ou `title`) ; pour `<input type="button">` l'intitulé est sa `value`, pour `<input type="image">` son `alt` | mineur, probable |
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
  (section 4), le nombre d'occurrences pénalisantes, la pénalité calculée
  comme en 3.2 (par rang, une `info` jamais comptée) et la pénalité obtenue.
- La pénalité brute totale de l'axe et le score d'axe (formule 3.3), calcul
  montré. Un axe non exécuté, partiel ou empêché le dit (3.4), avec sa cause.

Ensuite :
- **Score global** (formule 3.4), calcul montré, et **verdict** (section
  3.5) avec son motif.
- **Score global hors axe D** (voir section 6, point 3), pour la
  comparaison honnête.
- La liste des constats bloquants, à part, en tête de synthèse.
- Un tableau récapitulatif : axe, poids, score, pénalité brute, nombre de
  constats par sévérité.

Enfin, section séparée : la section 8 ci-dessous (jugements et critères
additionnels, hors barème). En usage *complément* (8.1), ton rapport se limite
à cette section : il renvoie aux constats de l'outil par leur identifiant et
ne refait ni les pénalités ni les scores.

---

## 8. Jugements que l'outil ne fait pas, et critères additionnels (hors barème)

**Rien de cette section ne modifie le score global reproduit en section 7** :
un jugement ne note jamais. L'outil algorithmique mesure ce qui se décide sur
un fait lisible (une fonction de plus de quatre-vingts lignes, un bloc copié,
une requête vers un hôte externe) ; il ne juge pas ce qui demande de comprendre
le widget (ce qu'il doit faire, d'où viennent ses données, si une complexité
est justifiée). Ce jugement est le tien, et il complète la mesure sans la
refaire.

### 8.1 Deux usages

- **Reproduction** (par défaut) : tu n'as que le code. Tu reproduis la grille
  (sections 3 à 7), puis tu fais les jugements de 8.3.
- **Complément** : on te donne en plus le rapport de l'outil (identifiants de
  règle, `fichier:ligne`, confiance). Tu ne le refais pas : tu cites
  l'identifiant d'un constat déjà posé au lieu de le reformuler, tu tranches
  ceux qui ne sont que des signaux, puis tu fais les jugements de 8.3. Tranche
  un signal quand une lecture le confirme ou l'infirme, avec l'emplacement qui
  le prouve : un constat `probable` ou `à vérifier`, un clone court que
  A-DUP-01 a rendu, une information (A-PERF-01 et 02, A-DUP-00, un fichier que
  la page ne charge pas, une dépendance que l'outil n'a pas pu juger). Dis
  « confirmé », « infirmé » ou « indécidable » et pourquoi ; ne change jamais
  la sévérité ni le score de l'outil.

### 8.2 Règles communes à tout jugement

1. **Un faux constat est le pire défaut.** Cite `fichier:ligne`, recopie deux
   lignes de code au plus, propose une correction. Quand la lecture ne donne
   rien, écris « aucun constat sur ce point » : ne force pas une case.
2. **Une absence se prouve en disant ce qui a été cherché** (« aucun appel à
   `x` dans les fichiers a, b, c »). Un fichier minifié ou que tu n'as pas pu
   lire est déclaré « non lu », jamais jugé.
3. **Ne répète pas une règle de la section 5** : si elle a posé le constat,
   cite son identifiant ; n'ajoute que ce qu'elle ne tranche pas.
4. **Un jugement se propose en `info`** : il ne note jamais. Il a la même
   exigence de trois éléments que la section 4 (emplacement, explication,
   action corrective), et, quand il pourrait un jour devenir une règle,
   pourquoi.

### 8.3 Ce que le code du widget doit être, et ce que tu en juges

Le code d'un widget doit être court et concis, efficient, sans code mort ni
dupliqué, aux fonctions claires, dans un périmètre fonctionnel délimité et
abouti. Pour chacun de ces critères, ce que tu juges est ce que l'outil ne peut
pas décider.

**Périmètre fonctionnel : délimité et abouti.**
- *Un seul métier ?* Lis la description (`package.json`, README), chaque page
  d'entrée et ce que son code lit et écrit dans Grist ; dis en une phrase chaque
  métier, avec le `fichier:ligne` d'un point d'entrée ou d'une écriture de
  chacun. Conclus à plusieurs métiers seulement si rien ne les relie (aucun
  appel de l'un à l'autre, aucune donnée ni option partagée) et si le README
  n'annonce pas un produit unique ; jamais sur le nombre de pages, de lignes ou
  d'API utilisées.
- *La description correspond-elle au code ?* Pour chaque fonctionnalité
  annoncée, cite le `fichier:ligne` qui la réalise ; pour chaque comportement
  important que la description ne dit pas (écriture dans le document, lecture de
  l'URL, appel réseau), cite l'endroit du code. Formule « le README annonce X,
  le code fait Y ». Ne répète pas B-DOC-03 et B-DOC-04.
- *Abouti ?* Pour chaque bouton, chaque abonnement à Grist et chaque option
  annoncée, suis le chemin « événement, fonction appelée, effet » et signale
  celui qui s'arrête (appel mis en commentaire, fonction qui ne fait que
  journaliser, « non implémenté », README « en développement »), en citant ses
  deux bouts. Cherche les chemins sans marqueur (A-DEV-03 compte les marqueurs) ;
  écris « aucun ouvrage inachevé trouvé » quand c'est le cas.
- *Le niveau d'accès demandé est-il le plus bas qui suffit ?* Relève le niveau
  et chaque appel à l'API de Grist (lecture de la table liée, `fetchTable`,
  écriture, jeton d'accès, action de schéma, table `_grist_*`), puis dis quel
  est le niveau le plus bas qui les couvre, en citant l'appel qui impose ce
  niveau. Si le widget lit le niveau accordé (`accessLevel`) et s'y adapte,
  `full` est peut-être facultatif. Ne recommande jamais `read table` sans avoir
  établi qu'aucun appel n'exige davantage.
- *Une configuration cachée dans l'adresse de la page ?* Cherche
  `location.search`, `location.hash`, `URLSearchParams` : dis ce que chaque
  paramètre commande et si le README le documente (un indicateur de démonstration
  n'est pas un défaut en soi).
- *Un repli hérité qui ne sert plus ?* Quand le résultat de
  `grist.mapColumnNames` est testé (`mapped || …`), ne le signale que si tu peux
  dire pourquoi il ne peut plus s'exécuter ; sinon c'est une compatibilité
  voulue.
- *Un écouteur ajouté à chaque donnée reçue ?* Un `addEventListener` sur `window`
  ou `document` dans `onRecord`, `onRecords` ou `onOptions` s'ajoute à chaque
  appel : dis s'il est retiré ou protégé, sinon propose de le poser au chargement.

**Efficience.** L'outil signale deux motifs seulement (A-PERF-01 et A-PERF-02,
en information) : le coût d'une boucle dépend de la taille de la table, que le
code ne dit pas. Pour tout motif coûteux que tu repères, **dis d'où vient la
collection** : issue des lignes de la table (elle peut atteindre des milliers)
ou du schéma, de l'interface, de paramètres (quelques dizaines) ? N'écris un
constat que si elle vient des lignes de la table ou d'une saisie non bornée, en
nommant la collection, la boucle et ce qui la remplacerait (`Map`, `Set`, un tri
avant la boucle) ; sinon « sans conséquence ». Pistes : recherche linéaire
(`find`, `includes`, `indexOf`, `filter`) dans une boucle sur les lignes ; boucles
imbriquées sur deux collections de lignes ; accumulateur recopié à chaque tour
(`acc = [...acc, x]`) ; rendu entier refait à chaque `onRecords` alors qu'une mise
à jour partielle suffirait ; opération linéaire répétée à chaque déplacement du
curseur ; sondage de l'API de Grist alors que `onRecords` pousse déjà les
changements ; `grist.ready` appelé plusieurs fois ; écriture dans `onRecords` non
conditionnée (boucle d'écho) ; conteneur de portée module qui grossit à chaque
événement sans purge ; écouteur de `scroll`, `resize`, `mousemove` ou `input` dont
le gestionnaire redessine ou interroge Grist sans anti-rebond ; expression
régulière à quantificateurs imbriqués appliquée à une cellule. **Pour chaque
piste, demande-toi si la complexité est justifiée** (ordre des écritures, limite
de débit, taille connue et petite) : si oui, ne la signale pas.

**Code mort, au-delà de A-MORT-01.** Tableaux, objets, `Map` ou `Set` remplis
sans jamais être lus ; propriétés CSS inconnues ou valeurs invalides que le
navigateur ignore en silence ; ce que le widget déclare (options, colonnes
requises, boutons, panneaux, gestionnaires) sans que le code le lise ou
l'affiche ; fichiers que la page ne charge pas (ni tests, ni outillage, ni
documentation) : pour chacun, dis s'il est utile (chargé dynamiquement, cité par
la configuration de construction) ou un reste. Une déclaration n'est « jamais
lue » que si tu as cherché dans tous les fichiers, page HTML et scripts inline
compris.

**Duplication, au-delà de A-DUP-01.** Deux blocs de plus de six lignes qui se
ressemblent sans être identiques : se factorisent-ils en une fonction
paramétrée plus courte et aussi lisible ? Si la factorisation compliquerait la
lecture, ou si les deux blocs doivent pouvoir diverger, ne le signale pas. Pour
un clone court que l'outil a rendu, dis en une phrase s'il vaut la peine d'être
factorisé ou s'il est lisible tel quel (étapes parallèles, amorçage,
configuration).

**Fonctions et noms clairs.** Au plus cinq noms de fonctions ou de variables qui
ne disent pas ce qu'ils font ou contiennent (`html` pour une fonction, `data`,
`res`, `doStuff`), avec le nom proposé — pas les idiomes (`t`, `el`, `e`, `i`) ;
les fautes de frappe dans un nom exporté ou répété ; parmi les fonctions que
A-FONC-02 signale, dis si un humain peut les suivre (table de correspondance
lisible) ou s'il faut tenir quatre conditions en tête — une cascade de gardes
ou un aiguillage par type n'est pas un défaut ; les valeurs qui portent une
règle métier qu'on ne devine pas (une marge de 560, un code de touche 32) ;
l'état partagé, regroupé et nommé ou dispersé en cinq variables réaffectées
dans six fonctions.

**Commentaires : l'utilité, jamais la quantité.** Un commentaire apprend-il ce
que le code ne dit pas (pourquoi, contrainte de Grist, cas limite) ? Un bloc de
plus de vingt lignes documente-t-il une intention encore vraie, ou raconte-t-il
un historique ? Une fonction dont presque chaque instruction est commentée
raconte-t-elle des étapes qui répètent le code ? Du code mis en commentaire
est-il un reste ?

### 8.4 Autres critères

Tout ce que tu as remarqué en auditant ce widget et qui n'est couvert ni par la
section 5 ni par 8.3, si tu le juges réellement pertinent pour un hébergement
sur une instance Grist officielle, y compris un motif repéré hors de la surface
exécutée (script de développement non branché, prototype). Pour chacun : la
même exigence de trois éléments (emplacement, explication, action corrective),
plus une sévérité proposée et pourquoi tu penses que ça mériterait d'entrer un
jour dans le référentiel. C'est un espace pour proposer, pas pour corriger le
barème toi-même.

---

## Rappel final

Les trois éléments de chaque constat (emplacement, explication, action
corrective) et la séparation stricte entre le score reproduit (sections 5-7)
et tes jugements et propositions (section 8) sont les deux exigences sur
lesquelles ce prompt ne transige pas. Un faux constat est le pire défaut :
quand la lecture ne donne rien, dis « aucun constat sur ce point ». Tout le
reste — formulation, longueur, ton — est à ton appréciation, du moment que le
calcul reste vérifiable par un lecteur humain qui reprendrait tes chiffres à
la main.
