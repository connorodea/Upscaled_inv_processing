import path from 'path';
import { describe, expect, it } from 'vitest';
import { getBatchDir, getBatchFileName, getBatchFilePath, parseBatchFileName } from '../src/batchFiles.js';

describe('batchFiles', () => {
  it('builds location-scoped batch paths', () => {
    const location = 'DET001';
    const batchPath = getBatchFilePath(1, location);
    const expectedDir = path.join(process.cwd(), 'data', location);
    expect(batchPath).toBe(path.join(expectedDir, 'B1.csv'));
    expect(getBatchFileName(2)).toBe('B2.csv');
    expect(getBatchDir(location)).toBe(expectedDir);
  });

  it('parses new and legacy batch filenames', () => {
    expect(parseBatchFileName('B1.csv')).toEqual({ batchNumber: 1 });
    expect(parseBatchFileName('B12-DET001.csv')).toEqual({ batchNumber: 12, location: 'DET001' });
    expect(parseBatchFileName('not-a-batch.csv')).toBeNull();
  });
});
