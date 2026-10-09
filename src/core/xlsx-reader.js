'use strict';

const yauzl = require('yauzl');

// Minimal .xlsx reader for one-off bulk imports (e.g. a broker-provided
// spreadsheet, not a recurring sync source). Deliberately NOT using the
// `xlsx` (SheetJS) npm package -- its last npm-published version (0.18.5)
// has two unpatched high-severity advisories (prototype pollution, ReDoS,
// no fix available). `exceljs` was tried first but fails to parse files
// exported by Google Sheets' "Download as .xlsx": their workbook.xml uses
// a non-default namespace prefix (`<x:workbook>`/`<x:sheet>` instead of
// the unprefixed default), which exceljs's strict parser rejects outright.
// `yauzl` only extracts files from the zip container (a much smaller,
// well-established, actively maintained library with no xlsx-specific
// parsing surface); the OOXML sheet XML itself is read here with a small
// regex-based extractor, same shape contract as
// src/google-sheets/sheets-client.js's readSheetRows (header-keyed row
// objects, blank cells as '', never a missing key) so it drops into the
// exact same validateStockRow/validateAliasRow pipeline.

function readZipEntry(filePath, entryName) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      let found = false;
      zipfile.on('error', reject);
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipfile.readEntry();
          return;
        }
        found = true;
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            zipfile.close();
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => {
        if (!found) resolve(null);
      });
      zipfile.readEntry();
    });
  });
}

// Decodes the handful of XML entities OOXML text content actually uses --
// not a general XML parser, just enough for cell/shared-string text.
function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&'); // must be last -- otherwise "&amp;lt;" double-decodes
}

// Every <t>...</t> inside one <si> (a shared-string entry can have
// multiple rich-text <r><t>...</t></r> runs that concatenate).
function extractSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const siRe = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g;
  let siMatch;
  while ((siMatch = siRe.exec(xml))) {
    const body = siMatch[1];
    const tRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
    let tMatch;
    let text = '';
    let any = false;
    while ((tMatch = tRe.exec(body))) {
      any = true;
      text += decodeXmlEntities(tMatch[1]);
    }
    strings.push(any ? text : '');
  }
  return strings;
}

function columnLetterFromRef(ref) {
  const m = /^([A-Z]+)/.exec(ref);
  return m ? m[1] : null;
}

function columnLetterToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // 0-based
}

function parseCell(cellXml, sharedStrings) {
  const refMatch = /\br="([A-Z]+\d+)"/.exec(cellXml);
  const ref = refMatch ? refMatch[1] : null;
  if (!ref) return null;
  const typeMatch = /\bt="([a-zA-Z]+)"/.exec(cellXml);
  const type = typeMatch ? typeMatch[1] : null;

  let rawValue = null;
  if (type === 'inlineStr') {
    const tMatch = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/.exec(cellXml);
    rawValue = tMatch ? decodeXmlEntities(tMatch[1]) : '';
  } else {
    const vMatch = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(cellXml);
    if (!vMatch) return { ref, value: '' };
    const raw = decodeXmlEntities(vMatch[1]);
    if (type === 's') {
      const idx = Number.parseInt(raw, 10);
      rawValue = Number.isInteger(idx) ? (sharedStrings[idx] ?? '') : '';
    } else if (type === 'b') {
      rawValue = raw === '1' ? 'TRUE' : 'FALSE';
    } else {
      // 'str' (inline formula result) or untyped (numeric) -- both are
      // already the literal display value in <v>.
      rawValue = raw;
    }
  }
  return { ref, value: rawValue };
}

function parseSheetRows(sheetXml, sharedStrings) {
  const rowRe = /<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g;
  // [^>]*? is LAZY: a blank cell is self-closing (`<x:c r="J2" s="1"/>`) --
  // a greedy [^>]* would swallow the trailing "/" as part of the attribute
  // list, miss the "/>" branch entirely, and fall through to hunting for
  // the next "</c>" closing tag, silently merging several real cells into
  // one bogus match and shifting every later column in that row left by
  // one. Confirmed with a real file: any row with an empty cell before its
  // last populated column reproduced exactly this shift.
  const cellRe = /<(?:\w+:)?c\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?c>)/g;
  const rows = [];
  let rowMatch;
  while ((rowMatch = rowRe.exec(sheetXml))) {
    const body = rowMatch[1];
    const cells = {};
    let cellMatch;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(body))) {
      const parsed = parseCell(cellMatch[0], sharedStrings);
      if (!parsed) continue;
      cells[columnLetterFromRef(parsed.ref)] = parsed.value;
    }
    rows.push(cells);
  }
  return rows;
}

// Returns header-keyed row objects for the FIRST worksheet only (good
// enough for a single-tab import file; this is not a general-purpose
// multi-sheet reader). Row 1 is always the header row, same contract as
// readSheetRows: every header column is present on every row, '' when the
// source cell was blank/absent, never a missing key.
async function readXlsxRows(filePath) {
  const [sharedStringsXml, sheetXml] = await Promise.all([
    readZipEntry(filePath, 'xl/sharedStrings.xml'),
    readZipEntry(filePath, 'xl/worksheets/sheet1.xml'),
  ]);
  if (!sheetXml) {
    throw new Error(`readXlsxRows: xl/worksheets/sheet1.xml not found in ${filePath} (not a single-sheet .xlsx file?)`);
  }
  const sharedStrings = extractSharedStrings(sharedStringsXml);
  const rawRows = parseSheetRows(sheetXml, sharedStrings);
  if (!rawRows.length) return [];

  const headerCells = rawRows[0];
  const headerByCol = {};
  for (const col of Object.keys(headerCells)) {
    const name = String(headerCells[col] ?? '').trim();
    if (name) headerByCol[col] = name;
  }
  const headerCols = Object.keys(headerByCol).sort((a, b) => columnLetterToIndex(a) - columnLetterToIndex(b));

  return rawRows.slice(1).map((cells) => {
    const obj = {};
    for (const col of headerCols) {
      const value = cells[col];
      obj[headerByCol[col]] = value !== undefined && value !== null ? value : '';
    }
    return obj;
  });
}

module.exports = { readXlsxRows };
