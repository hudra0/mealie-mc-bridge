# Prompt rules for the converter

Condensed rules for the converter's system prompt, derived from `techniques.json`, `device-programs.json` (hard limits), `device-limits.json` (recommended ranges), `timing-model.json`, `units.json` and `step-patterns.md` (corpus of 2221 de-DE MC Smart recipes, October 2026). Numbers are corpus medians with the p10-p90 range in parentheses unless stated otherwise. The output recipe is German (de-DE); German phrases in quotes are the wording to use.

## Structure

- Write in the official MC style: short text steps tell the cook what to do, working steps let the machine do it. An official recipe has a median of 23 steps: 12 text, 6 scale, 5 working.
- Put one or two text or scale steps before every working step. They say what goes in, how much, how it is cut and which accessory changes. Two working steps in a row only for a continued phase, such as a second cooking stage.
- Working steps carry no description. Give them a short action title of one to three words, for example "Zerkleinern", "Andünsten", "Köcheln".
- A text step holds one or two instructions in one sentence: median 9 words, at most 240 characters; under 80 characters the title equals the text.
- Never repeat speed, temperature or time in text; the working step carries them. Minutes in text are only for work outside the machine (oven, rising, cooling).
- Each ingredient that goes into the bowl by weight gets its own scale step titled "<n> g <Zutat> ...", for example "200 g Wasser". Weights below 5 g go into a text step in Tl, Prise or Msp.
- Mention an accessory only when its state changes: "Messbecher entfernen", "Messbecher einsetzen", "Rühraufsatz einsetzen", "Kocheinsatz einsetzen", "Dampfgaraufsatz aufsetzen", each in the text right before the working step.
- After chopping, add "mit dem Spatel nach unten schieben" before the next step on the same contents.
- Do dry tasks first (grate cheese, chop herbs, grind sugar), then "umfüllen" or "beiseitestellen". Add "Mixbehälter ausspülen" when the next stage needs a clean bowl.
- Call the bowl "Mixbehälter". Start with preparation or weighing; end with one to three text steps such as "abschmecken" and "servieren".
- The total time includes oven, rising and chilling time. It is never shorter than the prep time or the summed machine time.

## Amounts and units

- Weigh everything weighable in g, liquids included: water, milk, stock and cream 1 g per ml, oil 0.92 g per ml, honey 1.4 g per ml. Never ml or l.
- Allowed units, spelled exactly: g, Stück, Tl, El (rare), Prise for 1 and Prisen for more, Msp., and an empty unit for to-taste items.
- Convert tablespoons to g (official recipes do so in 88 %). Teaspoons stay Tl for spices, salt and baking powder; 5 g or more of sugar, butter or oil becomes g.
- Round grams to the official grid: below 10 g only 5 g; 10-49 g in steps of 5; 50-249 g in steps of 10; 250-999 g in steps of 50; from 1000 g in steps of 100. Spoon amounts in wholes, halves or quarters.
- Keep Stück for eggs, garlic cloves (name "Knoblauchzehen"), herb stems (name "Petersilienstiele") and bay leaves. Vegetables that a scale step weighs get grams from `units.json` pieceWeights (onion 70 g, carrot 75 g, shallot 30 g, zucchini 200 g, tomato 100 g).
- The amount field is a bare number string with unicode fractions (½, ¼, 1 ½): no ranges, no units, no decimals for spoons. To-taste items carry the purpose in the name and an empty amount: "Salz zum Abschmecken".
- Never invent or drop a quantity. Keep the source amounts (scaled) and list anything unclear in reviewHints.

## Chopping

- Chop in manual mode at 0 °C, forward rotation, measuring cup in. Onion and garlic: speed 6 for 6 s (5-10 s, speed 5-8). Vegetables: speed 6 for 6 s (4-10 s). Herbs: speed 6 for 8 s. Nuts: speed 6 for 8 s (4-15 s). Hard cheese and chocolate: speed 8 for 10 s.
- Chopping time does not grow with the amount. For a finer result push down and add a second short step instead of a longer one.
- Turbo pulses chop coarsely: 2 s is the official standard (1-5 s), at most 20 s. Never on contents above 60 °C, never with the whisk, at most 2500 g in the bowl.
- Grind sugar, grains, spices or ground nuts at speed 8-10 for 20 s (10-60 s) in a completely dry bowl. Crush ice or frozen fruit at speed 8 for 20 s (6-45 s).
- Stir cold mixtures at speed 4 for 15-30 s (speed 4 is the mixing speed). Fold in so pieces stay whole with reverse at speed 1-3 for 20 s (10-45 s).

## Sautéing and roasting

- Sear and brown with the roasting program, which takes no speed: 130 °C for 240 s (120-420 s); 120 °C for 180 s for gentler browning. Measuring cup out. Roasting time does not depend on the mass.
- Sauté onions or vegetables without browning in manual mode at 100-120 °C, speed 1, 300 s (120-900 s), measuring cup out, reverse when diced pieces must keep their shape. The roasting program at 120-130 °C for 180 s is the alternative.
- Before sautéing: fat in a scale step and the chopped food pushed down with the spatula. After it: deglaze with liquid in a scale step.
- Toast nuts, seeds or spices without fat in manual mode at 120 °C (80-130 °C), speed 1, 300 s (120-1500 s), measuring cup out, reverse when whole nuts or seeds must stay whole; transfer them at once. The roasting program at 110-130 °C for 240 s is the alternative.

## Simmering, sauces and soups

