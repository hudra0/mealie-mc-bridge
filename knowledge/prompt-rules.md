# Prompt rules for the converter

Condensed rules for the converter's system prompt. They are derived from the knowledge base (technique table, hard device limits, recommended ranges, timing model, unit rules and step patterns of 2221 de-DE MC Smart recipes) and written as instructions; the evidence stays in the source documents. Numbers are typical values with the usual range of official recipes in parentheses. The output recipe is {{language}}; {{languageName}} phrases in quotes are the wording to use.

## Structure

- Write in the official MC style: short text steps tell the cook what to do, working steps let the machine do it. A main dish has about 20-25 steps: roughly half text steps, a quarter scale steps and a fifth working steps.
- Put one or two text or scale steps before every working step. They say what goes in, how much, how it is cut and which accessory changes. Two working steps in a row only for a continued phase, such as a second cooking stage.
- Working steps carry no description. Give them a short action title of one to three words that says what the step does, for example {{phrases:workingStepTitles}}. A turbo step's title names the seconds: "{{phrase:turboTitle}}".
- A text step holds one or two instructions in one sentence of about 9 words, at most 240 characters. Join two instructions with "{{phrase:and}}", never with a semicolon. The bridge sets a text step's title from its text, so give the title a label of a few words.
- Never repeat speed, temperature or time in text; the working step carries them. Minutes in text are only for work outside the machine (oven, rising, resting, cooling).
- Each ingredient that goes into the bowl by weight gets its own scale step titled "{{phrase:scaleTitle}}" and described "{{phrase:scaleDescription}}", for example "{{phrase:scaleExample}}". Amounts under 5 g go into a text step in {{unit:teaspoon}}, {{unit:pinch}} or {{unit:knifeTip}}.
- Weigh in the {{phrase:bowl}} only what stays in it. Ingredients for outside the machine (brushing, coating, garnish, food cooked on the stove or in the oven) stay in a text step with their amount, or a scale step weighs them in a container on top: "{{phrase:weighInContainer}}" Never weigh on a plate.
- A portion that was set aside and goes back in (collected cooking liquid, chopped herbs) keeps its name and amount: "{{phrase:returnReserved}}"
- Mention an accessory only when its state changes, each in the text right before the working step.
- After chopping, add "{{phrase:pushDown}}" before the next step on the same contents.
- Do dry tasks first (grate cheese, chop herbs, grind sugar), then "{{phrase:transfer}}" or "{{phrase:setAside}}". Herbs for finishing are chopped first, set aside and added at the end; they never cook longer than 5 minutes. Add "{{phrase:rinseBowl}}" when the next stage needs a clean bowl.
- Use the machine for every preparation it can do (toasted crumbs or nuts, a sauce, a topping) instead of sending the cook to the stove; plan it once the main mass is out of the bowl.
- Call the bowl "{{phrase:bowl}}". Start with preparation or weighing; end with one to three text steps. Savory dishes end with "{{phrase:season}}" after the last cooking step, then "{{phrase:serve}}".
- The total time includes oven, rising, resting and chilling time. It is never shorter than the prep time or the summed machine time.

## Standard phrases

- "{{phrase:measuringCupOut}}" before roasting or cooking at 100 °C or more, so steam escapes. "{{phrase:measuringCupIn}}" before cold chopping, mixing, turbo or puréeing, and again after roasting. Each is its own text step.
- "{{phrase:whiskIn}}" and "{{phrase:whiskOut}}": around whipping and gentle stirring, each in its own text step.
- "{{phrase:basketIn}}", "{{phrase:intoBasket}}", "{{phrase:basketOut}}": cooking food in the basket. "{{phrase:basketSplashGuard}}": only before reducing, jam or hard boiling, never for a normal simmer.
- "{{phrase:steamerSpread}}", then "{{phrase:steamerOn}}" right before steaming; "{{phrase:steamerOff}}" after it.
- "{{phrase:throughLid}}": adding liquid or butter while the blade runs. Oil for an emulsion goes onto the lid instead (see Dough).
- "{{phrase:intoBowl}}" and "{{phrase:add}}": the standard adding verbs.
- "{{phrase:transfer}}", "{{phrase:setAside}}": freeing the bowl after chopping. "{{phrase:rinseBowl}}": after a transfer, before a different preparation.
- "{{phrase:season}}" after the last cooking step; "{{phrase:cool}}", "{{phrase:serve}}", "{{phrase:preheatOven}}" for finishing and outside work; "{{phrase:refillWater}}" during long steaming.

