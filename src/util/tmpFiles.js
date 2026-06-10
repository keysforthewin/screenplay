import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../log.js';

// Delete agent-generated attachment files, but only inside os.tmpdir() —
// PDFs live in config.pdf.exportDir (served by filename) and must survive.
export async function cleanupTmpAttachments(paths) {
  const tmpRoot = path.resolve(os.tmpdir());
  for (const p of paths || []) {
    try {
      const resolved = path.resolve(p);
      if (!resolved.startsWith(tmpRoot + path.sep)) continue;
      await fsp.unlink(resolved);
    } catch (e) {
      if (e?.code !== 'ENOENT') logger.warn(`failed to delete tmp attachment ${p}: ${e.message}`);
    }
  }
}
