# Widget d'exemple

Squelette minimal, conforme au guide de contribution Grist.Gouv, utilisé
comme point d'ancrage par le mécanisme de lancement local de `gwaudit`.

**Remplacez ce contenu par votre widget, ou pointez la variable
d'environnement `GRIST_WIDGET_DIR` vers son dossier**, pour tester votre
propre code sans modifier cet exemple.

## Description

N'affiche qu'un texte fixe et appelle `grist.ready()` au chargement. Aucune
fonctionnalité au-delà de cette négociation minimale : c'est un point de
départ à copier, pas un widget à installer.

## Configuration

Aucune. Le widget déclare `requiredAccess: 'none'` (niveau d'accès minimal) :
il ne lit ni n'écrit aucune donnée du document.

## Dépendances

`grist-plugin-api.js`, chargé depuis `docs.getgrist.com` (usage de
développement courant ; un widget déployé le sert plutôt depuis sa propre
instance, voir la remédiation de la règle `C-EXFIL-04`). Aucune autre
dépendance.
