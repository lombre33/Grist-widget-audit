// Sonde réseau minimale, sans dépendance : affiche SORTI si une requête HTTP
// aboutit, BLOQUE:<code> si le réseau la refuse, INCONNU:<détail> pour toute
// autre erreur. Sert deux fois dans docker/ci/verifier.sh : dans le conteneur
// d'exécution (doit être BLOQUE) puis, comme témoin, sur un réseau ouvert
// (doit être SORTI) — sans le témoin, un BLOQUE ne prouverait rien : la sonde
// ou le runner pourraient simplement être cassés. Une erreur qui n'est pas de
// nature réseau (URL invalide, port interdit à fetch…) n'est jamais comptée
// comme un blocage.
const cible = process.argv[2] ?? 'http://1.1.1.1';
const CODES_RESEAU = new Set([
  'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET',
  'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT',
]);
try {
  await fetch(cible, { signal: AbortSignal.timeout(8000) });
  console.log('SORTI');
} catch (e) {
  const causes = e.cause?.errors ?? [e.cause];
  const code = causes.map((c) => c?.code).find((c) => CODES_RESEAU.has(c));
  if (code) console.log(`BLOQUE:${code}`);
  else if (e.name === 'TimeoutError' || e.name === 'AbortError') console.log('BLOQUE:delai');
  else console.log(`INCONNU:${e.name}:${e.cause?.code ?? e.cause?.message ?? e.message}`);
}
