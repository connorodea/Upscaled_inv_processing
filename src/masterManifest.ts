import { promises as fs } from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

export interface MasterManifestUpdateInput {
  manifestId: string;
  upc?: string;
  manufacturer?: string;
  model?: string;
}

export interface MasterManifestUpdateResult {
  updated: boolean;
  manifestPath?: string;
  matchedRow?: number;
  reason?: string;
}

const MASTER_DIR_NAME = 'MasterManifests';
const PROCESSED_HEADER = 'Processed';
const PROCESSED_AT_HEADER = 'Processed At';

function normalizeText(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeUpc(value: unknown): string {
  return normalizeText(value).replace(/\D/g, '');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveManifestPath(manifestId: string): Promise<string | null> {
  const baseDir = path.join(process.cwd(), MASTER_DIR_NAME);
  const normalizedId = manifestId.trim();
  const directCandidates = [
    path.join(baseDir, `${normalizedId}_manifest.xlsx`),
    path.join(baseDir, `${normalizedId}.xlsx`)
  ];

  for (const candidate of directCandidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  try {
    const entries = await fs.readdir(baseDir);
    const upperId = normalizedId.toUpperCase();
    const match = entries.find(entry =>
      entry.toUpperCase().startsWith(upperId) && entry.toLowerCase().endsWith('.xlsx')
    );
    return match ? path.join(baseDir, match) : null;
  } catch {
    return null;
  }
}

export async function updateMasterManifestForProduct(
  input: MasterManifestUpdateInput
): Promise<MasterManifestUpdateResult> {
  const manifestId = input.manifestId.trim();
  if (!manifestId) {
    return { updated: false, reason: 'missing_manifest_id' };
  }

  const manifestPath = await resolveManifestPath(manifestId);
  if (!manifestPath) {
    return { updated: false, reason: 'manifest_not_found' };
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(manifestPath);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return { updated: false, manifestPath, reason: 'missing_sheet' };
  }

  const headerRowNumber = sheet.actualRowCount > 0 ? 1 : 0;
  if (!headerRowNumber) {
    return { updated: false, manifestPath, reason: 'empty_sheet' };
  }

  const headerRow = sheet.getRow(headerRowNumber);

  const headerMap = new Map<string, number>();
  for (let col = 1; col <= headerRow.cellCount; col += 1) {
    const headerValue = normalizeText(headerRow.getCell(col).text);
    if (headerValue) {
      headerMap.set(headerValue, col);
    }
  }

  const upcCol = headerMap.get('UPC');
  const productNameCol = headerMap.get('PRODUCT NAME');
  const listingTitleCol = headerMap.get('LISTING TITLE');

  const normalizedUpc = normalizeUpc(input.upc);
  const normalizedManufacturer = normalizeText(input.manufacturer);
  const normalizedModel = normalizeText(input.model);
  const canMatchByUpc = normalizedUpc.length > 0 && upcCol !== undefined;
  const canMatchByText =
    normalizedManufacturer.length > 0 &&
    normalizedModel.length > 0 &&
    (productNameCol !== undefined || listingTitleCol !== undefined);

  if (!canMatchByUpc && !canMatchByText) {
    return { updated: false, manifestPath, reason: 'missing_match_fields' };
  }

  const matches: number[] = [];
  for (let row = headerRowNumber + 1; row <= sheet.rowCount; row += 1) {
    const rowRef = sheet.getRow(row);
    if (canMatchByUpc && upcCol !== undefined) {
      const rowUpc = normalizeUpc(rowRef.getCell(upcCol).text);
      if (rowUpc && rowUpc === normalizedUpc) {
        matches.push(row);
        continue;
      }
    }

    if (canMatchByText) {
      const productName = productNameCol !== undefined ? rowRef.getCell(productNameCol).text : '';
      const listingTitle = listingTitleCol !== undefined ? rowRef.getCell(listingTitleCol).text : '';
      const haystack = normalizeText(`${productName} ${listingTitle}`);
      if (haystack.includes(normalizedManufacturer) && haystack.includes(normalizedModel)) {
        matches.push(row);
      }
    }
  }

  if (matches.length === 0) {
    return { updated: false, manifestPath, reason: 'no_match' };
  }

  let processedCol = headerMap.get(PROCESSED_HEADER.toUpperCase());
  let processedAtCol = headerMap.get(PROCESSED_AT_HEADER.toUpperCase());

  if (processedCol === undefined) {
    processedCol = headerRow.cellCount + 1;
    headerRow.getCell(processedCol).value = PROCESSED_HEADER;
  }

  if (processedAtCol === undefined) {
    processedAtCol = Math.max(headerRow.cellCount + 1, processedCol + 1);
    headerRow.getCell(processedAtCol).value = PROCESSED_AT_HEADER;
  }

  headerRow.commit();

  const timestamp = new Date().toISOString();
  let targetRow = matches[0];
  if (processedCol !== undefined) {
    for (const row of matches) {
      const value = normalizeText(sheet.getRow(row).getCell(processedCol).text);
      if (!value || value === 'NO') {
        targetRow = row;
        break;
      }
    }
  }

  const target = sheet.getRow(targetRow);
  target.getCell(processedCol).value = 'YES';
  target.getCell(processedAtCol).value = timestamp;

  const processedFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFC7CE' }
  };
  const maxCol = Math.max(sheet.columnCount, processedAtCol);
  for (let col = 1; col <= maxCol; col += 1) {
    target.getCell(col).fill = processedFill;
  }
  target.commit();

  await workbook.xlsx.writeFile(manifestPath);

  return { updated: true, manifestPath, matchedRow: targetRow };
}
