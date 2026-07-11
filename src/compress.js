import zlib from 'node:zlib';

const QUALITY = { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 };

/**
 * articles.content/full_content are stored brotli-compressed (since the v11
 * migration) — TEXT columns holding BLOB values, which SQLite allows without
 * conversion (TEXT affinity only coerces numeric input, never BLOBs). Quality
 * 11 (max) is fine here: compression happens once per article, not on a hot
 * path (see fetchArticleText/ingestFeed), so the extra time versus a lower
 * quality level is irrelevant next to the ratio it buys.
 */
export function compressText(text) {
  if (text == null) return null;
  return zlib.brotliCompressSync(Buffer.from(text, 'utf8'), { params: QUALITY });
}

export function decompressText(blob) {
  if (blob == null) return null;
  return zlib.brotliDecompressSync(blob).toString('utf8');
}
