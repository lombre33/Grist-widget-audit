/**
 * Différentiel Chromium de E-DEP-01 sur ce que le code charge par une adresse
 * (`import`, `export … from`, `import()`) : la règle dit « protégé » (majeur)
 * quand l'import map de la page porte à l'adresse du module une empreinte bien
 * formée ; Chromium 141 doit alors refuser le module quand l'empreinte est
 * fausse. Elle dit « exposé » (critique et bloquant) sinon ; Chromium doit
 * alors l'exécuter malgré l'empreinte fausse. Une règle qui dirait « protégé »
 * là où Chromium exécute blanchirait ce que le navigateur ne garantit pas ; une
 * règle qui dirait « exposé » là où Chromium refuse ferait un faux constat.
 *
 * Chaque cas est joué trois fois (empreinte fausse : le différentiel ; juste et
 * aucune : le module tourne, ce qui prouve que le montage n'est pas la cause d'un
 * refus), page seule et dans un iframe d'une autre origine (Grist affiche
 * toujours le widget dans un iframe), en navigation privée ; avec un profil
 * persistant aussi si `GWAUDIT_SONDE_PROFILS=prive,persistant`. Le « tiers » est
 * `cdn.localhost`, une autre origine que la page (`widget.localhost`) qui ne se
 * confond pas avec `localhost` pour la règle ; Chromium résout `*.localhost`
 * vers la machine et le traite comme un contexte sûr. Ce que le module fait
 * quand il tourne : une requête d'une ligne au serveur d'essai.
 *
 * Sans Chromium le test ÉCHOUE (GWAUDIT_SUITE_SANS_CHROMIUM=1 le saute, et cela se voit).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { auditer, page } from './aide-surface.mjs';
import { chromiumIndisponible } from './aide-chromium.mjs';

const H = { cdn: 'cdn.localhost', widget: 'widget.localhost', externe: 'externe.localhost' };
const MOD = (corps) => `<script type="module">\n${corps}\n</script>`;
const empreinte = (algo, contenu) => `${algo}-${crypto.createHash(algo).update(contenu).digest('base64')}`;

// [id, nom, ce que Chromium fait de l'empreinte fausse (true : refuse), fichiers(c), options]
// options : algo (sha384 par défaut), variantes (['faux', 'juste', 'sans'] par défaut), morceaux (page livrée en deux morceaux), lent (worker, service worker, worklet : l'exécution suit la requête de bien après), corps (le code du module tiers, quand l'exécution ne peut pas se voir par un `fetch` : un worklet n'en a pas), regleStricte (la règle expose ce que Chromium refuse seulement à cause de la livraison),
// limite (une limite connue de l'audit : la règle ne voit pas ce que Chromium exécute ; le cas exige qu'elle ne le voie pas, et échoue le jour où elle le voit, pour que la limite soit retirée)
const CAS = [
  // --- les contextes de document : l'empreinte s'applique
  ['module-import', 'module de la page : import statique', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carte()) })],
  ['module-export-from', 'module de la page : export * from', true, (c) => ({ 'index.html': page(MOD(`export * from "${c.U}";`), c.carte()) })],
  ['module-import-dyn', 'module de la page : import()', true, (c) => ({ 'index.html': page(MOD(`import("${c.U}");`), c.carte()) })],
  ['classique-import-dyn', 'script classique de la page : import()', true, (c) => ({ 'index.html': page(`<script>import("${c.U}");</script>`, c.carte()) })],
  ['module-src', 'module .js chargé par la page : import statique', true, (c) => ({
    'index.html': page('<script type="module" src="app.js"></script>', c.carte()),
    'app.js': `import "${c.U}";\n`,
  })],
  ['module-chaine', 'module atteint par un autre module : import statique', true, (c) => ({
    'index.html': page('<script type="module" src="app.js"></script>', c.carte()),
    'app.js': 'import "./b.js";\n',
    'b.js': `import "${c.U}";\n`,
  })],

  // --- un worker n'hérite jamais de l'empreinte de la page
  ['worker-module-import', 'Worker module : import statique', false, (c) => ({
    'index.html': page(MOD('new Worker("w.js", { type: "module" });'), c.carte()),
    'w.js': `import "${c.U}";\n`,
  }), { lent: true }],
  ['worker-classique-import-dyn', 'Worker classique : import()', false, (c) => ({
    'index.html': page(MOD('new Worker("w.js");'), c.carte()),
    'w.js': `import("${c.U}");\n`,
  }), { lent: true }],
  ['worker-module-import-dyn', 'Worker module : import()', false, (c) => ({
    'index.html': page(MOD('new Worker("w.js", { type: "module" });'), c.carte()),
    'w.js': `import("${c.U}");\n`,
  }), { lent: true }],
  ['sharedworker-module', 'SharedWorker module : import statique', false, (c) => ({
    'index.html': page(MOD('new SharedWorker("w.js", { type: "module" });'), c.carte()),
    'w.js': `import "${c.U}";\n`,
  }), { lent: true }],
  ['worker-blob', 'Worker construit depuis un Blob littéral : import statique', false, (c) => ({
    'index.html': page(MOD(`new Worker(URL.createObjectURL(new Blob(['import "${c.U}";'], { type: 'text/javascript' })), { type: 'module' });`), c.carte()),
  }), { lent: true }],
  ['worker-partage', 'fichier chargé par la page ET par un worker', false, (c) => ({
    'index.html': page(`<script type="module" src="lib.js"></script>${MOD('new Worker("lib.js", { type: "module" });')}`, c.carte()),
    'lib.js': `import "${c.U}";\n`,
  }), { lent: true }],
  ['worker-empaqueteur', 'new Worker(new URL("./w.js", import.meta.url)) : adresse écrite, w.js importe', false, (c) => ({
    'index.html': page(MOD('new Worker(new URL("./w.js", import.meta.url), { type: "module" });'), c.carte()),
    'w.js': `import "${c.U}";\n`,
  }), { lent: true }],
  ['worker-empaqueteur-sans-import', 'new Worker(new URL("./w.js", import.meta.url)) suivi comme une adresse écrite : l\'import du module de la page reste protégé', true, (c) => ({
    'index.html': page(MOD(`import "${c.U}";\nnew Worker(new URL("./w.js", import.meta.url), { type: "module" });`), c.carte()),
    'w.js': 'self.postMessage(1);\n',
  }), { lent: true }],
  ['worker-adresse-calculee', 'worker à adresse calculée : l\'import du module de la page ne compte plus comme protégé, un worker peut exécuter n\'importe quel fichier', false, (c) => ({
    'index.html': page(`${MOD(`import "${c.U}";`)}${MOD('const nom = ["w", "js"].join(".");\nnew Worker(nom, { type: "module" });')}`, c.carte()),
    'w.js': `import "${c.U}";\n`,
  }), { lent: true }],
  ['service-worker', 'service worker module : import statique', false, (c) => ({
    'index.html': page(MOD('navigator.serviceWorker.register("sw.js", { type: "module" });'), c.carte()),
    'sw.js': `import "${c.U}";\n`,
  }), { lent: true }],
  ['worklet', 'module de worklet audio : import statique (l\'exécution se voit à l\'enregistrement d\'un processeur, un worklet n\'a pas de fetch)', false, (c) => ({
    'index.html': page(MOD(`const ctx = new AudioContext();\nctx.audioWorklet.addModule("m.js").then(() => { new AudioWorkletNode(ctx, "ran-${c.cle}"); fetch("${c.ran}", { mode: "no-cors" }); }).catch(() => {});`), c.carte()),
    'm.js': `import "${c.U}";\n`,
  }), { lent: true, corps: ({ cle }) => `registerProcessor("ran-${cle}", class extends AudioWorkletProcessor { process() { return true; } });\n` }],

  // --- un iframe ouvre un autre document, avec ses propres cartes
  ['iframe-fille-sans-carte', 'page fille en iframe sans carte : celle de la parente ne la couvre pas', false, (c) => ({
    'index.html': page('<iframe src="fille.html"></iframe>', c.carte()),
    'fille.html': page(MOD(`import "${c.U}";`)),
  }), { limite: 'un iframe local n\'est pas suivi : la page fille n\'est pas dans la surface (étapes « scripts hors surface » et « iframes locaux »)' }],
  ['iframe-fille-avec-carte', 'page fille en iframe avec sa propre carte', true, (c) => ({
    'index.html': page('<iframe src="fille.html"></iframe>'),
    'fille.html': page(MOD(`import "${c.U}";`), c.carte()),
  }), { limite: 'un iframe local n\'est pas suivi : la page fille n\'est pas dans la surface (étapes « scripts hors surface » et « iframes locaux »)' }],
  ['iframe-fille-module-src', 'module .js de la page fille : la carte de la parente ne le couvre pas', false, (c) => ({
    'index.html': page('<iframe src="fille.html"></iframe>', c.carte()),
    'fille.html': page('<script type="module" src="lib.js"></script>'),
    'lib.js': `import "${c.U}";\n`,
  }), { limite: 'un iframe local n\'est pas suivi : la page fille n\'est pas dans la surface (étapes « scripts hors surface » et « iframes locaux »)' }],

  // --- les clés : comparées à l'adresse résolue, contre l'adresse de base du document
  ['cle-hote-majuscules', 'clé dont l\'hôte est en capitales', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carte(c.U.replace(H.cdn, H.cdn.toUpperCase()))) })],
  ['cle-segment-point', 'clé avec un segment /./', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carte(c.U.replace('/lib/', '/lib/./'))) })],
  ['cle-avec-requete', 'clé pour U?v=1 : ne protège pas U', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carte(`${c.U}?v=1`)) })],
  ['cle-autre-adresse', 'clé pour une autre adresse', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carte(`${c.U}.autre.js`)) })],
  ['cle-relative-sans-base', 'clé « ./module.js » sans <base> : résolue contre la page, pas contre le tiers', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carte(`./${c.nomLib}`)) })],
  ['cle-relative-base-avant', 'clé « ./module.js » après <base href> vers le tiers : protège', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `<base href="${c.origine.cdn}/lib/">${c.carte(`./${c.nomLib}`)}`) })],
  ['cle-relative-base-apres', '<base href> après la carte : ne change pas la clé', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `${c.carte(`./${c.nomLib}`)}<base href="${c.origine.cdn}/lib/">`) })],
  ['cle-sha256', 'empreinte sha256', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carte()) }), { algo: 'sha256' }],
  ['cle-sha512', 'empreinte sha512', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carte()) }), { algo: 'sha512' }],
  ['valeur-vide', 'valeur vide : ne protège rien', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carteBrute({ [c.U]: '' })) }), { variantes: ['faux'] }],
  ['valeur-x', 'valeur « x »', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carteBrute({ [c.U]: 'x' })) }), { variantes: ['faux'] }],
  ['valeur-md5', 'valeur md5-…', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carteBrute({ [c.U]: 'md5-AAAAAAAAAAAAAAAAAAAAAA==' })) }), { variantes: ['faux'] }],
  ['valeur-sha384-nue', 'valeur « sha384- »', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carteBrute({ [c.U]: 'sha384-' })) }), { variantes: ['faux'] }],
  ['valeur-nulle', 'valeur null', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), c.carteBrute({ [c.U]: null })) }), { variantes: ['faux'] }],

  // --- une carte que Chromium n'applique pas : placée après le premier script module
  ['carte-apres-module-en-ligne', 'carte placée après un premier script module en ligne : elle s\'applique aux imports qui la suivent', true, (c) => ({ 'index.html': page(`${MOD('/* rien */')}${c.carte()}${MOD(`import "${c.U}";`)}`) })],
  ['carte-apres-module-src', 'carte placée après un premier script module externe : elle s\'applique aux imports qui la suivent', true, (c) => ({
    'index.html': page(`<script type="module" src="rien.js"></script>${c.carte()}${MOD(`import "${c.U}";`)}`),
    'rien.js': '/* rien */\n',
  })],
  ['carte-apres-classique', 'carte placée après un script classique : elle s\'applique', true, (c) => ({ 'index.html': page(`<script>/* rien */</script>${c.carte()}${MOD(`import "${c.U}";`)}`) })],
  ['carte-apres-module-en-gabarit', 'carte placée après un module dans un <template> : elle s\'applique', true, (c) => ({ 'index.html': page(`<template>${MOD('/* rien */')}</template>${c.carte()}${MOD(`import "${c.U}";`)}`) })],
  // Une carte lue APRÈS le module qui importe : l'empreinte ne s'applique qu'aux chargements qui commencent après elle. Page livrée d'un bloc, le navigateur lit la carte avant de résoudre l'import du module ; livrée en deux morceaux, il résout l'import du premier module avant de voir la carte.
  ['module-avant-carte', 'module en ligne AVANT la carte, page livrée d\'un bloc : Chromium lit la carte avant de résoudre l\'import, la règle n\'en garantit rien', true, (c) => ({ 'index.html': page(`${MOD(`import "${c.U}";`)}<!--CHUNK-->${c.carte()}`) }), { regleStricte: 'la livraison d\'un bloc, seule, fait lire la carte avant l\'import' }],
  ['module-avant-carte-morcele', 'module en ligne AVANT la carte, page livrée en deux morceaux : le même module s\'exécute sans l\'empreinte', false, (c) => ({ 'index.html': page(`${MOD(`import "${c.U}";`)}<!--CHUNK-->${c.carte()}`) }), { morceaux: true }],
  ['module-src-avant-carte', 'module externe AVANT la carte, page livrée d\'un bloc : Chromium lit la carte avant de résoudre l\'import, la règle n\'en garantit rien', true, (c) => ({
    'index.html': page(`<script type="module" src="app.js"></script><!--CHUNK-->${c.carte()}`),
    'app.js': `import "${c.U}";\n`,
  }), { regleStricte: 'la livraison d\'un bloc, seule, fait lire la carte avant l\'import' }],
  ['module-src-avant-carte-morcele', 'module externe AVANT la carte, page livrée en deux morceaux : le même module s\'exécute sans l\'empreinte', false, (c) => ({
    'index.html': page(`<script type="module" src="app.js"></script><!--CHUNK-->${c.carte()}`),
    'app.js': `import "${c.U}";\n`,
  }), { morceaux: true }],
  // --- une balise <script src> vers le tiers, dont seule l'import map porte l'empreinte (l'attribut `integrity` est absent, vide ou mal formé)
  ['module-src-distant', '<script type="module" src> vers le tiers : l\'empreinte de la carte qui la précède s\'applique', true, (c) => ({ 'index.html': page(`<script type="module" src="${c.U}"></script>`, c.carte()) })],
  ['module-src-distant-carte-apres', '<script type="module" src> vers le tiers AVANT la carte : la balise résout son adresse avant de voir la carte', false, (c) => ({ 'index.html': page(`<script type="module" src="${c.U}"></script><!--CHUNK-->${c.carte()}`) })],
  ['module-src-distant-carte-apres-morcele', '<script type="module" src> vers le tiers AVANT la carte, page livrée en deux morceaux', false, (c) => ({ 'index.html': page(`<script type="module" src="${c.U}"></script><!--CHUNK-->${c.carte()}`) }), { morceaux: true }],
  ['classique-src-distant', '<script src> classique vers le tiers : la carte ne s\'applique pas à un script classique', false, (c) => ({ 'index.html': page(`<script src="${c.U}"></script>`, c.carte()) })],
  ['module-src-distant-attribut-vide', '<script type="module" src integrity=""> : un attribut vide l\'emporte, la carte n\'est plus consultée', false, (c) => ({ 'index.html': page(`<script type="module" src="${c.U}" integrity=""></script>`, c.carte()) })],
  ['module-src-distant-attribut-x', '<script type="module" src integrity="x"> : un attribut mal formé l\'emporte, la carte n\'est plus consultée', false, (c) => ({ 'index.html': page(`<script type="module" src="${c.U}" integrity="x"></script>`, c.carte()) })],
  ['carte-apres-module-vide', 'carte placée après un script module vide (rien à exécuter)', true, (c) => ({ 'index.html': page(`<script type="module"></script>${c.carte()}${MOD(`import "${c.U}";`)}`) })],
  ['carte-apres-classique-import-dyn', 'carte placée après un script classique qui a résolu un import() d\'un autre module', true, (c) => ({ 'index.html': page(`<script>import("./rien-du-tout.js").catch(() => {});</script>${c.carte()}${MOD(`import "${c.U}";`)}`) })],
  ['carte-seconde-apres-module', 'deux cartes, un module entre elles : la seconde (empreinte fausse) s\'applique', true, (c) => ({ 'index.html': page(`${c.carteBrute({ 'http://inutile.localhost/x.js': c.integrite })}${MOD('/* rien */')}${c.carte()}${MOD(`import "${c.U}";`)}`) })],
  // --- deux valeurs pour la même adresse (deux clés, ou deux cartes) : Chromium 141 suit la spécification, la dernière clé d'une carte, la première carte
  ['cles-doublon-vide-puis-empreinte', 'deux clés à la même adresse : valeur vide, puis empreinte fausse (la dernière s\'applique)', true, (c) => ({
    'index.html': page(MOD(`import "${c.U}";`), c.carteBrute({ [c.U]: '', [c.U.replace(H.cdn, H.cdn.toUpperCase())]: c.integrite })),
  }), { variantes: ['faux'] }],
  ['cles-doublon-empreinte-puis-vide', 'deux clés à la même adresse : empreinte fausse, puis valeur vide (la dernière s\'applique)', false, (c) => ({
    'index.html': page(MOD(`import "${c.U}";`), c.carteBrute({ [c.U]: c.integrite, [c.U.replace(H.cdn, H.cdn.toUpperCase())]: '' })),
  }), { variantes: ['faux'] }],
  ['cartes-empreinte-puis-vide', 'deux cartes : la première protège (empreinte fausse), la seconde met une valeur vide (la première s\'applique)', true, (c) => ({
    'index.html': page(MOD(`import "${c.U}";`), `${c.carte()}${c.carteBrute({ [c.U]: '' })}`),
  }), { variantes: ['faux'] }],
  ['cartes-vide-puis-empreinte', 'deux cartes : la première met une valeur vide, la seconde protège (empreinte fausse) (la première s\'applique)', false, (c) => ({
    'index.html': page(MOD(`import "${c.U}";`), `${c.carteBrute({ [c.U]: '' })}${c.carte()}`),
  }), { variantes: ['faux'] }],

  // --- une valeur qui n'est pas une chaîne ne nomme pas l'adresse : la carte suivante peut la protéger
  ['cartes-nulle-puis-empreinte', 'deux cartes : la première met null, la seconde protège (empreinte fausse) : null ne nomme pas l\'adresse', true, (c) => ({
    'index.html': page(MOD(`import "${c.U}";`), `${c.carteBrute({ [c.U]: null })}${c.carte()}`),
  }), { variantes: ['faux'] }],
  ['cartes-nombre-puis-empreinte', 'deux cartes : la première met un nombre, la seconde protège (empreinte fausse)', true, (c) => ({
    'index.html': page(MOD(`import "${c.U}";`), `${c.carteBrute({ [c.U]: 12 })}${c.carte()}`),
  }), { variantes: ['faux'] }],
  ['cles-nulle-puis-empreinte', 'deux clés à la même adresse : null, puis empreinte fausse (la dernière s\'applique)', true, (c) => ({
    'index.html': page(MOD(`import "${c.U}";`), c.carteBrute({ [c.U]: null, [c.U.replace(H.cdn, H.cdn.toUpperCase())]: c.integrite })),
  }), { variantes: ['faux'] }],
  ['cles-empreinte-puis-nulle', 'deux clés à la même adresse : empreinte fausse, puis null : la valeur qui n\'est pas une chaîne est ignorée, l\'empreinte reste', true, (c) => ({
    'index.html': page(MOD(`import "${c.U}";`), c.carteBrute({ [c.U]: c.integrite, [c.U.replace(H.cdn, H.cdn.toUpperCase())]: null })),
  }), { variantes: ['faux'] }],

  // --- un <link rel="modulepreload"> vers l'adresse d'un module la charge à la balise, avant que la carte suivante soit lue : le module qu'un import trouve ensuite est celui-là, sans l'empreinte. Vers un fichier local, il ne charge que ce fichier : ses imports se résolvent plus tard, avec la carte.
  ['modulepreload-distant-apres-carte', '<link rel="modulepreload"> vers le tiers APRÈS la carte, puis import : l\'empreinte s\'applique', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `${c.carte()}<link rel="modulepreload" href="${c.U}">`) })],
  ['modulepreload-distant-avant-carte', '<link rel="modulepreload"> vers le tiers AVANT la carte, page livrée d\'un bloc, puis import : le module est chargé sans l\'empreinte', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `<link rel="modulepreload" href="${c.U}">${c.carte()}`) })],
  ['modulepreload-distant-avant-carte-morcele', '<link rel="modulepreload"> vers le tiers AVANT la carte, page livrée en deux morceaux, puis import', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `<link rel="modulepreload" href="${c.U}"><!--CHUNK-->${c.carte()}`) }), { morceaux: true }],
  ['modulepreload-distant-script-src', '<link rel="modulepreload"> vers le tiers AVANT la carte, puis <script type="module" src> APRÈS elle : la balise trouve le module déjà chargé', false, (c) => ({ 'index.html': page(`<script type="module" src="${c.U}"></script>`, `<link rel="modulepreload" href="${c.U}">${c.carte()}`) })],
  ['modulepreload-distant-integrity', '<link rel="modulepreload" integrity> vers le tiers AVANT la carte : l\'attribut du lien protège le chargement qu\'il commence', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `<link rel="modulepreload" href="${c.U}"${c.integrite ? ` integrity="${c.integrite}"` : ''}>${c.carte()}`) })],
  ['modulepreload-distant-integrity-vide-apres-carte', '<link rel="modulepreload" integrity=""> vers le tiers APRÈS la carte : un attribut vide l\'emporte, la carte n\'est plus consultée pour ce lien', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `${c.carte()}<link rel="modulepreload" href="${c.U}" integrity="">`) })],
  ['modulepreload-distant-integrity-x-apres-carte', '<link rel="modulepreload" integrity="x"> vers le tiers APRÈS la carte : un attribut mal formé l\'emporte', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `${c.carte()}<link rel="modulepreload" href="${c.U}" integrity="x">`) })],
  ['modulepreload-distant-integrity-avant-carte-script', '<link rel="modulepreload" integrity> AVANT la carte, puis <script type="module" src> après elle : l\'attribut du lien protège', true, (c) => ({ 'index.html': page(`<script type="module" src="${c.U}"></script>`, `<link rel="modulepreload" href="${c.U}"${c.integrite ? ` integrity="${c.integrite}"` : ''}>${c.carte()}`) })],
  ['modulepreload-distant-hors-gabarit', '<link rel="modulepreload"> dans un <template> avant la carte : inerte, ne charge rien', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `<template><link rel="modulepreload" href="${c.U}"></template>${c.carte()}`) })],
  ['modulepreload-distant-base', '<link rel="modulepreload" href="./module.js"> sous <base> vers le tiers, AVANT la carte', false, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `<base href="${c.origine.cdn}/lib/"><link rel="modulepreload" href="./${c.nomLib}">${c.carte()}`) })],
  ['preload-script-distant-avant-carte', '<link rel="preload" as="script" crossorigin> vers le tiers AVANT la carte, puis import', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `<link rel="preload" as="script" crossorigin href="${c.U}">${c.carte()}`) })],
  ['preload-fetch-distant-avant-carte', '<link rel="preload" as="fetch" crossorigin> vers le tiers AVANT la carte, puis import', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `<link rel="preload" as="fetch" crossorigin href="${c.U}">${c.carte()}`) })],
  ['prefetch-distant-avant-carte', '<link rel="prefetch"> vers le tiers AVANT la carte, puis import', true, (c) => ({ 'index.html': page(MOD(`import "${c.U}";`), `<link rel="prefetch" href="${c.U}">${c.carte()}`) })],
  ['modulepreload-local-apres-carte', '<link rel="modulepreload"> vers lib.js APRÈS la carte, lib.js importe le tiers', true, (c) => ({
    'index.html': page('<script type="module" src="lib.js"></script>', `${c.carte()}<link rel="modulepreload" href="lib.js">`),
    'lib.js': `import "${c.U}";\n`,
  })],
  ['modulepreload-local-avant-carte', '<link rel="modulepreload"> vers lib.js AVANT la carte, page livrée d\'un bloc : les imports de lib.js se résolvent avec la carte', true, (c) => ({
    'index.html': page('<script type="module" src="lib.js"></script>', `<link rel="modulepreload" href="lib.js">${c.carte()}`),
    'lib.js': `import "${c.U}";\n`,
  })],
  ['modulepreload-local-avant-carte-morcele', '<link rel="modulepreload"> vers lib.js AVANT la carte, page livrée en deux morceaux : les imports de lib.js se résolvent quand même avec la carte', true, (c) => ({
    'index.html': page('<script type="module" src="lib.js"></script>', `<link rel="modulepreload" href="lib.js"><!--CHUNK-->${c.carte()}`),
    'lib.js': `import "${c.U}";\n`,
  }), { morceaux: true }],
];

