// ── Reading a .docx ──────────────────────────────────────────────────────────
// The Asamblea serves the text of every law as a Word file. A .docx is a ZIP
// holding XML, and both halves of that are already in the runtime: the central
// directory is a documented byte layout, and DecompressionStream inflates the
// entries. So this reads Word documents with no dependency at all, which keeps
// a 300 KB download from pulling a parsing library into the server.
//
// Only what a law needs is implemented: find one entry by name, inflate it,
// and turn its paragraphs into text. Anything exotic (encryption, ZIP64,
// multi-disk archives) is refused rather than half-supported.

/** Signature of the End Of Central Directory record, little-endian. */
const EOCD_SIGNATURE = 0x06054b50;
/** Signature of a central directory file header. */
const CENTRAL_SIGNATURE = 0x02014b50;

/** Stored (0) means the bytes are already plain; deflated (8) needs inflating. */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  /** Offset of the local file header, which precedes the data. */
  localHeaderOffset: number;
}

/**
 * Walks the ZIP central directory.
 *
 * The directory lives at the end of the file and is found by scanning backwards
 * for its signature, because the record has a variable-length comment after it.
 */
function readCentralDirectory(buf: Uint8Array): ZipEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // The comment is at most 65535 bytes, so the search never needs to go further.
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file: no end-of-central-directory record");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff) throw new Error("zip64 archives are not supported");

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];

  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length) break;
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;

    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);

    entries.push({
      name: decoder.decode(buf.subarray(offset + 46, offset + 46 + nameLength)),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Inflates one entry.
 *
 * The compressed bytes do not start at the local header: the header itself has
 * variable-length name and extra fields that have to be stepped over first. The
 * lengths in the *local* header are the ones to trust here, since they can
 * differ from the central directory's copy.
 */
async function readEntry(buf: Uint8Array, entry: ZipEntry): Promise<string> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nameLength = view.getUint16(entry.localHeaderOffset + 26, true);
  const extraLength = view.getUint16(entry.localHeaderOffset + 28, true);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const bytes = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === METHOD_STORE) return new TextDecoder().decode(bytes);
  if (entry.method !== METHOD_DEFLATE) {
    throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
  }

  // "deflate-raw" is the headerless deflate stream that ZIP stores. Plain
  // "deflate" would expect a zlib wrapper that is not there.
  //
  // The copy is not wasted work: `bytes` is a view into the whole archive, and
  // Blob will only accept a view backed by a plain ArrayBuffer. Copying out the
  // compressed entry also keeps the Blob from pinning the entire file in memory
  // for the life of the stream.
  const entryBytes = new Uint8Array(bytes);
  const stream = new Blob([entryBytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));

  return await new Response(stream).text();
}

/** True when the bytes begin with the ZIP local file header magic "PK\x03\x04". */
export function looksLikeDocx(bytes: Uint8Array): boolean {
  return bytes.length > 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Turns WordprocessingML into text.
 *
 * Word wraps every run of characters in its own tags, so the tags are removed
 * rather than parsed. The structural ones are converted first, because they are
 * the only reason the output has any shape at all: a paragraph end becomes a
 * newline, a tab becomes a tab, and a soft break becomes a newline. Stripping
 * everything blindly would run the whole law into one line.
 */
function documentXmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t");

  const stripped = withBreaks.replace(/<[^>]+>/g, "");

  // Entity decoding comes last: doing it earlier could turn a literal "&lt;div&gt;"
  // in the law's own text into a tag that the stripper would then delete.
  const decoded = stripped
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

  return decoded
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extracts the readable text of a .docx. Throws if the bytes are not one. */
export async function docxToText(bytes: Uint8Array): Promise<string> {
  const entries = readCentralDirectory(bytes);
  const main = entries.find((e) => e.name === "word/document.xml");
  if (!main) throw new Error("no word/document.xml: not a Word document");
  return documentXmlToText(await readEntry(bytes, main));
}

/**
 * Formats the flat text of a law as Markdown, so a reader can hold the original
 * next to our summary and see that nothing was smuggled in.
 *
 * The shaping is deliberately conservative. Only lines the law itself marks as
 * structure become headings: the "ARTÍCULO 5" openers and the handful of fixed
 * phrases the Asamblea prints on every law. Guessing harder would risk
 * promoting an ordinary sentence to a heading and changing what the law appears
 * to say, which is the one thing this document must never do.
 */
export function lawTextToMarkdown(text: string): string {
  const ARTICLE = /^(ART[ÍI]CULO|TRANSITORIO)\b/i;
  const SECTION = /^(CAP[ÍI]TULO|T[ÍI]TULO|SECCI[ÓO]N)\b/i;
  const DECREES = /^(DECRETA|LA ASAMBLEA LEGISLATIVA)\b/i;

  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (SECTION.test(line)) out.push(`## ${line}`);
    else if (ARTICLE.test(line)) out.push(`### ${line}`);
    else if (DECREES.test(line)) out.push(`**${line}**`);
    else out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
