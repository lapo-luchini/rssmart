// Shared byte-decoding helpers. WHATWG fetch's Response.text() (and most
// XML/HTML libraries) always decode as UTF-8, which turns non-UTF-8
// responses — still common, e.g. iso-8859-1/windows-1252 on older Italian
// sites — into U+FFFD mojibake. Callers detect the declared charset
// (Content-Type header, XML prolog, HTML meta tag...) and decode the raw
// bytes with it explicitly instead.

/** Extract a charset label from a Content-Type header value, if present. */
export function charsetFromContentType(contentType) {
  return /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ?? null;
}

/** Decode bytes with the given charset label. Unknown/unsupported labels
 * make TextDecoder throw a RangeError; fall back to UTF-8, best effort. */
export function decodeBytes(bytes, charset) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return Buffer.from(bytes).toString('utf8');
  }
}