- Simmer or cook in liquid at 100 °C, speed 1 (at most 3), 420 s (120-1200 s); the cooking goal sets the time. Reverse when pieces must stay whole; forward when the contents are puréed later.
- The first heated step after filling the bowl must cover the heat-up: about 460 s per kg of watery contents to boil, tMin = g / 1000 × 4200 × (min(T, 100) − 20) / 735 s. Official recipes give 2.3 times tMin on median.
- Split long cooking into two steps at the same temperature (for example 600 s, then 300 s at 100 °C) when ingredients go in between.
- Reduce or cook hard with the measuring cup out and the cooking basket on the lid as splash guard: 100 °C (95-120), speed 1-2, 720 s (300-2700 s). For a reduction keep the measuring cup out and extend the simmering time by these seconds; do not estimate the evaporation loss. Never reduce soups.
- Thicken (roux, béchamel, starch) at 100 °C (95-120 °C), speed 1-3, 240 s (120-720 s): starch needs at least 95 °C for at least 120 s. Add thickeners in the last 2-3 minutes or stir them into cold liquid first.
- Egg yolk and custard at most 80 °C, milk at most 95 °C. Milk rice and pudding at 80-100 °C, speed 2-3, 480 s (240-1800 s); milk rice in reverse.
- Risotto and one-pot pasta at 100 °C, speed 1, always reverse. Pasta time is the package time plus about 2 minutes.
- Jam at 100 °C (95-120), speed 2, 600 s (180-1500 s), measuring cup out, basket on the lid, at most 2500 g in the bowl.
- Melt chocolate at 50 °C, speed 1, 90-150 s; butter tolerates up to 100 °C. Warm milk and other liquids at most 95 °C, speed 1-2.
- Settings of 105-130 °C with liquid in the bowl are normal: the contents stay at the boiling point and boil harder. Official recipes use 120 °C for steaming in manual mode and for jam.

## Dough

- Dissolve yeast with liquid and a little sugar at 37 °C, speed 1, 180 s. Never above 37 °C.
- Knead yeast dough with kneading_solid_dough for 120 s (45-240 s); soft doughs such as brioche or soft rolls with kneading_soft_dough. At most 1000 g flour per kneading step. The dough rises outside the machine; the text step after names the time.
- Short crust: kneading_solid_dough for 45-120 s, or manual speed 4-6 for 20 s, with cold butter in pieces.
- Cake batter in manual mode at speed 4 for 30 s (10-60 s), flour last. Thin batters such as pancakes: kneading_liquid_dough or speed 4.
- Whip with the whisk at speed 4 at most: 90 s (15-300 s). Fit and remove the whisk in text steps; egg whites need a fat-free bowl.
- Emulsify mayonnaise and dressings in two steps: a short mix of the base, then a long step at speed 4 (up to 240 s) while the oil runs "durch die Deckelöffnung".

## Steaming

- Steaming order: water or stock in a scale step (1000 g, never below 500 g), food spread in the steamer ("im Dampfgaraufsatz verteilen"), "Dampfgaraufsatz aufsetzen", then the steaming program, which takes no temperature.
- Steaming time by load, not by mass: vegetables, potatoes and fish 900 s; meat, dumplings and desserts in moulds 1200 s; overall 480-2100 s.
- Cook a side (potatoes, rice) in the cooking basket below while the steamer runs, and count everything in the bowl toward the 3000 g limit. Official recipes also steam in manual mode at 120 °C, speed 1, when liquid in the bowl must cook too.
- Steaming longer than 30 minutes with less than 1000 g of water needs a "Wasser nachfüllen" text step.

## Purée and blend

- Purée cold contents (dips, pesto, cold soups) in manual mode at 0 °C, speed 8-10, 30 s (20-60 s), measuring cup in; push down and repeat rather than running longer.
- Purée hot soup with the measuring cup in, using the puree program for 30-60 s, or manual steps at 0 °C with rising speed, starting at speed 4 or lower (for example 10 s each at speed 4, 6 and 8). Never start hot contents at a higher speed.
- Blend drinks and smoothies in manual mode at speed 6-10 for 20 s (7-60 s), or the smoothie program for 60 s.

## Special programs

- Use only modes the member editor offers on MC3.0: kneading_solid_dough, kneading_soft_dough and kneading_liquid_dough instead of kneading; puree or manual steps instead of ramp. The device has not been tested with kneading or ramp from a member recipe.
- Rare programs: sous_vide 50-85 °C for 25-90 min; slow_cooking 70-95 °C (official 90 °C for 3-4 h); fermentation 37-40 °C for 1-12 h; cooking_eggs with size and texture; rice_cooking 1200-2400 s, which no corpus recipe uses. Use food_processor only when the installation has the attachment; replace precleaning with the text step "Mixbehälter ausspülen".

## Safety and limits

- Temperatures lie on the grid 0, 37, 40-130 °C in steps of 5. Manual speed is 1-10; there is no speed 0, and a pause is a text step.
- Manual speed at most 3 when heating or in reverse, at most 4 with the whisk; at speed 6 or more a step lasts at most 600 s. Every step except ramp has exactly one phase.
- Program steps carry no speed and no reverse; the turbo flag only on turbo steps; steaming stores 0 °C.
- At most 3000 g in the bowl at any step, 2500 g for contents that foam or boil up (milk, jam, pasta, rice, potatoes in water), 2500 g per scale step, 1000 g flour per kneading step, about 1200 g of food in the cooking basket.
- When a limit cannot be met, scale the whole recipe down and say so in reviewHints; when the bowl mass is unknown, convert pieces with pieceWeights first.
