import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Toute image de base des Dockerfile de docker/ (image d'exécution, proxy de
 * sortie) est épinglée par empreinte : une étiquette (`debian:bookworm-slim`,
 * `:latest`) peut être repointée sur une autre image sans qu'aucun fichier du
 * dépôt ne change, et la brique livrée à qui déploiera n'est alors plus celle
 * qui a été éprouvée. Une empreinte, elle, échoue franchement si elle disparaît.
 *
 * Deux formes admises : `FROM image@sha256:…`, ou `FROM ${VARIABLE}` où
 * `ARG VARIABLE=image@sha256:…` porte l'empreinte par défaut. (Le
 * docker-compose.yml de la validation manuelle d'un widget, hors image V2,
 * veut au contraire le Grist du jour : il n'est pas concerné.)
 */
const RACINE = path.resolve(import.meta.dirname, '..');
const DOCKERFILES = ['docker/execution/Dockerfile', 'docker/egress-proxy/Dockerfile'];
const EMPREINTE = /@sha256:[0-9a-f]{64}(\s|$)/;

function images(source) {
  const args = new Map([...source.matchAll(/^ARG\s+(\w+)=(\S+)/gm)].map((m) => [m[1], m[2]]));
  return [...source.matchAll(/^FROM\s+(?:--\S+\s+)?(\S+)/gim)].map((m) => {
    const brute = m[1];
    const variable = /^\$\{(\w+)\}$/.exec(brute) ?? /^\$(\w+)$/.exec(brute);
    return { brute, resolue: variable ? args.get(variable[1]) : brute, variable: variable?.[1] };
  });
}

for (const dockerfile of DOCKERFILES) {
  test(`${dockerfile} : chaque image de base est épinglée par empreinte`, () => {
    const source = fs.readFileSync(path.join(RACINE, dockerfile), 'utf8');
    const trouvees = images(source);
    assert.ok(trouvees.length > 0, `aucune ligne FROM dans ${dockerfile} : le test ne saurait plus quoi éprouver`);
    for (const { brute, resolue, variable } of trouvees) {
      assert.ok(resolue, `FROM ${brute} : la variable ${variable} n'a pas de valeur par défaut (ARG ${variable}=image@sha256:…), l'image n'est pas déterminée par le dépôt`);
      assert.match(resolue, EMPREINTE, `FROM ${brute}${variable ? ` (${resolue})` : ''} : image non épinglée par empreinte (@sha256:…)`);
    }
  });
}
