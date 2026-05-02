import PDFDocument from 'pdfkit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { findAllCharacters, getCharacter } from '../mongo/characters.js';
import { getPlot, searchBeats } from '../mongo/plots.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import { readImageBuffer, listLibraryImages } from '../mongo/images.js';
import { listLibraryAttachments } from '../mongo/attachments.js';
import { attachmentLink } from '../server/index.js';
import { analyzeText } from '../llm/analyze.js';
import { logger } from '../log.js';
import { registerNotoFonts, NOTO_FONTS, renderMarkdown } from './markdown.js';
import {
  buildAnchorContext,
  renderToc,
  measureTocPageCount,
} from './toc.js';

const FALLBACK_SLUG_BY_MODE = {
  dossier: 'dossier',
  character: 'character-sheet',
  characters: 'character-sheets',
  beats: 'beats',
  full: 'full-script',
};

export function slugifyFilename(s, { maxLen = 60 } = {}) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
}

const ORDINAL_SUFFIX = ['th', 'st', 'nd', 'rd'];

function dayOrdinal(n) {
  const v = n % 100;
  return ORDINAL_SUFFIX[(v - 20) % 10] || ORDINAL_SUFFIX[v] || ORDINAL_SUFFIX[0];
}

export function formatExportTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const month = get('month').toLowerCase();
  const dayNum = parseInt(get('day'), 10);
  const day = `${dayNum}${dayOrdinal(dayNum)}`;
  const hour = get('hour');
  const minute = get('minute');
  const period = get('dayPeriod').toLowerCase();
  return `${month}-${day}-${hour}${minute}${period}-est`;
}

function fallbackSlugForMode(mode) {
  return FALLBACK_SLUG_BY_MODE[mode] || 'export';
}

function renderUserPromptForMeta(meta) {
  const now = new Date();
  const lines = [
    `Today is ${now.toUTCString()}.`,
    `Export mode: ${meta.mode}.`,
    `Working title: ${meta.title ? `"${meta.title}"` : '(none)'}.`,
  ];
  if (meta.mode === 'dossier' && meta.characterName) {
    lines.push(`Dossier subject: ${meta.characterName}.`);
    if (typeof meta.beatCount === 'number') {
      lines.push(`Includes ${meta.beatCount} beats featuring this character.`);
    }
  } else if (meta.mode === 'character' && meta.characterName) {
    lines.push(`Character: ${meta.characterName}.`);
  } else if (meta.mode === 'characters' && Array.isArray(meta.characterNames)) {
    lines.push(
      `Characters (${meta.characterNames.length}): ${meta.characterNames.join(', ')}.`,
    );
  } else if (meta.mode === 'beats') {
    lines.push(`Beats query: "${meta.beatsQuery || ''}".`);
    if (typeof meta.beatCount === 'number') {
      lines.push(`Matched ${meta.beatCount} beats.`);
    }
  } else if (meta.mode === 'full') {
    if (typeof meta.characterCount === 'number' && typeof meta.beatCount === 'number') {
      lines.push(
        `Full export contains ${meta.characterCount} characters and ${meta.beatCount} beats.`,
      );
    }
  }
  return lines.join('\n');
}

export async function inferExportTitle(meta) {
  const fallback = fallbackSlugForMode(meta.mode);
  try {
    const system =
      "You name PDF export files for a screenwriting bot. Given a description of " +
      "what's in the export, return one short, descriptive title between 3 and 50 " +
      "characters. Use plain English. Title case is fine. No quotes, no file " +
      "extensions, no dates, no trailing punctuation. Examples: \"Rae's Character " +
      "Sheet\", \"Beats 1-10\", \"Full Script\", \"Act One Climax Beats\", \"Hero " +
      "Trio Sheets\". Respond with only the title — no preamble, no explanation.";
    const user = renderUserPromptForMeta(meta);
    const text = await analyzeText({
      system,
      user,
      model: 'claude-haiku-4-5',
      maxTokens: 60,
    });
    const slug = slugifyFilename(text, { maxLen: 60 });
    return slug || fallback;
  } catch (e) {
    logger.warn(`PDF filename inference failed, using fallback: ${e.message}`);
    return fallback;
  }
}

