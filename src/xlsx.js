/**
 * Minimal .xlsx writer and reader, one sheet of text cells.
 * An .xlsx file is a zip of XML files. The browser can inflate (DecompressionStream)
 * and parse XML, so this needs no spreadsheet library. Files read here are untrusted:
 * sizes are capped, and cell values are only ever returned as plain strings.
 */

const LAST_ROW = 10000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 50 * 1024 * 1024;

/* ---------- zip ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Little-endian bytes from [value, size] pairs. */
function fields(...pairs) {
  const out = [];
  for (const [value, size] of pairs) for (let i = 0; i < size; i++) out.push((value / 2 ** (8 * i)) & 0xff);
  return Uint8Array.from(out);
}

/** A zip with stored (uncompressed) entries. */
function zip(files) {
  const encoder = new TextEncoder();
  const body = [];
  const directory = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    // Version 2.0, no flags, stored, DOS date 1980-01-01, then crc and both sizes.
    const common = [[20, 2], [0, 2], [0, 2], [0, 2], [33, 2], [crc32(data), 4], [data.length, 4], [data.length, 4], [nameBytes.length, 2], [0, 2]];
    body.push(fields([0x04034b50, 4], ...common), nameBytes, data);
    directory.push(fields([0x02014b50, 4], [20, 2], ...common, [0, 2], [0, 2], [0, 2], [0, 4], [offset, 4]), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = directory.reduce((sum, part) => sum + part.length, 0);
  const end = fields([0x06054b50, 4], [0, 2], [0, 2], [files.length, 2], [files.length, 2], [size, 4], [offset, 4], [0, 2]);
  return [...body, ...directory, end];
}

async function inflate(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PART_BYTES) {
      await reader.cancel();
      throw new Error("Filen är för stor uppackad.");
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

/** Name → loader for each entry in a zip, read from the central directory. */
function unzip(buffer) {
  const view = new DataView(buffer);
  let end = buffer.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Filen är inte en .xlsx-fil.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (at + 46 > buffer.byteLength || view.getUint32(at, true) !== 0x02014b50) throw new Error("Filen är skadad.");
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const header = view.getUint32(at + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, at + 46, nameLength));
    entries.set(name, async () => {
      if (header + 30 > buffer.byteLength) throw new Error("Filen är skadad.");
      const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
      if (start + compressed > buffer.byteLength) throw new Error("Filen är skadad.");
      const bytes = new Uint8Array(buffer, start, compressed);
      if (method === 0) return bytes;
      if (method === 8) return inflate(bytes);
      throw new Error("Filen använder en okänd komprimering.");
    });
    at += 46 + skip;
  }
  return entries;
}

/* ---------- write ---------- */

const xml = (value) =>
  String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

const columnName = (index) => String.fromCharCode(65 + index);
const HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

/**
 * Rows of text as an .xlsx blob. Text cells are never formulas, so a value like
 * =SUM(...) stays text. `list` makes one column a dropdown: { column, values }.
 */
export function xlsxBlob(rows, list) {
  const width = Math.max(...rows.map((row) => row.length));
  const cols = Array.from({ length: width }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="24" customWidth="1"/>`).join("");
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => `<c r="${columnName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`)
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const column = columnName(list.column);
  const validation =
    `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="Ogiltigt val" ` +
    `error="Välj ett värde i listan." sqref="${column}2:${column}${LAST_ROW}"><formula1>${xml(`"${list.values.join(",")}"`)}</formula1></dataValidation></dataValidations>`;

  const parts = zip([
    [
      "[Content_Types].xml",
      `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`,
    ],
    [
      "_rels/.rels",
      `${HEAD}<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `${HEAD}<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="Användare" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `${HEAD}<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ],
    [
      "xl/worksheets/sheet1.xml",
      `${HEAD}<worksheet xmlns="${SHEET_NS}"><cols>${cols}</cols><sheetData>${sheetRows}</sheetData>${validation}</worksheet>`,
    ],
  ]);
  return new Blob(parts, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/* ---------- read ---------- */

const tags = (node, name) => [...node.getElementsByTagNameNS("*", name)];

async function readXml(entries, name) {
  const load = entries.get(name);
  if (!load) return null;
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(await load()), "application/xml");
  if (tags(doc, "parsererror").length) throw new Error("Filen är skadad.");
  return doc;
}

/** Index of the column in a cell reference: "C5" → 2. */
function columnIndex(reference) {
  const letters = String(reference).match(/^[A-Z]+/)?.[0] ?? "";
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

/** Rows of strings from the first sheet of an .xlsx file. */
export async function readXlsx(buffer) {
  if (buffer.byteLength > MAX_FILE_BYTES) throw new Error("Filen är större än 5 MB.");
  const entries = unzip(buffer);
  const workbook = await readXml(entries, "xl/workbook.xml");
  const rels = await readXml(entries, "xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new Error("Filen är inte en .xlsx-fil.");

  const relId = tags(workbook, "sheet")[0]?.getAttributeNS(REL_NS, "id");
  const target = tags(rels, "Relationship").find((rel) => rel.getAttribute("Id") === relId)?.getAttribute("Target") ?? "";
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const sheet = await readXml(entries, path);
  if (!sheet) throw new Error("Hittar inget blad i filen.");

  const shared = await readXml(entries, "xl/sharedStrings.xml");
  const strings = shared ? tags(shared, "si").map((si) => tags(si, "t").map((t) => t.textContent).join("")) : [];

  const rows = [];
  for (const row of tags(sheet, "row").slice(0, LAST_ROW)) {
    const cells = [];
    for (const cell of tags(row, "c")) {
      const index = columnIndex(cell.getAttribute("r"));
      if (index < 0 || index > 25) continue;
      const type = cell.getAttribute("t");
      const value = tags(cell, "v")[0]?.textContent ?? "";
      let text = value;
      if (type === "s") text = strings[Number(value)] ?? "";
      else if (type === "inlineStr") text = tags(cell, "t").map((t) => t.textContent).join("");
      cells[index] = text;
    }
    rows.push(Array.from(cells, (text) => text ?? ""));
  }
  return rows;
}