## Typical sequences

- Savory cooked dishes: chop, then sauté with the roasting program, then simmer. Simmer the sauce base first; ingredients that only need heating (canned legumes, halved cherry tomatoes, frozen peas, cooked meat) go in for a last stage at 100 °C, speed 1, reverse, 300-600 s.
- Soups: chop, sauté, simmer, then purée hot as the last machine step.
- Steamed dinners: chop and prepare a sauce or side, weigh in water, then steam with the steamer on top and often a side in the basket below; the sauce follows in manual mode at 120 °C after steaming.
- Risotto and rice dishes: chop, sauté the rice, then cook at 100 °C in reverse at speed 1. One-pot pasta: chop, sear, simmer the sauce, then cook the pasta in it at 100 °C in reverse.
- Yeast dough: dissolve the yeast at 37 °C, then add the flour and knead; rising happens outside the machine. Short crust: one short kneading step.
- Cake batter: chop or grind, stir, then mix the batter at speed 4. Whip egg whites first in a clean, dry bowl with the whisk.
- Creams and desserts: stir, cook the egg-yolk base at 70-80 °C, then whip. Sauces and dips: chop, then stir; emulsions add a long speed-4 step while the oil runs in from the lid.
- Dumplings and masses bound with breadcrumbs, semolina or flour (Knödel, Nockerl): a text step rests the mass for 20-30 minutes before shaping, the shaping step names the piece size or count, and they cook "{{phrase:simmerGently}}".
- Jam: chop the fruit, heat it, then cook hard with the basket on the lid as splash guard. Drinks: crush ice or blend.
- Repeated identical steps are normal: chopping or stirring in stages, and cooking split into two stages at the same temperature (for example 600 s, then 300 s at 100 °C) when ingredients go in between.

## Amounts and units

- Weigh everything weighable in g, liquids included, with the densities of the Units section. Never ml or l.
- Convert tablespoons to g with the spoon weights of the Units section (by food). Teaspoons stay {{unit:teaspoon}} for spices, salt and baking powder; 5 g or more of sugar, butter or oil becomes g.
- Amounts under 5 g are not weighed: write them in {{unit:teaspoon}}, {{unit:pinch}} or {{unit:knifeTip}}. Round to the gram grid of the Units section only amounts you convert from another unit; keep gram amounts of the source as they are. Spoon amounts in wholes, halves or quarters.
- Counted items keep their count as the wording rules say. Vegetables that a scale step weighs get grams from the piece weights of the Units section.
- The amount field is a bare number string with unicode fractions (½, ¼, 1 ½): no ranges, no units, no decimals for spoons. To-taste items carry the purpose in the name and an empty amount: "{{phrase:toTaste}}".
- Never invent or drop an ingredient or a quantity. Keep the source amounts (scaled), changed only by unit conversion and rounding, and list anything unclear in reviewHints.
- ingredientMapping says where each ingredient-list entry comes from: one entry per ingredient-list name, written exactly as in the list, with the index [i] of the source ingredient line, or null for an ingredient the source does not have (water for steaming, say). Every source ingredient line appears in it. When two source lines become one list entry, give one mapping entry per source line with the same name; when one source line is split over two groups, one entry with that name covers both.

## Chopping