const cheminChromium = () => {
  const impose = process.env.GWAUDIT_CHROMIUM_PATH;
  if (impose) return fs.existsSync(impose) ? impose : null;
  const defaut = chromium.executablePath();
  return fs.existsSync(defaut) ? defaut : null;
};

/** Un seul serveur pour la page, le module tiers et la balise : ce que Chromium en demande est ce que le journal garde. */
function demarrerServeur() {
  const etat = { pages: new Map(), libs: new Map(), journal: [], ran: new Map(), morcelees: new Set() };
  const serveur = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    etat.journal.push(pathname);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    if (pathname.startsWith('/ran/')) {
      etat.ran.set(pathname.slice(5), (etat.ran.get(pathname.slice(5)) ?? 0) + 1);
      res.end('ok');
      return;
    }
    const corps = etat.libs.get(pathname) ?? etat.pages.get(pathname);
    if (corps === undefined) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    if (etat.morcelees.has(pathname)) {
      // Deux morceaux, l'un après l'autre : le navigateur lit et exécute le premier avant que le second arrive.
      const [debut, ...reste] = corps.split('<!--CHUNK-->');
      res.write(debut);
      setTimeout(() => res.end(reste.join('')), 700);
      return;
    }
    res.end(corps);
  });
  return new Promise((ok) => serveur.listen(0, () => ok({ serveur, etat, port: serveur.address().port })));
}

