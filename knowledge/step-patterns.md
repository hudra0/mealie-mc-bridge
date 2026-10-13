# Step patterns of MC Smart guided-cooking recipes

Structural rules for recipes on the Monsieur Cuisine Smart (MC3.0), derived from 2221 published de-DE recipes (1094 official, 1127 member) with 42322 steps, analysed in October 2026. Official recipes are the reference; member values appear where they differ. Counts in parentheses are corpus counts. Quoted phrases are short generic wording, not recipe text.

Terms used below:

- **Text step**: a step without device settings. The device shows its title and description.
- **Scale step**: a step in `scale` mode that weighs one ingredient into the bowl.
- **Working step**: any other machine step: manual cooking (`customized`) or a program such as `roasting` or `steaming`.
- Tokens such as `C0/5-7` mean manual mode at 0 °C and speed 5-7; `/R` means reverse rotation.

## 1. Recipe shape

1. An official recipe has a median of 23 steps: 12 text, 6 scale and 5 working steps (member: 13 steps, 6 text, 4 scale, 3 working). Text steps make up 52.8 % of official steps.
2. Step counts depend on the dish (median steps, all sources): drinks 10, sauces and dips 12, desserts 13, soups 17, baking 18, main dishes 21, one-pot 22, dinner 25.
3. Official recipes use a median of 2 distinct modes and 5 working steps (member 1 and 3).
4. The first step weighs something or prepares something (first step: scale 57.5 %, text 41.9 %, working step 0.7 %).
5. The recipe ends with finishing text steps: a median of 2 text steps follow the last working step (p90 6). "servieren" sits in the last step in 91.5 % of the text steps that contain it.

## 2. A text or scale step before every working step

6. Every working step follows a text or scale step (96.7 %: text 63.9 %, scale 32.8 %). Two working steps in a row are rare (3.3 %) and stand for a continued phase, such as a second cooking stage at the same temperature.
7. Between two working steps official recipes place one or two text steps (one 35.2 %, two 24.4 %, none 12.2 %) and zero or one scale step (none 32.3 %, one 33.7 %, two 18.0 %).
8. The most common blocks right before a working step are T (17.7 %), S (9.4 %), TT (7.0 %), TS (5.8 %) and ST (5.1 %).
9. The block before a working step says what goes in and how much (75.3 % of blocks carry an amount, 79.5 % name an ingredient), how it is prepared (peeled in 35 % of the text before official chopping steps, halved in 20 %, quartered in 14 %) and which accessory changes.
10. The working step itself carries no text: 99.8 % of official working steps have an empty description or one equal to the title. The device shows a description only on text, scale and turbo steps.
11. Device settings are never repeated in text. A speed appears in text in 36 steps (1 official recipe). Minutes in text (2082 steps) describe work outside the machine: oven, resting, cooling.

## 3. Scale steps

