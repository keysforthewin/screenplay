import { getCharacterTemplate, setCharacterTemplate, getPlotTemplate, setPlotTemplate } from '../mongo/prompts.js';

const DEFAULT_CHARACTER_FIELDS = [
  { name: 'name', description: "The character's name.", required: true, core: true },
  { name: 'plays_self', description: 'Whether the real person plays themselves (true) or a Hollywood actor portrays them (false).', required: true, core: true },
  { name: 'hollywood_actor', description: 'Name of the actor playing this character. Required when plays_self is false.', required: false, core: true },
  { name: 'own_voice', description: 'Whether the character uses their own voice (true) or is dubbed by the actor (false).', required: true, core: true },
  { name: 'background_story', description: 'Backstory before the events of the movie.', required: true, core: false },
  { name: 'origin_story', description: 'How the character came to be who they are at the start.', required: true, core: false },
  { name: 'arc', description: 'How the character develops throughout the movie.', required: true, core: false },
  { name: 'events', description: 'Notable things that happen to them during the story.', required: true, core: false },
  { name: 'memes', description: 'Memes, catchphrases, or running jokes associated with them.', required: false, core: false },
];

const DEFAULT_PLOT_TEMPLATE = {
  synopsis_guidance: 'A 3-5 sentence summary of the movie. What it is about, the protagonist, the central conflict.',
  beat_guidance: 'A beat is a per-scene unit of the story. Each beat has order (number), name (short identifier), desc (1-2 sentence summary set on creation), body (long-form developing content), and characters. Beats are created on the fly whenever the user describes an event or scene; the bot generates a name and desc from the description, then accumulates body content as the user adds lore. Aim for 8-15 beats covering setup, inciting incident, escalations, climax, resolution — but expect lots of supporting beats for character moments and lore.',
};

export async function seedDefaults() {
  if (!(await getCharacterTemplate())) {
    await setCharacterTemplate({ fields: DEFAULT_CHARACTER_FIELDS });
  }
  if (!(await getPlotTemplate())) {
    await setPlotTemplate(DEFAULT_PLOT_TEMPLATE);
  }
}