const attendre = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function jusqua(condition, delaiMs) {
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) { if (condition()) return true; await attendre(25); }
  return condition();
}

test('E-DEP-01 face à Chromium : « protégé » exactement quand une empreinte fausse fait refuser le module', async (t) => {
  const executable = cheminChromium();
  if (!executable) { chromiumIndisponible(t, 'aucun Chromium lançable (voir GWAUDIT_CHROMIUM_PATH)'); return; }
  const profils = (process.env.GWAUDIT_SONDE_PROFILS ?? 'prive').split(',').map((p) => p.trim()).filter(Boolean);
  const { serveur, etat, port } = await demarrerServeur();
  const origine = Object.fromEntries(Object.entries(H).map(([nom, hote]) => [nom, `http://${hote}:${port}`]));
  const dossiersProfil = [];
  t.after(() => { serveur.close(); for (const d of dossiersProfil) fs.rmSync(d, { recursive: true, force: true }); });

  // Les exécutions à jouer : chaque cas et chaque variante, avec la page que la règle audite
  const executions = [];
  const variantesDe = (options) => options.variantes ?? ['faux', 'juste', 'sans'];
  // GWAUDIT_SONDE_CAS : une expression régulière sur l'identifiant, pour ne rejouer que quelques cas en cherchant (la suite entière les joue tous).
  const filtre = process.env.GWAUDIT_SONDE_CAS ? new RegExp(process.env.GWAUDIT_SONDE_CAS) : null;
  for (const [id, nom, bloque, fichiers, options = {}] of CAS) {
    if (filtre && !filtre.test(id)) continue;
    for (const variante of variantesDe(options)) {
      const cle = `${id}-${variante}`;
      const nomLib = `${cle}.js`;
      const U = `${origine.cdn}/lib/${nomLib}`;
      const ran = `${origine.cdn}/ran/${cle}`;
      const corpsLib = options.corps ? options.corps({ cle }) : `fetch(${JSON.stringify(ran)}, { mode: 'no-cors' });\n`;
      const algo = options.algo ?? 'sha384';
      const integrite = variante === 'faux' ? empreinte(algo, `faux ${cle}`) : variante === 'juste' ? empreinte(algo, corpsLib) : null;
      const carteBrute = (cles) => `<script type="importmap">${JSON.stringify({ integrity: cles })}</script>`;
      const c = {
        U, origine, nomLib, integrite, carteBrute, cle, ran,
        carte: (cleU = U, valeur = integrite) => (valeur === null ? '' : carteBrute({ [cleU]: valeur })),
      };
      executions.push({ id, nom, bloque, variante, cle, U, corpsLib, fichiers: fichiers(c), page: 'index.html', morceaux: Boolean(options.morceaux), lent: Boolean(options.lent), regleStricte: options.regleStricte ?? null, limite: options.limite ?? null });
    }
  }

  // Ce que dit la règle : « protégé » si chaque constat E-DEP-01 sur l'adresse est un majeur
  for (const e of executions) {
    const a = await auditer(e.fichiers);
    const constats = a.de('E-DEP-01').filter((x) => x.constat.includes(e.U));
    e.regle = { constats, protege: constats.length > 0 && constats.every((x) => x.severite === 'majeur') };
    for (const [chemin, contenu] of Object.entries(e.fichiers)) etat.pages.set(`/w/${e.cle}/${chemin}`, contenu);
    if (e.morceaux) etat.morcelees.add(`/w/${e.cle}/index.html`);
    etat.libs.set(`/lib/${e.cle}.js`, e.corpsLib);
    etat.pages.set(`/o/${e.cle}/outer.html`, `<!doctype html><title>o</title><iframe src="${origine.widget}/w/${e.cle}/index.html" width="600" height="400"></iframe>`);
  }

  const args = [];
  const observations = new Map();
  const jouer = async (contexte, e, embarquement, profil) => {
    const libChemin = `/lib/${e.cle}.js`;
    const compter = (chemin) => etat.journal.filter((p) => p === chemin).length;
    const [avantDemandes, avantRan] = [compter(libChemin), etat.ran.get(e.cle) ?? 0];
    const p = await contexte.newPage();
    const console_ = [];
    p.on('console', (m) => console_.push(m.text()));
    try {
      const url = embarquement === 'seule' ? `${origine.widget}/w/${e.cle}/index.html` : `${origine.externe}/o/${e.cle}/outer.html`;
      await p.goto(url, { waitUntil: 'domcontentloaded' });
      const demande = await jusqua(() => compter(libChemin) > avantDemandes, 15_000);
      // Une exécution qui arrive s'arrête d'elle-même, une qui n'arrive pas se conclut par l'attente : une page livrée en deux morceaux (le second arrive après 700 ms) n'exécute ses scripts qu'une fois lue en entier,
      // et un worker, un service worker ou un worklet démarrent bien après la requête de leur module (mesuré : plus de 400 ms).
      const execute = demande ? await jusqua(() => (etat.ran.get(e.cle) ?? 0) > avantRan, e.lent ? 4_000 : e.morceaux ? 2_500 : 1_000) : false;
      observations.set(`${e.cle}|${embarquement}|${profil}`, { demande, execute, console: console_.filter((m) => /integrity|digest|import map/i.test(m)) });
    } finally {
      // Un service worker déjà enregistré n'est pas relancé par la page suivante (elle ne fait que vérifier ses scripts, ce qui se voit dans le journal sans que rien s'exécute) : on le retire.
      for (const cadre of p.frames()) await cadre.evaluate(() => navigator.serviceWorker?.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister())))).catch(() => {});
      await p.close();
    }
  };
  const file = async (taches, parallele) => {
    const suite = [...taches];
    await Promise.all(Array.from({ length: parallele }, async () => { for (let tache = suite.shift(); tache; tache = suite.shift()) await tache(); }));
  };

  for (const profil of profils) {
    let navigateur = null;
    let contexte;
    if (profil === 'persistant') {
      const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-sonde-profil-'));
      dossiersProfil.push(dossier);
      contexte = await chromium.launchPersistentContext(dossier, { executablePath: executable, args });
    } else {
      navigateur = await chromium.launch({ executablePath: executable, args });
      contexte = await navigateur.newContext();
    }
    try {
      for (const embarquement of ['seule', 'iframe']) {
        await file(executions.map((e) => () => jouer(contexte, e, embarquement, profil)), Number(process.env.GWAUDIT_SONDE_PARALLELE) || 4);
      }
    } finally {
      await contexte.close();
      if (navigateur) await navigateur.close();
    }
  }

  for (const profil of profils) {
    for (const embarquement of ['seule', 'iframe']) {
      await t.test(`${profil}, ${embarquement === 'seule' ? 'page seule' : 'dans un iframe d\'une autre origine'} (${executions.length} exécutions)`, async (sous) => {
        const ecarts = [];
        for (const e of executions) {
          const o = observations.get(`${e.cle}|${embarquement}|${profil}`);
          const detail = `${e.nom} [${e.variante}] : Chromium ${o.demande ? (o.execute ? 'exécute' : 'refuse') : 'ne demande pas le module'}, la règle ${e.regle.protege ? 'protège' : 'expose'} (${e.regle.constats.map((x) => `${x.fichier}:${x.ligne} ${x.severite}`).join(' ; ') || 'aucun constat'})`;
          if (!o.demande) { ecarts.push(`montage : ${detail}`); continue; }
          if (e.variante === 'faux') {
            if (e.limite) {
              // Une limite connue, dite dans le cas : la règle ne voit pas ce que Chromium exécute. Le jour où elle le voit, le cas doit changer.
              if (e.regle.constats.length > 0) ecarts.push(`la limite (${e.limite}) n'existe plus, la règle voit l'import : retirer \`limite\` du cas : ${detail}`);
              else if (e.bloque !== !o.execute) ecarts.push(`ce que Chromium fait n'est pas ce qui était mesuré (${e.bloque ? 'refus' : 'exécution'} attendu) : ${detail}`);
            } else if (e.regle.constats.length === 0) ecarts.push(`la règle ne voit pas l'import : ${detail}`);
            else if (e.bloque !== !o.execute) ecarts.push(`ce que Chromium fait n'est pas ce qui était mesuré (${e.bloque ? 'refus' : 'exécution'} attendu) : ${detail}`);
            // Une règle plus stricte que Chromium, dite dans le cas (`regleStricte`) : elle expose ce que Chromium refuse ici seulement par la façon dont la page lui est livrée. Jamais l'inverse : protéger ce que Chromium exécute blanchit.
            else if (e.regle.protege !== !o.execute && !(e.regleStricte && !e.regle.protege)) ecarts.push(`écart règle / Chromium : ${detail}`);
          } else if (!o.execute) {
            ecarts.push(`le module ne tourne pas avec ${e.variante === 'juste' ? 'la bonne empreinte' : 'aucune empreinte'}, le montage est en cause : ${detail}`);
          }
        }
        assert.deepEqual(ecarts, [], `${ecarts.length} écart(s) :\n${ecarts.join('\n')}`);
        void sous;
      });
    }
  }
});
