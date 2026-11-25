/**
 * Serveur statique minimal pour l'audit dynamique.
 *
 * Sert deux racines sous un seul port et une seule origine, pour que le
 * widget et le harnais soient perçus par le navigateur comme appartenant au
 * même site (ce qui reflète l'usage réel : Grist sert le widget depuis son
 * propre domaine) :
 *   /widget/…   → le dépôt audité
 *   /harnais/…  → hote.js, page-hote.html, axe.min.js
 *
 * Le chargement de l'API Grist (`grist-plugin-api.js`) est l'usage normal d'un
 * widget, d'où qu'il le demande (`/grist-plugin-api.js` à la racine du site,
 * `../grist-plugin-api.js`, un sous-dossier…) : si le dépôt n'a pas son propre
 * fichier à cet endroit, le serveur sert l'API officielle fournie avec l'outil.
 * Un fichier du dépôt passe toujours avant (un widget qui embarque sa propre
 * copie est audité avec cette copie).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_GRIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../ressources/grist-plugin-api/grist-plugin-api.js');
const EST_API_GRIST = /(^|\/)grist-plugin-api\.js$/;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

export function demarrerServeur({ widgetRacine, harnaisRacine }) {
  /** Chemins pour lesquels le serveur a servi l'API officielle (le dépôt n'en avait pas) : ce qu'elle écrit dans la console n'est pas le fait du widget. */
  const apiServie = new Set();
  const serveur = http.createServer((req, res) => {
    try {
      const url = decodeURIComponent(req.url.split('?')[0]);
      let base, sousChemin;
      if (url === '/' ) { res.writeHead(302, { Location: '/harnais/page-hote.html' }); return res.end(); }
      if (url.startsWith('/widget/')) { base = widgetRacine; sousChemin = url.slice('/widget/'.length); }
      else if (url.startsWith('/harnais/')) { base = harnaisRacine; sousChemin = url.slice('/harnais/'.length); }
      else if (EST_API_GRIST.test(url)) { base = widgetRacine; sousChemin = url.slice(1); }   // racine du site du widget
      else { res.writeHead(404); return res.end('Non trouvé'); }

      const abs = path.normalize(path.join(base, sousChemin));
      if (!abs.startsWith(path.normalize(base))) { res.writeHead(403); return res.end('Interdit'); }

      const servir = (data, fichier) => { res.writeHead(200, { 'Content-Type': TYPES[path.extname(fichier).toLowerCase()] ?? 'application/octet-stream' }); res.end(data); };
      fs.readFile(abs, (err, data) => {
        if (!err) return servir(data, abs);
        if (base === widgetRacine && EST_API_GRIST.test(url)) return fs.readFile(API_GRIST, (e2, api) => { if (e2) { res.writeHead(404); return res.end('Non trouvé : ' + sousChemin); } apiServie.add(url); servir(api, API_GRIST); });
        res.writeHead(404); return res.end('Non trouvé : ' + sousChemin);
      });
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });

  return new Promise((resolve) => {
    serveur.listen(0, '127.0.0.1', () => {
      const { port } = serveur.address();
      resolve({ port, origine: `http://127.0.0.1:${port}`, apiServie, fermer: () => new Promise((r) => serveur.close(r)) });
    });
  });
}
