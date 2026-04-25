import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../log.js';
import { TOOLS } from './tools.js';
import { dispatchTool } from './handlers.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { listCharacters } from '../mongo/characters.js';
import { getCharacterTemplate, getPlotTemplate } from '../mongo/prompts.js';
import { getPlot } from '../mongo/plots.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const MAX_TOOL_ITERATIONS = 12;

async function buildSystem() {
  const [characters, characterTemplate, plotTemplate, plot] = await Promise.all([
    listCharacters(),
    getCharacterTemplate(),
    getPlotTemplate(),
    getPlot(),
  ]);
  return buildSystemPrompt({ characters, characterTemplate, plotTemplate, plot });
}

export async function runAgent({ history, userText }) {
  const messages = [...history, { role: 'user', content: [{ type: 'text', text: userText }] }];
  const pdfPaths = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const system = await buildSystem();
    logger.debug(`agent iteration ${i}, ${messages.length} messages`);

    const resp = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason !== 'tool_use') {
      const text = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { messages, text, pdfPaths };
    }

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    const results = [];
    for (const tu of toolUses) {
      logger.info(`tool_use: ${tu.name}`);
      let result = await dispatchTool(tu.name, tu.input);
      if (typeof result === 'string' && result.startsWith('__PDF_PATH__:')) {
        pdfPaths.push(result.slice('__PDF_PATH__:'.length));
        result = 'PDF generated and queued for upload.';
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    messages.push({ role: 'user', content: results });
  }

  return { messages, text: '(Agent hit max tool iterations.)', pdfPaths };
}
