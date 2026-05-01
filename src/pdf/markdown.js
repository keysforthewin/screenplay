import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'charts', 'fonts');

export const NOTO_FONTS = {
  regular: 'Noto',
  bold: 'Noto-Bold',
  italic: 'Noto-Italic',
  boldItalic: 'Noto-BoldItalic',
  mono: 'Courier',
};

export function registerNotoFonts(doc) {
  doc.registerFont(NOTO_FONTS.regular, path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
  doc.registerFont(NOTO_FONTS.bold, path.join(FONT_DIR, 'NotoSans-SemiBold.ttf'));
  doc.registerFont(NOTO_FONTS.italic, path.join(FONT_DIR, 'NotoSans-Italic.ttf'));
  doc.registerFont(NOTO_FONTS.boldItalic, path.join(FONT_DIR, 'NotoSans-SemiBoldItalic.ttf'));
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>', '|', '~']);

function buildRun(text, { bold, italic, mono, link } = {}) {
  const r = { text };
  if (bold) r.bold = true;
  if (italic) r.italic = true;
  if (mono) r.mono = true;
  if (link) r.link = link;
  return r;
}

export function tokenizeInline(text) {
  const runs = [];
  let buf = '';
  let i = 0;

  const push = (style) => {
    if (buf) { runs.push({ text: buf, ...style }); buf = ''; }
  };

  while (i < text.length) {
    const c = text[i];

    if (c === '\\' && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (c === '`') {
      const close = findUnescaped(text, '`', i + 1);
      if (close > i) {
        push({});
        runs.push({ text: text.slice(i + 1, close), mono: true });
        i = close + 1;
        continue;
      }
    }

    if (c === '!' && text[i + 1] === '[') {
      const m = matchLink(text, i + 1);
      if (m) { i = m.end; continue; }
    }
    if (c === '[') {
      const m = matchLink(text, i);
      if (m) {
        push({});
        const inner = tokenizeInline(m.text);
        for (const r of inner) {
          runs.push(buildRun(r.text, { bold: r.bold, italic: r.italic, mono: r.mono, link: m.url }));
        }
        i = m.end;
        continue;
      }
    }

    if (c === '*' || c === '_') {
      let n = 1;
      while (n < 3 && text[i + n] === c) n++;
      const close = findExactRun(text, i + n, c, n);
      if (close > i + n) {
        push({});
        const inner = tokenizeInline(text.slice(i + n, close));
        const addBold = n === 2 || n === 3;
        const addItalic = n === 1 || n === 3;
        for (const r of inner) {
          runs.push(buildRun(r.text, {
            bold: r.bold || addBold,
            italic: r.italic || addItalic,
            mono: r.mono,
            link: r.link,
          }));
        }
        i = close + n;
        continue;
      }
    }

    buf += c;
    i++;
  }
  push({});
  return runs;
}

function findUnescaped(text, char, start) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === char) return i;
    i++;
  }
  return -1;
}

function findExactRun(text, start, char, len) {
  let i = start;
  while (i <= text.length - len) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === char) {
      let n = 0;
      while (i + n < text.length && text[i + n] === char) n++;
      if (n === len) return i;
      i += n;
      continue;
    }
    i++;
  }
  return -1;
}

function matchLink(text, start) {
  if (text[start] !== '[') return null;
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '[') depth++;
    else if (text[i] === ']') depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0 || text[i + 1] !== '(') return null;
  const closeBracket = i;
  const closeParen = findUnescaped(text, ')', closeBracket + 2);
  if (closeParen < 0) return null;
  const linkText = text.slice(start + 1, closeBracket);
  const url = text.slice(closeBracket + 2, closeParen).trim();
  if (!url) return null;
  return { text: linkText, url, end: closeParen + 1 };
}

