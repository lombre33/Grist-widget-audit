import { SEVERITES } from '../moteur/modele.js';

/**
 * Export SARIF 2.1.0 — pour intégration CI (GitHub code scanning et tout
 * autre outil consommant ce format standard). Un axe sans fichier précis
 * (D, E, F pour l'essentiel) reçoit une localisation synthétique plutôt que
 * d'omettre `locations` : plusieurs ingesteurs SARIF, dont GitHub, rejettent
 * ou masquent silencieusement les résultats sans localisation.
 */
const NIVEAUX_PAR_RANG = { 4: 'error', 3: 'warning', 2: 'note', 1: 'note' };

export function genererSarif({ notation, meta }) {
  const constats = Object.values(notation.parAxe).flatMap((a) => a.constats);

  const regles = new Map();
  for (const c of constats) {
    if (!regles.has(c.regle)) {
      regles.set(c.regle, {
        id: c.regle,
        name: c.regle,
        shortDescription: { text: c.titre },
        fullDescription: { text: c.constat },
        helpUri: 'https://github.com/lombre33/Grist-widget-audit/blob/main/docs/METHODOLOGIE.md',
        properties: { axe: c.axe },
      });
    }
  }
  const listeRegles = [...regles.values()];
  const indexRegle = new Map(listeRegles.map((r, i) => [r.id, i]));

  const results = constats.map((c) => ({
    ruleId: c.regle,
    ruleIndex: indexRegle.get(c.regle),
    level: NIVEAUX_PAR_RANG[SEVERITES[c.severite].rang] ?? 'note',
    message: {
      text: [c.titre, c.constat, c.remediation ? `Remédiation : ${c.remediation}` : null].filter(Boolean).join('\n\n'),
    },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: c.fichier ?? `(analyse globale du dépôt — axe ${c.axe})` },
        ...(c.ligne ? { region: { startLine: c.ligne } } : {}),
      },
    }],
    partialFingerprints: { gwauditFingerprint: `${c.regle}:${c.fichier ?? ''}:${c.ligne ?? ''}` },
    properties: { severiteGwaudit: c.severite, confiance: c.confiance, bloquant: c.bloquant },
  }));

  return JSON.stringify({
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'gwaudit',
          informationUri: 'https://github.com/lombre33/Grist-widget-audit',
          version: meta.version,
          rules: listeRegles,
        },
      },
      results,
    }],
  }, null, 2);
}
