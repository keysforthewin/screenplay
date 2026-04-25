import PDFDocument from 'pdfkit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { findAllCharacters } from '../mongo/characters.js';
import { getPlot } from '../mongo/plots.js';
import { readImageBuffer } from '../mongo/images.js';
import { readCharacterImageBuffer } from '../mongo/files.js';
import { logger } from '../log.js';

export function renderScreenplayPdf({ title = 'Untitled Screenplay', characters, plot, beatImages = {}, characterImages = {} }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margins: { top: 72, bottom: 72, left: 90, right: 72 } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Times-Bold').fontSize(28).text(title, { align: 'center' });
    doc.moveDown(2);
    doc.font('Times-Italic').fontSize(14).text('Working draft', { align: 'center' });
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
      const charImg = charId ? characterImages[charId] : null;
      if (charImg) {
        doc.moveDown(0.3);
        try {
          doc.image(charImg, { fit: [220, 220] });
        } catch (e) {
          logger.warn(`failed to embed character image: ${e.message}`);
        }
      }
      doc.moveDown(0.5);
      for (const [k, v] of Object.entries(c.fields || {})) {
        doc.font('Times-Bold').text(`${k.replace(/_/g, ' ')}: `, { continued: true });
        doc.font('Times-Roman').text(Array.isArray(v) ? v.join(', ') : String(v));
      }
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
      const imgBuf = beatId ? beatImages[beatId] : null;
      if (imgBuf) {
        doc.moveDown(0.3);
        try {
          doc.image(imgBuf, { fit: [400, 280], align: 'center' });
        } catch (e) {
          logger.warn(`failed to embed beat image: ${e.message}`);
        }
      }
      doc.moveDown(0.5);
    }
    if (plot.notes) {
      doc.moveDown();
      doc.font('Times-Bold').fontSize(13).text('Notes');
      doc.font('Times-Roman').fontSize(11).text(plot.notes);
    }

    doc.end();
  });
}

async function loadBeatImages(plot) {
  const out = {};
  for (const b of plot.beats || []) {
    if (!b.main_image_id || !b._id) continue;
    try {
      const res = await readImageBuffer(b.main_image_id);
      if (res) out[b._id.toString()] = res.buffer;
    } catch (e) {
      logger.warn(`could not load main image for beat ${b._id}: ${e.message}`);
    }
  }
  return out;
}

async function loadCharacterImages(characters) {
  const out = {};
  for (const c of characters) {
    if (!c.main_image_id || !c._id) continue;
    try {
      const res = await readCharacterImageBuffer(c.main_image_id);
      if (res) out[c._id.toString()] = res.buffer;
    } catch (e) {
      logger.warn(`could not load main image for character ${c._id}: ${e.message}`);
    }
  }
  return out;
}

export async function exportToPdf({ title } = {}) {
  const characters = await findAllCharacters();
  const plot = await getPlot();
  const [beatImages, characterImages] = await Promise.all([
    loadBeatImages(plot),
    loadCharacterImages(characters),
  ]);
  const buf = await renderScreenplayPdf({ title, characters, plot, beatImages, characterImages });
  await fs.mkdir(config.pdf.exportDir, { recursive: true });
  const filename = `screenplay-${Date.now()}.pdf`;
  const filepath = path.join(config.pdf.exportDir, filename);
  await fs.writeFile(filepath, buf);
  return filepath;
}
