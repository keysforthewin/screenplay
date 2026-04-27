import * as Characters from '../mongo/characters.js';
import * as Plots from '../mongo/plots.js';
import * as Prompts from '../mongo/prompts.js';
import * as Files from '../mongo/files.js';
import * as Images from '../mongo/images.js';
import * as Tmdb from '../tmdb/client.js';
import * as Tavily from '../tavily/client.js';
import { generateImage as generateImageBytes } from '../gemini/client.js';
import { buildImagePrompt } from '../gemini/promptBuilder.js';
import * as Messages from '../mongo/messages.js';
import { config } from '../config.js';
import { exportToPdf } from '../pdf/export.js';
import { buildOverview } from './overview.js';
import { logger } from '../log.js';
import { countNgrams, topNgrams } from '../analysis/ngrams.js';
import { rankSimilar, bagOfWords } from '../analysis/similarity.js';
import { detectClimax } from '../analysis/sentiment.js';
import { analyzeText } from '../llm/analyze.js';
import { create, all } from 'mathjs';
import { runJsInVm } from './codeRunner.js';

const mj = create(all, { number: 'BigNumber', precision: 64 });

function compact(obj) {
  return JSON.stringify(obj, null, 2);
}

function preview(text, n = 120) {
  if (!text) return '';
  const t = String(text).trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

function serializeBeatSummary(b, currentId) {
  return {
    _id: b._id.toString(),
    order: b.order,
    name: b.name,
    desc_preview: preview(b.desc),
    body_length: (b.body || '').length,
    character_count: (b.characters || []).length,
    image_count: (b.images || []).length,
    is_current: !!(currentId && b._id.equals(currentId)),
  };
}

function serializeBeat(b) {
  return {
    _id: b._id.toString(),
    order: b.order,
    name: b.name,
    desc: b.desc || '',
    body: b.body || '',
    characters: b.characters || [],
    images: (b.images || []).map((i) => ({
      _id: i._id.toString(),
      filename: i.filename,
      content_type: i.content_type,
      size: i.size,
      source: i.source || 'upload',
      prompt: i.prompt || null,
      generated_by: i.generated_by || null,
      caption: i.caption || null,
      uploaded_at: i.uploaded_at,
    })),
    main_image_id: b.main_image_id ? b.main_image_id.toString() : null,
  };
}

async function maybeAutoFetchActorPortrait(characterIdentifier) {
  let c;
  try {
    c = await Characters.getCharacter(characterIdentifier);
  } catch (e) {
    return ` (Note: could not re-read character to auto-fetch portrait: ${e.message})`;
  }
  if (!c) return null;
  if (c.plays_self) return null;
  if (!c.hollywood_actor) return null;
  if (c.main_image_id) return null;

  const lookup = await Tmdb.findActorPortraitUrl(c.hollywood_actor);
  if (!lookup.ok) {
    return ` (Note: TMDB portrait lookup for "${c.hollywood_actor}" failed: ${lookup.reason}.)`;
  }

  try {
    await Files.attachImageToCharacter({
      character: c._id.toString(),
      sourceUrl: lookup.url,
      filename: null,
      caption: `TMDB profile photo for ${lookup.person_name}`,
      setAsMain: true,
    });
    return ` Auto-attached TMDB portrait for "${lookup.person_name}".`;
  } catch (e) {
    logger.warn(`auto-portrait attach failed for ${c.name}: ${e.message}`);
    return ` (Note: TMDB portrait found but attach failed: ${e.message}.)`;
  }
}

async function resolveBeat(identifier, { allowCurrent = true } = {}) {
  if (identifier === undefined || identifier === null || identifier === '') {
    if (!allowCurrent) throw new Error('A beat identifier is required.');
    const cur = await Plots.getCurrentBeat();
    if (!cur) {
      throw new Error('No current beat is set. Pass an explicit `beat` identifier or call set_current_beat first.');
    }
    return cur;
  }
  const b = await Plots.getBeat(String(identifier));
  if (!b) throw new Error(`Beat not found: ${identifier}`);
  return b;
}

const CHARACTER_TEXT_FIELDS = ['background_story', 'origin_story', 'arc', 'events', 'memes'];
const BEAT_TEXT_FIELDS = ['name', 'desc', 'body'];

async function appendSimilarityHeadsUp(type, item, baseMessage) {
  try {
    const selfId = item?._id ? item._id.toString() : null;
    let corpus;
    let targetText;

    if (type === 'character') {
      const all = await Characters.findAllCharacters();
      corpus = all.map((c) => {
        const fields = {};
        for (const f of CHARACTER_TEXT_FIELDS) fields[f] = String(c.fields?.[f] || '');
        return { id: c._id.toString(), label: c.name, fields };
      });
      targetText = CHARACTER_TEXT_FIELDS.map((f) => item.fields?.[f] || '')
        .filter(Boolean)
        .join('\n');
    } else if (type === 'beat') {
      const beats = await Plots.listBeats();
      corpus = beats.map((b) => {
        const fields = {};
        for (const f of BEAT_TEXT_FIELDS) fields[f] = String(b[f] || '');
        return { id: b._id.toString(), label: `#${b.order} ${b.name}`, fields };
      });
      targetText = BEAT_TEXT_FIELDS.map((f) => item[f] || '').filter(Boolean).join('\n');
    } else {
      return baseMessage;
    }

    if (!targetText.trim() || corpus.length <= 1) return baseMessage;

    const targetTokens = bagOfWords(targetText);
    if (targetTokens.size === 0) return baseMessage;

    const matches = rankSimilar(
      { tokens: targetTokens },
      corpus,
      { threshold: 0.6, excludeId: selfId },
    );
    if (!matches.length) return baseMessage;

    const top = matches[0];
    const pct = Math.round(top.score * 100);
    const fieldNote =
      top.matched_field && top.matched_field !== '_concat'
        ? ` (matched on ${top.matched_field})`
        : '';
    return `${baseMessage}\n\nHeads up: this ${type} is ${pct}% similar to "${top.label}"${fieldNote}. Use check_similarity for full results.`;
  } catch (e) {
    logger.warn(`similarity hook failed: ${e.message}`);
    return baseMessage;
  }
}

function truncateStr(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return `${str.slice(0, n - 1)}…`;
}

function buildSimilarityQuery({ kind, profile, focus }) {
  let prefix = '';
  const parts = [];
  if (kind === 'character') {
    prefix = 'fictional character archetype: ';
    if (profile.hollywood_actor) parts.push(`played by ${profile.hollywood_actor}`);
    for (const f of CHARACTER_TEXT_FIELDS) {
      const v = profile.fields?.[f];
      if (v && typeof v === 'string' && v.trim()) parts.push(v.trim());
    }
  } else if (kind === 'plot') {
    prefix = 'story plot similar to: ';
    if (profile.synopsis) parts.push(profile.synopsis.trim());
    const beatSummary = (profile.beats || [])
      .slice(0, 12)
      .map((b) => truncateStr(String(b.desc || b.name || ''), 80))
      .filter(Boolean)
      .join('; ');
    if (beatSummary) parts.push(beatSummary);
  } else if (kind === 'beat') {
    prefix = 'scene similar to: ';
    if (profile.desc) parts.push(profile.desc.trim());
    if (profile.body) parts.push(truncateStr(profile.body, 300));
  }
  let q = prefix + parts.filter(Boolean).join('. ');
  if (focus && typeof focus === 'string' && focus.trim()) {
    q += ` (focus: ${focus.trim()})`;
  }
  return truncateStr(q, 400);
}

function buildProfileSection(kind, profile) {
  const lines = [];
  if (kind === 'character') {
    if (profile.hollywood_actor) lines.push(`Cast as: ${profile.hollywood_actor}`);
    for (const f of CHARACTER_TEXT_FIELDS) {
      const v = profile.fields?.[f];
      if (v && typeof v === 'string' && v.trim()) lines.push(`${f}: ${v.trim()}`);
    }
  } else if (kind === 'plot') {
    if (profile.synopsis) lines.push(`Synopsis: ${profile.synopsis.trim()}`);
    const beats = (profile.beats || []).slice(0, 20);
    if (beats.length) {
      lines.push('Beats:');
      for (const b of beats) {
        const order = b.order ?? '';
        const name = b.name || '';
        const desc = truncateStr(b.desc || '', 200);
        lines.push(`- (${order}) ${name}${desc ? `: ${desc}` : ''}`);
      }
    }
  } else if (kind === 'beat') {
    if (profile.name) lines.push(`Beat name: ${profile.name}`);
    if (profile.desc) lines.push(`desc: ${profile.desc.trim()}`);
    if (profile.body) lines.push(`body: ${truncateStr(profile.body, 1500)}`);
  }
  return lines.join('\n');
}

function formatTavilyResultsForPrompt(results) {
  if (!results.length) return '(no search results)';
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title || '(no title)'} — ${r.url || ''}`];
      if (r.snippet) lines.push(`   snippet: ${r.snippet}`);
      if (r.content) lines.push(`   content: ${r.content}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

function buildAnalysisPrompt({ kind, profile, results, maxWorks }) {
  const profileSection = buildProfileSection(kind, profile);
  const resultsSection = formatTavilyResultsForPrompt(results);
  const subjectWord = kind === 'character' ? 'character' : kind === 'beat' ? 'scene' : 'plot';
  const matchTarget = kind === 'character' ? 'characters' : 'plots or scenes';
  const system =
    `You are a literary and film analyst. You will receive a screenplay ${subjectWord} profile and a list of web search results. ` +
    `Your job is to identify up to ${maxWorks} well-known existing works whose ${matchTarget} share the strongest structural or thematic parallels with the profile.\n\n` +
    `Hard rules:\n` +
    `- Reason ONLY from the profile and the search results provided. Do not invent works that are not supported by the snippets.\n` +
    `- If nothing in the snippets resembles the profile, output a single short sentence saying so and stop. Do not pad.\n` +
    `- For each parallel, cite specific traits from the profile and the snippet that support it. Be concrete.\n` +
    `- Rate confidence as high, medium, or low.\n` +
    `- Output Markdown only. No preamble, no closing remarks.\n\n` +
    `Format each parallel as:\n` +
    `1. **Title** (Year) — <character or "plot">\n` +
    `   Confidence: <high|medium|low>\n` +
    `   Evidence: <2-3 sentences>\n` +
    `   Source: <URL>\n`;
  const user =
    `<profile>\n${profileSection}\n</profile>\n\n` +
    `<search_results>\n${resultsSection}\n</search_results>\n\n` +
    `Identify up to ${maxWorks} parallels.`;
  return { system, user };
}

async function runSimilaritySearch({ query, maxResults = 8, rawContentTopN = 3 }) {
  const data = await Tavily.search({
    query,
    search_depth: 'advanced',
    topic: 'general',
    max_results: maxResults,
    include_answer: false,
    include_images: false,
    include_raw_content: true,
  });
  return (data.results || []).map((r, i) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: typeof r.content === 'string' ? r.content.slice(0, 600) : '',
    content:
      i < rawContentTopN && typeof r.raw_content === 'string'
        ? r.raw_content.slice(0, 3000)
        : null,
    score: r.score,
  }));
}

