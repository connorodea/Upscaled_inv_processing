import fs from 'fs/promises';
import path from 'path';
import { getBatchDir, getBatchFilePath } from './batchFiles.js';
import { syncGoogleSheet } from './googleSheetsSync.js';

const INVENTORY_CSV = path.join(process.cwd(), 'data', 'inventory.csv');

export class BatchExporter {
  async exportBatch(batchNumber: number, location: string): Promise<void> {
    try {
      // Read the main inventory CSV
      const csvContent = await fs.readFile(INVENTORY_CSV, 'utf-8');
      const lines = csvContent.split('\n');

      if (lines.length < 2) {
        console.log('No data to export for batch', batchNumber);
        return;
      }

      // Get header
      const header = lines[0];

      // Filter lines for this batch and location
      const batchKey = `-${location}-B${batchNumber}UID`;
      const batchLines = lines.filter(line =>
        line.includes(batchKey) && line.trim() !== ''
      );

      if (batchLines.length === 0) {
        console.log(`No items found for batch ${batchNumber} at ${location}`);
        return;
      }

      // Create batch CSV file
      const batchFile = getBatchFilePath(batchNumber, location);
      const batchContent = [header, ...batchLines].join('\n');

      await fs.mkdir(getBatchDir(location), { recursive: true });
      await fs.writeFile(batchFile, batchContent);

      console.log(`✓ Batch ${batchNumber} (${location}) exported to ${batchFile} (${batchLines.length} items)`);
      try {
        await syncGoogleSheet();
        console.log(`✓ Synced Google Sheet for ${location} batch ${batchNumber}`);
      } catch (error) {
        console.warn('Google Sheet sync skipped:', error);
      }
    } catch (error) {
      console.error(`Failed to export batch ${batchNumber}:`, error);
    }
  }
}
