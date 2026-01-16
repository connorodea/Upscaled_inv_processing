import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import crypto from 'crypto';
import { promisify } from 'util';
import ExcelJS from 'exceljs';

const execAsync = promisify(exec);
const DEFAULT_SHEET_ID = '194YbDkn6T8xHa_ECxTD5oDwiMmcQN2STo5Gnf-WbKcw';

type SheetValue = string | number | null;

interface ManifestLocationMap {
  [manifestId: string]: string;
}

function normalizeText(value: string): string {
  return value.trim().toUpperCase();
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current);
  return fields;
}

async function readCsv(filePath: string): Promise<SheetValue[][]> {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
  return lines.map(line => parseCsvLine(line));
}

async function getAccessToken(): Promise<string> {
  const keyPath =
    process.env.UPSCALED_SERVICE_ACCOUNT_KEY ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(process.cwd(), 'data', 'upscaled-sheets-sync-2.json');

  const preferServiceAccount =
    Boolean(process.env.UPSCALED_SERVICE_ACCOUNT_KEY) ||
    Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);

  try {
    await fs.access(keyPath);
    const raw = await fs.readFile(keyPath, 'utf8');
    const key = JSON.parse(raw) as { client_email: string; private_key: string };
    if (key?.client_email && key?.private_key) {
      return await getServiceAccountToken(key.client_email, key.private_key);
    }
    throw new Error('Service account key missing client_email/private_key');
  } catch (error) {
    if (preferServiceAccount) {
      throw error;
    }
    // fall back to gcloud
  }

  const { stdout } = await execAsync('gcloud auth print-access-token');
  return stdout.trim();
}

function base64UrlEncode(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function getServiceAccountToken(clientEmail: string, privateKey: string): Promise<string> {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    Buffer.from(
      JSON.stringify({
        iss: clientEmail,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
      })
    )
  );
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey);
  const assertion = `${header}.${payload}.${base64UrlEncode(signature)}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google OAuth error (${response.status}): ${text}`);
  }
  const json = await response.json();
  return String(json.access_token || '');
}

async function fetchJson(url: string, options: { method?: string; body?: unknown; token: string }) {
  const { method = 'GET', body, token } = options;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Sheets API error (${response.status}): ${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function ensureSheet(token: string, spreadsheetId: string, title: string): Promise<void> {
  const metadata = await fetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
    { token }
  );
  const sheets = metadata?.sheets ?? [];
  const existing = sheets.some((sheet: any) => sheet.properties?.title === title);

  if (existing) {
    return;
  }

  await fetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      token,
      body: {
        requests: [
          {
            addSheet: {
              properties: { title }
            }
          }
        ]
      }
    }
  );
}

async function clearSheet(token: string, spreadsheetId: string, title: string): Promise<void> {
  const range = encodeURIComponent(`'${title}'`);
  await fetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:clear`,
    { method: 'POST', token, body: {} }
  );
}

async function writeSheet(
  token: string,
  spreadsheetId: string,
  title: string,
  values: SheetValue[][]
): Promise<void> {
  const range = encodeURIComponent(`'${title}'!A1`);
  await fetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: 'PUT',
      token,
      body: { values }
    }
  );
}

async function loadManifestLocationMap(): Promise<ManifestLocationMap> {
  const map: ManifestLocationMap = {};

  try {
    const manifestData = await fs.readFile(path.join(process.cwd(), 'data', 'manifests.json'), 'utf8');
    const records = JSON.parse(manifestData) as Array<{ manifestId?: string; location?: string }>;
    for (const record of records) {
      if (record.manifestId && record.location) {
        map[normalizeText(record.manifestId)] = normalizeText(record.location);
      }
    }
  } catch {
    // ignore missing file
  }

  try {
    const inventoryPath = path.join(process.cwd(), 'data', 'inventory.csv');
    const content = await fs.readFile(inventoryPath, 'utf8');
    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
    if (lines.length > 1) {
      const headers = parseCsvLine(lines[0]).map(h => normalizeText(h));
      const manifestIndex = headers.indexOf('MANIFEST ID');
      const locationIndex = headers.indexOf('LOCATION');
      if (manifestIndex >= 0 && locationIndex >= 0) {
        for (const line of lines.slice(1)) {
          const fields = parseCsvLine(line);
          const manifestId = fields[manifestIndex];
          const location = fields[locationIndex];
          if (manifestId && location) {
            const key = normalizeText(manifestId);
            if (!map[key]) {
              map[key] = normalizeText(location);
            }
          }
        }
      }
    }
  } catch {
    // ignore missing inventory
  }

  return map;
}

async function readMasterManifest(filePath: string): Promise<SheetValue[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return [];
  }

  const rows: SheetValue[][] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 1) {
      return;
    }
    const values = row.values as Array<string | number | null>;
    const normalized = values.slice(1);
    if (normalized.every(value => value === null || value === undefined || String(value).trim() === '')) {
      return;
    }
    rows.push(normalized.map(value => (value === undefined ? null : value)));
  });

  return rows;
}

async function buildMasterManifestTabs(): Promise<Record<string, SheetValue[][]>> {
  const manifestDir = path.join(process.cwd(), 'MasterManifests');
  const files = await fs.readdir(manifestDir);
  const manifestMap = await loadManifestLocationMap();
  const tabs: Record<string, SheetValue[][]> = {};

  for (const file of files) {
    if (!file.toLowerCase().endsWith('.xlsx')) {
      continue;
    }
    const manifestId = file.replace(/_manifest\.xlsx$/i, '').replace(/\.xlsx$/i, '');
    const location = manifestMap[normalizeText(manifestId)];
    if (!location) {
      continue;
    }
    const values = await readMasterManifest(path.join(manifestDir, file));
    if (values.length === 0) {
      continue;
    }

    const tabName = `${location}-mastermanifest`;
    if (!tabs[tabName]) {
      tabs[tabName] = [['Order ID', ...values[0]]];
    }

    for (const row of values.slice(1)) {
      tabs[tabName].push([manifestId, ...row]);
    }
  }

  return tabs;
}

async function buildBatchTabs(): Promise<Record<string, SheetValue[][]>> {
  const dataDir = path.join(process.cwd(), 'data');
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  const tabs: Record<string, SheetValue[][]> = {};

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const location = entry.name.toUpperCase();
    const locationDir = path.join(dataDir, entry.name);
    const files = await fs.readdir(locationDir);
    for (const file of files) {
      const match = file.match(/^B(\d+)\.csv$/i);
      if (!match) {
        continue;
      }
      const batchNumber = match[1];
      const values = await readCsv(path.join(locationDir, file));
      if (values.length === 0) {
        continue;
      }
      const tabName = `${location}-B${batchNumber}`;
      tabs[tabName] = values;
    }
  }

  return tabs;
}

export async function syncGoogleSheet(): Promise<{ updatedTabs: string[] }> {
  const spreadsheetId = process.env.UPSCALED_SHEET_ID || DEFAULT_SHEET_ID;
  const token = await getAccessToken();
  const updatedTabs: string[] = [];

  const batchTabs = await buildBatchTabs();
  const masterTabs = await buildMasterManifestTabs();
  const combinedTabs = { ...batchTabs, ...masterTabs };

  for (const [title, values] of Object.entries(combinedTabs)) {
    await ensureSheet(token, spreadsheetId, title);
    await clearSheet(token, spreadsheetId, title);
    await writeSheet(token, spreadsheetId, title, values);
    updatedTabs.push(title);
  }

  return { updatedTabs };
}