- Chop in manual mode at 0 °C, forward rotation, measuring cup in. Onion, garlic and ginger before sautéing: turbo for 2 s (1-5 s), or speed 6 for 6 s (5-10 s, speed 5-8); official recipes use both, turbo in about a third of cases. Chop a single garlic clove with other ingredients or with turbo. Vegetables: speed 6 for 6 s (4-10 s). Herbs: speed 6 for 8 s. Nuts: speed 6 for 8 s (4-15 s). Hard cheese and chocolate: speed 8 for 10 s.
- Chopping time does not grow with the amount. For a finer result push down and add a second short step instead of a longer one.
- Turbo is its own working step: 2 s is the standard (1-5 s), at most 20 s. Never on contents above 60 °C, never with the whisk, at most 2500 g in the bowl.
- Grind sugar, grains, spices or ground nuts at speed 8-10 for 20 s (10-60 s) in a completely dry bowl. Crush ice or frozen fruit at speed 8 for 20 s (6-45 s).
- Stir cold mixtures at speed 4 for 15-30 s (speed 4 is the mixing speed). Fold in so pieces stay whole with reverse at speed 1-3 for 20 s (10-45 s).

## Sautéing and roasting

- Sauté onions, garlic or vegetables with the roasting program at 130 °C for 180-240 s, or at 120 °C for a lighter result, measuring cup out; it takes no speed. Official recipes do this in about three of four cases. Use manual mode at 100 °C (80-120 °C), speed 1, 300 s only when the food must stay pale or liquid is already in the bowl, with reverse when diced pieces must keep their shape.
- Sear and brown meat or vegetables with the roasting program: 130 °C for 240 s (120-420 s). Roasting time does not depend on the mass.
- Before sautéing: fat in a scale step and the chopped food pushed down with the spatula. After it: deglaze with liquid in a scale step.
- Ground spices get one heat step only: sauté them with the onions or add them with the liquid. Tomato paste joins the sauté or goes in with the liquid; never add a second dry roasting step for it.
- Toast nuts, seeds or spices without fat in manual mode at 120 °C (80-130 °C), speed 1, 300 s (120-1500 s), measuring cup out, reverse when whole nuts or seeds must stay whole; transfer them at once. The roasting program at 110-130 °C for 240 s is the alternative.

## Simmering, sauces and soups

- Simmer or cook in liquid at 100 °C, speed 1 (at most 3), 420 s (120-1200 s); the cooking goal sets the time. Reverse when pieces must stay whole; forward when the contents are puréed later.
- Every heated step on cold contents must cover the heat-up time of the Timing section. That includes the step after cold liquid was added to sautéed food: a litre of stock cools the bowl down again.
- Reduce or cook hard with the measuring cup out and the cooking basket on the lid as splash guard: 100 °C (95-120), speed 1-2, 720 s (300-2700 s). For a reduction keep the measuring cup out and extend the simmering time by these seconds; do not estimate the evaporation loss. Never reduce soups.
- Thicken (roux, béchamel, starch) at 100 °C (95-120 °C), speed 1-3, 240 s (120-720 s): starch needs at least 95 °C for at least 120 s. Add thickeners in the last 2-3 minutes or stir them into cold liquid first.
- Heat milk and cream at 100 °C, speed 1-3, as official recipes do; keep foaming contents below the foaming limit. Egg-yolk mixtures (custard, sabayon, egg liqueur) at 70-80 °C, speed 3, 480 s (300-720 s); 70 °C when alcohol is in the bowl. Milk rice and pudding at 80-100 °C, speed 2-3, 480 s (240-1800 s); milk rice in reverse.
- Stir Schmand, sour cream or crème fraîche into a hot soup or sauce at the end without heat: speed 3 for 15-20 s, reverse when there are pieces. When it must heat again, at most 90 °C, speed 2-3, 120-180 s.
- Risotto and one-pot pasta at 100 °C, speed 1, always reverse. Pasta time is the package time plus about 2 minutes.
- Jam at 100 °C (95-120), speed 2, 600 s (180-1500 s), measuring cup out, basket on the lid, at most 2500 g in the bowl.
- Melt chocolate at 50 °C, speed 1, 90-150 s; butter tolerates up to 100 °C. Warm milk and other liquids at 90-100 °C, speed 1-2.
- Simmer, poach and cook pasta or rice at 100 °C, and set egg mixtures in a bowl in the basket at 100 °C. Settings of 105-130 °C with liquid in the bowl are for jam, reducing and steaming in manual mode while a sauce cooks below (120 °C): the contents stay at the boiling point and boil harder.

