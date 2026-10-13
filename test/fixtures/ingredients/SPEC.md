# Ingredient line test set

`ingredient-lines.jsonl` has 260 lines (180 de, 80 en), one JSON object each. Every `expected` value was read and decided by hand against its input line, and the tags were cross-checked against the values (for example `range` must match `quantityMax` being set). `src/ingredients/parse.test.ts` runs the whole file as the parser gate.

```json
{
  "id": "de-111",
  "lang": "de",
  "input": "2 Dosen à 400 g Tomaten",
  "expected": {
    "quantity": 2,
    "quantityMax": null,
    "unit": "Dose",
    "food": "Tomaten",
    "note": "à 400 g",
    "optional": false,
    "parsed": true,
    "weightGrams": 400
  },
  "tags": ["container", "weight-grams", "per-unit-weight"]
}
```

## Fields

| Field       | Meaning                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| quantity    | Number or null. Lower bound for ranges. Fractions become decimals rounded to 3 places (⅓ = 0.333, ⅔ = 0.667). Compare with tolerance 0.001. |
| quantityMax | Upper bound of a range, else null.                                                                                                          |
| unit        | Normalized code (below) or null.                                                                                                            |
| food        | The food as written: trimmed, no lemmatizing (`Eiern`, `Zwiebeln` stay), no translation. Case-insensitive comparison.                       |
| note        | Everything else: prep notes, qualifiers, approximation words, parenthetical content, purpose. Informational, not gated.                     |
| optional    | See rule 11.                                                                                                                                |
| parsed      | false only for headers (rule 13). Then all other fields are empty or null.                                                                  |
| weightGrams | Present only when a gram weight is stated next to the unit (rule 6). Per unit, in grams.                                                    |

## Unit codes

Metric: `g` (g, gr, Gramm, and dag/dkg/Deka x10), `kg` (kg, Kilo), `ml` (ml, Milliliter, and cl x10), `l` (l, Liter).
German: `EL` (EL, Esslöffel, Essl.), `TL`, `Msp` (Msp., Messerspitze), `Prise` (Prise, Prisen), `Spritzer`, `Tropfen`, `Schuss`, `Stueck` (Stück, Stk., St.), `Zehe` (Zehen), `Scheibe`, `Blatt` (Blätter), `Bund`, `Stange`, `Kopf`, `Knolle`, `Dose`, `Glas` (Gläser), `Packung` (Pkg., Päckchen, Pck.), `Becher`, `Tasse`, `Wuerfel` (Würfel), `Tuete` (Tüte), `Beutel`, `Flasche`.
English: `cup`, `tbsp` (tablespoon, Tbsp, TBSP, tbsp.), `tsp` (teaspoon), `oz`, `floz` (fl oz, fluid ounce), `lb` (lbs, lb.), `pinch` (pinches), `can`, `clove`, `slice`. English words with a German code: bunch = `Bund`, head = `Kopf`, jar = `Glas`, bottle = `Flasche`, package = `Packung`.
Matching ignores case, plural and a trailing dot. A word that is not in these lists is not a unit (Handvoll, Zweige, Stiele, sticks, sprigs, handful). Then unit is null and the word stays at the start of food (tag `oov-unit`).

## Conventions

