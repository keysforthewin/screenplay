import PDFDocument from 'pdfkit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { findAllCharacters } from '../mongo/characters.js';
import { getPlot } from '../mongo/plots.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import { readImageBuffer, listLibraryImages } from '../mongo/images.js';
import { listLibraryAttachments } from '../mongo/attachments.js';
import { attachmentLink } from '../server/index.js';
import { logger } from '../log.js';

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

function renderImageBundle(doc, items, fit) {
  for (const item of items || []) {
    if (!item?.buffer) continue;
    doc.moveDown(0.3);
    try {
      placeImage(doc, item.buffer, fit);
      const caption = item.meta?.caption;
      if (caption) {
        doc.font('Times-Italic').fontSize(9).fillColor('#666')
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
    doc.font('Times-Bold').fontSize(11).text(heading);
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
    doc.font('Times-Roman').fontSize(10);
    if (url) {
      doc.text(line, { continued: true });
      doc.fillColor('#0645AD').text(`  ${url}`, { link: url, underline: true });
      doc.fillColor('#000');
    } else {
      doc.text(line);
    }
  }
}

export function renderScreenplayPdf({
  title = 'Untitled Screenplay',
  characters,
  plot,
  directorNotes = null,
  beatImages = {},
  characterImages = {},
  directorNoteImages = {},
  library = null,
}) {
  const beatCount = (plot?.beats || []).length;
  const countItems = (map) =>
    Object.values(map || {}).reduce((acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
  const embedCount =
    countItems(beatImages) + countItems(characterImages) + countItems(directorNoteImages)
    + (library?.images?.length || 0);
  logger.info(
    `pdf render → beats=${beatCount} characters=${characters?.length || 0} embed_imgs=${embedCount}`,
  );
  const renderT0 = Date.now();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margins: { top: 72, bottom: 72, left: 90, right: 72 } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      const buf = Buffer.concat(chunks);
      logger.info(`pdf render ← bytes=${buf.length} ${Date.now() - renderT0}ms`);
      resolve(buf);
    });
    doc.on('error', reject);

    doc.font('Times-Bold').fontSize(28).text(title, { align: 'center' });
    doc.moveDown(2);
    doc.font('Times-Italic').fontSize(14).text('Working draft', { align: 'center' });

    const dnList = Array.isArray(directorNotes?.notes) ? directorNotes.notes : [];
    if (dnList.length) {
      doc.addPage();
      doc.font('Times-Bold').fontSize(18).text("Director's Notes");
      doc.moveDown();
      doc.font('Times-Italic').fontSize(11).text(
        'Standing rules for this screenplay — apply to every character and beat unless otherwise noted.',
      );
      doc.moveDown();
      doc.font('Times-Roman').fontSize(11);
      for (const n of dnList) {
        doc.font('Times-Roman').text(`• ${n.text}`, {
          indent: 0,
          paragraphGap: 4,
        });
        const noteId = n._id ? n._id.toString() : null;
        const items = noteId ? (directorNoteImages[noteId] || []) : [];
        renderImageBundle(doc, items, [320, 240]);
        renderAttachmentList(doc, n.attachments, { source: 'inline' });
      }
    }

    doc.addPage();
    doc.font('Times-Bold').fontSize(18).text('Characters');
    doc.moveDown();
    for (const c of characters) {
      doc.font('Times-Bold').fontSize(14).text(c.name);
      doc.font('Times-Roman').fontSize(11);
      const role = c.plays_self ? 'Plays themselves' : `Played by ${c.hollywood_actor || '(unspecified)'}`;
      const voice = c.own_voice ? 'own voice' : 'dubbed by actor';
      doc.text(`${role} — ${voice}`);
      const charId = c._id ? c._id.toString() : null;
      const charItems = charId ? (characterImages[charId] || []) : [];
      renderImageBundle(doc, charItems, [220, 220]);
      doc.moveDown(0.5);
      for (const [k, v] of Object.entries(c.fields || {})) {
        doc.font('Times-Bold').text(`${k.replace(/_/g, ' ')}: `, { continued: true });
        doc.font('Times-Roman').text(Array.isArray(v) ? v.join(', ') : String(v));
      }
      renderAttachmentList(doc, c.attachments, { source: 'inline' });
      doc.moveDown();
    }

    doc.addPage();
    doc.font('Times-Bold').fontSize(18).text('Plot');
    doc.moveDown();
    doc.font('Times-Bold').fontSize(13).text('Synopsis');
    doc.font('Times-Roman').fontSize(11).text(plot.synopsis || '(none)');
    doc.moveDown();
    doc.font('Times-Bold').fontSize(13).text('Beats');
    doc.font('Times-Roman').fontSize(11);
    const beats = [...(plot.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const b of beats) {
      doc.font('Times-Bold').text(`${b.order}. ${b.name || ''}`);
      if (b.desc) doc.font('Times-Italic').fontSize(11).text(b.desc);
      if (b.body) doc.font('Times-Roman').fontSize(11).text(b.body);
      if (b.characters?.length) doc.font('Times-Italic').text(`Characters: ${b.characters.join(', ')}`);
      const beatId = b._id ? b._id.toString() : null;
      const beatItems = beatId ? (beatImages[beatId] || []) : [];
      renderImageBundle(doc, beatItems, [400, 280]);
      renderAttachmentList(doc, b.attachments, { source: 'inline' });
      doc.moveDown(0.5);
    }
    if (plot.notes) {
      doc.moveDown();
      doc.font('Times-Bold').fontSize(13).text('Notes');
      doc.font('Times-Roman').fontSize(11).text(plot.notes);
    }

    const hasLibrary =
      library && ((library.images?.length || 0) + (library.attachments?.length || 0) > 0);
    if (hasLibrary) {
      doc.addPage();
      doc.font('Times-Bold').fontSize(18).text('Library');
      doc.moveDown(0.5);
      doc.font('Times-Italic').fontSize(11).text(
        'Images and files not associated with any character or beat.',
      );
      doc.moveDown();

      if (library.images?.length) {
        doc.font('Times-Bold').fontSize(13).text('Images');
        for (const item of library.images) {
          if (!item?.buffer) continue;
          doc.moveDown(0.3);
          try {
            placeImage(doc, item.buffer, [400, 300]);
            const cap = item.file?.filename || item.file?.metadata?.prompt;
            if (cap) {
              doc.font('Times-Italic').fontSize(9).fillColor('#666')
                .text(cap, { align: 'center' }).fillColor('#000');
            }
          } catch (e) {
            logger.warn(`failed to embed library image: ${e.message}`);
          }
        }
      }

      if (library.attachments?.length) {
        doc.moveDown();
        doc.font('Times-Bold').fontSize(13).text('Files');
        renderAttachmentList(doc, library.attachments, { source: 'gridfs', heading: null });
      }
    }

    doc.end();
  });
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

export async function exportToPdf({ title } = {}) {
  const characters = await findAllCharacters();
  const plot = await getPlot();
  const directorNotes = await getDirectorNotes();
  const [beatImages, characterImages, directorNoteImages, library] = await Promise.all([
    loadBeatImages(plot),
    loadCharacterImages(characters),
    loadDirectorNoteImages(directorNotes),
    loadLibrary(),
  ]);
  const buf = await renderScreenplayPdf({
    title,
    characters,
    plot,
    directorNotes,
    beatImages,
    characterImages,
    directorNoteImages,
    library,
  });
  await fs.mkdir(config.pdf.exportDir, { recursive: true });
  const filename = `screenplay-${Date.now()}.pdf`;
  const filepath = path.join(config.pdf.exportDir, filename);
  await fs.writeFile(filepath, buf);
  return filepath;
}
