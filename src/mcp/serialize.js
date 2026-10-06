// serialize.js
//
// The JSON shapes the MCP tools answer with: compact, ids as strings, every
// stored file with the URL it is served at.

import { config } from '../config.js';
import { hardBreaksToLines, stripMarkdown } from '../util/markdown.js';
import { wardrobeImageId, wardrobeText } from '../web/wardrobe.js';

const HEX24 = /^[a-f0-9]{24}$/i;
const hex = (id) => (id && HEX24.test(String(id)) ? String(id) : null);

function publicBase() {
  return (config.web.publicBaseUrl || `http://localhost:${config.web.port}`).replace(/\/+$/, '');
}

export function imageUrl(id) {
  return hex(id) ? `${publicBase()}/image/${hex(id)}` : null;
}

export function attachmentUrl(id) {
  return hex(id) ? `${publicBase()}/attachment/${hex(id)}` : null;
}

export function serializeProject(p) {
  return { id: p._id.toString(), title: p.title };
}

export function serializeBeatSummary(beat, counts = {}) {
  return {
    order: beat.order,
    id: String(beat._id),
    name: stripMarkdown(beat.name || ''),
    desc: stripMarkdown(beat.desc || ''),
    characters: beat.characters || [],
    sets: beat.sets || [],
    ...counts,
  };
}

export function serializeDialog(d) {
  return {
    id: String(d._id),
    order: d.order,
    character: stripMarkdown(d.character || ''),
    direction: stripMarkdown(d.direction || ''),
    line: hardBreaksToLines(d.body || '').trim(),
    audio_seconds: d.audio_duration_seconds ?? null,
    audio_url: attachmentUrl(d.audio_file_id),
  };
}

export function serializeBeat(beat, dialogs = null) {
  const out = {
    order: beat.order,
    id: String(beat._id),
    name: stripMarkdown(beat.name || ''),
    desc: hardBreaksToLines(beat.desc || '').trim(),
    characters: beat.characters || [],
    sets: beat.sets || [],
    // The page as written: one screenplay line per line.
    body: hardBreaksToLines(beat.body || '').trim(),
  };
  if (beat.dialog_notes) out.dialog_notes = hardBreaksToLines(beat.dialog_notes).trim();
  if (dialogs) out.dialogue = dialogs.map(serializeDialog);
  return out;
}

function serializeFrame(frame) {
  if (!frame) return { prompt: '', reference_ids: [], image_id: null, image_url: null, can_undo: false };
  return {
    prompt: frame.prompt || '',
    reference_ids: (frame.reference_ids || []).map(String),
    image_id: hex(frame.image_id),
    image_url: imageUrl(frame.image_id),
    can_undo: !!frame.previous_image_id,
    ...(frame.model ? { model: frame.model } : {}),
  };
}

// `texts` overlays what was just written: a text write lands in the shared
// document first and reaches Mongo a moment later.
export function serializeCut(cut, scene = null, texts = {}) {
  const out = {
    id: String(cut._id),
    label: scene ? `${scene.order}.${cut.cut_index}` : undefined,
    scene_id: String(cut.scene_id),
    title: texts.title ?? cut.title ?? '',
    duration_seconds: cut.duration_seconds ?? null,
    prompt: texts.prompt ?? cut.prompt ?? '',
    start_frame: serializeFrame(cut.start_frame),
    end_frame: serializeFrame(cut.end_frame),
    video: cut.video_file_id
      ? {
          attachment_id: String(cut.video_file_id),
          url: attachmentUrl(cut.video_file_id),
          duration_seconds: cut.video_duration_seconds ?? null,
          model: cut.video_model_label || cut.video_model_id || null,
        }
      : null,
  };
  if (texts.start_frame_prompt != null) out.start_frame.prompt = texts.start_frame_prompt;
  if (texts.end_frame_prompt != null) out.end_frame.prompt = texts.end_frame_prompt;
  return out;
}

export function serializeScene(scene, cuts = null, title = null) {
  const out = {
    id: String(scene._id),
    order: scene.order,
    title: title ?? scene.title ?? '',
  };
  if (cuts) {
    out.cuts = cuts
      .slice()
      .sort((a, b) => (a.cut_index || 0) - (b.cut_index || 0))
      .map((c) => serializeCut(c, scene));
  }
  return out;
}

export function serializeCharacter(c, beat = null) {
  const portrait = c.main_image_id || c.images?.[0]?._id || null;
  const fields = {};
  for (const [k, v] of Object.entries(c.fields || {})) {
    if (typeof v === 'string' && v.trim()) fields[k] = hardBreaksToLines(v).trim();
  }
  return {
    id: String(c._id),
    name: stripMarkdown(c.name || ''),
    hollywood_actor: stripMarkdown(c.hollywood_actor || '') || null,
    wardrobe: wardrobeText(c, beat) || null,
    portrait_image_id: hex(portrait),
    portrait_url: imageUrl(portrait),
    wardrobe_image_id: wardrobeImageId(c) || null,
    wardrobe_image_url: imageUrl(wardrobeImageId(c)),
    fields,
  };
}

export function serializeSet(s) {
  return {
    id: String(s._id),
    name: stripMarkdown(s.name || ''),
    description: hardBreaksToLines(s.description || '').trim(),
    main_image_id: hex(s.main_image_id),
    main_image_url: imageUrl(s.main_image_id),
  };
}

export function serializeImageFile(file) {
  const m = file.metadata || {};
  return {
    image_id: String(file._id),
    url: imageUrl(file._id),
    content_type: file.contentType || null,
    bytes: file.length ?? null,
    owner_type: m.owner_type || 'library',
    owner_id: m.owner_id ? String(m.owner_id) : null,
    name: m.name || '',
    description: m.description || '',
    prompt: m.prompt || null,
    generated_by: m.generated_by || null,
  };
}

// Every picture a character or set carries, uncapped: its finished artwork
// (the curated look) first, then its gallery uploads. `role` marks the
// portrait / main image and a character's wardrobe plate.
export function serializeOwnerImages(doc, ownerType) {
  const main = hex(doc.main_image_id);
  const plate = ownerType === 'character' ? wardrobeImageId(doc) : '';
  const roles = (id) => [
    ...(id === main ? [ownerType === 'character' ? 'portrait' : 'main'] : []),
    ...(id && id === plate ? ['wardrobe_plate'] : []),
  ];
  const seen = new Set();
  const out = [];
  for (const a of doc.artworks || []) {
    const id = a?.status === 'done' ? hex(a.result_image_id) : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      image_id: id,
      url: imageUrl(id),
      kind: 'artwork',
      name: String(a.name || '').trim(),
      description: String(a.description || '').trim(),
      prompt: String(a.prompt || '').trim() || null,
      model: a.model || null,
      roles: [...roles(id), ...(a.prop ? ['prop_plate'] : [])],
      ...(a.prop ? { prop: String(a.prop) } : {}),
    });
  }
  for (const img of doc.images || []) {
    const id = hex(img?._id ?? img);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      image_id: id,
      url: imageUrl(id),
      kind: 'gallery',
      name: String(img?.filename || '').trim(),
      description: String(img?.caption || '').trim(),
      prompt: img?.prompt || null,
      model: img?.generated_by || null,
      roles: roles(id),
    });
  }
  return out;
}
