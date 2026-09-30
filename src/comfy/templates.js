// Template workflow files for the ComfyUI registry. A template is fetched
// from the gallery through comfy-mcp once, into config.comfy.templateDir
// (bind-mounted data/ in prod), and its `local_check` — whether every node
// class the graph uses exists in the target ComfyUI — is cached per process.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../log.js';
import { comfy } from './client.js';

export class ComfyTemplateNotRunnableError extends Error {
  constructor(template, localCheck) {
    const errors = Array.isArray(localCheck?.errors) ? localCheck.errors : [];
    super(
      `ComfyUI template ${template} cannot run on the target ComfyUI` +
        (errors.length ? `: ${errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ')}` : '.'),
    );
    this.code = 'COMFY_TEMPLATE_NOT_RUNNABLE';
    this.status = 400;
    this.template = template;
    this.local_check = localCheck || null;
  }
}

const checkCache = new Map(); // template name → local_check

export function templateFilePath(templateName) {
  return path.resolve(config.comfy.templateDir, `${templateName}.json`);
}

function assertRunnable(templateName, localCheck) {
  if (localCheck && localCheck.checked && localCheck.runnable === false) {
    throw new ComfyTemplateNotRunnableError(templateName, localCheck);
  }
}

// Ensure the model's template JSON exists locally and is runnable. Returns
// { path, local_check }. A missing file is fetched; an existing file without a
// cached check re-reads the gallery entry for its local_check.
export async function ensureTemplateFile(model, { refresh = false } = {}) {
  const name = model?.template;
  if (!name) throw new Error('model has no template');
  const filePath = templateFilePath(name);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const exists = !refresh && fs.existsSync(filePath);
  if (!exists) {
    const result = await comfy.fetchTemplate(name, filePath);
    const localCheck = result?.local_check || null;
    checkCache.set(name, localCheck);
    assertRunnable(name, localCheck);
    logger.info(`comfy: fetched template ${name} → ${filePath}`);
    return { path: result?.path || filePath, local_check: localCheck };
  }
  if (!checkCache.has(name)) {
    let localCheck = null;
    try {
      const info = await comfy.getTemplate(name);
      localCheck = info?.local_check || null;
    } catch (e) {
      logger.warn(`comfy: local_check for ${name} unavailable: ${e.message}`);
    }
    checkCache.set(name, localCheck);
  }
  const cached = checkCache.get(name) || null;
  assertRunnable(name, cached);
  return { path: filePath, local_check: cached };
}

export function _resetTemplateCacheForTests() {
  checkCache.clear();
}
