// Widget de test dont le thread principal boucle indéfiniment dès le
// chargement — sert à vérifier si le plafond CPU posé sur Chromium pendant
// l'axe D (ulimit sous Linux/macOS, Job Object sous Windows) arrête
// réellement un navigateur bloqué, pas seulement s'il s'installe sans
// erreur. Une boucle sur le thread principal (pas un Worker) bloque
// l'évènement "load" : `page.goto()` finit par expirer (30s) et gwaudit
// tente alors de fermer le navigateur — s'il ne répond plus, c'est
// exactement le cas que le plafond CPU est censé couvrir.
//
// Usage : node scripts/creer-widget-cpu.mjs
// Puis  : node bin/gwaudit.js widget-cpu-test --sortie ./test-cpu --json
//
// Résultat attendu si le plafond fonctionne : la commande finit par se
// terminer d'elle-même après un peu plus d'une minute (le plafond a tué
// le processus bloqué). Si elle ne se termine jamais (Ctrl+C au bout de
// 2-3 minutes), le plafond n'a pas arrêté le navigateur bloqué.

import fs from 'node:fs';

const html = `<!DOCTYPE html>
<html>
<body>
<script>
while (true) { Math.sqrt(Math.random()); }
</script>
</body>
</html>
`;

fs.mkdirSync('widget-cpu-test', { recursive: true });
fs.writeFileSync('widget-cpu-test/index.html', html);
console.log('Widget créé : widget-cpu-test/index.html (boucle indéfiniment dès le chargement)');
