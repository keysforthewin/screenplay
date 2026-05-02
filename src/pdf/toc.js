import PDFDocument from 'pdfkit';
import { registerNotoFonts, NOTO_FONTS } from './markdown.js';

const TOC_MARGINS = { top: 72, bottom: 72, left: 90, right: 72 };

function slugify(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildAnchorContext(mode, doc, collector = []) {
  let counter = 0;
  let lastTopLevelOutline = null;

  function makeDestName(kind, label) {
    counter += 1;
    const slug = slugify(label) || 'item';
    return `toc-${kind}-${slug}-${counter}`;
  }

  function record(kind, label, depth) {
    if (mode === 'noop') return undefined;
    const destinationName = makeDestName(kind, label);
    const cleanLabel = formatTocLabel(label);
    if (mode === 'capture') {
      collector.push({
        kind,
        label: cleanLabel,
        destinationName,
        pageNumber: doc.page.number,
        depth,
      });
    } else if (mode === 'final') {
      if (depth === 0) {
        lastTopLevelOutline = doc.outline.addItem(cleanLabel);
      } else if (lastTopLevelOutline) {
        lastTopLevelOutline.addItem(cleanLabel);
      } else {
        doc.outline.addItem(cleanLabel);
      }
    }
    return destinationName;
  }

  return {
    anchor(kind, label) { return record(kind, label, 0); },
    subAnchor(kind, label) { return record(kind, label, 1); },
    entries: collector,
  };
}

export function renderToc(doc, entries, tocPageOffset = 0) {
  doc.addPage();
  doc.font(NOTO_FONTS.bold).fontSize(20).fillColor('#000');
  doc.text('Table of Contents', { align: 'center' });
  doc.moveDown(2);

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  for (const e of entries || []) {
    const indent = e.depth * 18;
    const displayedPage = String(e.pageNumber + tocPageOffset);
    const fontStyle = e.depth === 0 ? NOTO_FONTS.bold : NOTO_FONTS.regular;
    const fontSize = e.depth === 0 ? 12 : 11;

    doc.font(fontStyle).fontSize(fontSize).fillColor('#000');
    const labelW = doc.widthOfString(e.label);
    const pageW = doc.widthOfString(displayedPage);
    const dotW = doc.widthOfString('.');
    const padW = doc.widthOfString('  ');
    const remaining = contentWidth - indent - labelW - pageW - 2 * padW;
    const dotCount = Math.max(0, Math.floor(remaining / dotW));
    const dots = '.'.repeat(dotCount);

    doc.text(e.label, { goTo: e.destinationName, continued: true, indent });
    doc.fillColor('#999');
    doc.text(`  ${dots}  `, { goTo: e.destinationName, continued: true });
    doc.fillColor('#000');
    doc.text(displayedPage, { goTo: e.destinationName });
  }
}

export function measureTocPageCount(entries) {
  const doc = new PDFDocument({
    margins: TOC_MARGINS,
    bufferPages: true,
    autoFirstPage: false,
  });
  registerNotoFonts(doc);
  doc.on('data', () => {});
  doc.on('error', () => {});
  renderToc(doc, entries || [], 0);
  const count = doc.bufferedPageRange().count;
  try { doc.end(); } catch { /* ignore */ }
  return count;
}

export function formatTocLabel(text, { maxChars = 60 } = {}) {
  if (text == null) return '';
  let s = String(text);
  if (!s) return '';
  s = s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxChars) {
    s = s.slice(0, maxChars - 1) + '…';
  }
  return s;
}
