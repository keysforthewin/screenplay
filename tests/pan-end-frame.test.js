// The end frame of a camera that slides the picture: which way, how far, the
// slid canvas, the seam detector and the two instructions.
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  MAX_PAN_STILL_SHIFT,
  buildShiftedCanvas,
  composePanEndPrompt,
  composePanFillPrompt,
  detectPanSeam,
  composeMasterMovePrompt,
  composeMasterPrompt,
  cropFromMaster,
  cutHasPeopleToPlace,
  masterAspectFor,
  panDirectionForCut,
  panShiftFraction,
} from '../src/web/panEndFrame.js';

const cam = (movement, extra = {}) => ({ camera: { movement, ...extra } });

// Left half red, right half blue.
async function twoTone(width = 200, height = 100) {
  const half = await sharp({ create: { width: width / 2, height, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .composite([{ input: half, left: width / 2, top: 0 }])
    .png()
    .toBuffer();
}

async function pixel(buffer, x, y) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

describe('panDirectionForCut', () => {
  it('reads the stored cuts: the travel cell, then the block', () => {
    expect(panDirectionForCut(cam('pan', { travel: 'right to left, from the blank marquee panel to the rows of parked cars' }))).toBe('left');
    expect(panDirectionForCut({ ...cam('pan'), prompt: 'Wide shot, the camera already panning left at one slow, even speed.' })).toBe('left');
    expect(panDirectionForCut(cam('truck', { travel: 'right to left along the curb, from the first teenager to the last' }))).toBe('left');
    expect(panDirectionForCut({ ...cam('truck', { travel: 'sideways along the back of the counter' }), prompt: 'the camera already trucking right at one even speed' })).toBe('right');
    expect(panDirectionForCut(cam('crane', { travel: 'from open dusk sky, down to the blank marquee panel' }))).toBe('down');
    expect(panDirectionForCut({ ...cam('tilt'), prompt: 'the camera already tilting up at one slow speed' })).toBe('up');
  });

  it('the planner\'s travel_direction wins; a wrong-axis value is ignored', () => {
    expect(panDirectionForCut(cam('pan', { travel_direction: 'right', travel: 'right to left' }))).toBe('right');
    expect(panDirectionForCut(cam('pan', { travel_direction: 'up', travel: 'right to left' }))).toBe('left');
  });

  it('is null for a move that does not slide the picture', () => {
    expect(panDirectionForCut(cam('track', { travel: 'forward behind his shoulder, from the canopy edge to the open glass door' }))).toBeNull();
    expect(panDirectionForCut({ ...cam('push_in'), prompt: 'panning left' })).toBeNull();
    expect(panDirectionForCut(cam('static'))).toBeNull();
    expect(panDirectionForCut(cam('pan'))).toBeNull();
  });
});

describe('panShiftFraction', () => {
  it('never slides more than half the frame, and defaults to half', () => {
    expect(panShiftFraction(cam('pan', { travel_widths: 1 }))).toBe(MAX_PAN_STILL_SHIFT);
    expect(MAX_PAN_STILL_SHIFT).toBe(0.5);
    expect(panShiftFraction(cam('pan', { travel_widths: 0.3 }))).toBe(0.3);
    expect(panShiftFraction(cam('pan', { travel_widths: 0.01 }))).toBe(0.15);
    expect(panShiftFraction(cam('pan'))).toBe(0.5);
  });
});

describe('buildShiftedCanvas', () => {
  it('panning left shows the start frame\'s left part at the right and leaves a grey band on the left', async () => {
    const c = await buildShiftedCanvas(await twoTone(), 'left', 0.5);
    expect(c).toMatchObject({ width: 200, height: 100, shiftPx: 100, bandPercent: 50, bandSide: 'left' });
    expect(await pixel(c.buffer, 20, 50)).toEqual([128, 128, 128]);
    expect(await pixel(c.buffer, 150, 50)).toEqual([255, 0, 0]);
  });

  it('panning right keeps the right part at the left', async () => {
    const c = await buildShiftedCanvas(await twoTone(), 'right', 0.5);
    expect(c.bandSide).toBe('right');
    expect(await pixel(c.buffer, 20, 50)).toEqual([0, 0, 255]);
    expect(await pixel(c.buffer, 180, 50)).toEqual([128, 128, 128]);
  });

  it('a move down leaves the band along the bottom', async () => {
    const c = await buildShiftedCanvas(await twoTone(), 'down', 0.4);
    expect(c).toMatchObject({ shiftPx: 40, bandPercent: 40, bandSide: 'bottom' });
    expect(await pixel(c.buffer, 20, 90)).toEqual([128, 128, 128]);
    expect(await pixel(c.buffer, 20, 10)).toEqual([255, 0, 0]);
  });
});

describe('detectPanSeam', () => {
  it('finds the hard line of a band painted as a second picture — wherever it is — and none in one picture', async () => {
    const split = await detectPanSeam(await twoTone(), 'left');
    expect(split).toMatchObject({ seam: true, at: 0.5 });
    const flat = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 90, g: 80, b: 70 } } }).png().toBuffer();
    expect((await detectPanSeam(flat, 'left')).seam).toBe(false);
    // A vertical line is not a seam for a vertical move, which meets along a horizontal one.
    expect((await detectPanSeam(await twoTone(), 'down')).seam).toBe(false);
  });
});

