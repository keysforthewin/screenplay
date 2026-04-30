import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import {
  renderTokenUsageChart,
  renderToolTokensChart,
  renderToolInvocationsChart,
  renderSectionAllocationChart,
} from '../src/charts/tokenUsageChart.js';

// Empty SVG with shapes only renders to ~6 KB. A chart with rendered text
// labels (title, legend, axis ticks, in-bar values, totals, x-axis names)
// is meaningfully larger. If resvg silently drops <text> because the bundled
// font fails to load, PNG size collapses back toward the shapes-only baseline
// — these thresholds catch that regression.
const MIN_BYTES_WITH_TEXT = 12000;

async function pngSize(p) {
  const buf = await fs.readFile(p);
  await fs.unlink(p).catch(() => {});
  return buf.length;
}

describe('token usage chart rendering', () => {
  it('renders user usage chart with text labels', async () => {
    const p = await renderTokenUsageChart({
      window: 'week',
      rows: [
        { discord_user_display_name: 'Alice', total: 12000, anthropic_text: 9000, anthropic_image_input: 2000, gemini_image: 1000 },
        { discord_user_display_name: 'Bob', total: 8000, anthropic_text: 7500, anthropic_image_input: 500, gemini_image: 0 },
      ],
    });
    expect(await pngSize(p)).toBeGreaterThan(MIN_BYTES_WITH_TEXT);
  });

  it('renders tool tokens chart with text labels', async () => {
    const p = await renderToolTokensChart({
      window: 'week',
      rows: [
        { tool_name: 'create_beat', invocations: 42, result_tokens: 18000 },
        { tool_name: 'list_characters', invocations: 31, result_tokens: 9500 },
      ],
    });
    expect(await pngSize(p)).toBeGreaterThan(MIN_BYTES_WITH_TEXT);
  });

  it('renders tool invocations chart with text labels', async () => {
    const p = await renderToolInvocationsChart({
      window: 'week',
      rows: [
        { tool_name: 'create_beat', invocations: 42, result_tokens: 18000 },
        { tool_name: 'list_characters', invocations: 31, result_tokens: 9500 },
      ],
    });
    expect(await pngSize(p)).toBeGreaterThan(MIN_BYTES_WITH_TEXT);
  });

  it('renders section allocation chart with text labels', async () => {
    const p = await renderSectionAllocationChart({
      window: 'week',
      sectionStats: {
        sample_count: 27,
        averages: { system: 1800, tools: 4200, message_history: 9500, user_input: 320, total: 15820 },
      },
    });
    expect(await pngSize(p)).toBeGreaterThan(MIN_BYTES_WITH_TEXT);
  });
});