const FONT = NOTO_FONTS;

function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function placeImage(doc, buf, fit) {
  const [maxW, maxH] = fit;
  let drawW = maxW;
  let drawH = maxH;
  try {
    const img = doc.openImage(buf);
    let imgW = img.width;
    let imgH = img.height;
    // PDFKit swaps width/height internally for EXIF orientations 5–8; mirror
    // that here so our pre-measure matches the actual rendered dimensions.
    if (img.orientation && img.orientation > 4) [imgW, imgH] = [imgH, imgW];
    const scale = Math.min(maxW / imgW, maxH / imgH, 1);
    drawW = imgW * scale;
    drawH = imgH * scale;
  } catch {
    // openImage failed; fall back to worst-case fit dims.
  }

  const top = doc.page.margins.top;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const availablePageHeight = bottom - top;

  if (drawH > availablePageHeight) {
    spanImageAcrossTwoPages(doc, buf, drawW, drawH);
    return;
  }

  if (doc.y + drawH > bottom) doc.addPage();
  doc.image(buf, { fit, align: 'center' });
}

function spanImageAcrossTwoPages(doc, buf, drawW, drawH) {
  const { left, right, top, bottom: bottomMargin } = doc.page.margins;
  const contentWidth = doc.page.width - left - right;
  const availablePageHeight = doc.page.height - top - bottomMargin;
  const x = left + (contentWidth - drawW) / 2;

  if (doc.y > top) doc.addPage();

  doc.save();
  doc.rect(left, top, contentWidth, availablePageHeight).clip();
  doc.image(buf, x, top, { width: drawW, height: drawH });
  doc.restore();

  doc.addPage();
  doc.save();
  doc.rect(left, top, contentWidth, availablePageHeight).clip();
  doc.image(buf, x, top - availablePageHeight, { width: drawW, height: drawH });
  doc.restore();

  doc.y = top + (drawH - availablePageHeight);
}

function formatFieldEntry(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  const entries = Object.entries(v).filter(([, val]) => val != null && val !== '');
  if (!entries.length) return '';
  return entries
    .map(([k, val]) => `${k.replace(/_/g, ' ')}: ${val}`)
    .join(' — ');
}

export function formatFieldValue(v) {
  if (v == null) return '';
  if (Array.isArray(v)) {
    const sep = v.some((x) => x && typeof x === 'object') ? '; ' : ', ';
    return v.map(formatFieldEntry).filter(Boolean).join(sep);
  }
  return formatFieldEntry(v);
}

function renderImageBundle(doc, items, fit) {
  for (const item of items || []) {
    if (!item?.buffer) continue;
    doc.moveDown(0.3);
    try {
      placeImage(doc, item.buffer, fit);
      const caption = item.meta?.caption;
      if (caption) {
        doc.font(FONT.italic).fontSize(9).fillColor('#666')
          .text(caption, { align: 'center' });
        doc.fillColor('#000');
      }
    } catch (e) {
      logger.warn(`failed to embed image: ${e.message}`);
    }
  }
}

function renderAttachmentList(doc, attachments, { source = 'inline', heading = 'Attachments:' } = {}) {
  if (!attachments?.length) return;
  if (heading) {
    doc.moveDown(0.3);
    doc.font(FONT.bold).fontSize(11).text(heading);
  }
  for (const a of attachments) {
    const id   = a?._id;
    const name = a.filename || '(unnamed)';
    const ct   = source === 'gridfs'
      ? (a.metadata?.content_type || a.contentType || 'unknown')
      : (a.content_type || 'unknown');
    const size = source === 'gridfs' ? a.length : a.size;
    const cap  = source === 'gridfs' ? null : a.caption;
    const url  = id ? attachmentLink(id) : null;
    let line = `• ${name}  (${ct}, ${formatBytes(size)})`;
    if (cap) line += ` — ${cap}`;
    doc.font(FONT.regular).fontSize(10);
    if (url) {
      doc.text(line, { continued: true });
      doc.fillColor('#0645AD').text(`  ${url}`, { link: url, underline: true });
      doc.fillColor('#000');
    } else {
      doc.text(line);
    }
  }
}

