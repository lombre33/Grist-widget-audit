#!/usr/bin/env node
/**
 * Rejoue les budgets de temps (`tests/budgets/*.budget.mjs`) : ce que la suite par défaut ne mesure jamais.
 * Voir scripts/lib/budgets.mjs pour ce qu'est un budget et pourquoi il est à part.
 *
 * Usage : node scripts/verifier-budgets.mjs [--ci] [--liste] [expression régulière sur le nom du cas]
 *
 *   (par défaut)  le budget de chaque cas, et le refus de mesurer si la machine n'est pas au calme (code 2) ;
 *   --ci          un ordre de grandeur au-dessus du budget, sans refus sous charge (le job « budgets » de .github/workflows/tests.yml) ;
 *   --liste       dit les cas et leurs budgets, sans rien exécuter.
 * Chaque cas tourne dans son propre processus, avec une limite dure au-delà de laquelle il est tué (`limite`).
 * Code de sortie : 0 tous les cas tenus, 1 un cas trop lent, fautif ou tué, 2 rien n'a pu être mesuré (machine chargée, aucun cas).
 */
import { verifierBudgets } from './lib/budgets.mjs';

process.exitCode = await verifierBudgets({ argv: process.argv.slice(2) });
