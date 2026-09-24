import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { RESERVED_PREFIX, statIdentity, type ReadyFile } from './watcher';

// Looked up on each call rather than bound once, so the file system functions stay replaceable.
const link = (existing: string, target: string) => promisify(fs.link)(existing, target);
const unlink = (file: string) => promisify(fs.unlink)(file);
const copyFile = (source: string, target: string, mode: number) => promisify(fs.copyFile)(source, target, mode);
const mkdir = (directory: string) => promisify(fs.mkdir)(directory, { recursive: true });
const rename = (source: string, target: string) => promisify(fs.rename)(source, target);

/** What happens to a file after its handler succeeds: leave it, delete it, or move it into another directory. */
export type DoneAction = 'keep' | 'delete' | { moveTo: string };

export type ResolvedAction = { type: 'keep' } | { type: 'delete' } | { type: 'move'; directory: string };

/** Where the handled file ended up. `replaced`: another file took its name and was left alone. */
export type ActionResult = { type: 'kept' } | { type: 'removed' } | { type: 'moved'; to: string } | { type: 'replaced' };

export function parseAction(action: DoneAction | undefined): ResolvedAction {
  if (action === undefined || action === 'keep') {
    return { type: 'keep' };
  }
  if (action === 'delete') {
    return { type: 'delete' };
  }
  if (typeof action === 'object' && action !== null && typeof action.moveTo === 'string' && action.moveTo.length > 0) {
    return { type: 'move', directory: path.resolve(action.moveTo) };
  }
  throw new TypeError(`done must be 'keep', 'delete', or { moveTo: string }.`);
}

/** Creates the target directory of a move, which must not be the watched directory. */
export function prepareAction(action: ResolvedAction, watched: string): void {
  if (action.type !== 'move') {
    return;
  }

  fs.mkdirSync(action.directory, { recursive: true });
  // Compare identities, not strings: another letter case or a symlink can name the watched directory,
  // and moving files into it would hand them out again forever.
  const target = fs.statSync(action.directory, { bigint: true });
  const source = fs.statSync(watched, { bigint: true });
  if (target.dev === source.dev && target.ino === source.ino) {
    throw new TypeError('done.moveTo must differ from the watched directory.');
  }
}

/** Applies an action to the handled file, leaving alone a different file that took its name. */
export async function applyAction(action: ResolvedAction, file: ReadyFile): Promise<ActionResult> {
  if (action.type === 'keep') {
    return { type: 'kept' };
  }

  const identity = await statIdentity(file.path);
  if (identity === undefined) {
    // The handler removed or moved the file itself.
    return { type: 'removed' };
  }
  if (identity !== file.identity) {
    return { type: 'replaced' };
  }

  if (action.type === 'delete') {
    return (await removeExact(file)) === 'replaced' ? { type: 'replaced' } : { type: 'removed' };
  }

  await mkdir(action.directory);
  return moveWithoutOverwriting(file, action.directory);
}

// Next suffix to try per target name, so repeated names do not rescan -1, -2, ... from the start.
const nextSuffix = new Map<string, number>();

/**
 * Moves the file into `directory` under its name, or name-1, name-2, ... when taken. A hard link fails
 * atomically when the name is taken, so concurrent movers never overwrite each other.
 */
async function moveWithoutOverwriting(file: ReadyFile, directory: string): Promise<ActionResult> {
  const extension = path.extname(file.name);
  const stem = file.name.slice(0, file.name.length - extension.length);
  const key = path.join(directory, file.name);
  for (let index = 0; ; index += 1) {
    if (index === 1) {
      index = Math.max(1, nextSuffix.get(key) ?? 1);
    }
    const target = path.join(directory, index === 0 ? file.name : `${stem}-${index}${extension}`);

    try {
      await link(file.path, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        continue;
      }
      if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EOPNOTSUPP') {
        // No hard link across file systems or on this one: copy without overwriting instead.
        const copied = await copyWithoutOverwriting(file, target);
        if (copied === 'taken') {
          continue;
        }
        return copied;
      }
      throw error;
    }

    if (index > 0) {
      if (nextSuffix.size > 10_000) {
        nextSuffix.clear();
      }
      nextSuffix.set(key, index + 1);
    }
    // The link names whatever file held the name at that moment; keep it only if it is the handled one.
    if ((await statIdentity(target)) !== file.identity) {
      await unlink(target).catch(ignoreMissing);
      return { type: 'replaced' };
    }
    // The handled file is safely at the target; drop the source name without touching a newer file.
    await removeExact(file);
    return { type: 'moved', to: target };
  }
}

async function copyWithoutOverwriting(file: ReadyFile, target: string): Promise<ActionResult | 'taken'> {
  try {
    await copyFile(file.path, target, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return 'taken';
    }
    // Do not leave a partial copy behind.
    await unlink(target).catch(() => undefined);
    throw error;
  }

  let removed: 'removed' | 'replaced' | 'missing';
  try {
    removed = await removeExact(file);
  } catch (error) {
    // Keep exactly one copy: the retry moves the source again.
    await unlink(target).catch(() => undefined);
    throw error;
  }
  if (removed === 'replaced') {
    // Another file took the name, so the copy may not be of the handled file; the new file is kept.
    await unlink(target).catch(ignoreMissing);
    return { type: 'replaced' };
  }
  return { type: 'moved', to: target };
}

/**
 * Removes the handled file's name without ever removing a different file that took the name: the
 * name is first renamed away atomically, and whatever was renamed is put back unless it is the
 * handled file.
 */
async function removeExact(file: ReadyFile): Promise<'removed' | 'replaced' | 'missing'> {
  const parked = path.join(path.dirname(file.path), `${RESERVED_PREFIX}${randomUUID()}`);
  try {
    await rename(file.path, parked);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }

  if ((await statIdentity(parked)) === file.identity) {
    await unlink(parked);
    return 'removed';
  }
  await restore(parked, file.path);
  return 'replaced';
}

// Puts a parked file back under its name, or under name-1, name-2, ... if that name was taken meanwhile.
async function restore(parked: string, original: string): Promise<void> {
  const extension = path.extname(original);
  const stem = original.slice(0, original.length - extension.length);
  for (let index = 0; ; index += 1) {
    const target = index === 0 ? original : `${stem}-${index}${extension}`;
    try {
      await link(parked, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        continue;
      }
      if (fs.existsSync(target)) {
        continue;
      }
      // No hard links here: rename, which is safe once the name is known to be free.
      await rename(parked, target);
      return;
    }
    await unlink(parked);
    return;
  }
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}
