# Provenance de build/grist-plugin-api.js

Compilé depuis `app/plugin/grist-plugin-api.ts` du dépôt
[gristlabs/grist-core](https://github.com/gristlabs/grist-core), licence
Apache 2.0 (voir `LICENSE-grist-core-apache-2.0.txt` dans ce dossier).

- Référence : `main`
- Commit : `87eeb6ab43d6aa04a0bbfe1525f336e2223b3160`
- Reconstruit avec : `node scripts/construire-grist-plugin-api.mjs main`
- Généré le : 2026-09-19

Ce fichier n'est utilisé que par le harnais de test (axe D). Il fait jouer à
notre hôte de test le rôle de la vraie fenêtre parente Grist, en dialoguant
avec le widget audité via le protocole RPC réel (`grain-rpc`), sans se
substituer à une vraie instance Grist en production.
