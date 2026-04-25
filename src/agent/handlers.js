import * as Characters from '../mongo/characters.js';
import * as Plots from '../mongo/plots.js';
import * as Prompts from '../mongo/prompts.js';
import { exportToPdf } from '../pdf/export.js';

function compact(obj) {
  return JSON.stringify(obj, null, 2);
}

export const HANDLERS = {
  async list_characters() {
    const list = await Characters.listCharacters();
    return compact(list.map((c) => ({ _id: c._id.toString(), name: c.name })));
  },

  async get_character({ identifier }) {
    const c = await Characters.getCharacter(identifier);
    if (!c) return `No character found for "${identifier}".`;
    return compact(c);
  },

  async create_character(input) {
    if (!input.plays_self && !input.hollywood_actor) {
      return 'Error: when plays_self is false, hollywood_actor is required.';
    }
    const c = await Characters.createCharacter(input);
    return `Created character ${c.name} (_id ${c._id}).`;
  },

  async update_character({ identifier, patch }) {
    const c = await Characters.updateCharacter(identifier, patch);
    return `Updated ${c.name}. Current state:\n${compact(c)}`;
  },

  async search_characters({ query }) {
    const results = await Characters.searchCharacters(query);
    return compact(results.map((c) => ({ _id: c._id.toString(), name: c.name })));
  },

  async get_character_template() {
    return compact(await Prompts.getCharacterTemplate());
  },

  async update_character_template({ add = [], remove = [] }) {
    const tpl = await Prompts.updateCharacterTemplateFields({ add, remove });
    return `Template updated. New fields:\n${compact(tpl.fields)}`;
  },

  async get_plot() {
    return compact(await Plots.getPlot());
  },

  async update_plot(patch) {
    const p = await Plots.updatePlot(patch);
    return `Plot updated.\n${compact(p)}`;
  },

  async export_pdf({ title }) {
    const path = await exportToPdf({ title });
    return `__PDF_PATH__:${path}`;
  },
};

export async function dispatchTool(name, input) {
  const fn = HANDLERS[name];
  if (!fn) return `Unknown tool: ${name}`;
  try {
    return await fn(input || {});
  } catch (e) {
    return `Tool error (${name}): ${e.message}`;
  }
}
