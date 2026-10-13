// The locale packs and knowledge base of the repository, loaded once for the tests.

import { fileURLToPath } from "node:url";
import { loadKnowledge, type Knowledge } from "../convert/knowledge.js";
import { loadAllLocalePacks, loadLocalePack, type LocalePack } from "../locale/pack.js";
import { renderLabels, type RenderLabels } from "../mealie/render.js";
import { pipelineLocale, type PipelineLocale } from "../pipeline/locale.js";

export const KNOWLEDGE_DIR = fileURLToPath(new URL("../../knowledge", import.meta.url));

export const packs: LocalePack[] = await loadAllLocalePacks(KNOWLEDGE_DIR);
export const dePack: LocalePack = await loadLocalePack(KNOWLEDGE_DIR, "de-DE");
export const enPack: LocalePack = await loadLocalePack(KNOWLEDGE_DIR, "en-US");

export const deLabels: RenderLabels = renderLabels(dePack);
export const enLabels: RenderLabels = renderLabels(enPack);

export const deLocale: PipelineLocale = pipelineLocale(dePack, packs);
export const enLocale: PipelineLocale = pipelineLocale(enPack, packs);

const knowledgeCache = new Map<string, Promise<Knowledge>>();

// The knowledge base for an output locale, loaded once per locale.
export function testKnowledge(locale = "de-DE"): Promise<Knowledge> {
  let knowledge = knowledgeCache.get(locale);
  if (!knowledge) {
    knowledge = loadKnowledge(KNOWLEDGE_DIR, locale);
    knowledgeCache.set(locale, knowledge);
  }
  return knowledge;
}