function renderTitlePage(doc, { title }) {
  doc.font(FONT.bold).fontSize(28).text(title, { align: 'center' });
  doc.moveDown(2);
  doc.font(FONT.italic).fontSize(14).text('Working draft', { align: 'center' });
}

function renderDirectorNotesSection(doc, { directorNotes, directorNoteImages }, ctx) {
  const dnList = Array.isArray(directorNotes?.notes) ? directorNotes.notes : [];
  if (!dnList.length) return;
  doc.addPage();
  const dest = ctx.anchor('director_notes', "Director's Notes");
  doc.font(FONT.bold).fontSize(18).text("Director's Notes", { destination: dest });
  doc.moveDown();
  doc.font(FONT.italic).fontSize(11).text(
    'Standing rules for this screenplay — apply to every character and beat unless otherwise noted.',
  );
  doc.moveDown();
  for (const n of dnList) {
    doc.font(FONT.regular).fontSize(11).fillColor('#000');
    doc.text('• ', { indent: 0, continued: true });
    renderMarkdown(doc, n.text || '', {
      size: 11,
      paragraphGap: 4,
      indent: 14,
      continueFirstParagraph: true,
    });
    const noteId = n._id ? n._id.toString() : null;
    const items = noteId ? (directorNoteImages[noteId] || []) : [];
    renderImageBundle(doc, items, [320, 240]);
    renderAttachmentList(doc, n.attachments, { source: 'inline' });
  }
}

function renderCharactersSection(doc, { characters, characterImages }, ctx) {
  if (!(characters || []).length) return;
  doc.addPage();
  const sectionDest = ctx.anchor('characters', 'Characters');
  doc.font(FONT.bold).fontSize(18).text('Characters', { destination: sectionDest });
  doc.moveDown();
  for (const c of characters) {
    ensureSpaceFor(doc, 18);
    const charDest = ctx.subAnchor('character', c.name);
    doc.font(FONT.bold).fontSize(14).text(c.name, { destination: charDest });
    doc.font(FONT.regular).fontSize(11);
    const role = c.plays_self ? 'Plays themselves' : `Played by ${c.hollywood_actor || '(unspecified)'}`;
    const voice = c.own_voice ? 'own voice' : 'dubbed by actor';
    doc.text(`${role} — ${voice}`);
    const charId = c._id ? c._id.toString() : null;
    const charItems = charId ? (characterImages[charId] || []) : [];
    renderImageBundle(doc, charItems, [220, 220]);
    doc.moveDown(0.5);
    for (const [k, v] of Object.entries(c.fields || {})) {
      const valueStr = formatFieldValue(v);
      if (!valueStr) continue;
      doc.font(FONT.bold).fontSize(11).fillColor('#000');
      doc.text(`${k.replace(/_/g, ' ')}:`);
      renderMarkdown(doc, valueStr, {
        size: 11,
        paragraphGap: 4,
        indent: 12,
      });
    }
    renderAttachmentList(doc, c.attachments, { source: 'inline' });
    doc.moveDown();
  }
}

