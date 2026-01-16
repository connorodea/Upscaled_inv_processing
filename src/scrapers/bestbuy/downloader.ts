import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';

const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

function getExtensionFromUrl(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const ext = path.extname(pathname);
    return ext ? ext.toLowerCase() : null;
  } catch {
    return null;
  }
}

function getExtension(contentType?: string | null): string {
  if (contentType && CONTENT_TYPE_EXT[contentType]) {
    return CONTENT_TYPE_EXT[contentType];
  }
  return '.jpg';
}

export function buildImagePath(baseDir: string, sku: string, url: string, position: number, contentType?: string | null): string {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
  const extFromUrl = getExtensionFromUrl(url);
  const ext = extFromUrl ?? getExtension(contentType);
  const fileName = `${sku}-${String(position).padStart(2, '0')}-${hash}${ext}`;
  return path.join(baseDir, sku, fileName);
}

export async function downloadImage(url: string, destPath: string, userAgent: string): Promise<{ contentType?: string; size?: number }> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  try {
    await fs.access(destPath);
    return {};
  } catch {
    // continue
  }

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': userAgent }
  });

  await fs.writeFile(destPath, response.data);

  const contentType = response.headers['content-type'];
  const size = response.data?.byteLength ?? undefined;

  return { contentType, size };
}
