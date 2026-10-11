import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { fnv1a32, maskSegment } from '../../shared/hash.ts';

/** A project's stable id: it depends only on the cwd, so it survives restarts. */
export function projectIdFor(cwd: string): string {
  return crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

export function fileIdFor(projectId: string, relPath: string): string {
  return fnv1a32(`${projectId} ${relPath}`).toString(36);
}

/**
 * Privacy level 3: a hash of every segment, with extension and depth
 * preserved. The city's topology remains, the names disappear.
 */
export function redactRelPath(relPath: string): string {
  const ext = path.extname(relPath);
  const segments = relPath.split('/').filter((s) => s.length > 0);
  const masked = segments.map((s, i) => (i === segments.length - 1 ? maskSegment(s) + ext : maskSegment(s)));
  return masked.join('/');
}

export function redactName(name: string): string {
  return maskSegment(name);
}
