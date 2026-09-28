import { Tokenizer } from 'parse5';

/**
 * Le découpeur de parse5 (l'automate du standard HTML), à un détail près :
 * pour écarter un attribut en double, parse5 relit tous les attributs déjà
 * lus de la balise, ce qui rend une balise à des dizaines de milliers
 * d'attributs quadratique. Un ensemble de noms fait le même tri (le premier
 * attribut d'un nom est gardé, comme dans le navigateur). Repose sur
 * `_leaveAttrName`, `currentToken` et `currentAttr`, internes à parse5 : sa
 * version est épinglée dans package.json, et un test chronométré surveille
 * la sous-classe.
 */
export class Decoupeur extends Tokenizer {
  _leaveAttrName() {
    const balise = this.currentToken;
    balise.nomsVus ??= new Set();
    if (balise.nomsVus.has(this.currentAttr.name)) return;
    balise.nomsVus.add(this.currentAttr.name);
    balise.attrs.push(this.currentAttr);
  }
}
