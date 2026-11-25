# Environnement de test Grist réel (validation manuelle)

Ce dossier fait tourner une vraie instance Grist en local, pour l'étape
qu'aucune automatisation ne remplace : voir le widget fonctionner dans le
vrai produit, tel qu'un agent le verrait.

## Démarrage

```powershell
$env:GRIST_WIDGET_DIR = "C:\chemin\vers\le\widget\a-tester"
cd docker
docker compose up -d
```

(Docker Desktop est nécessaire. Pour jouer le widget dans un vrai Grist sans rien
installer ni lancer à la main, voir `gwaudit --grist-reel` dans le README.)

Puis :
1. Ouvrir http://localhost:8484, créer un compte de test et un document.
2. Ajouter une vue, choisir *Custom Widget*, et donner comme URL
   `http://localhost:8585/index.html` (adapter le nom de fichier si le point
   d'entrée du widget n'est pas `index.html` — voir le rapport de gwaudit,
   section « Contexte de l'audit », qui l'indique).
3. Observer l'écran de consentement d'accès : il doit correspondre à ce que
   `gwaudit` a trouvé dans le code (section Axe C, règles `C-GRIST-*`) et à
   ce que le README du widget documente.
4. Utiliser le widget avec de vraies données de test, y compris des cas
   limites (cellules vides, caractères spéciaux, accents).

## Pourquoi ce n'est pas ce que fait `gwaudit --dynamique`

L'axe D de l'outil (voir `docs/METHODOLOGIE.md`) exécute le widget dans un
vrai navigateur, mais face à un hôte de test qui reproduit le protocole RPC
de Grist sans être Grist : pas de moteur de calcul, pas de vraie
authentification, pas de vrai stockage de document. C'est ce qui permet de
l'exécuter à chaque audit, en quelques secondes, sans dépendre d'un accès
réseau à une image Docker ni d'un temps de démarrage de plusieurs minutes.

Cette instance réelle, elle, sert à la vérification humaine finale avant
un hébergement officiel — c'est ce que demande le guide de contribution
pour la voie B (« une vérification de sécurité supplémentaire sera menée
par l'équipe technique avant tout déploiement en production »).

## Statut

Cette pile suit la structure officielle du dépôt `gristlabs/grist-core`
(`docker-compose-examples/grist-local-testing/docker-compose.yml`) mais n'a pas
été éprouvée de bout en bout par l'outil : le réseau de l'environnement où elle a
été écrite bloquait Docker Hub. À confirmer au premier lancement réel.