export const HANDLERS = {
  async get_overview() {
    return compact(await buildOverview());
  },

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
    const playsSelf = input.plays_self === undefined ? true : !!input.plays_self;
    const ownVoice = input.own_voice === undefined ? true : !!input.own_voice;
    if (!playsSelf && !input.hollywood_actor) {
      return 'Error: when plays_self is false, hollywood_actor is required.';
    }
    const c = await Characters.createCharacter({
      ...input,
      plays_self: playsSelf,
      own_voice: ownVoice,
    });
    const note = await maybeAutoFetchActorPortrait(c._id.toString());
    const base = `Created character ${c.name} (_id ${c._id}).${note || ''}`;
    return appendSimilarityHeadsUp('character', c, base);
  },

  async update_character({ identifier, patch }) {
    const c = await Characters.updateCharacter(identifier, patch);
    const note = await maybeAutoFetchActorPortrait(c._id.toString());
    const fresh = note ? await Characters.getCharacter(c._id.toString()) : c;
    const base = `Updated ${c.name}.${note || ''}\nCurrent state:\n${compact(fresh)}`;
    const touchedText =
      patch && (patch.name !== undefined || (patch.fields && typeof patch.fields === 'object'));
    return touchedText ? appendSimilarityHeadsUp('character', fresh, base) : base;
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
    const plot = await Plots.getPlot();
    return compact({
      synopsis: plot.synopsis,
      notes: plot.notes,
      current_beat_id: plot.current_beat_id ? plot.current_beat_id.toString() : null,
      beat_count: (plot.beats || []).length,
    });
  },

  async update_plot(patch) {
    const p = await Plots.updatePlot(patch);
    return `Plot updated.\n${compact({ synopsis: p.synopsis, notes: p.notes })}`;
  },

  async list_beats() {
    const plot = await Plots.getPlot();
    const beats = [...(plot.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    return compact(beats.map((b) => serializeBeatSummary(b, plot.current_beat_id)));
  },

  async get_beat({ identifier } = {}) {
    const b = await Plots.getBeat(identifier);
    if (!b) {
      return identifier
        ? `No beat found for "${identifier}".`
        : 'No current beat is set.';
    }
    return compact(serializeBeat(b));
  },

  async create_beat({ name, desc, body, characters, order }) {
    const b = await Plots.createBeat({ name, desc, body, characters, order });
    const base = `Created beat "${b.name}" (order ${b.order}, _id ${b._id}). It is now the current beat if none was set.`;
    return appendSimilarityHeadsUp('beat', b, base);
  },

  async update_beat({ identifier, patch }) {
    const b = await Plots.updateBeat(identifier, patch);
    const base = `Updated beat "${b.name}".\n${compact(serializeBeat(b))}`;
    const touchedText =
      patch && (patch.name !== undefined || patch.desc !== undefined || patch.body !== undefined);
    return touchedText ? appendSimilarityHeadsUp('beat', b, base) : base;
  },

  async append_to_beat_body({ beat, content }) {
    const target = await resolveBeat(beat);
    const updated = await Plots.appendBeatBody(target._id.toString(), content);
    return `Appended ${String(content || '').length} chars to beat "${updated.name}". Body is now ${updated.body.length} chars.`;
  },

  async search_beats({ query }) {
    const matches = await Plots.searchBeats(query);
    return compact({
      query,
      result_count: matches.length,
      results: matches.map((m) => ({
        _id: m.beat._id.toString(),
        order: m.beat.order,
        name: m.beat.name,
        desc_preview: preview(m.beat.desc),
        matched_field: m.matched_field,
        score: m.score,
      })),
    });
  },

  async delete_beat({ identifier }) {
    const res = await Plots.deleteBeat(identifier);
    await Images.deleteImages(res.image_ids);
    return `Deleted beat "${res.name}" and ${res.image_ids.length} image(s).`;
  },

  async link_character_to_beat({ beat, character }) {
    const target = await resolveBeat(beat);
    const updated = await Plots.linkCharacterToBeat(target._id.toString(), character);
    return `Linked ${character} to beat "${updated.name}". Characters now: ${updated.characters.join(', ') || '(none)'}.`;
  },

  async unlink_character_from_beat({ beat, character }) {
    const target = await resolveBeat(beat);
    const updated = await Plots.unlinkCharacterFromBeat(target._id.toString(), character);
    return `Unlinked ${character} from beat "${updated.name}". Characters now: ${updated.characters.join(', ') || '(none)'}.`;
  },

  async set_current_beat({ identifier }) {
    const b = await Plots.setCurrentBeat(identifier);
    return `Current beat is now "${b.name}" (_id ${b._id}).`;
  },

  async get_current_beat() {
    const b = await Plots.getCurrentBeat();
    if (!b) return 'No current beat is set.';
    return compact(serializeBeat(b));
  },

  async clear_current_beat() {
    await Plots.clearCurrentBeat();
    return 'Current beat cleared.';
  },

  async add_beat_image({ beat, source_url, filename, caption, set_as_main }) {
    const target = await resolveBeat(beat);
    const file = await Images.uploadImageFromUrl({
      sourceUrl: source_url,
      filename,
      ownerType: 'beat',
      ownerId: target._id,
    });
    const meta = {
      _id: file._id,
      filename: file.filename,
      content_type: file.content_type,
      size: file.size,
      source: 'upload',
      prompt: null,
      generated_by: null,
      caption: caption?.trim() || null,
      uploaded_at: file.uploaded_at,
    };
    const { is_main } = await Plots.pushBeatImage(target._id.toString(), meta, set_as_main);
    return `Added image to beat "${target.name}".\n${compact({
      _id: meta._id.toString(),
      filename: meta.filename,
      content_type: meta.content_type,
      size: meta.size,
      is_main,
    })}`;
  },

  async list_beat_images({ beat } = {}) {
    const target = await resolveBeat(beat);
    return compact({
      beat: { _id: target._id.toString(), name: target.name },
      main_image_id: target.main_image_id ? target.main_image_id.toString() : null,
      images: (target.images || []).map((i) => ({
        _id: i._id.toString(),
        filename: i.filename,
        content_type: i.content_type,
        size: i.size,
        source: i.source || 'upload',
        prompt: i.prompt || null,
        caption: i.caption || null,
        uploaded_at: i.uploaded_at,
      })),
    });
  },

  async set_main_beat_image({ beat, image_id }) {
    const target = await resolveBeat(beat);
    const updated = await Plots.setBeatMainImage(target._id.toString(), image_id);
    return `Main image for beat "${updated.name}" set to ${updated.main_image_id.toString()}.`;
  },

  async remove_beat_image({ beat, image_id }) {
    const target = await resolveBeat(beat);
    const { removed, beat: updated } = await Plots.pullBeatImage(target._id.toString(), image_id);
    await Images.deleteImage(removed);
    return `Removed image ${removed.toString()} from beat "${updated.name}". Main image is now ${
      updated.main_image_id ? updated.main_image_id.toString() : 'none'
    }.`;
  },

  async list_library_images() {
    const files = await Images.listLibraryImages();
    return compact(
      files.map((f) => {
        const m = Images.imageFileToMeta(f);
        return { ...m, _id: m._id.toString() };
      }),
    );
  },

  async attach_library_image_to_beat({ image_id, beat, set_as_main }) {
    const target = await resolveBeat(beat);
    const file = await Images.findImageFile(image_id);
    if (!file) throw new Error(`Image not found: ${image_id}`);
    if (
      file.metadata?.owner_type === 'beat' &&
      file.metadata?.owner_id &&
      file.metadata.owner_id.equals(target._id)
    ) {
      return `Image ${image_id} is already attached to beat "${target.name}".`;
    }
    if (file.metadata?.owner_type === 'beat') {
      throw new Error(
        `Image ${image_id} is currently attached to a different beat. Detach it first with remove_beat_image.`,
      );
    }
    await Images.setImageOwner(image_id, { ownerType: 'beat', ownerId: target._id });
    const meta = {
      _id: file._id,
      filename: file.filename,
      content_type: file.contentType,
      size: file.length,
      source: file.metadata?.source || 'upload',
      prompt: file.metadata?.prompt || null,
      generated_by: file.metadata?.generated_by || null,
      caption: null,
      uploaded_at: file.uploadDate,
    };
    const { is_main } = await Plots.pushBeatImage(target._id.toString(), meta, set_as_main);
    return `Attached image to beat "${target.name}"${is_main ? ' (now main image)' : ''}.`;
  },

  async show_image({ image_id }) {
    const { path: filepath } = await Images.streamImageToTmp(image_id);
    return `__IMAGE_PATH__:${filepath}`;
  },

  async generate_image({
    prompt,
    include_beat,
    beat,
    include_recent_chat,
    aspect_ratio,
    attach_to_current_beat,
    set_as_main,
  }) {
    if (!config.gemini.apiKey && !config.gemini.vertex.project) {
      return 'Error: Gemini is not configured. Set GEMINI_VERTEX_PROJECT (+ GOOGLE_APPLICATION_CREDENTIALS) for Vertex AI, or GEMINI_API_KEY for the Developer API.';
    }
    if (!prompt && !include_beat && !include_recent_chat) {
      return 'Error: provide at least one of `prompt`, `include_beat: true`, or `include_recent_chat: true`.';
    }

    let beatDoc = null;
    if (include_beat || beat) {
      try {
        beatDoc = await resolveBeat(beat);
      } catch (e) {
        if (include_beat) throw e;
      }
    }

    let recentMessages = [];
    if (include_recent_chat) {
      const history = await Messages.loadHistoryForLlm(config.discord.movieChannelId);
      recentMessages = history.slice(-10);
    }

    const finalPrompt = buildImagePrompt({
      userPrompt: prompt,
      beat: include_beat ? beatDoc : null,
      recentMessages,
    });

    const { buffer, contentType } = await generateImageBytes({
      prompt: finalPrompt,
      aspectRatio: aspect_ratio,
    });

    const current = beatDoc || (await Plots.getCurrentBeat());
    const shouldAttach =
      attach_to_current_beat === undefined ? !!current : !!attach_to_current_beat;
    const ownerType = shouldAttach && current ? 'beat' : null;
    const ownerId = shouldAttach && current ? current._id : null;

    const file = await Images.uploadGeneratedImage({
      buffer,
      contentType,
      prompt: finalPrompt,
      generatedBy: 'gemini-2.5-flash-image',
      ownerType,
      ownerId,
    });

    if (shouldAttach && current) {
      const meta = {
        _id: file._id,
        filename: file.filename,
        content_type: file.content_type,
        size: file.size,
        source: 'generated',
        prompt: finalPrompt,
        generated_by: 'gemini-2.5-flash-image',
        caption: null,
        uploaded_at: file.uploaded_at,
      };
      await Plots.pushBeatImage(current._id.toString(), meta, set_as_main);
    }

    const { path: filepath } = await Images.streamImageToTmp(file._id);
    const where = shouldAttach && current ? `attached to beat "${current.name}"` : 'saved to library';
    return `__IMAGE_PATH__:${filepath}|Generated image (${file._id.toString()}) ${where}.`;
  },

  async export_pdf({ title }) {
    const path = await exportToPdf({ title });
    return `__PDF_PATH__:${path}`;
  },

  async add_character_image({ character, source_url, filename, caption, set_as_main }) {
    const meta = await Files.attachImageToCharacter({
      character,
      sourceUrl: source_url,
      filename,
      caption,
      setAsMain: set_as_main,
    });
    return `Added image to ${character}.\n${compact({
      _id: meta._id.toString(),
      filename: meta.filename,
      content_type: meta.content_type,
      size: meta.size,
      is_main: meta.is_main,
    })}`;
  },

  async list_character_images({ character }) {
    const { images, main_image_id } = await Files.listCharacterImages(character);
    return compact({
      main_image_id: main_image_id ? main_image_id.toString() : null,
      images: images.map((i) => ({
        _id: i._id.toString(),
        filename: i.filename,
        content_type: i.content_type,
        size: i.size,
        caption: i.caption,
        uploaded_at: i.uploaded_at,
      })),
    });
  },

  async set_main_character_image({ character, image_id }) {
    const res = await Files.setMainCharacterImage({ character, imageId: image_id });
    return `Main image for ${res.character} set to ${res.main_image_id.toString()}.`;
  },

  async remove_character_image({ character, image_id }) {
    const res = await Files.removeCharacterImage({ character, imageId: image_id });
    return `Removed image ${res.removed.toString()} from ${res.character}. Main image is now ${
      res.main_image_id ? res.main_image_id.toString() : 'none'
    }.`;
  },

  async tmdb_search_movie({ query, year }) {
    if (!config.tmdb.readAccessToken) {
      return 'Error: TMDB_READ_ACCESS_TOKEN is not configured. Cannot look up movies.';
    }
    const data = await Tmdb.searchMovie({ query, year });
    const results = (data.results || []).slice(0, 5).map((m) => ({
      id: m.id,
      title: m.title,
      year: (m.release_date || '').slice(0, 4) || null,
      overview_preview: preview(m.overview, 200),
      poster_url: Tmdb.posterUrl(m.poster_path),
    }));
    return compact({ query, total_results: data.total_results || 0, results });
  },

  async tmdb_get_movie({ movie_id }) {
    if (!config.tmdb.readAccessToken) {
      return 'Error: TMDB_READ_ACCESS_TOKEN is not configured. Cannot look up movies.';
    }
    const m = await Tmdb.getMovieDetails(movie_id);
    const crew = m.credits?.crew || [];
    const director = crew.find((c) => c.job === 'Director')?.name || null;
    const cast = (m.credits?.cast || []).slice(0, 8).map((c) => ({
      character: c.character,
      actor_name: c.name,
      person_id: c.id,
      photo_url: Tmdb.profileUrl(c.profile_path),
    }));
    return compact({
      id: m.id,
      title: m.title,
      year: (m.release_date || '').slice(0, 4) || null,
      overview: m.overview || '',
      runtime_minutes: m.runtime || null,
      genres: (m.genres || []).map((g) => g.name),
      director,
      poster_url: Tmdb.posterUrl(m.poster_path),
      top_cast: cast,
    });
  },

  async tmdb_get_movie_credits({ movie_id }) {
    if (!config.tmdb.readAccessToken) {
      return 'Error: TMDB_READ_ACCESS_TOKEN is not configured. Cannot look up movies.';
    }
    const data = await Tmdb.getMovieCredits(movie_id);
    const cast = (data.cast || []).map((c) => ({
      character: c.character,
      actor_name: c.name,
      person_id: c.id,
      photo_url: Tmdb.profileUrl(c.profile_path),
      order: c.order,
    }));
    return compact({ movie_id, cast });
  },

  async tmdb_search_person({ query }) {
    if (!config.tmdb.readAccessToken) {
      return 'Error: TMDB_READ_ACCESS_TOKEN is not configured. Cannot look up people.';
    }
    const data = await Tmdb.searchPerson(query);
    const results = (data.results || []).slice(0, 5).map((p) => ({
      id: p.id,
      name: p.name,
      known_for_titles: (p.known_for || [])
        .map((k) => k.title || k.name)
        .filter(Boolean)
        .slice(0, 5),
      photo_url: Tmdb.profileUrl(p.profile_path),
    }));
    return compact({ query, total_results: data.total_results || 0, results });
  },

  async tmdb_show_image({ url, caption }) {
    if (!config.tmdb.readAccessToken) {
      return 'Error: TMDB_READ_ACCESS_TOKEN is not configured. Cannot fetch TMDB images.';
    }
    if (!Tmdb.isTmdbImageUrl(url)) {
      return `Error: tmdb_show_image only accepts URLs on image.tmdb.org. Got: ${url}`;
    }
    const { path: filepath } = await Tmdb.fetchTmdbImageToTmp(url);
    const note = caption?.trim() || 'TMDB image.';
    return `__IMAGE_PATH__:${filepath}|${note}`;
  },

  async tavily_search({
    query,
    max_results,
    search_depth,
    topic,
    time_range,
    include_domains,
    exclude_domains,
  }) {
    if (!config.tavily.apiKey) {
      return 'Error: TAVILY_API_KEY is not configured. Cannot run web search.';
    }
    if (!query || !String(query).trim()) {
      return 'Error: tavily_search requires a non-empty query.';
    }
    const requested = Math.min(Math.max(Number(max_results) || 5, 1), 10);
    const body = {
      query: String(query).trim(),
      search_depth: search_depth === 'basic' ? 'basic' : 'advanced',
      topic: topic === 'news' ? 'news' : 'general',
      max_results: requested,
      include_answer: 'advanced',
      include_images: true,
      include_image_descriptions: true,
    };
    if (time_range) body.time_range = time_range;
    if (Array.isArray(include_domains) && include_domains.length) {
      body.include_domains = include_domains;
    }
    if (Array.isArray(exclude_domains) && exclude_domains.length) {
      body.exclude_domains = exclude_domains;
    }

    const data = await Tavily.search(body);

    const results = (data.results || []).slice(0, requested).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: typeof r.content === 'string' ? r.content.slice(0, 600) : '',
      score: r.score,
    }));
    const images = (data.images || []).slice(0, 5).map((img) =>
      typeof img === 'string'
        ? { url: img }
        : { url: img.url, description: img.description || null },
    );
    return compact({
      query: data.query || query,
      answer: data.answer || null,
      results,
      images,
    });
  },

  async tavily_show_image({ url, caption }) {
    if (!url || typeof url !== 'string') {
      return 'Error: tavily_show_image requires a url.';
    }
    const { path: filepath } = await Tavily.fetchTavilyImageToTmp(url);
    const note = caption?.trim() || 'Web image.';
    return `__IMAGE_PATH__:${filepath}|${note}`;
  },

  async find_repeated_phrases({ fields, sizes, min_count, top_k } = {}) {
    const fieldSet = Array.isArray(fields) && fields.length ? fields : ['desc', 'body'];
    const ns = Array.isArray(sizes) && sizes.length ? sizes : [2, 3, 4];
    const minCount = Math.max(2, Number(min_count) || 2);
    const k = Math.min(100, Math.max(1, Number(top_k) || 25));

    const beats = await Plots.listBeats();
    if (beats.length === 0) {
      return compact({ status: 'empty', message: 'No beats yet — nothing to scan.' });
    }
    const lowSignal = beats.length < 10;

    const docs = beats
      .map((b) => ({
        id: b._id.toString(),
        label: `#${b.order} ${b.name}`,
        text: fieldSet.map((f) => b[f] || '').join('\n').trim(),
      }))
      .filter((d) => d.text);

    const counts = countNgrams(docs, ns, { minCount });
    const ranked = topNgrams(counts, k);

    const trimmed = ranked.map((g) => ({
      gram: g.gram,
      n: g.n,
      count: g.count,
      sources: g.sources.slice(0, 5),
      additional_sources: Math.max(0, g.sources.length - 5),
    }));

    return compact({
      status: lowSignal ? 'low_signal' : 'ok',
      note: lowSignal
        ? `Only ${beats.length} beat(s) — repetition signal is unreliable below ~10. Reporting anyway.`
        : null,
      fields_scanned: fieldSet,
      n_sizes: ns,
      beats_scanned: docs.length,
      min_count: minCount,
      phrases: trimmed,
    });
  },

  async check_similarity({ target_type, identifier, text, threshold, top_k } = {}) {
    if (target_type !== 'character' && target_type !== 'beat') {
      return 'Error: target_type must be "character" or "beat".';
    }
    if (!identifier && !text) {
      return 'Error: provide either `identifier` (existing item) or `text` (candidate text).';
    }
    if (identifier && text) {
      return 'Error: provide `identifier` OR `text`, not both.';
    }
    const thr = typeof threshold === 'number' ? threshold : 0.6;
    const k = Math.min(20, Math.max(1, Number(top_k) || 5));

    let corpus = [];
    let targetTokens = null;
    let excludeId = null;
    let mode = identifier ? 'existing' : 'candidate_text';

    if (target_type === 'character') {
      const all = await Characters.findAllCharacters();
      corpus = all.map((c) => {
        const fields = {};
        for (const f of CHARACTER_TEXT_FIELDS) fields[f] = String(c.fields?.[f] || '');
        return { id: c._id.toString(), label: c.name, fields };
      });
      if (identifier) {
        const t = await Characters.getCharacter(identifier);
        if (!t) return `No character found for "${identifier}".`;
        excludeId = t._id.toString();
        const targetText = CHARACTER_TEXT_FIELDS.map((f) => t.fields?.[f] || '')
          .filter(Boolean)
          .join('\n');
        targetTokens = bagOfWords(targetText);
      } else {
        targetTokens = bagOfWords(text);
      }
    } else {
      const beats = await Plots.listBeats();
      corpus = beats.map((b) => {
        const fields = {};
        for (const f of BEAT_TEXT_FIELDS) fields[f] = String(b[f] || '');
        return { id: b._id.toString(), label: `#${b.order} ${b.name}`, fields };
      });
      if (identifier) {
        const t = await Plots.getBeat(identifier);
        if (!t) return `No beat found for "${identifier}".`;
        excludeId = t._id.toString();
        const targetText = BEAT_TEXT_FIELDS.map((f) => t[f] || '').filter(Boolean).join('\n');
        targetTokens = bagOfWords(targetText);
      } else {
        targetTokens = bagOfWords(text);
      }
    }

    const comparable = corpus.filter((x) => x.id !== excludeId);
    if (comparable.length === 0) {
      return compact({
        status: 'no_corpus',
        message: `No other ${target_type}s to compare against.`,
        matches: [],
      });
    }

    const matches = rankSimilar(
      { tokens: targetTokens },
      corpus,
      { threshold: thr, excludeId },
    ).slice(0, k);

    return compact({
      target_type,
      mode,
      threshold: thr,
      corpus_size: comparable.length,
      matches,
    });
  },

  async find_character_phrases({ character, sizes, fields, top_k } = {}) {
    if (!character) return 'Error: `character` is required.';
    const ns = Array.isArray(sizes) && sizes.length ? sizes : [1, 2, 3];
    const fieldSet = Array.isArray(fields) && fields.length ? fields : ['desc', 'body'];
    const k = Math.min(50, Math.max(1, Number(top_k) || 15));

    const c = await Characters.getCharacter(character);
    if (!c) return `No character found for "${character}". Use list_characters to see options.`;
    const targetName = c.name.toLowerCase();

    const beats = await Plots.listBeats();
    const featuring = beats.filter((b) =>
      (b.characters || []).some((n) => String(n).toLowerCase() === targetName),
    );

    if (featuring.length === 0) {
      return compact({
        status: 'no_beats',
        character: c.name,
        message: `${c.name} is not listed in any beat. Add them via link_character_to_beat first.`,
        phrases_by_size: {},
      });
    }

    const docs = featuring.map((b) => ({
      id: b._id.toString(),
      label: `#${b.order} ${b.name}`,
      text: fieldSet.map((f) => b[f] || '').join('\n'),
    }));

    const counts = countNgrams(docs, ns, { minCount: 2 });
    const grouped = {};
    for (const n of ns) grouped[`size_${n}`] = [];
    for (const g of counts) {
      const key = `size_${g.n}`;
      if (grouped[key]) grouped[key].push({ gram: g.gram, count: g.count });
    }
    for (const key of Object.keys(grouped)) {
      grouped[key].sort((a, b) => b.count - a.count);
      grouped[key] = grouped[key].slice(0, k);
    }

    return compact({
      status: 'ok',
      character: c.name,
      beats_featuring: featuring.length,
      total_beats: beats.length,
      fields_scanned: fieldSet,
      phrases_by_size: grouped,
    });
  },

  async similar_character({ character, focus, max_works } = {}) {
    if (!character) return 'Error: `character` is required.';
    const c = await Characters.getCharacter(character);
    if (!c) return `No character found for "${character}".`;
    if (!config.tavily.apiKey) {
      return 'Error: TAVILY_API_KEY is not configured. Cannot run external similarity search.';
    }
    const max = Math.min(10, Math.max(1, Number(max_works) || 3));
    const profile = {
      hollywood_actor: c.hollywood_actor,
      fields: c.fields || {},
    };
    const hasContent =
      profile.hollywood_actor ||
      CHARACTER_TEXT_FIELDS.some((f) => String(profile.fields?.[f] || '').trim());
    if (!hasContent) {
      return `Error: character "${c.name}" has no descriptive fields to search on. Add background_story / arc / events / memes (or hollywood_actor) first.`;
    }
    const query = buildSimilarityQuery({ kind: 'character', profile, focus });
    const results = await runSimilaritySearch({ query });
    const { system, user } = buildAnalysisPrompt({
      kind: 'character',
      profile,
      results,
      maxWorks: max,
    });
    const analysis = await analyzeText({ system, user });
    return `Similarity scan for **${c.name}** (query: \`${query}\`)\n\n${
      analysis || '(no analysis returned)'
    }`;
  },

  async similar_works({ scope, beat, focus, max_works } = {}) {
    const s = scope === 'beat' ? 'beat' : 'plot';
    if (!config.tavily.apiKey) {
      return 'Error: TAVILY_API_KEY is not configured. Cannot run external similarity search.';
    }
    const max = Math.min(10, Math.max(1, Number(max_works) || 3));
    let kind;
    let profile;
    let label;

    if (s === 'plot') {
      const plot = await Plots.getPlot();
      const synopsis = String(plot.synopsis || '').trim();
      const beats = [...(plot.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
      if (!synopsis && beats.length === 0) {
        return 'Error: plot has no synopsis and no beats yet. Add some content before scanning for similar works.';
      }
      kind = 'plot';
      profile = { synopsis, beats };
      label = 'the current plot';
    } else {
      const target = await resolveBeat(beat);
      if (!String(target.desc || '').trim() && !String(target.body || '').trim()) {
        return `Error: beat "${target.name}" has no desc or body to analyze yet.`;
      }
      kind = 'beat';
      profile = { name: target.name, desc: target.desc, body: target.body };
      label = `beat #${target.order} ${target.name}`;
    }

    const query = buildSimilarityQuery({ kind, profile, focus });
    const results = await runSimilaritySearch({ query });
    const { system, user } = buildAnalysisPrompt({
      kind,
      profile,
      results,
      maxWorks: max,
    });
    const analysis = await analyzeText({ system, user });
    return `Similarity scan for ${label} (query: \`${query}\`)\n\n${
      analysis || '(no analysis returned)'
    }`;
  },

  async search_message_history({
    pattern,
    flags,
    since_days,
    until_days,
    role,
    limit,
    context_chars,
  } = {}) {
    if (!pattern || typeof pattern !== 'string') {
      return 'Error: `pattern` is required.';
    }
    const safeFlags = String(flags || 'i').replace(/[^imsu]/g, '');
    let regex;
    try {
      regex = new RegExp(pattern, safeFlags);
    } catch (e) {
      return `Error: invalid regex /${pattern}/${safeFlags}: ${e.message}`;
    }
    const { results, scanned, scan_limit_hit } = await Messages.searchMessages({
      channelId: config.discord.movieChannelId,
      regex,
      sinceDays: since_days,
      untilDays: until_days,
      role: role === 'user' || role === 'assistant' ? role : 'any',
      limit: Math.min(50, Math.max(1, Number(limit) || 20)),
      contextChars: Math.min(500, Math.max(40, Number(context_chars) || 200)),
    });
    return compact({
      pattern,
      flags: safeFlags,
      scanned,
      scan_limit_hit,
      match_count: results.length,
      results: results.map((r) => ({
        _id: r._id?.toString ? r._id.toString() : String(r._id),
        discord_message_id: r.discord_message_id,
        role: r.role,
        created_at: r.created_at,
        author_tag: r.author_tag,
        excerpt: r.excerpt,
        match: r.match,
      })),
    });
  },

  async analyze_dramatic_arc({ metric, fields } = {}) {
    const m = metric === 'steepest_drop' ? 'steepest_drop' : 'max_deviation';
    const fieldSet = Array.isArray(fields) && fields.length ? fields : ['desc', 'body'];

    const beats = await Plots.listBeats();
    if (beats.length === 0) {
      return compact({ status: 'empty', message: 'No beats yet.' });
    }
    if (beats.length < 3) {
      return compact({
        status: 'low_signal',
        message: `Only ${beats.length} beat(s); arc analysis needs at least 3.`,
      });
    }

    const series = beats.map((b) => ({
      id: b._id.toString(),
      order: b.order,
      name: b.name,
      text: fieldSet.map((f) => b[f] || '').join('\n'),
    }));

    const result = detectClimax(series, m);
    if (result.error) {
      return compact({ status: 'no_signal', message: result.error });
    }

    const climaxBeat = result.climax
      ? beats.find((b) => b._id.toString() === result.climax.id)
      : null;

    return compact({
      status: 'ok',
      metric: result.metric,
      baseline_comparative: result.baseline,
      expected_climax_window: result.expected_window,
      in_expected_window: result.in_expected_window,
      note: result.in_expected_window
        ? 'Detected climax sits in the conventional 75–90% window.'
        : 'Detected climax is outside the conventional 75–90% window — may indicate a front-loaded or misplaced peak.',
      climax: result.climax && {
        beat: {
          id: result.climax.id,
          order: result.climax.order,
          name: climaxBeat?.name || null,
        },
        comparative_sentiment: result.climax.comparative,
        delta: result.climax.deviation_or_drop,
        normalized_position: result.climax.normalized_position,
      },
      series: result.series,
    });
  },

  async calculator({ expression, precision } = {}) {
    if (typeof expression !== 'string' || !expression.trim()) {
      return 'Calculator error: `expression` is required.';
    }
    const p = Math.min(64, Math.max(4, Number(precision) || 14));
    try {
      const value = mj.evaluate(expression);
      let formatted;
      if (mj.isBigNumber(value) && value.isInteger()) {
        formatted = value.toFixed(0);
      } else {
        formatted = mj.format(value, { precision: p });
      }
      return compact({ expression, result: formatted });
    } catch (e) {
      return `Calculator error: ${e.message}`;
    }
  },

  async run_code({ code, timeout_ms } = {}) {
    if (typeof code !== 'string' || !code.trim()) {
      return 'run_code error: `code` is required.';
    }
    const result = runJsInVm(code, { timeoutMs: timeout_ms });
    return compact(result);
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