12. Each ingredient added by weight gets its own scale step (11945 scale steps; 82.5 % name an ingredient, 69.1 % exactly one, 74.3 % weigh exactly that ingredient's listed grams).
13. The scale-step title starts with the amount and the ingredient, for example "200 g Wasser" (78.7 % of official scale titles; member 30.6 %, where 51 % are a bare ingredient name). Official recipes write a space between number and unit: 6996 official scale steps write "200 g", 1 writes "200g".
14. The text step right before a scale step does something else (cutting, fitting an accessory); it names the same ingredient in only 3.2 % of cases.
15. Scale steps come alone or in short runs: one (64.7 %), two (22.4 %), three (8.2 %).
16. Amounts in spoons, pinches and pieces go into text steps with the amount written out. Units found in text steps: Tl 43.0 %, El 22.5 %, g 11.0 %, Prise 10.8 %, Msp 2.8 %.
17. Amounts are restated when the ingredient goes in: 83.9 % of g amounts, 87.4 % of Tl amounts and 86.1 % of Stück amounts appear in some step. 89.8 % of g amounts in step text equal a listed amount; the rest are split portions.
18. Steps use the list name without its qualifiers: catalog name verbatim 56.5 %, core name 21.7 %; names with parentheses appear verbatim in only 28.7 %, names with a comma qualifier in 3.8 %.
19. A scale step with a plate or bowl on the lid weighs something that does not go into the bowl (128 such steps). Use it only for that.

## 4. Titles and descriptions

20. Official working steps carry the program's default title: "Manuelles Kochen" (98.5 % of official manual steps), "Anbraten" (98.0 %), "Dampfgaren" (99.6 %), "Einfaches Kneten" (96.8 %), "Rampe" (98.3 %); the rarer programs use "Pürieren", "Fermentieren", "Slow Cook", "Sous-vide" and "Eier kochen". Member recipes use short custom titles instead ("Verrühren" 193, "Kochen" 165, "Zerkleinern" 149, "Mixen" 87). 89 % of all working-step titles have one or two words.
21. A turbo step's title names the seconds: "Turbo-Taste für 2 Sekunden" (the number matches the programmed time in 99.6 % of 262 such titles).
22. Official text steps have no separate heading: the title equals the text when it fits in 80 characters (65.7 %) or is the text cut at 80 characters (28.7 %). Member text steps mostly carry a separate heading (76.1 %).
23. Official text steps are short: median 9 words and 59 characters, p90 18 words and 124 characters, one sentence. 34.1 % exceed the 80-character title; 0.1 % exceed 200 characters. Member text steps run longer (5.9 % above 200 characters).
24. Hard limits (editor and SmartRecipe): step title 1-80 characters; description up to 240 characters, required on text, scale and turbo steps and empty on every other mode.

## 5. Standard phrases and when to use them

| Phrase                                               | When                                                      | Evidence                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| "Messbecher entfernen"                               | before roasting or cooking at 100 °C or more              | 695 text steps in 25.8 % of recipes; next working step roasting 47.7 %, 100 °C 18.4 %               |
| "Messbecher einsetzen"                               | before cold chopping or mixing, and back after roasting   | 567 text steps; next working step cold 57.4 %, 100 °C 21.1 %; previous working step roasting 39.7 % |
| "mit dem Spatel nach unten schieben"                 | after chopping, before the next step on the same contents | 1280 text steps in 41.8 % of recipes; previous working step cold chopping 75.7 %, turbo 18.6 %      |
| "Rühraufsatz einsetzen" / "entfernen"                | around whipping and gentle stirring                       | 230 and 125 text steps                                                                              |
| "Kocheinsatz einsetzen"                              | before cooking food in the basket                         | 159 text steps; next working step steaming 63.7 %                                                   |
| "Kocheinsatz als Spritzschutz" (on the lid)          | before reducing or hard boiling                           | 98 text steps; next step is the working step in 90.8 %                                              |
| "in den Kocheinsatz geben" / "Kocheinsatz entnehmen" | filling and removing the basket                           | 155 and 119 text steps                                                                              |
| "Dampfgaraufsatz aufsetzen"                          | right before steaming                                     | 342 text steps; next working step steaming 73.6 %                                                   |
| "im Dampfgaraufsatz verteilen"                       | when loading the steamer                                  | 376 text steps                                                                                      |
| "Dampfgaraufsatz abnehmen"                           | after steaming                                            | 149 text steps                                                                                      |
| "durch die Deckelöffnung"                            | adding liquid or oil while the blade runs                 | 98 text steps; next step is the working step in 93.9 %                                              |
| "in den Mixbehälter geben", "zugeben"                | the standard adding verbs                                 | 2707 and 3192 text steps                                                                            |
| "umfüllen", "beiseitestellen"                        | freeing the bowl after chopping                           | 1129 and 675 text steps; 77.0 % of "umfüllen" follow cold chopping                                  |
| "Mixbehälter ausspülen"                              | after a transfer, before a different preparation          | 731 text steps in 24.4 % of recipes                                                                 |
| "abschmecken"                                        | after the last cooking step                               | 442 text steps                                                                                      |
| "Wasser nachfüllen"                                  | during long steaming or sous-vide                         | 31 text steps                                                                                       |
| "abkühlen lassen", "servieren", "Backofen vorheizen" | finishing and outside work                                | 754, 1022 and 923 text steps                                                                        |

25. The vessel is called "Mixbehälter" (official recipes: 1082 recipes use it, "Mixtopf" 20; member recipes split 473 to 570).
26. Accessory actions get their own short text step or a clause in the block before the working step. The corpus names an accessory only when its state changes, so most working steps have no stated cup action before them.

## 6. Accessories

27. **Measuring cup.** Out before roasting (state at roasting steps: removed 493, inserted 15) and before manual steps at 105-130 °C (removed 148, inserted 67), so steam escapes. In for cold chopping (inserted 724, removed 237), turbo (33 against 3) and ramp purées (30 against 0). At 100 °C either state is common (inserted 229, removed 268); the cup stays in when splashing is likely and comes out when liquid should reduce.
28. **Spatula.** Used in 48.2 % of recipes (official 62.9 %), almost always to push food down after chopping.
29. **Whisk attachment (Rühraufsatz).** In 9.7 % of recipes (official 12.0 %), fitted during 474 working steps, mostly cold at speed 3-4 (57.4 %), time median 120 s (p10 15, p90 480). Speed at most 4 with the whisk (official guide; 92 % of these steps comply). Never turbo with the whisk. Fit and remove it in its own text step.
30. **Cooking basket (Kocheinsatz).** In 12.4 % of recipes. Inside the bowl during 328 working steps: steaming 33.2 %, manual at 105-130 °C and speed 1-2 14.9 %, at 100 °C 10.1 %. It holds potatoes, rice or eggs over or in liquid, often while the steamer runs on top. On the lid it is a splash guard (98 working steps, mostly 100 °C at speed 1-2, reverse in 49 % of the official ones, time median 720 s, p10-p90 300-2700 s).
31. **Steamer (Dampfgaraufsatz, with a flat insert as upper level).** In 21.1 % of official recipes and 4.2 % of member recipes. Fitted during 497 working steps: steaming program 43.7 %, manual mode 48.5 % (mostly 105-130 °C at speed 1-2). Water or stock goes into the bowl first (median 1000 g, p10 500 g); the level (deep bowl or flat insert) is named before 78.3 % of steaming steps.
32. **Food processor attachment.** 1.1 % of recipes; it is an optional accessory, so a converted recipe uses it only when the installation says it is present.

## 7. Typical sequences per dish type

Technique sequences of official recipes (consecutive repeats merged); counts are recipes or transitions.

33. **Savory cooked dishes** (dinner, main dishes, starters, one-pot, snacks): chop, then sear or sauté, then simmer. The triple chop > sear > simmer appears in 53 official dinner recipes, 45 snack, 23 starter, 18 main-dish and 17 one-pot recipes. As programs: `C0/5-7 > roasting > roasting` (81) and `roasting > roasting > C100/1-2/R` (64).
34. **Soups**: chop, sear, simmer, then purée hot as the last machine step (simmer > hot purée in 9 official starter recipes; 63 % of ramp steps sit in the last third of a recipe). The "Suppen & Eintöpfe" category uses the puree program in 26.5 % of its recipes and roasting in 56.6 %.
35. **Steamed dinners**: chop and prepare a sauce or side, fill water, then steam with the steamer on top and often a side in the basket below (chop > sear > steam in 18 official dinner recipes). The sauce follows in manual mode at 120 °C after steaming (steam > 120 °C: 49 transitions).
36. **Risotto and rice dishes**: chop, sauté the rice, then cook at 100 °C in reverse at speed 1 (chop > sear > risotto in 5 official one-pot recipes; reverse in 90.6 % of official risotto steps).
37. **One-pot pasta**: chop, sear, simmer the sauce, then cook the pasta in it at 100 °C in reverse (reverse in 92.3 % of official pasta steps).
38. **Yeast dough**: dissolve the yeast at 37 °C for 180 s at speed 1, then add flour and knead for 120 s (dissolve > knead is the whole machine part of 28 official baking and 26 snack recipes; 83 transitions from warm/dissolve to knead). Rising happens outside the machine.
39. **Short crust**: a single kneading step of 45-120 s, or a short manual step at speed 4-6 (kneading alone in 6 official baking recipes).
40. **Cake batter**: chop or grind, stir, then mix the batter at speed 4 for 30-60 s (chop > stir > batter in 14 official snack and 6 baking recipes). Whip egg whites first in a clean, dry bowl with the whisk.
41. **Creams and desserts**: stir, cook the custard at 80-90 °C, then whip (stir > cook > whip in 4 official dessert recipes).
42. **Sauces and dips**: chopping alone (17 official recipes) or chop then stir (9); emulsions add a long speed-4 step while oil runs onto the lid.
43. **Jam**: chop the fruit, heat it, then cook hard with the basket on the lid as splash guard (chop > sauté > jam in 3 official recipes).
44. **Drinks**: crush ice or frozen fruit (10 official recipes) or blend a smoothie (7).
45. **Salads and baby food**: the basket or steamer cooks potatoes, eggs or vegetables; chopping and stirring finish the dish; baby food ends with a purée.
46. Repeated identical steps are normal: stirring or chopping in stages (`C0/3-4` three times in a row: 120; `C0/5-7` three times: 93), and cooking split into two stages at the same temperature (100 °C then 100 °C: 296 transitions, typically 600 s then 300 s).

## 8. Ingredient list

47. Groups are optional (36.7 % of official recipes have none). When used, group names are upper case (99.6 %): "FÜR DEN TEIG" (475), "AUSSERDEM" (468), "FÜR DIE FÜLLUNG" (275), "ZUBEHÖR" (273), or a yield header such as "FÜR 12 STÜCKE". Equipment goes into ZUBEHÖR, serving extras into AUSSERDEM.
48. Units, spelling, rounding and piece weights: see `units.json`.

## 9. Times

49. Declared prep time has a median of 15 minutes. The total time adds all outside time (baking, rising, chilling): total over machine time is 1.35 for soups, 1.55 for one-pot dishes and 18 for baking (median 81 minutes outside the machine). A fit on machine and prep minutes alone explains almost nothing (R² 0.06); adding passive minutes named in text gets to R² 0.46 (formula in `timing-model.json`).
50. The total time is never below the prep time and never below the summed machine time (38 of 2221 recipes break the second rule).
