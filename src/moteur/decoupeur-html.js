import { Tokenizer } from 'parse5';

/**
 * Le découpeur de parse5 (l'automate du standard HTML), à un détail près :
 * pour écarter un attribut en double, parse5 relit tous les attributs déjà
 * lus de la balise, ce qui rend une balise à des dizaines de milliers
 * d'attributs quadratique. Un ensemble de noms fait le même tri (le premier
 * attribut d'un nom est gardé, comme dans le navigateur).
 *
 * Cette classe et ses appelants (`page-html.js`) reposent sur des points
 * internes de parse5, non couverts par son numéro de version publique : la
 * classe `Tokenizer` et les exports `@internal` `TokenizerMode` (pour forcer
 * le mode d'un contenu brut, `decoupeur.state = …`) et `foreignContent`
 * (`causesExit`, pour sortir de SVG/MathML) ; sur l'instance, la propriété
 * `state`, le drapeau `inForeignNode`, et — pour la déduplication des
 * attributs ci-dessous — la méthode `_leaveAttrName` avec `currentToken`,
 * `currentAttr` et `currentLocation` (l'emplacement de chaque attribut gardé,
 * `location.attrs`, comme le fait parse5 : la lecture des attributs `style`
 * en a besoin pour donner la ligne d'un `url()`). La version de parse5 est donc épinglée dans package.json, et
 * un test chronométré surveille que cette sous-classe garde son coût linéaire.
 */
export class Decoupeur extends Tokenizer {
  _leaveAttrName() {
    const balise = this.currentToken;
    balise.nomsVus ??= new Set();
    if (balise.nomsVus.has(this.currentAttr.name)) return;
    balise.nomsVus.add(this.currentAttr.name);
    balise.attrs.push(this.currentAttr);
    if (balise.location && this.currentLocation) {
      (balise.location.attrs ??= Object.create(null))[this.currentAttr.name] = this.currentLocation;
      this._leaveAttrValue();
    }
  }
}
