/**
 * Serveur statique minimal pour l'audit dynamique.
 *
 * Sert deux racines sous un seul port et une seule origine, pour que le
 * widget et le harnais soient perçus par le navigateur comme appartenant au
 * même site (ce qui reflète l'usage réel : Grist sert le widget depuis son
 * propre domaine) :
 *   /widget/…   → le dépôt audité
 *   /harnais/…  → hote.js, page-hote.html, axe.min.js
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

export function demarrerServeur({ widgetRacine, harnaisRacine }) {
  const serveur = http.createServer((req, res) => {
    try {
      const url = decodeURIComponent(req.url.split('?')[0]);
      let base, sousChemin;
      if (url === '/' ) { res.writeHead(302, { Location: '/harnais/page-hote.html' }); return res.end(); }
      if (url.startsWith('/widget/')) { base = widgetRacine; sousChemin = url.slice('/widget/'.length); }
      else if (url.startsWith('/harnais/')) { base = harnaisRacine; sousChemin = url.slice('/harnais/'.length); }
      else { res.writeHead(404); return res.end('Non trouvé'); }

      const abs = path.normalize(path.join(base, sousChemin));
      if (!abs.startsWith(path.normalize(base))) { res.writeHead(403); return res.end('Interdit'); }

      fs.readFile(abs, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Non trouvé : ' + sousChemin); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream' });
        res.end(data);
      });
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });

  return new Promise((resolve) => {
    serveur.listen(0, '127.0.0.1', () => {
      const { port } = serveur.address();
      resolve({ port, origine: `http://127.0.0.1:${port}`, fermer: () => new Promise((r) => serveur.close(r)) });
    });
  });
}
