#!/usr/bin/env node
/**
 * Reconstruit build/grist-plugin-api.js à partir des sources officielles de
 * grist-core (gristlabs/grist-core, licence Apache 2.0). Ce script clone le
 * dépôt dans un dossier temporaire, compile l'entrée officielle
 * `app/plugin/grist-plugin-api.ts` avec esbuild — exactement l'entrée que le
 * vrai `webpack.api.config.js` de Grist utilise pour produire le fichier
 * servi en production sous `/grist-plugin-api.js` — et copie le résultat.
 *
 * Pourquoi reconstruire plutôt que télécharger le fichier déjà compilé
 * (`https://docs.getgrist.com/grist-plugin-api.js`) : le dépôt fait
 * exactement ce que le guide de contribution demande aux widgets audités de
 * ne pas faire — dépendre d'un fichier récupéré à l'exécution sans contrôle
 * de version. La version vendue dans `build/` est donc reconstruite depuis
 * une référence Git figée (voir PROVENANCE.md dans ce dossier).
 *
 * Usage : node scripts/construire-grist-plugin-api.mjs [référence-git]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const REF = process.argv[2] ?? 'main';
const RACINE = path.resolve(import.meta.dirname, '..');

const tmp = mkdtempSync(path.join(tmpdir(), 'grist-core-'));
try {
  console.log(`Clonage de gristlabs/grist-core (${REF})…`);
  execFileSync('git', ['clone', '--depth', '1', '--branch', REF, 'https://github.com/gristlabs/grist-core', tmp], { stdio: 'inherit' });
  const commit = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD']).toString().trim();

  console.log('Compilation de app/plugin/grist-plugin-api.ts…');
  await esbuild.build({
    entryPoints: [path.join(tmp, 'app/plugin/grist-plugin-api.ts')],
    bundle: true, format: 'iife', globalName: 'grist', platform: 'browser', target: 'es2020',
    external: ['mousetrap'],
    absWorkingDir: RACINE,
    nodePaths: [tmp],
    outfile: path.join(RACINE, 'ressources/grist-plugin-api/grist-plugin-api.js'),
    logLevel: 'info',
  });

  cpSync(path.join(tmp, 'LICENSE'), path.join(RACINE, 'ressources/grist-plugin-api/LICENSE-grist-core-apache-2.0.txt'));
  writeFileSync(path.join(RACINE, 'ressources/grist-plugin-api/PROVENANCE.md'),
`# Provenance de build/grist-plugin-api.js

Compilé depuis \`app/plugin/grist-plugin-api.ts\` du dépôt
[gristlabs/grist-core](https://github.com/gristlabs/grist-core), licence
Apache 2.0 (voir \`LICENSE-grist-core-apache-2.0.txt\` dans ce dossier).

- Référence : \`${REF}\`
- Commit : \`${commit}\`
- Reconstruit avec : \`node scripts/construire-grist-plugin-api.mjs ${REF}\`
- Généré le : ${new Date().toISOString().slice(0, 10)}

Ce fichier n'est utilisé que par le harnais de test (axe D). Il fait jouer à
notre hôte de test le rôle de la vraie fenêtre parente Grist, en dialoguant
avec le widget audité via le protocole RPC réel (\`grain-rpc\`), sans se
substituer à une vraie instance Grist en production.
`);
  console.log('OK — build/grist-plugin-api.js régénéré, commit', commit);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
