import { describe, it, expect } from 'vitest';
import { placeImage } from '../src/pdf/export.js';

function makeFakeDoc({
  y,
  pageWidth = 612,
  pageHeight = 792,
  topMargin = 72,
  bottomMargin = 72,
  leftMargin = 90,
  rightMargin = 72,
  image,
} = {}) {
  const calls = [];
  const doc = {
    y,
    page: {
      width: pageWidth,
      height: pageHeight,
      margins: { top: topMargin, bottom: bottomMargin, left: leftMargin, right: rightMargin },
    },
    openImage: () => image,
    image: (...args) => {
      calls.push(['image', ...args]);
      return doc;
    },
    addPage: () => {
      calls.push(['addPage']);
      doc.y = topMargin;
      return doc;
    },
    save: () => {
      calls.push(['save']);
      return doc;
    },
    restore: () => {
      calls.push(['restore']);
      return doc;
    },
    rect: (...args) => {
      calls.push(['rect', ...args]);
      return doc;
    },
    clip: () => {
      calls.push(['clip']);
      return doc;
    },
    _calls: calls,
  };
  return doc;
}

describe('placeImage', () => {
  it('places the image on the current page when it fits', () => {
    // 100x50 image into [400,280] fit: scale=min(4, 5.6, 1)=1, drawH=50.
    // y = 100, bottom = 720, plenty of room.
    const doc = makeFakeDoc({ y: 100, image: { width: 100, height: 50 } });
    placeImage(doc, Buffer.from([]), [400, 280]);
    expect(doc._calls).toEqual([['image', expect.any(Buffer), { fit: [400, 280], align: 'center' }]]);
  });

  it('adds a new page when the scaled image would overflow the bottom margin', () => {
    // 800x800 image into [400,280] fit: scale=min(0.5, 0.35, 1)=0.35, drawH=280.
    // y = 600, bottom = 720, available = 120 < 280 → must paginate.
    const doc = makeFakeDoc({ y: 600, image: { width: 800, height: 800 } });
    placeImage(doc, Buffer.from([]), [400, 280]);
    expect(doc._calls[0]).toEqual(['addPage']);
    expect(doc._calls[1][0]).toBe('image');
  });

  it('does not paginate when the actual scaled height fits, even if maxH would not', () => {
    // 1000x100 image into [400,280] fit: scale=min(0.4, 2.8, 1)=0.4, drawH=40.
    // y = 600, bottom = 720, available = 120 ≥ 40 → no paginate.
    // (Worst-case maxH=280 wouldn't fit, but actual draw height fits, so we stay on page.)
    const doc = makeFakeDoc({ y: 600, image: { width: 1000, height: 100 } });
    placeImage(doc, Buffer.from([]), [400, 280]);
    expect(doc._calls.find((c) => c[0] === 'addPage')).toBeUndefined();
    expect(doc._calls[0][0]).toBe('image');
  });

  it('falls back to worst-case maxH when openImage throws', () => {
    const calls = [];
    const doc = {
      y: 600,
      page: { height: 792, margins: { bottom: 72 } },
      openImage: () => { throw new Error('bad image'); },
      image: (...args) => calls.push(['image', ...args]),
      addPage: () => calls.push(['addPage']),
    };
    placeImage(doc, Buffer.from([]), [400, 280]);
    // worst-case drawH=280, available=120 → must paginate
    expect(calls[0]).toEqual(['addPage']);
    expect(calls[1][0]).toBe('image');
  });

  it('spans an oversized image across two pages with clipping', () => {
    // 1000x4000 image into [400, 4000] fit: scale=min(0.4, 1.0, 1)=0.4,
    // drawW=400, drawH=1600. availablePageHeight = 792-72-72 = 648.
    // 1600 > 648 → span two pages.
    const doc = makeFakeDoc({ y: 100, image: { width: 1000, height: 4000 } });
    placeImage(doc, Buffer.from([]), [400, 4000]);

    const ops = doc._calls.map((c) => c[0]);
    expect(ops).toEqual([
      'addPage', // y=100 > top=72, so move to fresh page first
      'save', 'rect', 'clip', 'image', 'restore', // page 1: top half
      'addPage',
      'save', 'rect', 'clip', 'image', 'restore', // page 2: bottom half
    ]);

    // Page-1 image: drawn at top-left of content area, full height.
    const contentWidth = 612 - 90 - 72; // 450
    const x = 90 + (contentWidth - 400) / 2; // 115
    const page1Image = doc._calls.find((c, i) => c[0] === 'image' && doc._calls[i - 1]?.[0] === 'clip');
    expect(page1Image).toEqual(['image', expect.any(Buffer), x, 72, { width: 400, height: 1600 }]);

    // Page-2 image: same x/dimensions, y offset upward by availablePageHeight
    // so the bottom slice is what shows in the visible area.
    const imageOps = doc._calls.filter((c) => c[0] === 'image');
    expect(imageOps[1]).toEqual(['image', expect.any(Buffer), x, 72 - 648, { width: 400, height: 1600 }]);

    // doc.y after spanning sits where the image actually ends on page 2.
    expect(doc.y).toBe(72 + (1600 - 648));
  });

  it('skips the leading addPage when already at the top of a fresh page', () => {
    const doc = makeFakeDoc({ y: 72, image: { width: 1000, height: 4000 } });
    placeImage(doc, Buffer.from([]), [400, 4000]);

    const ops = doc._calls.map((c) => c[0]);
    // No leading addPage — first ops are the page-1 clip+draw.
    expect(ops).toEqual([
      'save', 'rect', 'clip', 'image', 'restore',
      'addPage',
      'save', 'rect', 'clip', 'image', 'restore',
    ]);
  });

  it('accounts for EXIF orientation when measuring rotated images', () => {
    // Source is 2000x500 stored landscape with EXIF orientation 6 (90° CW),
    // so it visually renders as 500x2000. Without the swap, scale=0.2 →
    // drawH=100 (fits at y=600). With the swap, scale=0.14 → drawH=280
    // (does NOT fit at y=600 with available 120). The orientation guard
    // must trigger pagination.
    const doc = makeFakeDoc({
      y: 600,
      image: { width: 2000, height: 500, orientation: 6 },
    });
    placeImage(doc, Buffer.from([]), [400, 280]);
    expect(doc._calls[0]).toEqual(['addPage']);
    expect(doc._calls[1][0]).toBe('image');
  });
});
