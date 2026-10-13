// What the job pipeline needs from the locale packs: the pack of MC_LOCALE (labels of the
// converter input, the Monsieur Cuisine settings for transport and payload) and the
// category-matching words of every pack, because Mealie categories may be in any language.

import { loadAllLocalePacks, loadLocalePack, type LocalePack } from "../locale/pack.js";
import { renderLabels, type RenderLabels } from "../mealie/render.js";
import type { CategoryWords } from "./categories.js";

export interface PipelineLocale {
  pack: LocalePack;
  labels: RenderLabels;
  categoryWords: CategoryWords;
}

export function pipelineLocale(
  pack: LocalePack,
  packs: readonly LocalePack[] = [],
): PipelineLocale {
  const all = [...new Set([pack, ...packs])];
  const union = (pick: (p: LocalePack) => readonly string[]) => [
    ...new Set(all.flatMap((p) => pick(p))),
  ];
  return {
    pack,
    labels: renderLabels(pack),
    categoryWords: {
      stopwords: union((p) => p.phrases.categoryMatching.stopwords),
      joiners: union((p) => p.phrases.categoryMatching.joiners),
      stemEndings: union((p) => p.phrases.categoryMatching.stemEndings),
    },
  };
}

export async function loadPipelineLocale(
  knowledgeDir: string,
  locale: string,
): Promise<PipelineLocale> {
  const [pack, packs] = await Promise.all([
    loadLocalePack(knowledgeDir, locale),
    loadAllLocalePacks(knowledgeDir),
  ]);
  return pipelineLocale(pack, packs);
}
