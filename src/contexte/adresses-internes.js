/**
 * Une adresse IP est-elle interne (boucle locale, réseau privé, lien local, etc.) ? Partagé par la validation de l'hôte cloné (bin/gwaudit.js)
 * et par le téléchargement des bibliothèques d'un widget (runtime/grist-reel/bibliotheques.js) : dans les deux cas, une adresse interne est refusée.
 */
import net from 'node:net';

export function estAdresseInterne(adresse) {
  if (net.isIPv4(adresse)) {
    const [a, b] = adresse.split('.').map(Number);
    return a === 127 || a === 10 || a === 0
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(adresse)) {
    const a = adresse.toLowerCase();
    // IPv4 inscrit dans une adresse IPv6 (::ffff:a.b.c.d) : l'analyseur d'URL le
    // réécrit en hexadécimal (::ffff:7f00:1), forme que l'ancien test textuel
    // « ::ffff:127. » ne reconnaissait pas. On décode les 32 derniers bits et on
    // juge l'adresse IPv4 obtenue.
    const inscrit = /^(?:0{0,4}:){0,5}(?:ffff:)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(a);
    if (inscrit) {
      const v4 = inscrit[1] ?? `${parseInt(inscrit[2], 16) >> 8}.${parseInt(inscrit[2], 16) & 255}.${parseInt(inscrit[3], 16) >> 8}.${parseInt(inscrit[3], 16) & 255}`;
      return estAdresseInterne(v4);
    }
    return a === '::1' || a === '::' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
  }
  return true;
}
