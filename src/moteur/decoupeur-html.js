import { Tokenizer } from 'parse5';

/**
 * Le découpeur de parse5 (l'automate du standard HTML), à deux détails près.
 *
 * 1. Pour écarter un attribut en double, parse5 relit tous les attributs déjà
 * lus de la balise, ce qui rend une balise à des dizaines de milliers
 * d'attributs quadratique. Un ensemble de noms fait le même tri (le premier
 * attribut d'un nom est gardé, comme dans le navigateur).
 *
 * 2. Quand `enregistrer` est vrai (le texte d'un script SVG, où le navigateur
 * décode les références de caractères et les sections CDATA), chaque jeton de
 * caractères porte `origines` : pour chaque unité UTF-16 de `chars`, sa
 * position dans le source. Une référence de caractères (`&amp;`, `&#x41;`)
 * ramène toutes ses unités à son `&` ; les unités que l'automate émet avant
 * le caractère courant (un `<` qui n'ouvrait pas de balise, `]` ou `]]` dans
 * un CDATA) se placent derrière lui. Sans cela, une ligne ou une colonne
 * lue dans le texte décodé se décalerait de la longueur de ce qui a été décodé.
 *
 * Cette classe et ses appelants (`page-html.js`, et `f-conformite.js` tant
 * qu'il garde sa propre marche du découpeur) reposent sur des points internes
 * de parse5, non couverts par son numéro de version publique : la classe
 * `Tokenizer` et les exports `@internal` `TokenizerMode` (pour forcer le mode
 * d'un contenu brut, `decoupeur.state = …`) et `foreignContent` (`causesExit`,
 * pour sortir de SVG/MathML) ; sur l'instance, la propriété `state`, le
 * drapeau `inForeignNode`, et, pour ce qui précède, les méthodes
 * `_leaveAttrName` (avec `currentLocation`, l'emplacement de chaque attribut gardé,
 * `location.attrs`, comme le fait parse5 : la lecture des attributs `style` en a besoin pour donner
 * la ligne d'un `url()`), `_leaveAttrValue`, `_emitChars`, `_stateCharacterReference`,
 * `_stateCdataSectionEnd`, `_appendCharToCurrentCharacterToken` et
 * `_emitCurrentCharacterToken`, avec `currentToken`, `currentAttr`,
 * `currentCharacterToken`, `entityStartPos` et `preprocessor` (`offset`,
 * `droppedBufferSize`). On l'écoute par `write()` et un `TokenHandler`.
 * La version de parse5 est donc épinglée dans package.json, un test
 * chronométré surveille que cette sous-classe garde son coût linéaire, et un
 * test compare les positions enregistrées au source.
 */
export class Decoupeur extends Tokenizer {
  enregistrer = false;
  origines = [];
  origineEntite = null;
  avantCourant = false;
  retard = 0;

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

  _emitChars(ch) {
    if (!this.enregistrer) return super._emitChars(ch);
    this.avantCourant = true;
    try {
      return super._emitChars(ch);
    } finally {
      this.avantCourant = false;
    }
  }

  _stateCdataSectionEnd(cp) {
    if (!this.enregistrer) return super._stateCdataSectionEnd(cp);
    // Sur un troisième `]`, l'automate émet le plus ancien des deux `]` en attente.
    this.retard = cp === 0x5d ? 1 : 0;
    try {
      return super._stateCdataSectionEnd(cp);
    } finally {
      this.retard = 0;
    }
  }

  _stateCharacterReference() {
    if (!this.enregistrer) return super._stateCharacterReference();
    this.origineEntite = this.preprocessor.droppedBufferSize + this.entityStartPos;
    try {
      return super._stateCharacterReference();
    } finally {
      this.origineEntite = null;
    }
  }

  _appendCharToCurrentCharacterToken(type, ch) {
    if (!this.enregistrer) return super._appendCharToCurrentCharacterToken(type, ch);
    const { offset } = this.preprocessor;
    const debut = this.origineEntite !== null ? null : this.avantCourant ? offset - ch.length - this.retard : offset - (ch.length - 1);
    const nouvelles = [];
    for (let k = 0; k < ch.length; k++) nouvelles.push(debut === null ? this.origineEntite : debut + k);
    // Le jeton précédent, si le type change, est émis (et prend ses origines) pendant cet appel.
    super._appendCharToCurrentCharacterToken(type, ch);
    for (const origine of nouvelles) this.origines.push(origine);
  }

  _emitCurrentCharacterToken(nextLocation) {
    if (this.origines.length && this.currentCharacterToken) {
      this.currentCharacterToken.origines = this.origines;
      this.origines = [];
    }
    super._emitCurrentCharacterToken(nextLocation);
  }
}
