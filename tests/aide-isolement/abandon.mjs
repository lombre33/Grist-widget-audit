// L'abandon de V8 (SIGABRT), avec ou sans le texte qu'il écrit d'ordinaire sur la sortie d'erreur.
import fs from 'node:fs';

export async function executer(entree, { etape, partiel }) {
  etape('regles');
  partiel({ vu: 'partiel' });
  if (entree.bruit) fs.writeSync(2, `${'x'.repeat(entree.bruit)}\n`);
  if (entree.texteDuTas) fs.writeSync(2, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n');
  // Le message d'un abandon du compilateur d'expressions régulières de V8 (ce que provoquait le piège des « x=>{ » imbriqués avant b3d12ba, qui ne l'abandonne plus : cet enfant factice est la seule façon de l'éprouver), suivi de sa trace native : plusieurs Kio, le message au-dessus.
  if (entree.textePileRegexp) {
    const trace = Array.from({ length: entree.trace ?? 40 }, (_, i) => `${String(i + 1).padStart(2)}: 0x${(0x121e1a7 + i * 4096).toString(16)} ${'v8::internal::RegExpImpl::IrregexpExec(v8::internal::Isolate*, v8::internal::Handle<v8::internal::JSRegExp>) '.repeat(2)}${i} [/opt/node22/bin/node]`);
    fs.writeSync(2, `${entree.prefixe ?? ''}FATAL ERROR: RegExpCompiler Allocation failed - process out of memory\n----- Native stack trace -----\n\n${trace.join('\n')}\n`);
  }
  process.kill(process.pid, 'SIGABRT');
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
