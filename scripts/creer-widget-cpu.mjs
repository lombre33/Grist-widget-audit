// Widget de test qui charge normalement (page.goto() réussit tout de
// suite, contrairement à une boucle bloquante sur le thread principal) puis
// sature tous les cœurs CPU disponibles pendant 2 minutes via des Web
// Workers, une fois la page rendue — sert à observer ce qui borne
// réellement l'exécution de l'axe D dans ce cas (délai JS de 45s, puis
// éventuellement le plafond CPU natif), et si des processus survivent
// après la fin de l'audit.
//
// Usage : node scripts/creer-widget-cpu.mjs
// Puis  : node bin/gwaudit.js widget-cpu-test --sortie ./test-cpu --json

import fs from 'node:fs';

const html = `<!DOCTYPE html>
<html>
<body>
<script>
const nb = navigator.hardwareConcurrency || 4;
for (let i = 0; i < nb; i++) {
  const code = "const fin = Date.now() + 120000; while (Date.now() < fin) { Math.sqrt(Math.random()); }";
  const blob = new Blob([code], { type: "application/javascript" });
  new Worker(URL.createObjectURL(blob));
}
</script>
</body>
</html>
`;

fs.mkdirSync('widget-cpu-test', { recursive: true });
fs.writeFileSync('widget-cpu-test/index.html', html);
console.log('Widget créé : widget-cpu-test/index.html (charge normalement, puis sature tous les cœurs pendant 2 minutes)');
