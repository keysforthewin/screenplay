import PDFDocument from 'pdfkit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { listCharacters, getCharacter } from '../mongo/characters.js';
import { getPlot } from '../mongo/plots.js';

export function renderScreenplayPdf({ title = 'Untitled Screenplay', characters, plot }) {
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
    const beats = [...(plot.beats || [])].sort((a, b) => a.order - b.order);
    for (const b of beats) {
      doc.font('Times-Bold').text(`${b.order}. ${b.title}`);
      doc.font('Times-Roman').text(b.description);
      if (b.characters?.length) doc.font('Times-Italic').text(`Characters: ${b.characters.join(', ')}`);
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

export async function exportToPdf({ title } = {}) {
  const names = await listCharacters();
  const characters = await Promise.all(names.map((n) => getCharacter(n._id.toString())));
  const plot = await getPlot();
  const buf = await renderScreenplayPdf({ title, characters, plot });
  await fs.mkdir(config.pdf.exportDir, { recursive: true });
  const filename = `screenplay-${Date.now()}.pdf`;
  const filepath = path.join(config.pdf.exportDir, filename);
  await fs.writeFile(filepath, buf);
  return filepath;
}
