import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const BATCH_FILE_REGEX = /^B(\d+)\.csv$/i;
const LEGACY_BATCH_FILE_REGEX = /^B(\d+)-([A-Z0-9]+)\.csv$/i;

export function getBatchFileName(batchNumber: number, _location?: string): string {
  return `B${batchNumber}.csv`;
}

export function getBatchDir(location: string): string {
  return path.join(DATA_DIR, location.toUpperCase());
}

export function getBatchFilePath(batchNumber: number, location: string): string {
  return path.join(getBatchDir(location), getBatchFileName(batchNumber));
}

export function parseBatchFileName(fileName: string): { batchNumber: number; location?: string } | null {
  const legacyMatch = fileName.match(LEGACY_BATCH_FILE_REGEX);
  if (legacyMatch) {
    return {
      batchNumber: Number.parseInt(legacyMatch[1], 10),
      location: legacyMatch[2].toUpperCase()
    };
  }

  const match = fileName.match(BATCH_FILE_REGEX);
  if (!match) {
    return null;
  }

  return {
    batchNumber: Number.parseInt(match[1], 10)
  };
}

export function isBatchFileForLocation(fileName: string, location: string): boolean {
  const parsed = parseBatchFileName(fileName);
  if (!parsed) {
    return false;
  }
  if (!parsed.location) {
    return true;
  }
  return parsed.location === location.toUpperCase();
}