function renderPlotSection(doc, { plot, beatImages }, ctx) {
  const synopsisText = (plot?.synopsis || '').trim();
  const notesText = (plot?.notes || '').trim();
  const beatList = plot?.beats || [];
  if (!synopsisText && !notesText && !beatList.length) return;
  doc.addPage();
  const sectionDest = ctx.anchor('plot', 'Plot');
  doc.font(FONT.bold).fontSize(18).text('Plot', { destination: sectionDest });
  doc.moveDown();
  if (synopsisText) {
    doc.font(FONT.bold).fontSize(13).text('Synopsis');
    renderMarkdown(doc, plot.synopsis, { size: 11, paragraphGap: 4 });
    doc.moveDown();
  }
  if (beatList.length) {
    doc.font(FONT.bold).fontSize(13).text('Beats');
    const beats = [...beatList].sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const b of beats) {
      ensureSpaceFor(doc, 14);
      const beatLabel = `${b.order}. ${b.name || ''}`;
      const beatDest = ctx.subAnchor('beat', beatLabel);
      doc.font(FONT.bold).fontSize(11).text(beatLabel, { destination: beatDest });
      if (b.desc) renderMarkdown(doc, b.desc, { size: 11, paragraphGap: 2, baseStyle: 'italic' });
      if (b.body) renderMarkdown(doc, b.body, { size: 11, paragraphGap: 4 });
      if (b.characters?.length) {
        doc.font(FONT.italic).fontSize(11).text(`Characters: ${b.characters.join(', ')}`);
      }
      const beatId = b._id ? b._id.toString() : null;
      const beatItems = beatId ? (beatImages[beatId] || []) : [];
      renderImageBundle(doc, beatItems, [400, 280]);
      renderAttachmentList(doc, b.attachments, { source: 'inline' });
      doc.moveDown(0.5);
    }
  }
  if (notesText) {
    doc.moveDown();
    doc.font(FONT.bold).fontSize(13).text('Notes');
    renderMarkdown(doc, plot.notes, { size: 11, paragraphGap: 4 });
  }
}

function renderLibrarySection(doc, { library }, ctx) {
  const hasLibrary =
    library && ((library.images?.length || 0) + (library.attachments?.length || 0) > 0);
  if (!hasLibrary) return;
  doc.addPage();
  const dest = ctx.anchor('library', 'Library');
  doc.font(FONT.bold).fontSize(18).text('Library', { destination: dest });
  doc.moveDown(0.5);
  doc.font(FONT.italic).fontSize(11).text(
    'Images and files not associated with any character or beat.',
  );
  doc.moveDown();

  if (library.images?.length) {
    doc.font(FONT.bold).fontSize(13).text('Images');
    for (const item of library.images) {
      if (!item?.buffer) continue;
      doc.moveDown(0.3);
      try {
        placeImage(doc, item.buffer, [400, 300]);
        const cap = item.file?.filename || item.file?.metadata?.prompt;
        if (cap) {
          doc.font(FONT.italic).fontSize(9).fillColor('#666')
            .text(cap, { align: 'center' }).fillColor('#000');
        }
      } catch (e) {
        logger.warn(`failed to embed library image: ${e.message}`);
      }
    }
  }

  if (library.attachments?.length) {
    doc.moveDown();
    doc.font(FONT.bold).fontSize(13).text('Files');
    renderAttachmentList(doc, library.attachments, { source: 'gridfs', heading: null });
  }
}

function ensureSpaceFor(doc, height) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) doc.addPage();
}

const NOOP_CTX = {
  anchor: () => undefined,
  subAnchor: () => undefined,
  entries: [],
};

function runRenderPass(args, ctxFactory, { tocEntries = null, tocPageOffset = 0, drain = false } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margins: { top: 72, bottom: 72, left: 90, right: 72 } });
    registerNotoFonts(doc);
    const chunks = [];
    if (drain) {
      doc.on('data', () => {});
    } else {
      doc.on('data', (c) => chunks.push(c));
    }
    doc.on('end', () => resolve(drain ? null : Buffer.concat(chunks)));
    doc.on('error', reject);
    const ctx = ctxFactory(doc);

    renderTitlePage(doc, args);
    if (tocEntries && tocEntries.length) {
      renderToc(doc, tocEntries, tocPageOffset);
    }
    renderDirectorNotesSection(doc, args, ctx);
    renderCharactersSection(doc, args, ctx);
    renderPlotSection(doc, args, ctx);
    renderLibrarySection(doc, args, ctx);

    doc.end();
  });
}

