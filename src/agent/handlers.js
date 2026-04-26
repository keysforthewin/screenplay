import * as Characters from '../mongo/characters.js';
import * as Plots from '../mongo/plots.js';
import * as Prompts from '../mongo/prompts.js';
import * as Files from '../mongo/files.js';
import * as Images from '../mongo/images.js';
import * as Tmdb from '../tmdb/client.js';
import * as Tavily from '../tavily/client.js';
import { generateImage as generateImageBytes } from '../gemini/client.js';
import { buildImagePrompt } from '../gemini/promptBuilder.js';
import { loadHistoryForLlm } from '../mongo/messages.js';
import { config } from '../config.js';
import { exportToPdf } from '../pdf/export.js';
import { buildOverview } from './overview.js';

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
    return `Created beat "${b.name}" (order ${b.order}, _id ${b._id}). It is now the current beat if none was set.`;
  },

  async update_beat({ identifier, patch }) {
    const b = await Plots.updateBeat(identifier, patch);
    return `Updated beat "${b.name}".\n${compact(serializeBeat(b))}`;
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
      const history = await loadHistoryForLlm(config.discord.movieChannelId);
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