export function tokenizeBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  const isBlank = (l) => /^\s*$/.test(l);
  const isHr = (l) => /^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l) || /^\s{0,3}([-*_])\1{2,}\s*$/.test(l);
  const headingRe = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const blockquoteRe = /^\s{0,3}>\s?(.*)$/;
  const bulletRe = /^(\s*)([-*+])\s+(.*)$/;
  const orderedRe = /^(\s*)(\d+)[.)]\s+(.*)$/;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) { i++; continue; }

    if (isHr(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    const hMatch = line.match(headingRe);
    if (hMatch) {
      blocks.push({
        type: 'heading',
        level: hMatch[1].length,
        inlines: tokenizeInline(hMatch[2].trim()),
      });
      i++;
      continue;
    }

    if (blockquoteRe.test(line)) {
      const quoteLines = [];
      while (i < lines.length) {
        const m = lines[i].match(blockquoteRe);
        if (!m) {
          if (isBlank(lines[i])) break;
          if (quoteLines.length) {
            quoteLines.push(lines[i].trim());
            i++;
            continue;
          }
          break;
        }
        quoteLines.push(m[1]);
        i++;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n') });
      continue;
    }

    if (bulletRe.test(line) || orderedRe.test(line)) {
      const ordered = orderedRe.test(line);
      const result = parseList(lines, i, ordered);
      blocks.push(result.block);
      i = result.next;
      continue;
    }

    const paraLines = [];
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) break;
      if (isHr(l)) break;
      if (headingRe.test(l)) break;
      if (blockquoteRe.test(l)) break;
      if (bulletRe.test(l) || orderedRe.test(l)) break;
      paraLines.push(l.trim());
      i++;
    }
    blocks.push({
      type: 'paragraph',
      inlines: tokenizeInline(paraLines.join(' ')),
    });
  }

  return blocks;
}

function parseList(lines, start, ordered) {
  const items = [];
  const itemRe = ordered ? /^(\s*)(\d+)[.)]\s+(.*)$/ : /^(\s*)([-*+])\s+(.*)$/;
  const otherListRe = ordered ? /^(\s*)([-*+])\s+(.*)$/ : /^(\s*)(\d+)[.)]\s+(.*)$/;
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(itemRe);
    if (m) {
      items.push({
        indent: m[1].length,
        marker: ordered ? parseInt(m[2], 10) : null,
        lines: [m[3]],
      });
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) {
      let j = i + 1;
      while (j < lines.length && /^\s*$/.test(lines[j])) j++;
      if (j < lines.length && (itemRe.test(lines[j]) || otherListRe.test(lines[j]))) {
        i = j;
        continue;
      }
      break;
    }
    if (otherListRe.test(line)) break;
    if (items.length && /^\s+\S/.test(line)) {
      items[items.length - 1].lines.push(line.trim());
      i++;
      continue;
    }
    break;
  }

  const minIndent = items.length ? Math.min(...items.map((it) => it.indent)) : 0;
  return {
    next: i,
    block: {
      type: 'list',
      ordered,
      items: items.map((it) => ({
        depth: Math.max(0, Math.floor((it.indent - minIndent) / 2)),
        marker: it.marker,
        inlines: tokenizeInline(it.lines.join(' ')),
      })),
    },
  };
}

function pickFont(ctx, run) {
  if (run.mono) return ctx.fonts.mono;
  const wantBold = !!run.bold;
  const wantItalic = !!run.italic || ctx.baseStyle === 'italic';
  if (wantBold && wantItalic) return ctx.fonts.boldItalic;
  if (wantBold) return ctx.fonts.bold;
  if (wantItalic) return ctx.fonts.italic;
  return ctx.fonts.regular;
}

function emitInlines(ctx, inlines, { firstCallOpts = {}, paragraphGap } = {}) {
  const { doc, size } = ctx;
  if (!inlines || inlines.length === 0) {
    doc.font(ctx.fonts.regular).fontSize(size).text('', firstCallOpts);
    return;
  }

  for (let idx = 0; idx < inlines.length; idx++) {
    const run = inlines[idx];
    const font = pickFont(ctx, run);
    doc.font(font).fontSize(size);
    const isLast = idx === inlines.length - 1;
    const opts = isLast ? {} : { continued: true };
    if (idx === 0) Object.assign(opts, firstCallOpts);
    if (isLast && paragraphGap !== undefined) opts.paragraphGap = paragraphGap;
    if (run.link) {
      doc.fillColor('#0645AD');
      opts.link = run.link;
      opts.underline = true;
    } else {
      doc.fillColor('#000');
    }
    doc.text(run.text, opts);
  }
  doc.fillColor('#000');
}

