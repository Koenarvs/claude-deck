import fs from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';

/**
 * Size of a tar header block (and padding alignment) in bytes.
 */
const BLOCK_SIZE = 512;

/**
 * Creates a tar header block for a single file entry.
 *
 * Follows the POSIX ustar format with the minimum fields required
 * for extraction by standard tar utilities.
 *
 * @param entryPath - The path as it should appear in the tar archive.
 * @param size - The file size in bytes.
 * @returns A 512-byte Buffer containing the tar header.
 */
function createTarHeader(entryPath: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);

  // name (0-99, 100 bytes) — truncated if longer
  const nameBytes = Buffer.from(entryPath, 'utf-8');
  nameBytes.copy(header, 0, 0, Math.min(nameBytes.byteLength, 100));

  // mode (100-107, 8 bytes)
  header.write('0000644\0', 100, 8, 'utf-8');

  // uid (108-115, 8 bytes)
  header.write('0001000\0', 108, 8, 'utf-8');

  // gid (116-123, 8 bytes)
  header.write('0001000\0', 116, 8, 'utf-8');

  // size (124-135, 12 bytes) — octal, null-terminated
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf-8');

  // mtime (136-147, 12 bytes)
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12, 'utf-8');

  // typeflag (156, 1 byte) — '0' = regular file
  header.write('0', 156, 1, 'utf-8');

  // magic (257-262, 6 bytes) — "ustar\0"
  header.write('ustar\0', 257, 6, 'utf-8');

  // version (263-264, 2 bytes)
  header.write('00', 263, 2, 'utf-8');

  // Compute checksum: sum of all bytes in header, treating checksum field as spaces
  // checksum field is at offset 148, 8 bytes
  // First fill checksum with spaces
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    checksum += header[i]!;
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf-8');

  return header;
}

/**
 * Pads data to the next 512-byte boundary as required by tar format.
 *
 * @param size - The actual file data size.
 * @returns A Buffer of zero bytes to reach the next block boundary, or empty buffer if already aligned.
 */
function createPadding(size: number): Buffer {
  const remainder = size % BLOCK_SIZE;
  if (remainder === 0) return Buffer.alloc(0);
  return Buffer.alloc(BLOCK_SIZE - remainder, 0);
}

/**
 * Creates a readable stream that produces a tar archive of a single directory.
 * All files directly inside the directory are included (non-recursive).
 *
 * @param dirPath - Absolute path to the directory to archive.
 * @param prefix - Path prefix for entries inside the tar (e.g., "session-id/").
 * @returns A Readable stream producing the tar archive.
 */
export function createTarStream(dirPath: string, prefix: string): Readable {
  const stream = new PassThrough();

  // Process asynchronously to avoid blocking
  (async () => {
    try {
      if (!fs.existsSync(dirPath)) {
        stream.end();
        return;
      }

      const files = fs.readdirSync(dirPath).filter((f) => {
        const stat = fs.statSync(path.join(dirPath, f));
        return stat.isFile();
      });

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const content = fs.readFileSync(filePath);
        const entryPath = prefix + file;

        const header = createTarHeader(entryPath, content.byteLength);
        stream.write(header);
        stream.write(content);

        const padding = createPadding(content.byteLength);
        if (padding.byteLength > 0) {
          stream.write(padding);
        }
      }

      // End-of-archive: two 512-byte blocks of zeros
      stream.write(Buffer.alloc(BLOCK_SIZE * 2, 0));
      stream.end();
    } catch (err) {
      stream.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return stream;
}

/**
 * Creates a readable stream that produces a tar archive containing multiple
 * session directories. Each session's files appear under `<sessionId>/` prefix.
 *
 * @param sessionDirs - Array of { sessionId, dirPath } objects.
 * @returns A Readable stream producing the tar archive.
 */
export function createMultiSessionTarStream(
  sessionDirs: Array<{ sessionId: string; dirPath: string }>,
): Readable {
  const stream = new PassThrough();

  (async () => {
    try {
      for (const { sessionId, dirPath } of sessionDirs) {
        if (!fs.existsSync(dirPath)) continue;

        const files = fs.readdirSync(dirPath).filter((f) => {
          const stat = fs.statSync(path.join(dirPath, f));
          return stat.isFile();
        });

        for (const file of files) {
          const filePath = path.join(dirPath, file);
          const content = fs.readFileSync(filePath);
          const entryPath = `${sessionId}/${file}`;

          const header = createTarHeader(entryPath, content.byteLength);
          stream.write(header);
          stream.write(content);

          const padding = createPadding(content.byteLength);
          if (padding.byteLength > 0) {
            stream.write(padding);
          }
        }
      }

      // End-of-archive marker
      stream.write(Buffer.alloc(BLOCK_SIZE * 2, 0));
      stream.end();
    } catch (err) {
      stream.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return stream;
}

/**
 * Creates a gzip-compressed tar stream (.tar.gz) from a single directory.
 *
 * @param dirPath - Absolute path to the directory to archive.
 * @param prefix - Path prefix for entries inside the tar.
 * @returns A Readable stream producing gzip-compressed tar data.
 */
export function createTarGzStream(dirPath: string, prefix: string): Readable {
  const tarStream = createTarStream(dirPath, prefix);
  const gzip = createGzip();
  return tarStream.pipe(gzip);
}
