/**
 * Which way a line of story text reads, by its first strong character — the
 * rule `dir="auto"` applies to the DOM, for the text the canvas draws itself.
 * Digits and punctuation are not strong, so «٤.» and «؟» decide nothing.
 */
const FIRST_LETTER = /\p{L}/u;
const RIGHT_TO_LEFT = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

export function textDirection(text) {
  const letter = FIRST_LETTER.exec(String(text ?? ''))?.[0];
  return letter && RIGHT_TO_LEFT.test(letter) ? 'rtl' : 'ltr';
}

