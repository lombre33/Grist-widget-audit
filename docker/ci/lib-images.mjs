// Lecture des images de base des Dockerfile de la brique (docker/execution,
// docker/egress-proxy) : partagée par tests/images-epinglees.test.mjs (chaque
// image porte une empreinte) et docker/ci/derive-empreintes.mjs (cette
// empreinte est-elle encore ce que son étiquette désigne ?).

/** Chaque FROM, avec l'image qu'il désigne une fois l'ARG dont il dépend résolu (`resolue` vaut undefined si l'ARG n'a pas de valeur par défaut). */
export function imagesDeBase(source) {
  const args = new Map([...source.matchAll(/^ARG\s+(\w+)=(\S+)/gm)].map((m) => [m[1], m[2]]));
  return [...source.matchAll(/^FROM\s+(?:--\S+\s+)?(\S+)/gim)].map((m) => {
    const brute = m[1];
    const variable = /^\$\{(\w+)\}$/.exec(brute) ?? /^\$(\w+)$/.exec(brute);
    return { brute, resolue: variable ? args.get(variable[1]) : brute, variable: variable?.[1] };
  });
}

/**
 * `mcr.microsoft.com/playwright:v1.63.0-jammy@sha256:…` → registre, dépôt, étiquette, empreinte.
 * Sans registre nommé c'est Docker Hub (registre `registry-1.docker.io`, dépôt `library/…` pour une image officielle).
 * Renvoie null pour une référence qui n'a pas d'étiquette et d'empreinte à comparer.
 */
export function analyserReference(reference) {
  const m = /^(?<nom>[^@\s]+?)(?::(?<etiquette>[\w][\w.-]{0,127}))?@(?<empreinte>sha256:[0-9a-f]{64})$/.exec(reference ?? '');
  if (!m) return null;
  let { nom } = m.groups;
  // Une étiquette est la partie après le dernier « : » SI elle ne contient pas de « / » (sinon c'est le port d'un registre) : la regex ci-dessus ne coupe qu'un « :étiquette » final.
  const premier = nom.split('/')[0];
  const registreNomme = nom.includes('/') && (premier.includes('.') || premier.includes(':') || premier === 'localhost');
  const registre = registreNomme ? premier : 'docker.io';
  let depot = registreNomme ? nom.slice(premier.length + 1) : nom;
  if (registre === 'docker.io' && !depot.includes('/')) depot = `library/${depot}`;
  return {
    registre: registre === 'docker.io' ? 'registry-1.docker.io' : registre,
    depot,
    etiquette: m.groups.etiquette ?? null,
    empreinte: m.groups.empreinte,
    reference,
  };
}
