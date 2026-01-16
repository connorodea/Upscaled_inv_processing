import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

describe('BatchManager legacy state behavior', () => {
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upscaled-tests-'));
    process.chdir(tempDir);
    vi.resetModules();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('applies legacy state to default location when legacy has no location', async () => {
    await writeJson(path.join(tempDir, 'data', 'location.json'), { location: 'DEN001' });
    await writeJson(path.join(tempDir, 'data', 'batch-state.json'), {
      currentBatchNumber: 7,
      currentItemNumber: 12
    });

    const { BatchManager } = await import('../src/batchManager.js');
    const manager = new BatchManager();
    await manager.load();

    expect(manager.getLocation()).toBe('DEN001');
    expect(manager.getCurrentBatchNumber()).toBe(7);
    expect(manager.getCurrentItemNumber()).toBe(12);
  });

  it('does not apply legacy state to non-default location without a matching location', async () => {
    await writeJson(path.join(tempDir, 'data', 'location.json'), { location: 'DET001' });
    await writeJson(path.join(tempDir, 'data', 'batch-state.json'), {
      currentBatchNumber: 7,
      currentItemNumber: 12
    });

    const { BatchManager } = await import('../src/batchManager.js');
    const manager = new BatchManager();
    await manager.load();

    expect(manager.getLocation()).toBe('DET001');
    expect(manager.getCurrentBatchNumber()).toBe(1);
    expect(manager.getCurrentItemNumber()).toBe(1);
  });
});