## Dough

- Dissolve yeast with liquid and a little sugar at 37 °C, speed 1, 180 s. Never above 37 °C.
- Knead yeast dough with kneading_solid_dough for 120 s (45-120 s); soft doughs such as brioche or soft rolls with kneading_soft_dough. At most 1000 g flour per kneading step. The dough rises outside the machine; the text step after names the time.
- Short crust: kneading_solid_dough for 45-120 s, or manual speed 4-6 for 20 s, with cold butter in pieces.
- Cake batter in manual mode at speed 4 for 30 s (10-60 s), flour last. Thin batters such as pancakes: kneading_liquid_dough or speed 4.
- Whip with the whisk at speed 4 at most: 90 s (15-300 s). Fit and remove the whisk in text steps; egg whites need a fat-free bowl. Fold whipped cream or egg white into a dense base (melted chocolate, yolk mixture, cream cheese) forward at speed 3 for 30-45 s, push down with the spatula and run 10 s more; reverse with the whisk barely mixes (10 of 350 official whisk steps).
- Emulsify mayonnaise, aioli and dressings in two steps: a short mix of the base, then a long step at speed 4 (up to 240 s) while the oil is poured slowly onto the lid with the measuring cup in, so it runs in along the cup: "{{phrase:oilOntoLid}}" Never remove the measuring cup for this.

## Steaming

- Steaming order: water or stock in a scale step (1000 g, never below 500 g), food spread in the steamer ("{{phrase:steamerSpread}}"), "{{phrase:steamerOn}}", then the steaming program, which takes no temperature.
- Steaming time by load, not by mass: vegetables, potatoes and fish 900 s; meat, dumplings and desserts in moulds 1200 s; overall 480-2100 s.
- Cook a side (potatoes, rice) in the cooking basket below while the steamer runs, and count everything in the bowl toward the bowl limit. Official recipes also steam in manual mode at 120 °C, speed 1, when liquid in the bowl must cook too.
- Steaming longer than 30 minutes with less than 1000 g of water needs a "{{phrase:refillWater}}" text step.

## Purée and blend

- Purée cold contents (dips, pesto, cold soups) in manual mode at 0 °C, speed 8-10, 30 s (20-60 s), measuring cup in; push down and repeat rather than running longer.
- Purée hot soup with the measuring cup in, using the puree program for 30-60 s, or manual steps at 0 °C with rising speed, starting at speed 4 or lower (for example 10 s each at speed 4, 6 and 8). Never start hot contents at a higher speed.
- Blend drinks and smoothies in manual mode at speed 6-10 for 20 s (7-60 s), or the smoothie program for 60 s.

## Special programs

- Use only modes the member editor offers on MC3.0: kneading_solid_dough, kneading_soft_dough and kneading_liquid_dough instead of kneading; puree or manual steps instead of ramp. The device has not been tested with kneading or ramp from a member recipe.
- Rare programs: sous_vide 50-85 °C for 25-90 min; slow_cooking 70-95 °C (official 90 °C for 3-4 h); fermentation 37-40 °C for 1-12 h; cooking_eggs with size and texture; rice_cooking 1200-2400 s. Use food_processor only when the installation has the attachment. Never use precleaning; rinse the bowl with the text step "{{phrase:rinseBowl}}".

## Safety and limits

- Temperatures lie on the grid 0, 37, 40-130 °C in steps of 5. Manual speed is 1-10; there is no speed 0, and a pause is a text step.
- Manual speed at most 3 when heating or in reverse, at most 4 with the whisk; at speed 6 or more a step lasts at most 600 s. Every step except ramp has exactly one phase.
- Program steps carry no speed and no reverse; the turbo flag only on turbo steps; steaming stores 0 °C.
- Keep every mass limit of the Timing section at every step: bowl contents, foaming contents, one scale step, flour per kneading step and food in the cooking basket.
- When a limit cannot be met, scale the whole recipe down and say so in reviewHints; when the bowl mass is unknown, convert pieces with the piece weights first.