1. Numbers. Decimal comma and point both occur (`0,5 l`, `1.5 kg`). `1 1/2`, `1½` and `2 ½` are mixed numbers. Number words: ein/eine/einen, a, an, one = 1; ein halbes, einer halben, half a = 0.5. No thousands separators in this set.
2. Ranges. `2-3`, `2 – 3` (en dash), `2–3`, `2 bis 3`, `2 to 3`. quantity is the lower bound, quantityMax the upper. In `100 g bis 150 g` the unit is read once.
3. Approximations. ca., ca, circa, etwa, ungefähr, gut, knapp, about, approx. leave the quantity as written and go to note, not to food.
4. Vague amounts (einige, ein paar, etwas). quantity stays null, never a guess. A following unit is still set (`ein paar Tropfen` has unit Tropfen). Tag `vague`.
5. Commas and modifiers. The first comma outside parentheses ends the food, the rest is note. A decimal comma is not a split point. Words before the noun stay in food (`große Zwiebeln`, `gehackte Tomaten`, `large eggs`, `ground beef`, `frischer Koriander`), and so does `gr. Zwiebel`, where gr. means groß and is not a unit. Alternatives and pairs stay one food (`Butter oder Margarine`, `Salz und Pfeffer`).
6. Parentheses. Their content goes to note, never to food. When it is a weight in g or kg, weightGrams holds it in grams (`(1,2 kg)` is 1200). The same applies to `à 400 g`, `2x 400 g Dosen`, `400-g-Dose`. Volumes and ounces such as `(720 ml)` or `(14 oz)` give no weightGrams. The weight is per unit. After a container (`1 Dose (400 g)`) and with `à` or `je` it already is. After a count or a measure it weighs all pieces and is divided by quantity: `2 Zwiebeln (ca. 300 g)` gives 150. A range such as `2-3 Zwiebeln (300 g)` gives no weightGrams.
7. Containers with a size. `2x 400 g Dosen Tomaten`, `2 x 400 g cans chopped tomatoes`: quantity 2, unit Dose or can, food is the content, note is the size. `400-g-Dose Tomaten` and `1,5 l-Flasche Wasser` have no count, so quantity is 1 (tag `implied-quantity`).
8. Saft von. `Saft von 1 Zitrone` gives quantity 1, unit null, food `Zitrone`, note `Saft von`. The same for Abrieb von, Schale von, Eigelb von 2 Eiern (food `Eiern`), Juice of, Zest of. Scaling follows the fruit count, and the parser never has to invent "Zitronensaft".
9. Leading food (Monsieur Cuisine style). `Mehl 500 g`, `Zwiebeln 2 Stück`, `Knoblauchzehen 2`, `Wasser, lauwarm 250 ml`. The trailing amount is the quantity, the comma part stays in note.
10. Austrian and cl. 1 dag = 1 dkg = 1 Deka = 10 g. 1 cl = 10 ml. Quantity is multiplied, unit is g or ml. Tag `austrian` or `cl`. No note is kept for the original unit.
11. Optional. optional is true if the line contains one of: optional, nach Belieben, wenn vorhanden, falls vorhanden, nach Wunsch, if desired, if available. The phrase also stays in note. "nach Geschmack" and "to taste" are not optional.
12. Qualifier-only lines (`Salz`, `Öl zum Braten`, `Mehl für die Arbeitsfläche`, `Pfeffer aus der Mühle`, `Zucker nach Geschmack`, `etwas Zitronensaft`, `Cooking spray`). quantity null, unit null, parsed true. Purpose or qualifier goes to note.
13. Headers (`Für den Teig:`, `ZUTATEN`, `Zutaten für 4 Portionen:`, `Ingredients`, `For the sauce:`). parsed false. A digit in a header is not a quantity.
14. Noise. Repeated or leading and trailing whitespace, non-breaking spaces, bullets (`-`, `•`), a trailing dot and mixed or upper case are all ignored.

## Acceptance

A line passes when quantity, quantityMax, unit and food all match (null equals null, numbers within 0.001, unit exact, food after trim, whitespace collapse and lower-casing). For `parsed: false` lines, the parser must report parsed false.

Gate 1: at least 95 % of the 260 lines pass (at most 13 failures).
Gate 2: no phantom quantities. On the 28 lines with `expected.quantity` null (including the 6 headers) the parser must return a null quantity, with zero exceptions.

Held-out set: `held-out-lines.jsonl` has 30 lines in the same format, written after the parser rules. ho-01 to ho-06 cover flour type numbers, a case found in review; the other 24 passed unchanged when they were added. Do not tune the parser against this file; add fresh lines instead. Gate: at least 90 % exact matches, no phantom quantities, weights per unit as above.

Reported, not gated: optional accuracy, weightGrams accuracy on the 18 lines that carry one, note recall (share of expected note words found in the parser note), parsed accuracy.

## Tags

Format: metric, us-unit, unit-word, unit-map, decimal-comma, decimal-point, cl, austrian, austrian-vocab. Amounts: fraction-unicode, fraction-text, mixed-number, range, approx, vague, number-word, implied-quantity, multiplier, dual-measure, no-unit. Units: spoon, small-measure, count, container, oov-unit, ambiguous-unit. Structure: paren-weight, paren-other, weight-grams, per-unit-weight, prep-note, qualifier-only, leading-food, glued, saft-von, egg, optional, alternatives, plural, header. Noise: messy (15 lines), whitespace, trailing-dot, abbrev-dot, case, bullet, nbsp.
