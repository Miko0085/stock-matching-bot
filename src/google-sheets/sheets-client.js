'use strict';

const fs = require('fs');
const { google } = require('googleapis');

// Service-account auth, not the OAuth2 flow the old (now-deleted, ADR-040)
// n8n stock-sync workflow used -- that credential required an interactive
// login and had already expired by the time this was written. A service
// account never expires that way: it just needs to be shared (Viewer is
// enough, this never writes to the sheet) with the sheet once.
//
// GOOGLE_SERVICE_ACCOUNT_JSON may be either a path to the downloaded key
// file, or the key JSON itself pasted directly into the env var -- whatever
// is more convenient for how this gets deployed. Never committed either way
// (see .gitignore).
function loadServiceAccountCredentials(raw) {
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set -- cannot authenticate to Google Sheets.');
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  return JSON.parse(fs.readFileSync(trimmed, 'utf8'));
}

function buildSheetsClient({ serviceAccountJson } = {}) {
  const credentials = loadServiceAccountCredentials(serviceAccountJson ?? process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Reads a tab as an array of header-keyed row objects -- row 1 is always
// the header row. A column present in the header but blank on a given row
// becomes an explicit empty string, never a missing key, so downstream
// normalization (src/core/sync-normalize.js) sees a consistent shape no
// matter which columns a particular row happened to fill in.
async function readSheetRows(sheets, { spreadsheetId, tabName }) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabName,
  });
  const [header, ...rows] = data.values || [];
  if (!header) return [];
  return rows.map((row) => {
    const obj = {};
    header.forEach((col, i) => {
      obj[col] = row[i] !== undefined ? row[i] : '';
    });
    return obj;
  });
}

module.exports = { buildSheetsClient, readSheetRows, loadServiceAccountCredentials };