export async function renderScreenplayPdf(args) {
  const {
    title = 'Untitled Screenplay',
    characters,
    plot,
    directorNotes = null,
    beatImages = {},
    characterImages = {},
    directorNoteImages = {},
    library = null,
    toc = true,
  } = args;
  const fullArgs = {
    title,
    characters,
    plot,
    directorNotes,
    beatImages,
    characterImages,
    directorNoteImages,
    library,
  };
  const beatCount = (plot?.beats || []).length;
  const countItems = (map) =>
    Object.values(map || {}).reduce((acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
  const embedCount =
    countItems(beatImages) + countItems(characterImages) + countItems(directorNoteImages)
    + (library?.images?.length || 0);
  logger.info(
    `pdf render → beats=${beatCount} characters=${characters?.length || 0} embed_imgs=${embedCount} toc=${toc}`,
  );
  const renderT0 = Date.now();

  if (!toc) {
    const buf = await runRenderPass(fullArgs, () => NOOP_CTX);
    logger.info(`pdf render ← bytes=${buf.length} ${Date.now() - renderT0}ms (no toc)`);
    return buf;
  }

  const collector = [];
  await runRenderPass(
    fullArgs,
    (doc) => buildAnchorContext('capture', doc, collector),
    { drain: true },
  );

  if (collector.length < 2) {
    const buf = await runRenderPass(fullArgs, () => NOOP_CTX);
    logger.info(`pdf render ← bytes=${buf.length} ${Date.now() - renderT0}ms (toc skipped: ${collector.length} entries)`);
    return buf;
  }

  const tocPageCount = measureTocPageCount(collector);

  const buf = await runRenderPass(
    fullArgs,
    (doc) => buildAnchorContext('final', doc),
    { tocEntries: collector, tocPageOffset: tocPageCount },
  );
  logger.info(`pdf render ← bytes=${buf.length} ${Date.now() - renderT0}ms (toc=${tocPageCount}p, ${collector.length} entries)`);
  return buf;
}

async function loadOwnerImages(ownerImages, mainImageId) {
  const items = [];
  for (const img of ownerImages || []) {
    if (!img?._id) continue;
    try {
      const res = await readImageBuffer(img._id);
      if (res) items.push({ buffer: res.buffer, meta: img });
    } catch (e) {
      logger.warn(`could not load image ${img._id}: ${e.message}`);
    }
  }
  if (mainImageId) {
    const mainStr = mainImageId.toString();
    items.sort((a, b) => {
      const aMain = a.meta?._id?.toString() === mainStr ? -1 : 0;
      const bMain = b.meta?._id?.toString() === mainStr ? -1 : 0;
      return aMain - bMain;
    });
  }
  return items;
}

async function loadBeatImages(plot) {
  const out = {};
  for (const b of plot.beats || []) {
    if (!b._id) continue;
    out[b._id.toString()] = await loadOwnerImages(b.images, b.main_image_id);
  }
  return out;
}

async function loadCharacterImages(characters) {
  const out = {};
  for (const c of characters || []) {
    if (!c._id) continue;
    out[c._id.toString()] = await loadOwnerImages(c.images, c.main_image_id);
  }
  return out;
}

async function loadDirectorNoteImages(directorNotes) {
  const out = {};
  for (const n of directorNotes?.notes || []) {
    if (!n._id) continue;
    out[n._id.toString()] = await loadOwnerImages(n.images, n.main_image_id);
  }
  return out;
}

async function loadLibrary() {
  const orphanFiles = await listLibraryImages();
  const images = [];
  for (const file of orphanFiles || []) {
    try {
      const res = await readImageBuffer(file._id);
      if (res) images.push({ buffer: res.buffer, file });
    } catch (e) {
      logger.warn(`could not load library image ${file._id}: ${e.message}`);
    }
  }
  const attachments = await listLibraryAttachments();
  return { images, attachments: attachments || [] };
}

async function buildExportData({ characters: charNames, beats_query, dossier_character }) {
  if (Array.isArray(charNames) && charNames.length) {
    const resolved = await Promise.all(charNames.map((n) => getCharacter(n)));
    const missing = charNames.filter((_, i) => !resolved[i]);
    if (missing.length) return { error: `No such character(s): ${missing.join(', ')}.` };
    const characterImages = await loadCharacterImages(resolved);
    const names = resolved.map((c) => c.name);
    const meta = resolved.length === 1
      ? { mode: 'character', characterName: names[0] }
      : { mode: 'characters', characterNames: names };
    return {
      characters: resolved,
      plot: { synopsis: '', beats: [], notes: '' },
      directorNotes: null,
      beatImages: {},
      characterImages,
      directorNoteImages: {},
      library: null,
      meta,
    };
  }

  if (beats_query) {
    const matches = await searchBeats(beats_query);
    if (!matches.length) return { error: `No beats matched query: "${beats_query}".` };
    const beats = matches
      .map((m) => m.beat)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const beatImages = await loadBeatImages({ beats });
    return {
      characters: [],
      plot: { synopsis: '', beats, notes: '' },
      directorNotes: null,
      beatImages,
      characterImages: {},
      directorNoteImages: {},
      library: null,
      meta: { mode: 'beats', beatsQuery: beats_query, beatCount: beats.length },
    };
  }

  if (dossier_character) {
    const character = await getCharacter(dossier_character);
    if (!character) return { error: `Character not found: ${dossier_character}.` };
    const plot = await getPlot();
    const target = String(character.name || '').toLowerCase();
    const beats = (plot.beats || [])
      .filter((b) => (b.characters || []).some((n) => String(n).toLowerCase() === target))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const [characterImages, beatImages] = await Promise.all([
      loadCharacterImages([character]),
      loadBeatImages({ beats }),
    ]);
    return {
      characters: [character],
      plot: { synopsis: '', beats, notes: '' },
      directorNotes: null,
      beatImages,
      characterImages,
      directorNoteImages: {},
      library: null,
      meta: { mode: 'dossier', characterName: character.name, beatCount: beats.length },
    };
  }

  const characters = await findAllCharacters();
  const plot = await getPlot();
  const directorNotes = await getDirectorNotes();
  const [beatImages, characterImages, directorNoteImages, library] = await Promise.all([
    loadBeatImages(plot),
    loadCharacterImages(characters),
    loadDirectorNoteImages(directorNotes),
    loadLibrary(),
  ]);
  return {
    characters,
    plot,
    directorNotes,
    beatImages,
    characterImages,
    directorNoteImages,
    library,
    meta: {
      mode: 'full',
      characterCount: characters.length,
      beatCount: (plot.beats || []).length,
    },
  };
}

export async function exportToPdf({ title, characters, beats_query, dossier_character } = {}) {
  const result = await buildExportData({ characters, beats_query, dossier_character });
  if (result.error) return { error: result.error };
  const { meta, ...data } = result;
  let effectiveTitle = typeof title === 'string' ? title.trim() : '';
  if (!effectiveTitle) {
    const persistedTitle = (result.plot?.title || (await getPlot()).title || '').trim();
    if (persistedTitle) effectiveTitle = persistedTitle;
  }
  const renderArgs = effectiveTitle ? { title: effectiveTitle, ...data } : { ...data };
  const inferArgs = effectiveTitle ? { ...meta, title: effectiveTitle } : { ...meta };
  const [buf, slug] = await Promise.all([
    renderScreenplayPdf(renderArgs),
    inferExportTitle(inferArgs),
  ]);
  await fs.mkdir(config.pdf.exportDir, { recursive: true });
  const filename = `${slug}-${formatExportTimestamp()}.pdf`;
  const filepath = path.join(config.pdf.exportDir, filename);
  await fs.writeFile(filepath, buf);
  return { path: filepath };
}