describe('the instructions', () => {
  it('the fill names the band, forbids a seam and lets the photograph win', () => {
    const p = composePanFillPrompt({ direction: 'left', bandPercent: 50, endPrompt: 'Rows of cars under amber lamps.', movement: 'pan' });
    expect(p).toContain('The camera has panned left');
    expect(p).toContain('the flat grey band along the left (about 50% of the image)');
    expect(p).toContain('No visible boundary, seam, split or change of sky');
    expect(p).toContain('the photograph wins');
    expect(p.endsWith('Rows of cars under amber lamps.')).toBe(true);
    expect(composePanFillPrompt({ direction: 'left', bandPercent: 50, endPrompt: 'x', movement: 'truck' })).toContain('The camera has moved left');
  });

  it('the plain edit says the same camera moved, which way the picture slides, and by how much', () => {
    const p = composePanEndPrompt({ direction: 'left', fraction: 0.35, endPrompt: 'Rows of cars.', travel: 'right to left', movement: 'pan' });
    expect(p).toContain('turned on its spot — panned left, by about 35% of the frame\'s width');
    expect(p).toContain('everything in the picture slides RIGHT');
    expect(p).toContain('The move: right to left');
    const guided = composePanEndPrompt({ direction: 'left', fraction: 0.5, endPrompt: 'x', travel: 'right to left', guidance: 'The canopy now sits right of centre.' });
    expect(guided).toContain('Where things end up: The canopy now sits right of centre.');
    expect(guided).not.toContain('The move: right to left');
    const crane = composePanEndPrompt({ direction: 'down', fraction: 0.5, endPrompt: 'x', movement: 'crane' });
    expect(crane).toContain('descended straight down without turning');
    expect(crane).toContain('slides UP');
  });
});

describe('the master plate', () => {
  it('is wider for a sideways move and taller for a vertical one', () => {
    expect(masterAspectFor('left')).toBe('21:9');
    expect(masterAspectFor('down')).toBe('4:3');
  });

  it('the shot opens on the part the camera leaves and closes on the part it goes to', async () => {
    // 210x90 plate, left half red, right half blue → 160x90 frames, 31% travel.
    const plate = await twoTone(210, 90);
    const start = await cropFromMaster(plate, 'left', 'start');
    const end = await cropFromMaster(plate, 'left', 'end');
    expect(start).toMatchObject({ width: 160, height: 90, travel: 0.31 });
    expect(await pixel(start.buffer, 150, 40)).toEqual([0, 0, 255]);
    expect(await pixel(end.buffer, 10, 40)).toEqual([255, 0, 0]);
    // Panning right is the mirror.
    expect(await pixel((await cropFromMaster(plate, 'right', 'start')).buffer, 10, 40)).toEqual([255, 0, 0]);
  });

  it('refuses a plate that is no wider than a frame', async () => {
    await expect(cropFromMaster(await twoTone(160, 90), 'left', 'end')).rejects.toThrow(/not wider than a frame/);
  });

  it('the prompts say which part is the given picture, and how far walkers have come', () => {
    const make = composeMasterPrompt({ direction: 'left', movement: 'pan', endPrompt: 'The lot.' });
    expect(make).toContain('The picture you are given is the RIGHT part of the wider frame');
    expect(make).toContain('Paint the new area at the left');
    const move = composeMasterMovePrompt({ direction: 'left', endPrompt: 'He is at the gap.', guidance: 'They did not move.' });
    expect(move).toContain('opens on the RIGHT part of the plate and closes on the LEFT part');
    expect(move).toContain('People who are sitting, leaning or standing in one place have not moved at all.');
    expect(move).toContain('A first attempt got this wrong: They did not move.');
    expect(cutHasPeopleToPlace({ in_frame: [{ character: 'A' }] })).toBe(true);
    expect(cutHasPeopleToPlace({ in_frame: [] })).toBe(false);
  });
});