function renderBlock(ctx, block) {
  const { doc, size } = ctx;

  switch (block.type) {
    case 'paragraph':
      emitInlines(ctx, block.inlines, {
        firstCallOpts: { indent: ctx.indent },
        paragraphGap: ctx.paragraphGap,
      });
      break;

    case 'heading': {
      const headingSizes = { 1: size + 7, 2: size + 4, 3: size + 2, 4: size + 1, 5: size, 6: size };
      const hSize = headingSizes[block.level] || size;
      doc.moveDown(0.3);
      const headingCtx = { ...ctx, size: hSize };
      const headingFonts = { ...ctx.fonts, regular: ctx.fonts.bold, italic: ctx.fonts.boldItalic };
      emitInlines({ ...headingCtx, fonts: headingFonts }, block.inlines, {
        firstCallOpts: { indent: ctx.indent },
        paragraphGap: 4,
      });
      break;
    }

    case 'hr': {
      doc.moveDown(0.4);
      const left = doc.page.margins.left + ctx.indent;
      const right = doc.page.width - doc.page.margins.right;
      const y = doc.y + 2;
      doc.save();
      doc.strokeColor('#888').lineWidth(0.5).moveTo(left, y).lineTo(right, y).stroke();
      doc.restore();
      doc.y = y + 6;
      break;
    }

    case 'list':
      renderList(ctx, block);
      break;

    case 'blockquote': {
      const childCtx = { ...ctx, indent: ctx.indent + 18, baseStyle: 'italic' };
      const inner = tokenizeBlocks(block.text);
      doc.moveDown(0.2);
      for (const b of inner) renderBlock(childCtx, b);
      doc.moveDown(0.2);
      break;
    }
  }
}

function renderList(ctx, block) {
  const { doc, size } = ctx;
  const counters = {};
  for (const item of block.items) {
    const depth = item.depth || 0;
    const indent = ctx.indent + depth * 18;
    counters[depth] = counters[depth] || 0;
    counters[depth]++;
    for (const k of Object.keys(counters)) {
      if (parseInt(k, 10) > depth) delete counters[k];
    }
    const bullet = block.ordered
      ? `${item.marker != null ? item.marker : counters[depth]}. `
      : depth % 2 === 0 ? '• ' : '◦ ';

    doc.font(ctx.fonts.regular).fontSize(size).fillColor('#000');
    doc.text(bullet, { indent, continued: true });
    emitInlines(ctx, item.inlines, {
      firstCallOpts: {},
      paragraphGap: 2,
    });
  }
}

export function renderMarkdown(doc, text, opts = {}) {
  const {
    fonts = NOTO_FONTS,
    size = 11,
    indent = 0,
    paragraphGap = 4,
    baseStyle = 'regular',
    continueFirstParagraph = false,
  } = opts;

  if (text == null) {
    if (continueFirstParagraph) doc.text('');
    return;
  }
  const str = typeof text === 'string' ? text : String(text);
  if (!str) {
    if (continueFirstParagraph) doc.text('');
    return;
  }

  const ctx = { doc, fonts, size, indent, paragraphGap, baseStyle };
  const blocks = tokenizeBlocks(str);
  if (blocks.length === 0) {
    if (continueFirstParagraph) doc.text('');
    return;
  }

  let startIdx = 0;
  if (continueFirstParagraph) {
    if (blocks[0].type === 'paragraph') {
      emitInlines(ctx, blocks[0].inlines, {
        firstCallOpts: {},
        paragraphGap: ctx.paragraphGap,
      });
      startIdx = 1;
    } else {
      doc.text('');
    }
  }

  for (let i = startIdx; i < blocks.length; i++) {
    renderBlock(ctx, blocks[i]);
  }
}
