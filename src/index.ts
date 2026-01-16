#!/usr/bin/env node

import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';
import gradient from 'gradient-string';
import ora from 'ora';
import fs from 'fs/promises';
import path from 'path';
import { BatchManager } from './batchManager.js';
import { CSVStorage } from './csvStorage.js';
import { LabelGenerator } from './labelGenerator.js';
import { ThermalPrinter } from './printer.js';
import { BatchExporter } from './batchExporter.js';
import { EbayIntegration } from './ebayIntegration.js';
import { generateSKU, validateGrade } from './skuGenerator.js';
import { Product, Grade } from './types.js';
import { PhotoManager } from './photoManager.js';
import { ManifestManager, ManifestRecord } from './manifestManager.js';
import { MarketplaceIntegration } from './marketplaceIntegration.js';
import { TechLiquidatorsIntegration } from './techLiquidatorsIntegration.js';
import { getBatchFilePath, getBatchFileName } from './batchFiles.js';
import { EbayCompsManifestAnalyzer } from './ebayCompsManifestAnalyzer.js';
import { loadDotEnv } from './env.js';
import { updateMasterManifestForProduct } from './masterManifest.js';
import { syncGoogleSheet } from './googleSheetsSync.js';
import { spawn } from 'child_process';

class InventoryProcessor {
  private batchManager: BatchManager;
  private csvStorage: CSVStorage;
  private labelGenerator: LabelGenerator;
  private printer: ThermalPrinter;
  private batchExporter: BatchExporter;
  private ebayIntegration: EbayIntegration;
  private photoManager: PhotoManager;
  private manifestManager: ManifestManager;
  private marketplaceIntegration: MarketplaceIntegration;
  private techLiquidatorsIntegration: TechLiquidatorsIntegration;
  private ebayCompsManifestAnalyzer: EbayCompsManifestAnalyzer;
  private hasShownDefaultMenuLabel: boolean;

  constructor() {
    this.batchManager = new BatchManager();
    this.csvStorage = new CSVStorage();
    this.labelGenerator = new LabelGenerator();
    this.printer = new ThermalPrinter();
    this.batchExporter = new BatchExporter();
    this.ebayIntegration = new EbayIntegration();
    this.photoManager = new PhotoManager();
    this.manifestManager = new ManifestManager();
    this.marketplaceIntegration = new MarketplaceIntegration();
    this.techLiquidatorsIntegration = new TechLiquidatorsIntegration();
    this.ebayCompsManifestAnalyzer = new EbayCompsManifestAnalyzer();
    this.hasShownDefaultMenuLabel = false;
  }

  private showBanner(): void {
    console.clear();
    const title = gradient.pastel.multiline([
      '╔═══════════════════════════════════════════════╗',
      '║                                               ║',
      '║     INVENTORY PROCESSING SYSTEM               ║',
      '║     Batch Tracking & Label Management         ║',
      '║                                               ║',
      '╚═══════════════════════════════════════════════╝'
    ].join('\n'));

    console.log('\n' + title + '\n');
  }

  async initialize(): Promise<void> {
    this.showBanner();

    const spinner = ora({
      text: 'Initializing system...',
      color: 'cyan'
    }).start();

    await this.batchManager.load();
    await this.manifestManager.load();

    spinner.stop();
    const { locationTag } = await inquirer.prompt([
      {
        type: 'list',
        name: 'locationTag',
        message: chalk.bold('Select location tag:'),
        choices: [
          { name: chalk.blue('DEN001'), value: 'DEN001' },
          { name: chalk.blue('DET001'), value: 'DET001' }
        ],
        default: this.batchManager.getLocation(),
        prefix: '🏷️'
      }
    ]);

    if (locationTag !== this.batchManager.getLocation()) {
      await this.batchManager.setLocation(locationTag);
    }

    spinner.start();
    spinner.text = 'Detecting printer...';
    await this.printer.initialize();
    const watcherStatus = await this.startPhotoWatcher({ quiet: true });

    spinner.succeed(chalk.green('System initialized'));

    const printerName = this.printer.getPrinterName();

    const statusTable = new Table({
      style: { head: ['cyan'] },
      colWidths: [25, 40]
    });

    statusTable.push(
      ['🖨️  Printer', printerName ? chalk.green(printerName) : chalk.yellow('No printer detected')],
      ['📦 Current Batch', chalk.cyan(`Batch ${this.batchManager.getCurrentBatchNumber()}`)],
      ['🔢 Current Item', chalk.cyan(`Item ${this.batchManager.getCurrentItemNumber()}`)],
      ['📊 Items Remaining', chalk.magenta(`${this.batchManager.getItemsRemainingInBatch()} items in batch`)],
      ['🏢 Location', chalk.blue(this.batchManager.getLocation())],
      ['📷 Photo watcher', watcherStatus.started ? chalk.green('● active') : chalk.dim('○ idle')]
    );

    console.log(statusTable.toString());
    console.log('');

    // Initialize database connection if USE_DATABASE=true
    if (process.env.USE_DATABASE === 'true') {
      const dbConnected = await this.csvStorage.initializeDatabase();
      if (dbConnected) {
        console.log(chalk.dim('  ✓ Database connected (dual-write mode enabled)\n'));
      }
    }

    // Check web platform availability
    const webPlatformAvailable = await this.marketplaceIntegration.checkAvailability();
    if (webPlatformAvailable) {
      console.log(chalk.dim('  ✓ Web platform available (cross-listing enabled)\n'));
    }
  }

  private getGradeColor(grade: Grade): string {
    const colors: Record<Grade, any> = {
      'LN': chalk.green,
      'VG': chalk.cyan,
      'G': chalk.blue,
      'PO': chalk.magenta,
      'AC': chalk.yellow,
      'SA': chalk.red
    };
    return colors[grade](grade);
  }

  private getGradeEmoji(grade: Grade): string {
    const emojis: Record<Grade, string> = {
      'LN': '⭐',
      'VG': '✨',
      'G': '👍',
      'PO': '♻️',
      'AC': '📦',
      'SA': '🔧'
    };
    return emojis[grade];
  }

  async processProduct(capturePhotos: boolean): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ ADD NEW PRODUCT ━━━━━━━━\n'));

    const batchId = this.batchManager.getCurrentBatchId();
    const location = this.batchManager.getLocation();
    const batchNumber = this.batchManager.getCurrentBatchNumber();

    const batchBox = boxen(
      `${chalk.bold.white(`Batch ${batchNumber}`)}  ` +
        `${chalk.cyan(`UID: ${batchId}`)}  ` +
        `${chalk.blue(`Location: ${location}`)}`,
      {
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        borderStyle: 'round',
        borderColor: 'cyan'
      }
    );
    console.log(batchBox);
    console.log('');

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'pidUid',
        message: chalk.bold('Enter PID-UID (from pre-printed label):'),
        prefix: '🏷️',
        filter: (input: string) => input.trim().toUpperCase(),
        validate: (input: string) => {
          const value = input.trim();
          if (!value) {
            return capturePhotos ? 'PID-UID is required for photo flow' : true;
          }
          return /^P\d+-ID\d+$/i.test(value) || 'PID-UID must look like P1-ID1';
        }
      },
      {
        type: 'list',
        name: 'grade',
        message: chalk.bold('Select product grade:'),
        choices: [
          { name: `${chalk.green('⭐ LN')} - Like New`, value: 'LN' },
          { name: `${chalk.cyan('✨ VG')} - Very Good`, value: 'VG' },
          { name: `${chalk.blue('👍 G')} - Good`, value: 'G' },
          { name: `${chalk.magenta('♻️ PO')} - Pre-Owned`, value: 'PO' },
          { name: `${chalk.yellow('📦 AC')} - Acceptable`, value: 'AC' },
          { name: `${chalk.red('🔧 SA')} - Salvage`, value: 'SA' }
        ],
        prefix: '📋'
      },
      {
        type: 'input',
        name: 'upc',
        message: chalk.bold('UPC (optional):'),
        default: '',
        prefix: '🔢'
      },
      {
        type: 'input',
        name: 'manufacturer',
        message: chalk.bold('Manufacturer (optional):'),
        default: '',
        prefix: '🏭'
      },
      {
        type: 'input',
        name: 'model',
        message: chalk.bold('Model number (optional):'),
        default: '',
        prefix: '🔤'
      },
      {
        type: 'input',
        name: 'warehouseTag',
        message: chalk.bold('Warehouse tag (optional):'),
        default: '',
        prefix: '📍',
        filter: (input: string) => {
          if (input && !input.toUpperCase().startsWith('BIN')) {
            return `BIN${input.padStart(3, '0')}`;
          }
          return input.toUpperCase();
        }
      },
      {
        type: 'input',
        name: 'notes',
        message: chalk.bold('Notes (optional):'),
        default: '',
        prefix: '📝',
        validate: (input: string, answers: { grade?: Grade }) => {
          if (answers?.grade === 'PO' && !input.trim()) {
            return 'Notes are required for PO grade';
          }
          return true;
        }
      }
    ]);

    const pidUid = answers.pidUid as string;
    const [palletId, unitId] = pidUid.split('-', 2);
    if (!palletId || !unitId) {
      console.log(chalk.yellow('PID-UID must be in the format P1-ID1.\n'));
      return;
    }
    const hasUpc = Boolean(answers.upc && String(answers.upc).trim());
    const hasManufacturer = Boolean(answers.manufacturer && String(answers.manufacturer).trim());
    const hasModel = Boolean(answers.model && String(answers.model).trim());
    if (!hasUpc && !(hasManufacturer && hasModel)) {
      console.log(chalk.yellow('Enter either a UPC or both Manufacturer + Model.\n'));
      return;
    }
    const manifest = this.manifestManager.getManifestByPalletId(palletId);
    const manifestId = manifest?.manifestId;

    // Generate SKU
    const sku = generateSKU(
      answers.grade as Grade,
      location,
      batchId,
      answers.warehouseTag || undefined
    );
    await this.batchManager.setLastSku(sku);

    // Create product record
    const product: Product = {
      grade: answers.grade as Grade,
      upc: answers.upc || undefined,
      manufacturer: answers.manufacturer || undefined,
      model: answers.model || undefined,
      warehouseTag: answers.warehouseTag || undefined,
      notes: answers.notes || undefined,
      palletId,
      unitId,
      pidUid,
      manifestId,
      sku,
      batchId,
      location,
      timestamp: new Date()
    };

    // Display product summary
    console.log('');
    const skuBox = boxen(
      chalk.bold.white(sku),
      {
        padding: 1,
        margin: { top: 0, bottom: 1 },
        borderStyle: 'double',
        borderColor: 'green',
        title: chalk.bold.green('GENERATED SKU'),
        titleAlignment: 'center'
      }
    );
    console.log(skuBox);

    const detailsTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [20, 45]
    });

    detailsTable.push(
      ...(pidUid ? [[chalk.bold('PID-UID'), chalk.magenta(pidUid)]] : []),
      ...(manifestId ? [[chalk.bold('Order #'), chalk.cyan(manifestId)]] : []),
      [chalk.bold('Grade'), `${this.getGradeEmoji(product.grade)} ${this.getGradeColor(product.grade)}`],
      [chalk.bold('Batch ID'), chalk.cyan(batchId)],
      [chalk.bold('Location'), chalk.blue(location)]
    );

    if (product.warehouseTag) {
      detailsTable.push([chalk.bold('Warehouse Tag'), chalk.magenta(product.warehouseTag)]);
    }
    if (product.upc) {
      detailsTable.push([chalk.bold('UPC'), chalk.white(product.upc)]);
    }
    if (product.manufacturer) {
      detailsTable.push([chalk.bold('Manufacturer'), chalk.white(product.manufacturer)]);
    }
    if (product.model) {
      detailsTable.push([chalk.bold('Model'), chalk.white(product.model)]);
    }
    if (product.notes) {
      detailsTable.push([chalk.bold('Notes'), chalk.white(product.notes)]);
    }

    console.log(detailsTable.toString());
    console.log('');

    // Processing steps with spinners
    const csvSpinner = ora('Saving to CSV...').start();
    await this.csvStorage.saveProduct(product);
    csvSpinner.succeed(chalk.green('Saved to CSV'));

    const labelSpinner = ora('Generating label...').start();
    const labelPath = await this.labelGenerator.generateLabel(product);
    labelSpinner.succeed(chalk.green(`Label saved: ${chalk.dim(labelPath)}`));

    // Print label
    const printSpinner = ora('Printing label...').start();
    try {
      await this.printer.print(labelPath);
      printSpinner.succeed(chalk.green(`Label printed to ${this.printer.getPrinterName()}`));
    } catch (error) {
      printSpinner.warn(chalk.yellow('Printing skipped - label saved to file'));
    }

    await this.updateMasterManifestForProduct(product);

    if (capturePhotos && pidUid && this.photoManager.isEnabled()) {
      await this.photoManager.captureForId(pidUid);
    } else if (capturePhotos) {
      if (!pidUid) {
        console.log(chalk.yellow('PID-UID is required to capture photos.'));
      } else {
        console.log(chalk.yellow('Photo step is disabled (set PHOTO_STEP=true to enable).'));
      }
    }

    // Increment batch counter and check for batch completion
    const completedBatch = await this.batchManager.incrementItem();

    // If batch completed, export it and list on eBay
    if (completedBatch !== null) {
      console.log('');
      const exportSpinner = ora(chalk.cyan(`Exporting completed batch ${completedBatch}...`)).start();
      await this.batchExporter.exportBatch(completedBatch, location);
      exportSpinner.succeed(chalk.green(`Batch ${completedBatch} (${location}) exported successfully`));

      // List batch on eBay
      const ebaySpinner = ora(chalk.cyan(`Listing batch ${completedBatch} on eBay...`)).start();
      try {
        await this.ebayIntegration.listBatchOnEbay(completedBatch, location);
        ebaySpinner.succeed(chalk.green(`Batch ${completedBatch} (${location}) listed on eBay successfully`));
      } catch (error) {
        ebaySpinner.fail(chalk.yellow(`eBay listing skipped: ${error}`));
        console.log(chalk.dim('  You can list manually later using the eBay Autolister'));
      }

      console.log('');
      console.log(boxen(
        chalk.bold.magenta(`🎉 BATCH ${completedBatch} (${location}) COMPLETE!\n\n50 items processed, exported, and listed on eBay`),
        {
          padding: 1,
          margin: { top: 0, bottom: 1 },
          borderStyle: 'double',
          borderColor: 'magenta'
        }
      ));
    }

    // Success message
    console.log('');
    console.log(boxen(
      chalk.green.bold('✓ PRODUCT PROCESSED SUCCESSFULLY'),
      {
        padding: 0,
        margin: { top: 0, bottom: 1 },
        borderStyle: 'round',
        borderColor: 'green',
        backgroundColor: 'black'
      }
    ));

    // Show remaining items
    const remaining = this.batchManager.getItemsRemainingInBatch();
    if (remaining <= 10) {
      console.log(chalk.yellow(`⚠ Only ${remaining} items remaining in current batch!\n`));
    }
  }

  async printLastSkuLabel(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ PRINT LAST SKU LABEL ━━━━━━━━\n'));

    let lastSku = this.batchManager.getLastSku();
    if (!lastSku) {
      lastSku = await this.csvStorage.getLastSku() || undefined;
      if (lastSku) {
        await this.batchManager.setLastSku(lastSku);
      }
    }

    if (!lastSku) {
      console.log(chalk.yellow('No SKU found to reprint yet.\n'));
      return;
    }

    const labelPath = path.join(process.cwd(), 'labels', `${lastSku}.png`);
    let resolvedLabelPath = labelPath;

    try {
      await fs.access(labelPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      const regenSpinner = ora('Label missing, regenerating...').start();
      resolvedLabelPath = await this.labelGenerator.generateLabelFromSku(lastSku);
      regenSpinner.succeed(chalk.green(`Label regenerated: ${chalk.dim(resolvedLabelPath)}`));
    }

    const printSpinner = ora(`Printing last label (${lastSku})...`).start();
    try {
      await this.printer.print(resolvedLabelPath);
      printSpinner.succeed(chalk.green(`Label printed to ${this.printer.getPrinterName()}`));
    } catch (error) {
      printSpinner.warn(chalk.yellow('Printing skipped - label saved to file'));
    }

    console.log('');
  }

  async deleteProduct(): Promise<void> {
    console.log(chalk.bold.red('\n━━━━━━━━ DELETE PRODUCT ━━━━━━━━\n'));

    const { sku } = await inquirer.prompt([
      {
        type: 'input',
        name: 'sku',
        message: chalk.bold('Enter SKU to delete:'),
        filter: (input: string) => input.trim(),
        prefix: '🗑️'
      }
    ]);

    if (!sku) {
      console.log(chalk.yellow('No SKU entered.\n'));
      return;
    }

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: chalk.bold.yellow(`Delete all records with SKU ${sku}?`),
        default: false,
        prefix: '⚠️'
      }
    ]);

    if (!confirm) {
      console.log(chalk.dim('Delete cancelled\n'));
      return;
    }

    const deleteSpinner = ora('Deleting product...').start();
    const deletedCount = await this.csvStorage.deleteProductBySku(sku);

    if (deletedCount === 0) {
      deleteSpinner.fail(chalk.yellow(`No records found for ${sku}`));
      console.log('');
      return;
    }

    deleteSpinner.succeed(
      chalk.green(`Deleted ${deletedCount} record${deletedCount === 1 ? '' : 's'} for ${sku}`)
    );

    const labelPath = path.join(process.cwd(), 'labels', `${sku}.png`);
    try {
      await fs.unlink(labelPath);
      console.log(chalk.dim(`Label removed: ${labelPath}`));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.log(chalk.yellow(`Label delete skipped: ${error}`));
      }
    }

    if (this.batchManager.getLastSku() === sku) {
      const updatedLastSku = await this.csvStorage.getLastSku();
      await this.batchManager.setLastSku(updatedLastSku);
    }

    console.log('');
  }

  async deleteLastProduct(): Promise<void> {
    console.log(chalk.bold.red('\n━━━━━━━━ DELETE LAST PRODUCT ━━━━━━━━\n'));

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: chalk.bold.yellow('Delete the last product record entered?'),
        default: false,
        prefix: '⚠️'
      }
    ]);

    if (!confirm) {
      console.log(chalk.dim('Delete cancelled\n'));
      return;
    }

    const deleteSpinner = ora('Deleting last product...').start();
    const result = await this.csvStorage.deleteLastProduct();

    if (!result.deleted) {
      deleteSpinner.fail(chalk.yellow('No records found to delete'));
      console.log('');
      return;
    }

    const deletedSku = result.sku || 'unknown SKU';
    deleteSpinner.succeed(chalk.green(`Deleted last record (${deletedSku})`));

    if (result.sku) {
      const labelPath = path.join(process.cwd(), 'labels', `${result.sku}.png`);
      try {
        await fs.unlink(labelPath);
        console.log(chalk.dim(`Label removed: ${labelPath}`));
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          console.log(chalk.yellow(`Label delete skipped: ${error}`));
        }
      }
    }

    await this.batchManager.setLastSku(result.remainingLastSku);

    console.log('');
  }

  private parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
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

  private truncateCell(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
  }


  private getDefaultInventoryHeaders(): string[] {
    return [
      'SKU',
      'Grade',
      'Location',
      'Batch ID',
      'Warehouse Tag',
      'UPC',
      'Manufacturer',
      'Model',
      'Notes',
      'Timestamp',
      'Manifest ID',
      'Pallet ID',
      'Unit ID',
      'PID-UID'
    ];
  }

  private getHeaderIndex(headers: string[], name: string): number | null {
    const target = name.trim().toLowerCase();
    const index = headers.findIndex(header => header.trim().toLowerCase() === target);
    return index >= 0 ? index : null;
  }

  private async loadInventoryCsv(): Promise<{ headers: string[]; rows: string[][] } | null> {
    const inventoryPath = path.join(process.cwd(), 'data', 'inventory.csv');
    let contents = '';
    try {
      contents = await fs.readFile(inventoryPath, 'utf-8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    const lines = contents.split(/\r?\n/).filter(line => line.trim() !== '');
    if (lines.length === 0) {
      return { headers: this.getDefaultInventoryHeaders(), rows: [] };
    }

    let headers = this.getDefaultInventoryHeaders();
    let startIndex = 0;
    const firstFields = this.parseCsvLine(lines[0]);
    const looksLikeHeader = firstFields.some(field => field.trim().toLowerCase() === 'sku');
    if (looksLikeHeader) {
      headers = firstFields;
      startIndex = 1;
    }

    const rows = lines.slice(startIndex).map(line => this.parseCsvLine(line));
    const normalizedRows = rows.map(row => {
      const normalized = [...row];
      while (normalized.length < headers.length) {
        normalized.push('');
      }
      return normalized;
    });

    return { headers, rows: normalizedRows };
  }

  private formatNumber(value: number, digits = 1): string {
    if (!Number.isFinite(value)) {
      return '--';
    }
    return value.toFixed(digits);
  }
  private async showCsvFile(title: string, filePath: string): Promise<void> {
    console.log(chalk.bold.cyan(`\n━━━━━━━━ ${title} ━━━━━━━━\n`));

    try {
      const contents = await fs.readFile(filePath, 'utf-8');
      if (!contents.trim()) {
        console.log(chalk.yellow('File is empty.\n'));
        return;
      }

      const lines = contents.split(/\r?\n/).filter(line => line.trim() !== '');
      const defaultHeaders = this.getDefaultInventoryHeaders();

      let headers = defaultHeaders;
      let startIndex = 0;
      const firstFields = this.parseCsvLine(lines[0]);
      const looksLikeHeader = firstFields.some(field => field.trim().toLowerCase() === 'sku');
      if (looksLikeHeader) {
        headers = firstFields;
        startIndex = 1;
      }

      const rows = lines.slice(startIndex).map(line => this.parseCsvLine(line));
      if (rows.length === 0) {
        console.log(chalk.yellow('No records found.\n'));
        return;
      }

      const normalizedRows = rows.map(row => {
        const normalized = [...row];
        while (normalized.length < headers.length) {
          normalized.push('');
        }
        return normalized;
      });

      const skuIndex = headers.findIndex(header => header.trim().toLowerCase() === 'sku');
      const gradeIndex = headers.findIndex(header => header.trim().toLowerCase() === 'grade');
      const batchIndex = headers.findIndex(header => header.trim().toLowerCase() === 'batch id');
      const locationIndex = headers.findIndex(header => header.trim().toLowerCase() === 'location');
      const timestampIndex = headers.findIndex(header => header.trim().toLowerCase() === 'timestamp');

      const lastRow = normalizedRows[normalizedRows.length - 1];
      const totalRows = normalizedRows.length;
      const lastSku = lastRow?.[skuIndex] || 'Unknown';
      const lastBatch = lastRow?.[batchIndex] || 'Unknown';
      const lastLocation = lastRow?.[locationIndex] || 'Unknown';
      const lastTimestamp = lastRow?.[timestampIndex] || 'Unknown';

      const summary = boxen(
        [
          chalk.bold.white(`${totalRows} total records`),
          chalk.cyan(`Last SKU: ${lastSku}`),
          chalk.magenta(`Last Batch: ${lastBatch}`),
          chalk.blue(`Location: ${lastLocation}`),
          chalk.dim(`Timestamp: ${lastTimestamp}`)
        ].join('\n'),
        {
          padding: 1,
          borderStyle: 'round',
          borderColor: 'cyan'
        }
      );
      console.log(summary);
      console.log('');

      const maxChoices = 50;
      const startOffset = Math.max(0, normalizedRows.length - maxChoices);
      const visibleRows = normalizedRows.slice(startOffset);

      const choices: Array<{ name: string; value: number } | inquirer.Separator> = visibleRows.map((row, idx) => {
        const number = startOffset + idx + 1;
        const sku = row[skuIndex] || 'Unknown SKU';
        const grade = row[gradeIndex] || '--';
        const batch = row[batchIndex] || '--';
        const location = row[locationIndex] || '--';
        return {
          name: `${number}. ${chalk.white(this.truncateCell(sku, 24))}  ${chalk.cyan(grade)}  ` +
            `${chalk.magenta(batch)}  ${chalk.blue(location)}`,
          value: startOffset + idx
        };
      });

      choices.push(new inquirer.Separator());
      choices.push({ name: chalk.dim('Back to menu'), value: -1 });

      const { selectedIndex } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedIndex',
          message: chalk.bold('Select a record to view details:'),
          choices,
          pageSize: Math.min(choices.length, 12),
          prefix: '📄'
        }
      ]);

      if (selectedIndex === -1) {
        console.log('');
        return;
      }

      const record = normalizedRows[selectedIndex];
      const detailsTable = new Table({
        style: { head: ['cyan'], border: ['grey'] },
        colWidths: [18, 50]
      });

      headers.forEach((header, index) => {
        const value = record[index] || '';
        if (value) {
          detailsTable.push([chalk.bold(header), chalk.white(value)]);
        }
      });

      console.log('');
      console.log(boxen(
        chalk.bold.white(`Record #${selectedIndex + 1}`),
        {
          padding: { top: 0, bottom: 0, left: 2, right: 2 },
          borderStyle: 'round',
          borderColor: 'magenta'
        }
      ));
      console.log(detailsTable.toString());
      console.log('');
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        console.log(chalk.yellow('File not found.\n'));
        return;
      }
      throw error;
    }
  }

  async viewInventoryCsv(): Promise<void> {
    const inventoryPath = path.join(process.cwd(), 'data', 'inventory.csv');
    await this.showCsvFile('INVENTORY CSV', inventoryPath);
  }

  async viewCurrentBatchCsv(): Promise<void> {
    const batchNumber = this.batchManager.getCurrentBatchNumber();
    const location = this.batchManager.getLocation();
    const batchPath = getBatchFilePath(batchNumber, location);
    await this.showCsvFile(`BATCH ${batchNumber} (${location}) CSV`, batchPath);
  }


  async showAnalyticsDashboard(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ ANALYTICS DASHBOARD ━━━━━━━━\n'));

    const inventory = await this.loadInventoryCsv();
    if (!inventory) {
      console.log(chalk.yellow('Inventory file not found.\n'));
      return;
    }

    const { headers, rows } = inventory;
    if (rows.length === 0) {
      console.log(chalk.yellow('No inventory records found.\n'));
      return;
    }

    const gradeIndex = this.getHeaderIndex(headers, 'grade') ?? 1;
    const timestampIndex = this.getHeaderIndex(headers, 'timestamp') ?? 9;

    const gradeCounts: Record<string, number> = {};
    const dateCounts = new Map<string, number>();
    let timestamped = 0;

    for (const row of rows) {
      const grade = (row[gradeIndex] || 'Unknown').trim().toUpperCase();
      gradeCounts[grade] = (gradeCounts[grade] || 0) + 1;

      const ts = row[timestampIndex];
      if (ts) {
        const date = new Date(ts);
        if (!Number.isNaN(date.getTime())) {
          const day = date.toISOString().slice(0, 10);
          dateCounts.set(day, (dateCounts.get(day) || 0) + 1);
          timestamped++;
        }
      }
    }

    const total = rows.length;
    const gradeTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [16, 12, 12]
    });
    gradeTable.push(['Grade', 'Count', 'Percent']);

    const grades = ['LN', 'VG', 'G', 'PO', 'AC', 'SA'];
    for (const grade of grades) {
      const count = gradeCounts[grade] || 0;
      const percent = total > 0 ? (count / total) * 100 : 0;
      gradeTable.push([
        grade,
        chalk.cyan(count.toString()),
        chalk.magenta(`${this.formatNumber(percent)}%`)
      ]);
    }

    const otherCount = Object.entries(gradeCounts)
      .filter(([grade]) => !grades.includes(grade))
      .reduce((sum, [, count]) => sum + count, 0);
    if (otherCount > 0) {
      const percent = total > 0 ? (otherCount / total) * 100 : 0;
      gradeTable.push(['Other', chalk.cyan(otherCount.toString()), chalk.magenta(`${this.formatNumber(percent)}%`)]);
    }

    console.log(chalk.bold('Grade Breakdown'));
    console.log(gradeTable.toString());
    console.log('');

    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const dayMs = 24 * 60 * 60 * 1000;
    let last7 = 0;
    let last30 = 0;
    let monthTotal = 0;

    for (const [day, count] of dateCounts.entries()) {
      const date = new Date(`${day}T00:00:00Z`);
      const diffDays = Math.floor((startOfToday.getTime() - date.getTime()) / dayMs);
      if (diffDays >= 0 && diffDays < 7) {
        last7 += count;
      }
      if (diffDays >= 0 && diffDays < 30) {
        last30 += count;
      }
      if (date.getUTCFullYear() === today.getUTCFullYear() && date.getUTCMonth() === today.getUTCMonth()) {
        monthTotal += count;
      }
    }

    const throughputTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [22, 16]
    });
    throughputTable.push(
      ['Total items', chalk.cyan(total.toString())],
      ['Timestamped items', chalk.cyan(timestamped.toString())],
      ['Last 7 days', chalk.cyan(last7.toString())],
      ['Last 30 days', chalk.cyan(last30.toString())],
      ['This month', chalk.cyan(monthTotal.toString())],
      ['Avg/day (7d)', chalk.magenta(this.formatNumber(last7 / 7))],
      ['Avg/day (30d)', chalk.magenta(this.formatNumber(last30 / 30))]
    );

    console.log(chalk.bold('Throughput Summary'));
    console.log(throughputTable.toString());
    console.log('');

    const { runCalculator } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'runCalculator',
        message: chalk.bold('Run profit/cost calculator?'),
        default: false,
        prefix: '🧮'
      }
    ]);

    if (runCalculator) {
      await this.runProfitCalculator();
    }
  }

  async runProfitCalculator(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ PROFIT CALCULATOR ━━━━━━━━\n'));

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'avgSellPrice',
        message: chalk.bold('Average sell price per unit:'),
        prefix: '💰',
        filter: (input: string) => input.trim()
      },
      {
        type: 'input',
        name: 'feesShipping',
        message: chalk.bold('Fees + shipping per unit:'),
        prefix: '📦',
        filter: (input: string) => input.trim(),
        default: '0'
      },
      {
        type: 'input',
        name: 'cogs',
        message: chalk.bold('COGS per unit:'),
        prefix: '🧾',
        filter: (input: string) => input.trim(),
        default: '0'
      },
      {
        type: 'input',
        name: 'variableLabor',
        message: chalk.bold('Variable labor per unit:'),
        prefix: '👷',
        filter: (input: string) => input.trim(),
        default: '0'
      },
      {
        type: 'input',
        name: 'fixedMonthly',
        message: chalk.bold('Fixed monthly costs:'),
        prefix: '🏢',
        filter: (input: string) => input.trim(),
        default: '0'
      },
      {
        type: 'input',
        name: 'unitsPerMonth',
        message: chalk.bold('Units per month:'),
        prefix: '🔢',
        filter: (input: string) => input.trim()
      }
    ]);

    const avgSell = Number.parseFloat(answers.avgSellPrice);
    const fees = Number.parseFloat(answers.feesShipping);
    const cogs = Number.parseFloat(answers.cogs);
    const labor = Number.parseFloat(answers.variableLabor);
    const fixed = Number.parseFloat(answers.fixedMonthly);
    const units = Number.parseInt(answers.unitsPerMonth, 10);

    if (!Number.isFinite(avgSell) || !Number.isFinite(units)) {
      console.log(chalk.yellow('Please enter valid numbers for sell price and units.\n'));
      return;
    }

    const marginalCost = fees + cogs + labor;
    const marginPerUnit = avgSell - marginalCost;
    const totalNet = (marginPerUnit * units) - (Number.isFinite(fixed) ? fixed : 0);
    const breakEvenUnits = marginPerUnit > 0 && Number.isFinite(fixed)
      ? Math.ceil(fixed / marginPerUnit)
      : null;

    const calcTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [26, 20]
    });

    calcTable.push(
      ['Avg sell price', `$${this.formatNumber(avgSell, 2)}`],
      ['Marginal cost/unit', `$${this.formatNumber(marginalCost, 2)}`],
      ['Margin per unit', `$${this.formatNumber(marginPerUnit, 2)}`],
      ['Units per month', units.toString()],
      ['Fixed monthly costs', `$${this.formatNumber(Number.isFinite(fixed) ? fixed : 0, 2)}`],
      ['Estimated net', `$${this.formatNumber(totalNet, 2)}`],
      ['Break-even units', breakEvenUnits ? breakEvenUnits.toString() : 'N/A']
    );

    console.log(calcTable.toString());
    console.log('');
  }

  async runAuctionBidModeler(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ AUCTION BID MODELER ━━━━━━━━\n'));

    const defaultBands = [
      { label: 'Home Run', hammerBidPct: 0.03 },
      { label: 'Strong/Scalable', hammerBidPct: 0.04 },
      { label: 'Acceptable/Faster Turns', hammerBidPct: 0.05 },
      { label: 'Thin/Edge', hammerBidPct: 0.06 }
    ];

    const lotAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'msrpTotal',
        message: chalk.bold('MSRP total (USD):'),
        prefix: '💰',
        filter: (input: string) => input.trim()
      },
      {
        type: 'input',
        name: 'unitsTotal',
        message: chalk.bold('Total units:'),
        prefix: '📦',
        filter: (input: string) => input.trim()
      }
    ]);

    const msrpTotal = Number.parseFloat(lotAnswers.msrpTotal);
    const unitsTotal = Number.parseInt(lotAnswers.unitsTotal, 10);

    if (!Number.isFinite(msrpTotal) || msrpTotal <= 0 || !Number.isFinite(unitsTotal) || unitsTotal <= 0) {
      console.log(chalk.yellow('Please enter valid MSRP and unit counts.\n'));
      return;
    }

    const assumptionAnswers = await inquirer.prompt<{
      sellThroughRate: string;
      salePricePct: string;
      platformFeeRate: string;
      shippingPerUnit: string;
      laborMode: 'hourly' | 'profit_share' | 'none';
      hourlyRate?: string;
      minutesPerUnit?: string;
      profitShareRate?: string;
      inboundMultiplier: string;
      recommendedRoiFloor: string;
      useDefaultBands: boolean;
    }>([
      {
        type: 'input',
        name: 'sellThroughRate',
        message: chalk.bold('Sell-through rate (0-1):'),
        prefix: '📈',
        filter: (input: string) => input.trim(),
        default: '0.7'
      },
      {
        type: 'input',
        name: 'salePricePct',
        message: chalk.bold('Avg sale price % of MSRP (0-1):'),
        prefix: '🏷️',
        filter: (input: string) => input.trim(),
        default: '0.5'
      },
      {
        type: 'input',
        name: 'platformFeeRate',
        message: chalk.bold('Platform fee rate (0-1):'),
        prefix: '🧾',
        filter: (input: string) => input.trim(),
        default: '0.13'
      },
      {
        type: 'input',
        name: 'shippingPerUnit',
        message: chalk.bold('Shipping cost per sold unit (USD):'),
        prefix: '🚚',
        filter: (input: string) => input.trim(),
        default: '15'
      },
      {
        type: 'list',
        name: 'laborMode',
        message: chalk.bold('Labor cost model:'),
        choices: [
          { name: 'Hourly', value: 'hourly' },
          { name: 'Profit share', value: 'profit_share' },
          { name: 'None', value: 'none' }
        ],
        default: 'hourly',
        prefix: '👷'
      },
      {
        type: 'input',
        name: 'hourlyRate',
        message: chalk.bold('Hourly labor rate (USD):'),
        prefix: '💵',
        filter: (input: string) => input.trim(),
        default: '20',
        when: (answers: { laborMode: string }) => answers.laborMode === 'hourly'
      },
      {
        type: 'input',
        name: 'minutesPerUnit',
        message: chalk.bold('Minutes per sold unit:'),
        prefix: '⏱️',
        filter: (input: string) => input.trim(),
        default: '10',
        when: (answers: { laborMode: string }) => answers.laborMode === 'hourly'
      },
      {
        type: 'input',
        name: 'profitShareRate',
        message: chalk.bold('Profit share rate (0-1):'),
        prefix: '🤝',
        filter: (input: string) => input.trim(),
        default: '0.3',
        when: (answers: { laborMode: string }) => answers.laborMode === 'profit_share'
      },
      {
        type: 'input',
        name: 'inboundMultiplier',
        message: chalk.bold('Inbound shipping multiplier on hammer:'),
        prefix: '🚛',
        filter: (input: string) => input.trim(),
        default: '2.0'
      },
      {
        type: 'input',
        name: 'recommendedRoiFloor',
        message: chalk.bold('Recommended ROI floor (multiple):'),
        prefix: '🎯',
        filter: (input: string) => input.trim(),
        default: '2.0'
      },
      {
        type: 'confirm',
        name: 'useDefaultBands',
        message: chalk.bold('Use default bid bands (3%, 4%, 5%, 6% of MSRP)?'),
        default: true,
        prefix: '📊'
      }
    ]);

    const sellThroughRate = Number.parseFloat(assumptionAnswers.sellThroughRate);
    const salePricePct = Number.parseFloat(assumptionAnswers.salePricePct);
    const platformFeeRate = Number.parseFloat(assumptionAnswers.platformFeeRate);
    const shippingPerUnit = Number.parseFloat(assumptionAnswers.shippingPerUnit);
    const inboundMultiplier = Number.parseFloat(assumptionAnswers.inboundMultiplier);
    const recommendedRoiFloor = Number.parseFloat(assumptionAnswers.recommendedRoiFloor);
    const laborMode = assumptionAnswers.laborMode as 'hourly' | 'profit_share' | 'none';
    const hourlyRate = Number.parseFloat(assumptionAnswers.hourlyRate ?? '0');
    const minutesPerUnit = Number.parseFloat(assumptionAnswers.minutesPerUnit ?? '0');
    const profitShareRate = Number.parseFloat(assumptionAnswers.profitShareRate ?? '0');

    const validationFailed = (
      !Number.isFinite(sellThroughRate) || sellThroughRate < 0 || sellThroughRate > 1 ||
      !Number.isFinite(salePricePct) || salePricePct < 0 || salePricePct > 1 ||
      !Number.isFinite(platformFeeRate) || platformFeeRate < 0 || platformFeeRate > 1 ||
      !Number.isFinite(shippingPerUnit) || shippingPerUnit < 0 ||
      !Number.isFinite(inboundMultiplier) || inboundMultiplier < 1 ||
      !Number.isFinite(recommendedRoiFloor) || recommendedRoiFloor < 0 ||
      (laborMode === 'hourly' && (!Number.isFinite(hourlyRate) || hourlyRate < 0)) ||
      (laborMode === 'hourly' && (!Number.isFinite(minutesPerUnit) || minutesPerUnit < 0)) ||
      (laborMode === 'profit_share' && (!Number.isFinite(profitShareRate) || profitShareRate < 0 || profitShareRate > 1))
    );

    if (validationFailed) {
      console.log(chalk.yellow('Inputs must follow the validation rules (0-1 rates, non-negative costs, inbound multiplier >= 1).\n'));
      return;
    }

    let bidBands = defaultBands;
    if (!assumptionAnswers.useDefaultBands) {
      const customBandAnswers = await inquirer.prompt(
        defaultBands.flatMap((band, idx) => [
          {
            type: 'input',
            name: `bandLabel${idx}`,
            message: chalk.bold(`Band ${idx + 1} label:`),
            prefix: '🏷️',
            filter: (input: string) => input.trim(),
            default: band.label
          },
          {
            type: 'input',
            name: `bandPct${idx}`,
            message: chalk.bold(`Band ${idx + 1} hammer bid % of MSRP (0-1):`),
            prefix: '📊',
            filter: (input: string) => input.trim(),
            default: band.hammerBidPct.toString()
          }
        ])
      );

      bidBands = defaultBands.map((band, idx) => {
        const label = String(customBandAnswers[`bandLabel${idx}`] ?? band.label).trim() || band.label;
        const pct = Number.parseFloat(customBandAnswers[`bandPct${idx}`]);
        return {
          label,
          hammerBidPct: Number.isFinite(pct) && pct >= 0 ? pct : band.hammerBidPct
        };
      });
    }

    const unitsSellable = Math.round(unitsTotal * sellThroughRate);
    const msrpSellable = msrpTotal * sellThroughRate;
    const grossRevenue = msrpSellable * salePricePct;
    const platformFees = grossRevenue * platformFeeRate;
    const shippingOutbound = unitsSellable * shippingPerUnit;

    let laborCost = 0;
    if (laborMode === 'hourly') {
      laborCost = unitsSellable * (minutesPerUnit / 60) * hourlyRate;
    }

    if (sellThroughRate < 0.5) {
      console.log(chalk.yellow('Warning: Sell-through under 50% is extreme; consider lowering bid bands.'));
    }
    if (laborMode === 'hourly' && minutesPerUnit > 20) {
      console.log(chalk.yellow('Warning: Labor time > 20 min/unit usually compresses margins.'));
    }
    console.log('');

    const formatMoney = (value: number) => `$${this.formatNumber(value, 2)}`;
    const formatPct = (value: number, digits = 1) => `${this.formatNumber(value * 100, digits)}%`;

    const inputTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [34, 24]
    });
    inputTable.push(
      ['MSRP total', formatMoney(msrpTotal)],
      ['Total units', unitsTotal.toString()],
      ['Sell-through rate', formatPct(sellThroughRate, 1)],
      ['Sale price % of MSRP', formatPct(salePricePct, 1)],
      ['Platform fee rate', formatPct(platformFeeRate, 1)],
      ['Shipping cost per sold unit', formatMoney(shippingPerUnit)],
      ['Labor mode', laborMode],
      ['Hourly rate', laborMode === 'hourly' ? formatMoney(hourlyRate) : '--'],
      ['Minutes per sold unit', laborMode === 'hourly' ? this.formatNumber(minutesPerUnit, 1) : '--'],
      ['Profit share rate', laborMode === 'profit_share' ? formatPct(profitShareRate, 1) : '--'],
      ['Inbound shipping multiplier', this.formatNumber(inboundMultiplier, 2)]
    );

    console.log(chalk.bold('Inputs Summary'));
    console.log(inputTable.toString());
    console.log('');

    const forecastTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [26, 24]
    });
    forecastTable.push(
      ['Units sellable', unitsSellable.toString()],
      ['Gross revenue', formatMoney(grossRevenue)],
      ['Platform fees', formatMoney(platformFees)],
      ['Outbound shipping', formatMoney(shippingOutbound)],
      ['Labor cost', formatMoney(laborCost)]
    );

    console.log(chalk.bold('Core Forecast'));
    console.log(forecastTable.toString());
    console.log('');

    const bandTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [22, 12, 16, 16, 18, 14]
    });
    bandTable.push([
      'Band',
      '% MSRP',
      'Hammer bid',
      'All-in cost',
      'Net profit',
      'ROI %'
    ]);

    const bandResults = bidBands.map(band => {
      const hammerBidUsd = msrpTotal * band.hammerBidPct;
      const allInCostUsd = hammerBidUsd * inboundMultiplier;
      const netProfitPrePartner = grossRevenue - platformFees - shippingOutbound - laborCost - allInCostUsd;
      const partnerCut = laborMode === 'profit_share'
        ? Math.max(0, netProfitPrePartner) * profitShareRate
        : 0;
      const netProfitToYou = netProfitPrePartner - partnerCut;
      const roiMultiple = allInCostUsd > 0 ? netProfitToYou / allInCostUsd : 0;
      const roiPercent = roiMultiple * 100;
      const breakevenSalePct = msrpSellable > 0
        ? (shippingOutbound + laborCost + allInCostUsd) / (msrpSellable * (1 - platformFeeRate))
        : 0;

      return {
        label: band.label,
        hammerBidPct: band.hammerBidPct,
        hammerBidUsd,
        allInCostUsd,
        netProfitToYou,
        roiMultiple,
        roiPercent,
        breakevenSalePct
      };
    }).sort((a, b) => a.hammerBidPct - b.hammerBidPct);

    for (const band of bandResults) {
      bandTable.push([
        band.label,
        formatPct(band.hammerBidPct, 1),
        formatMoney(band.hammerBidUsd),
        formatMoney(band.allInCostUsd),
        formatMoney(band.netProfitToYou),
        `${this.formatNumber(band.roiPercent, 1)}%`
      ]);
    }

    console.log(chalk.bold('Bid Bands'));
    console.log(bandTable.toString());
    console.log('');

    const eligible = bandResults.filter(band => band.netProfitToYou > 0 && band.roiMultiple >= recommendedRoiFloor);
    const recommended = eligible.length ? eligible[eligible.length - 1] : null;

    if (recommended) {
      const recommendationBox = boxen(
        `${chalk.bold('Recommended band')}: ${chalk.cyan(recommended.label)}\n` +
          `${chalk.bold('Hammer bid cap')}: ${chalk.cyan(formatMoney(recommended.hammerBidUsd))}\n` +
          `${chalk.bold('All-in cost')}: ${chalk.cyan(formatMoney(recommended.allInCostUsd))}\n` +
          `${chalk.bold('ROI')}: ${chalk.cyan(this.formatNumber(recommended.roiMultiple, 2))}x`,
        {
          padding: 1,
          borderStyle: 'round',
          borderColor: 'green'
        }
      );
      console.log(chalk.bold('Recommendation'));
      console.log(recommendationBox);
      console.log('');
    } else {
      console.log(chalk.bold('Recommendation'));
      console.log(chalk.red('NO BID - no band meets ROI floor or positive profit.\n'));

      const breakevenTable = new Table({
        style: { head: ['cyan'], border: ['grey'] },
        colWidths: [22, 24]
      });
      breakevenTable.push(['Band', 'Breakeven sale % of MSRP']);
      for (const band of bandResults) {
        breakevenTable.push([band.label, formatPct(band.breakevenSalePct, 1)]);
      }
      console.log(breakevenTable.toString());
      console.log('');
    }
  }

  async runEbayCompsManifestAnalyzer(): Promise<void> {
    await loadDotEnv();
    await this.ebayCompsManifestAnalyzer.run();
  }

  async receiveManifest(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ RECEIVE MANIFEST ━━━━━━━━\n'));

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'manifestId',
        message: chalk.bold('Order #:'),
        prefix: '📦',
        filter: (input: string) => input.trim().toUpperCase(),
        validate: (input: string) => input.trim() !== '' || 'Order # is required'
      },
      {
        type: 'input',
        name: 'unitCount',
        message: chalk.bold('Total units in manifest:'),
        prefix: '🔢',
        filter: (input: string) => input.trim()
      }
    ]);

    const unitCount = Number.parseInt(answers.unitCount, 10);
    if (!Number.isFinite(unitCount) || unitCount <= 0) {
      console.log(chalk.yellow('Invalid unit count.\n'));
      return;
    }

    const auctionData = await this.lookupAuctionForManifest(answers.manifestId);
    const record = await this.manifestManager.createManifest(
      answers.manifestId,
      unitCount,
      auctionData || undefined,
      this.batchManager.getLocation()
    );
    const pid = record.palletId;

    const summaryLines = [
      chalk.bold.white(`Order ${record.manifestId}`),
      chalk.cyan(`Pallet ID: ${pid}`),
      chalk.magenta(`Units: ${record.unitCount}`)
    ];
    if (record.auctionTitle) {
      summaryLines.push(chalk.white(`Auction: ${record.auctionTitle}`));
    }
    if (record.lotPriceValue !== undefined && record.lotPriceValue !== null) {
      summaryLines.push(chalk.green(`Lot Price: $${this.formatNumber(record.lotPriceValue, 2)}`));
    }

    const summary = boxen(
      summaryLines.join('\n'),
      {
        padding: 1,
        borderStyle: 'round',
        borderColor: 'magenta'
      }
    );
    console.log(summary);
    console.log('');

    const { confirmPrint } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmPrint',
        message: chalk.bold('Generate and print PID-UID labels now?'),
        default: true,
        prefix: '🖨️'
      }
    ]);

    if (!confirmPrint) {
      console.log(chalk.dim('Label generation skipped\n'));
      return;
    }

    const labelSpinner = ora(chalk.cyan('Generating PID-UID labels...')).start();
    const pidUids = Array.from({ length: unitCount }, (_, i) =>
      `${pid}-ID${i + 1}`
    );
    const labelPaths: string[] = [];

    for (const pidUid of pidUids) {
      const labelPath = await this.labelGenerator.generatePidUidLabel(pidUid, record.manifestId);
      labelPaths.push(labelPath);
    }

    labelSpinner.succeed(chalk.green(`Generated ${labelPaths.length} labels`));

    const printSpinner = ora(chalk.cyan('Printing labels...')).start();
    try {
      for (const labelPath of labelPaths) {
        await this.printer.print(labelPath);
      }
      printSpinner.succeed(chalk.green(`Printed ${labelPaths.length} labels`));
    } catch (error) {
      printSpinner.warn(chalk.yellow('Printing skipped - labels saved to file'));
    }

    console.log('');
  }

  private getPhotoWatcherPidFile(): string {
    return path.join(process.cwd(), 'data', 'photo-intake', 'watcher.pid');
  }

  private async runPrinterSetupWizard(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ PRINTER SETUP ━━━━━━━━\n'));

    const detectSpinner = ora(chalk.cyan('Detecting printers...')).start();
    await this.printer.initialize();
    const printers = await this.printer.listPrinters();
    detectSpinner.stop();

    if (printers.length === 0) {
      console.log(chalk.yellow('No printers detected on this machine.\n'));
      return;
    }

    const detected = this.printer.getPrinterName();
    const choices = printers.map(name => ({
      name: detected === name ? `${name} ${chalk.dim('(detected)')}` : name,
      value: name
    }));

    const { selectedPrinter } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedPrinter',
        message: chalk.bold('Select printer to use for labels:'),
        choices,
        default: detected ?? printers[0],
        prefix: '🖨️'
      }
    ]);

    const saveSpinner = ora(chalk.cyan('Saving printer configuration...')).start();
    await this.printer.saveConfiguredPrinter(selectedPrinter);
    this.printer.setPrinterName(selectedPrinter);
    saveSpinner.succeed(chalk.green(`Printer set to ${selectedPrinter}`));

    console.log(chalk.dim('Label size defaults to 2" x 1" (51x25mm).'));
    console.log('');
  }

  private async updateMasterManifestForProduct(product: Product): Promise<void> {
    if (!product.manifestId) {
      return;
    }

    try {
      const result = await updateMasterManifestForProduct({
        manifestId: product.manifestId,
        upc: product.upc,
        manufacturer: product.manufacturer,
        model: product.model
      });

      if (result.updated) {
        const label = result.manifestPath ? path.basename(result.manifestPath) : 'master manifest';
        const row = result.matchedRow ? ` (row ${result.matchedRow})` : '';
        console.log(chalk.green(`Master manifest updated: ${label}${row}`));
      } else if (result.reason === 'manifest_not_found') {
        console.log(chalk.yellow(`Master manifest not found for order ${product.manifestId}.`));
      } else if (result.reason === 'missing_match_fields') {
        console.log(chalk.yellow('Master manifest update skipped (need UPC or Manufacturer + Model).'));
      } else if (result.reason === 'no_match') {
        console.log(chalk.yellow('No matching row found in master manifest.'));
      }
    } catch (error) {
      console.log(chalk.yellow('Failed to update master manifest.'));
    }
  }

  async runGoogleSheetSync(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ GOOGLE SHEET SYNC ━━━━━━━━\n'));
    const spinner = ora(chalk.cyan('Syncing batch tabs + master manifests...')).start();
    try {
      const result = await syncGoogleSheet();
      spinner.succeed(chalk.green(`Synced ${result.updatedTabs.length} tab(s)`));
    } catch (error) {
      spinner.fail(chalk.red('Google Sheet sync failed'));
      console.log(chalk.yellow(String(error)));
    }
    console.log('');
  }

  private async syncTechLiquidatorsWatchlist(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ TECHLIQUIDATORS WATCHLIST ━━━━━━━━\n'));

    const syncSpinner = ora(chalk.cyan('Syncing watchlist from TechLiquidators...')).start();
    try {
      const payload = await this.techLiquidatorsIntegration.syncWatchlist();
      const count = payload?.items?.length ?? 0;
      syncSpinner.succeed(chalk.green(`Watchlist synced (${count} items)`));
    } catch (error) {
      syncSpinner.fail(chalk.red('Watchlist sync failed'));
      console.log(chalk.yellow(String(error)));
      console.log('');
      return;
    }

    const analyzeSpinner = ora(chalk.cyan('Analyzing manifests...')).start();
    const results = await this.techLiquidatorsIntegration.analyzeWatchlist();
    if (!results.length) {
      analyzeSpinner.warn(chalk.yellow('No watchlist items available for analysis'));
      console.log('');
      return;
    }
    analyzeSpinner.succeed(chalk.green(`Analyzed ${results.length} items`));

    const formatMoney = (value?: number) =>
      typeof value === 'number' ? `$${value.toFixed(2)}` : 'n/a';
    const formatPercent = (value?: number) =>
      typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'n/a';

    const table = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [14, 7, 10, 10, 10, 10, 12, 28]
    });

    table.push([
      chalk.cyan('Auction ID'),
      chalk.cyan('Decision'),
      chalk.cyan('Cost'),
      chalk.cyan('Resale'),
      chalk.cyan('Profit'),
      chalk.cyan('Margin'),
      chalk.cyan('AI'),
      chalk.cyan('Title')
    ]);

    for (const result of results) {
      const decisionColor = result.decision === 'PASS' ? chalk.green : chalk.red;
      const aiDecision = result.aiDecision ? result.aiDecision : 'n/a';
      table.push([
        result.auctionId,
        decisionColor(result.decision),
        formatMoney(result.costBasis),
        formatMoney(result.estimatedResaleValue),
        formatMoney(result.estimatedProfit),
        formatPercent(result.estimatedMargin),
        aiDecision,
        result.title || ''
      ]);
    }

    console.log('');
    console.log(table.toString());
    console.log('');
  }

  private formatDuration(ms: number): string {
    const totalMinutes = Math.max(Math.round(ms / 60000), 0);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const parts: string[] = [];
    if (days > 0) {
      parts.push(`${days}d`);
    }
    if (hours > 0 || days > 0) {
      parts.push(`${hours}h`);
    }
    parts.push(`${minutes}m`);
    return parts.join(' ');
  }

  private formatEndTime(value: Date): string {
    return value.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  async showTechLiquidatorsAlerts(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ TECHLIQUIDATORS ALERTS ━━━━━━━━\n'));

    const notify =
      this.readBooleanEnv('TECHLIQUIDATORS_ALERT_NOTIFY') ||
      process.argv.map(arg => arg.toLowerCase()).includes('--notify');

    const syncSpinner = ora(chalk.cyan('Syncing watchlist for alerts...')).start();
    try {
      const payload = await this.techLiquidatorsIntegration.syncWatchlist();
      const count = payload?.items?.length ?? 0;
      syncSpinner.succeed(chalk.green(`Watchlist synced (${count} items)`));
    } catch (error) {
      syncSpinner.warn(chalk.yellow('Watchlist sync failed, using cached data'));
      console.log(chalk.dim(String(error)));
    }

    const bidsSpinner = ora(chalk.cyan('Syncing My Bids for alerts...')).start();
    try {
      const payload = await this.techLiquidatorsIntegration.syncBids();
      const count = payload?.items?.length ?? 0;
      bidsSpinner.succeed(chalk.green(`My Bids synced (${count} items)`));
    } catch (error) {
      bidsSpinner.warn(chalk.yellow('My Bids sync failed, using cached data'));
      console.log(chalk.dim(String(error)));
    }

    const now = new Date();
    const { windowHours, graceMinutes } = this.techLiquidatorsIntegration.getAlertConfig();
    const alerts = await this.techLiquidatorsIntegration.getCombinedAlerts({ now });

    if (!alerts.length) {
      console.log(chalk.green(`No auctions ending within ${windowHours}h.`));
      console.log('');
      return;
    }

    if (notify) {
      await this.sendTechLiquidatorsNotifications(alerts);
    }

    const urgentMs = 30 * 60 * 1000;
    const warnMs = 2 * 60 * 60 * 1000;

    const table = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [12, 10, 16, 20, 12, 36]
    });

    table.push([
      chalk.cyan('Auction ID'),
      chalk.cyan('Source'),
      chalk.cyan('Ends In'),
      chalk.cyan('End Time'),
      chalk.cyan('Bid/Price'),
      chalk.cyan('Title')
    ]);

    let endedCount = 0;
    for (const alert of alerts) {
      const remaining = alert.millisRemaining;
      const isEnded = remaining <= 0;
      if (isEnded) {
        endedCount += 1;
      }
      const durationText = this.formatDuration(Math.abs(remaining));
      const endsInText = isEnded ? `Ended ${durationText} ago` : durationText;
      const coloredEndsIn = isEnded
        ? chalk.red(endsInText)
        : remaining <= urgentMs
          ? chalk.red(endsInText)
          : remaining <= warnMs
            ? chalk.yellow(endsInText)
            : chalk.green(endsInText);

      const bidValue =
        typeof alert.currentBid === 'number' && alert.currentBid > 0
          ? alert.currentBid
          : typeof alert.lotPrice === 'number' && alert.lotPrice > 0
            ? alert.lotPrice
            : undefined;
      const bidText = typeof bidValue === 'number' ? `$${bidValue.toFixed(2)}` : 'n/a';
      const sourceText = alert.sources.includes('watchlist') && alert.sources.includes('bids')
        ? 'Both'
        : alert.sources.includes('watchlist')
          ? 'Watchlist'
          : 'Bids';

      table.push([
        alert.auctionId,
        sourceText,
        coloredEndsIn,
        this.formatEndTime(alert.endTime),
        bidText,
        alert.title || ''
      ]);
    }

    console.log('');
    console.log(table.toString());
    console.log('');
    console.log(
      chalk.dim(
        `Showing auctions ending within ${windowHours}h (grace: ${graceMinutes}m). Ended: ${endedCount}.`
      )
    );
    if (!notify) {
      console.log(chalk.dim('Tip: run with --notify or set TECHLIQUIDATORS_ALERT_NOTIFY=true to send desktop alerts.'));
    }
    console.log('');
  }

  private readBooleanEnv(name: string): boolean {
    const value = process.env[name];
    if (!value) {
      return false;
    }
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }

  private getNotifyWindowMinutes(): number {
    const raw = process.env.TECHLIQUIDATORS_ALERT_NOTIFY_MINUTES;
    if (!raw) {
      return 60;
    }
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : 60;
  }

  private getNotifyMaxCount(): number {
    const raw = process.env.TECHLIQUIDATORS_ALERT_NOTIFY_MAX;
    if (!raw) {
      return 5;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : 5;
  }

  private escapeAppleScript(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private async sendTechLiquidatorsNotifications(alerts: Array<{
    auctionId: string;
    title?: string;
    url?: string;
    endTime: Date;
    millisRemaining: number;
    sources: Array<'watchlist' | 'bids'>;
  }>): Promise<void> {
    if (process.platform !== 'darwin') {
      console.log(chalk.yellow('Desktop notifications are only supported on macOS.'));
      return;
    }

    const notifyWindowMs = this.getNotifyWindowMinutes() * 60 * 1000;
    const maxCount = this.getNotifyMaxCount();
    const activeAlerts = alerts
      .filter(alert => alert.millisRemaining > 0 && alert.millisRemaining <= notifyWindowMs)
      .slice(0, maxCount);

    if (!activeAlerts.length) {
      return;
    }

    for (const alert of activeAlerts) {
      const title = `TL Auction ${alert.auctionId}`;
      const endsIn = this.formatDuration(alert.millisRemaining);
      const sourceText =
        alert.sources.includes('watchlist') && alert.sources.includes('bids')
          ? 'watchlist + bids'
          : alert.sources.includes('watchlist')
            ? 'watchlist'
            : 'bids';
      const body = `${alert.title || 'Auction'} • ends in ${endsIn} • ${sourceText}`;
      const script = `display notification "${this.escapeAppleScript(body)}" with title "${this.escapeAppleScript(title)}"`;

      await new Promise<void>(resolve => {
        const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
        child.on('close', () => resolve());
      });
    }
  }

  private async buildInventoryHub(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ BUILD INVENTORY HUB ━━━━━━━━\n'));

    const root = await this.findProjectRoot(process.cwd());
    if (!root) {
      console.log(chalk.yellow('Project root not found. Run from the UPSCALED workspace.\n'));
      return;
    }

    const scriptPath = path.join(
      root,
      '08_AUTOMATION',
      'CLI_Tools',
      'auction_scraper',
      'build_master_manifest.py'
    );

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const spinner = ora(chalk.cyan('Building inventory hub...')).start();

    await new Promise<void>((resolve) => {
      const child = spawn(pythonCmd, [scriptPath], { stdio: 'ignore' });
      child.on('close', (code) => {
        if (code === 0) {
          spinner.succeed(chalk.green('Inventory hub updated'));
        } else {
          spinner.fail(chalk.yellow('Inventory hub build failed'));
        }
        resolve();
      });
    });

    console.log('');
  }

  private async lookupAuctionForManifest(manifestId: string): Promise<Partial<ManifestRecord> | null> {
    const normalized = manifestId.trim().toUpperCase();
    const root = await this.findProjectRoot(process.cwd());
    if (!root) {
      return null;
    }
    const auctionsRoot = path.join(root, '01_SOURCING', 'Auctions');
    const indexFiles = await this.findIndexFiles(auctionsRoot);

    for (const indexPath of indexFiles) {
      let data = '';
      try {
        data = await fs.readFile(indexPath, 'utf-8');
      } catch {
        continue;
      }
      const lines = data.split(/\r?\n/).filter(line => line.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const auctionId = String(entry.auction_id || entry.lot_id || '').toUpperCase();
          const manifestUrl = String(entry.manifest_url || '').toUpperCase();
          if (!auctionId && !manifestUrl) {
            continue;
          }
          if (auctionId === normalized || manifestUrl.includes(normalized)) {
            return {
              auctionId: entry.auction_id || entry.lot_id,
              auctionTitle: entry.title,
              auctionUrl: entry.url,
              manifestUrl: entry.manifest_url,
              lotPriceValue: entry.lot_price_value,
              currentBidValue: entry.current_bid_value,
              msrpValue: entry.msrp_value,
              retailValue: entry.retail_value_value,
              itemsCountValue: entry.items_count_value,
              condition: entry.condition,
              warehouse: entry.warehouse,
              auctionEnd: entry.auction_end,
              sourceSite: entry.site,
              sourceYear: this.extractYear(indexPath),
              sourcePath: indexPath
            };
          }
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  private async findProjectRoot(start: string): Promise<string | null> {
    let current = path.resolve(start);
    while (true) {
      const candidate = path.join(current, '01_SOURCING');
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          return current;
        }
      } catch {
        // keep walking
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return null;
  }

  private async findIndexFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
          const nested = await this.findIndexFiles(fullPath);
          results.push(...nested);
        } else if (entry.isFile() && entry.name === 'index.jsonl') {
          results.push(fullPath);
        }
      }
    } catch {
      return results;
    }
    return results;
  }

  private extractYear(value: string): string | undefined {
    const match = value.match(/\\b(20\\d{2})\\b/);
    return match ? match[1] : undefined;
  }

  async startPhotoWatcher(options?: { quiet?: boolean }): Promise<{ started: boolean }> {
    const quiet = options?.quiet === true;
    if (!quiet) {
      console.log(chalk.bold.cyan('\n━━━━━━━━ START PHOTO WATCHER ━━━━━━━━\n'));
    }

    const pidFile = this.getPhotoWatcherPidFile();
    await fs.mkdir(path.dirname(pidFile), { recursive: true });

    try {
      const existing = await fs.readFile(pidFile, 'utf-8');
      if (existing.trim()) {
        if (!quiet) {
          console.log(chalk.yellow('Photo watcher already running.\n'));
        }
        return { started: false };
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    const scriptPath = path.join(process.cwd(), 'dist', 'photoWatcher.js');
    const child = spawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: 'ignore'
    });

    child.unref();
    await fs.writeFile(pidFile, String(child.pid));

    if (!quiet) {
      console.log(chalk.green(`Photo watcher started (PID ${child.pid}).`));
      console.log(chalk.dim(`Watching: ${this.photoManager.getIntakeDir()}\n`));
    }

    return { started: true };
  }

  async stopPhotoWatcher(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ STOP PHOTO WATCHER ━━━━━━━━\n'));

    const pidFile = this.getPhotoWatcherPidFile();
    let pid = '';
    try {
      pid = (await fs.readFile(pidFile, 'utf-8')).trim();
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        console.log(chalk.yellow('No photo watcher PID file found.\n'));
        return;
      }
      throw error;
    }

    if (!pid) {
      console.log(chalk.yellow('Photo watcher is not running.\n'));
      return;
    }

    try {
      process.kill(Number.parseInt(pid, 10));
      await fs.writeFile(pidFile, '');
      console.log(chalk.green('Photo watcher stopped.\n'));
    } catch (error) {
      console.log(chalk.yellow(`Unable to stop photo watcher: ${error}\n`));
    }
  }

  async listBatchOnEbay(): Promise<void> {
    console.log(chalk.bold.magenta('\n━━━━━━━━ LIST BATCH ON EBAY ━━━━━━━━\n'));

    const location = this.batchManager.getLocation();
    const { batchNumberInput } = await inquirer.prompt([
      {
        type: 'input',
        name: 'batchNumberInput',
        message: chalk.bold('Batch number to list:'),
        default: this.batchManager.getCurrentBatchNumber().toString(),
        filter: (input: string) => input.trim(),
        prefix: '📤'
      }
    ]);

    const batchNumber = Number.parseInt(batchNumberInput, 10);
    if (!Number.isFinite(batchNumber) || batchNumber <= 0) {
      console.log(chalk.yellow('Invalid batch number.\n'));
      return;
    }

    const batchPath = getBatchFilePath(batchNumber, location);
    let batchFileExists = true;

    try {
      await fs.access(batchPath);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        batchFileExists = false;
      } else {
        throw error;
      }
    }

    if (!batchFileExists) {
      const { confirmExport } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmExport',
          message: chalk.bold.yellow(
            `Batch file ${path.basename(batchPath)} not found. Export batch ${batchNumber} (${location}) from inventory?`
          ),
          default: true,
          prefix: '⚠️'
        }
      ]);

      if (!confirmExport) {
        console.log(chalk.dim('Listing cancelled\n'));
        return;
      }

      const exportSpinner = ora(chalk.cyan(`Exporting batch ${batchNumber}...`)).start();
      await this.batchExporter.exportBatch(batchNumber, location);
      exportSpinner.succeed(chalk.green(`Batch ${batchNumber} (${location}) exported successfully`));
    }

    const ebaySpinner = ora(chalk.cyan(`Listing batch ${batchNumber} on eBay...`)).start();
    try {
      await this.ebayIntegration.listBatchOnEbay(batchNumber, location);
      ebaySpinner.succeed(chalk.green(`Batch ${batchNumber} (${location}) listed on eBay successfully`));
    } catch (error) {
      ebaySpinner.fail(chalk.yellow(`eBay listing failed: ${error}`));
    }

    console.log('');
  }

  async showMenu(): Promise<boolean> {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: chalk.bold.cyan('What would you like to do?'),
        default: 'add-no-photos',
        choices: [
          new inquirer.Separator(chalk.dim('— Products —')),
          {
            name: chalk.green(
              `➕  Add new product (no photos)${this.hasShownDefaultMenuLabel ? '' : ' [default]'}`
            ),
            value: 'add-no-photos'
          },
          {
            name: chalk.yellow('📸  Add new product (with photos)'),
            value: 'add-with-photos'
          },
          {
            name: chalk.cyan('📦  Receive manifest / generate PID-UID labels'),
            value: 'receive-manifest'
          },
          new inquirer.Separator(),
          new inquirer.Separator(chalk.dim('— Sourcing —')),
          {
            name: chalk.yellow('👁️  Sync TL watchlist + analyze'),
            value: 'techliquidators-watchlist'
          },
          {
            name: chalk.magenta('⏰  TL watchlist expiry alerts'),
            value: 'techliquidators-alerts'
          },
          new inquirer.Separator(),
          new inquirer.Separator(chalk.dim('— Auctions —')),
          {
            name: chalk.cyan('🔍  Analyze Manifest (eBay Sold Comps)'),
            value: 'manifest-ebay-comps'
          },
          new inquirer.Separator(),
          new inquirer.Separator(chalk.dim('— Finance —')),
          {
            name: chalk.cyan('📈  Auction Bid Modeler (ROI + Safe Bid Ranges)'),
            value: 'auction-bid-modeler'
          },
          new inquirer.Separator(),
          new inquirer.Separator(chalk.dim('— Labels & Printing —')),
          {
            name: chalk.cyan('🏷️   Print last SKU label'),
            value: 'print-last-label'
          },
          {
            name: chalk.cyan('📸  Photo intake (auto PID-UID)'),
            value: 'photo-intake'
          },
          {
            name: chalk.cyan('▶️   Start photo watcher (background)'),
            value: 'photo-watch-start'
          },
          {
            name: chalk.cyan('⏹️   Stop photo watcher (background)'),
            value: 'photo-watch-stop'
          },
          {
            name: chalk.magenta('🖨️   List printers'),
            value: 'printers'
          },
          {
            name: chalk.magenta('🧭  Setup printer (auto-detect)'),
            value: 'printer-setup'
          },
          new inquirer.Separator(),
          new inquirer.Separator(chalk.dim('— Inventory —')),
          {
            name: chalk.red('🗑️   Delete last product entered'),
            value: 'delete-last'
          },
          {
            name: chalk.red('🗑️   Delete product'),
            value: 'delete'
          },
          {
            name: chalk.blue('📄  View inventory CSV'),
            value: 'view-inventory'
          },
          {
            name: chalk.blue('📁  View current batch CSV'),
            value: 'view-batch'
          },
          {
            name: chalk.blue('📊  Analytics dashboard'),
            value: 'analytics'
          },
          {
            name: chalk.blue('☁️  Sync Google Sheet'),
            value: 'sync-sheet'
          },
          {
            name: chalk.magenta('🧩  Build inventory hub (master manifests)'),
            value: 'build-hub'
          },
          new inquirer.Separator(),
          new inquirer.Separator(chalk.dim('— Batches —')),
          {
            name: chalk.magenta('📤  List batch on eBay'),
            value: 'list-ebay'
          },
          {
            name: chalk.blue('📊  View batch status'),
            value: 'status'
          },
          {
            name: chalk.yellow('🔄  Reset batch counter'),
            value: 'reset'
          },
          {
            name: chalk.blue('✅  Complete current batch early'),
            value: 'complete-batch'
          },
          new inquirer.Separator(),
          new inquirer.Separator(chalk.dim('— Marketplaces —')),
          {
            name: chalk.magenta('🌐  Cross-list batch to marketplaces'),
            value: 'cross-list'
          },
          {
            name: chalk.blue('📊  View marketplace status (by SKU)'),
            value: 'marketplace-status'
          },
          new inquirer.Separator(),
          {
            name: chalk.red('🚪  Exit'),
            value: 'exit'
          }
        ],
        prefix: '🎯',
        loop: false
      }
    ]);

    switch (action) {
      case 'add-no-photos':
        this.hasShownDefaultMenuLabel = true;
        await this.processProduct(false);
        return true;

      case 'add-with-photos':
        this.hasShownDefaultMenuLabel = true;
        await this.processProduct(true);
        return true;

      case 'receive-manifest':
        this.hasShownDefaultMenuLabel = true;
        await this.receiveManifest();
        return true;

      case 'techliquidators-watchlist':
        this.hasShownDefaultMenuLabel = true;
        await this.syncTechLiquidatorsWatchlist();
        return true;

      case 'techliquidators-alerts':
        this.hasShownDefaultMenuLabel = true;
        await this.showTechLiquidatorsAlerts();
        return true;

      case 'manifest-ebay-comps':
        this.hasShownDefaultMenuLabel = true;
        await this.runEbayCompsManifestAnalyzer();
        return true;

      case 'auction-bid-modeler':
        this.hasShownDefaultMenuLabel = true;
        await this.runAuctionBidModeler();
        return true;

      case 'print-last-label':
        this.hasShownDefaultMenuLabel = true;
        await this.printLastSkuLabel();
        return true;

      case 'photo-intake':
        this.hasShownDefaultMenuLabel = true;
        await this.photoManager.runPidUidIntakeSession();
        return true;

      case 'photo-watch-start':
        this.hasShownDefaultMenuLabel = true;
        await this.startPhotoWatcher();
        return true;

      case 'photo-watch-stop':
        this.hasShownDefaultMenuLabel = true;
        await this.stopPhotoWatcher();
        return true;

      case 'printer-setup':
        this.hasShownDefaultMenuLabel = true;
        await this.runPrinterSetupWizard();
        return true;

      case 'delete-last':
        this.hasShownDefaultMenuLabel = true;
        await this.deleteLastProduct();
        return true;

      case 'delete':
        this.hasShownDefaultMenuLabel = true;
        await this.deleteProduct();
        return true;

      case 'view-inventory':
        this.hasShownDefaultMenuLabel = true;
        await this.viewInventoryCsv();
        return true;

      case 'view-batch':
        this.hasShownDefaultMenuLabel = true;
        await this.viewCurrentBatchCsv();
        return true;

      case 'analytics':
        this.hasShownDefaultMenuLabel = true;
        await this.showAnalyticsDashboard();
        return true;

      case 'sync-sheet':
        this.hasShownDefaultMenuLabel = true;
        await this.runGoogleSheetSync();
        return true;

      case 'build-hub':
        this.hasShownDefaultMenuLabel = true;
        await this.buildInventoryHub();
        return true;

      case 'list-ebay':
        this.hasShownDefaultMenuLabel = true;
        await this.listBatchOnEbay();
        return true;

      case 'status':
        this.hasShownDefaultMenuLabel = true;
        console.log('');
        const statusBox = boxen(
          'BATCH STATUS',
          {
            padding: { top: 0, bottom: 0, left: 2, right: 2 },
            borderStyle: 'round',
            borderColor: 'cyan',
            backgroundColor: 'black'
          }
        );
        console.log(statusBox);

        const statusTable = new Table({
          style: { head: ['cyan'], border: ['grey'] },
          colWidths: [30, 30]
        });

        statusTable.push(
          ['Current Batch Number', chalk.cyan(this.batchManager.getCurrentBatchNumber().toString())],
          ['Current Item Number', chalk.cyan(this.batchManager.getCurrentItemNumber().toString())],
          ['Next Batch ID', chalk.yellow(this.batchManager.getCurrentBatchId())],
          ['Items Remaining in Batch', chalk.magenta(this.batchManager.getItemsRemainingInBatch().toString())],
          ['Batch Size', chalk.white('50 items')],
          ['Location', chalk.blue(this.batchManager.getLocation())]
        );

        console.log(statusTable.toString());
        console.log('');
        return true;

      case 'reset':
        this.hasShownDefaultMenuLabel = true;
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: chalk.bold.yellow('⚠ Are you sure you want to reset the batch counter?'),
            default: false,
            prefix: '⚡'
          }
        ]);
        if (confirm) {
          const resetSpinner = ora('Resetting batch counter...').start();
          await this.batchManager.reset();
          resetSpinner.succeed(chalk.green('Batch counter reset to B1UID001'));
          console.log('');
        } else {
          console.log(chalk.dim('Reset cancelled\n'));
        }
        return true;

      case 'printers':
        this.hasShownDefaultMenuLabel = true;
        const printerSpinner = ora('Scanning for printers...').start();
        const printers = await this.printer.listPrinters();
        printerSpinner.stop();

        console.log('');
        const printerBox = boxen(
          'AVAILABLE PRINTERS',
          {
            padding: { top: 0, bottom: 0, left: 2, right: 2 },
            borderStyle: 'round',
            borderColor: 'magenta'
          }
        );
        console.log(printerBox);

        if (printers.length > 0) {
          printers.forEach((p, i) => {
            const isActive = p === this.printer.getPrinterName();
            const prefix = isActive ? chalk.green('✓') : chalk.dim('○');
            const name = isActive ? chalk.green.bold(p) : chalk.white(p);
            console.log(`  ${prefix} ${name}`);
          });
        } else {
          console.log(chalk.yellow('  No printers found'));
        }
        console.log('');
        return true;

      case 'complete-batch':
        this.hasShownDefaultMenuLabel = true;
        const currentBatch = this.batchManager.getCurrentBatchNumber();
        const currentItem = this.batchManager.getCurrentItemNumber();
        const location = this.batchManager.getLocation();

        if (currentItem === 1) {
          console.log(chalk.yellow('\n⚠ Current batch has no items yet.\n'));
          return true;
        }

        const { confirmComplete } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirmComplete',
            message: chalk.bold.yellow(
              `Complete Batch ${currentBatch} early with ${currentItem - 1} items?`
            ),
            default: false,
            prefix: '⚡'
          }
        ]);

        if (confirmComplete) {
          const exportSpinner = ora(chalk.cyan(`Exporting batch ${currentBatch}...`)).start();
          await this.batchExporter.exportBatch(currentBatch, location);
          exportSpinner.succeed(chalk.green(`Batch ${currentBatch} (${location}) exported successfully`));

          // Move to next batch
          await this.batchManager.forceNextBatch();

          console.log('');
          console.log(boxen(
            chalk.bold.magenta(
              `🎉 BATCH ${currentBatch} (${location}) COMPLETED EARLY!\n\n` +
              `${currentItem - 1} items exported to ${getBatchFileName(currentBatch, location)}\n` +
              `Now starting Batch ${currentBatch + 1} (${location})`
            ),
            {
              padding: 1,
              margin: { top: 0, bottom: 1 },
              borderStyle: 'double',
              borderColor: 'magenta'
            }
          ));
        } else {
          console.log(chalk.dim('Batch completion cancelled\n'));
        }
        return true;

      case 'cross-list':
        this.hasShownDefaultMenuLabel = true;
        await this.crossListProduct();
        return true;

      case 'marketplace-status':
        this.hasShownDefaultMenuLabel = true;
        await this.viewMarketplaceStatus();
        return true;

      case 'exit':
        this.hasShownDefaultMenuLabel = true;
        console.log('');
        const exitBox = boxen(
          chalk.cyan.bold('Thanks for using Inventory Processor!'),
          {
            padding: 1,
            borderStyle: 'round',
            borderColor: 'cyan'
          }
        );
        console.log(exitBox);
        console.log('');
        return false;
    }

    return true;
  }

  async crossListProduct(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ CROSS-LIST BATCH TO MARKETPLACES ━━━━━━━━\n'));

    // Check if web platform is available
    if (!this.marketplaceIntegration.isWebPlatformAvailable()) {
      const isAvailable = await this.marketplaceIntegration.checkAvailability();
      if (!isAvailable) {
        console.log(boxen(
          chalk.yellow('⚠ Web platform not running\n\n') +
          chalk.dim('Start it with:\n') +
          chalk.cyan('cd ../upscaled-crosslist && npm run dev'),
          {
            padding: 1,
            borderStyle: 'round',
            borderColor: 'yellow'
          }
        ));
        console.log('');
        return;
      }
    }

    // Get available batches
    const availableBatches = await this.marketplaceIntegration.getAvailableBatches(
      this.batchManager.getLocation()
    );

    if (availableBatches.length === 0) {
      console.log(boxen(
        chalk.yellow('⚠ No batch files found for this location\n\n') +
        chalk.dim('Complete a batch first to create batch files:\n') +
        chalk.cyan('Batches → Complete current batch early'),
        {
          padding: 1,
          borderStyle: 'round',
          borderColor: 'yellow'
        }
      ));
      console.log('');
      return;
    }

    // Let user select a batch
    const { selectedBatch } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedBatch',
        message: chalk.bold('Select batch to cross-list:'),
        prefix: '📦',
        choices: availableBatches.map(batch => ({
          name: batch,
          value: batch
        }))
      }
    ]);

    // Show preview of batch
    const spinner = ora(chalk.cyan('Reading batch file...')).start();
    let skus: string[] = [];
    try {
      skus = await this.marketplaceIntegration.readBatchSKUs(
        selectedBatch,
        this.batchManager.getLocation()
      );
      spinner.succeed(chalk.green(`Found ${skus.length} products in ${selectedBatch}`));
      console.log(chalk.dim(`  Preview: ${skus.slice(0, 3).join(', ')}${skus.length > 3 ? '...' : ''}`));
      console.log('');
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to read batch file'));
      console.log(chalk.yellow(`  ${error.message}\n`));
      return;
    }

    // Get available marketplaces
    const availableMarketplaces = this.marketplaceIntegration.getAvailableMarketplaces();

    // Let user select marketplaces
    const { selectedMarketplaces } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedMarketplaces',
        message: chalk.bold('Select marketplaces to list on:'),
        prefix: '🌐',
        choices: availableMarketplaces.map(m => ({
          name: m.name,
          value: m.value
        })),
        validate: (selected: string[]) => {
          if (selected.length === 0) {
            return 'Please select at least one marketplace';
          }
          return true;
        }
      }
    ]);

    // Ask about price overrides
    const { usePriceOverrides } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'usePriceOverrides',
        message: chalk.bold('Do you want to set custom prices for specific marketplaces?'),
        default: false,
        prefix: '💰'
      }
    ]);

    let priceOverrides: Record<string, number> | undefined;
    if (usePriceOverrides) {
      priceOverrides = {};
      for (const marketplace of selectedMarketplaces) {
        const marketplaceName = availableMarketplaces.find(m => m.value === marketplace)?.name;
        const { price } = await inquirer.prompt([
          {
            type: 'number',
            name: 'price',
            message: chalk.bold(`Enter price for ${marketplaceName}:`),
            prefix: '💵',
            validate: (input: number) => {
              if (isNaN(input) || input <= 0) {
                return 'Please enter a valid price';
              }
              return true;
            }
          }
        ]);
        priceOverrides[marketplace] = price;
      }
    }

    // Confirm before bulk cross-listing
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: chalk.bold.yellow(
          `Cross-list ${skus.length} products to ${selectedMarketplaces.length} marketplace(s)?`
        ),
        default: false,
        prefix: '⚡'
      }
    ]);

    if (!confirm) {
      console.log(chalk.dim('Cross-listing cancelled\n'));
      return;
    }

    // Cross-list the batch
    const crossListSpinner = ora(chalk.cyan('Cross-listing batch...')).start();

    const result = await this.marketplaceIntegration.crossListBatch({
      batchFile: selectedBatch,
      location: this.batchManager.getLocation(),
      marketplaces: selectedMarketplaces,
      priceOverrides
    });

    if (result.success) {
      crossListSpinner.succeed(chalk.green('Batch cross-listed successfully'));
      console.log('');
      console.log(boxen(
        chalk.bold.green('✅ Cross-listing job created!\n\n') +
        chalk.dim(`Batch: ${selectedBatch}\n`) +
        chalk.dim(`Products: ${result.totalProducts}\n`) +
        chalk.dim(`Job ID: ${result.jobId}\n`) +
        chalk.dim(`Marketplaces: ${selectedMarketplaces.join(', ')}\n\n`) +
        chalk.cyan('View status in web platform:\n') +
        chalk.blue(this.marketplaceIntegration.getWebPlatformUrl()),
        {
          padding: 1,
          borderStyle: 'round',
          borderColor: 'green'
        }
      ));
    } else {
      crossListSpinner.fail(chalk.red('Cross-listing failed'));
      console.log('');
      console.log(boxen(
        chalk.bold.red('❌ Error:\n\n') +
        chalk.yellow(result.error || 'Unknown error'),
        {
          padding: 1,
          borderStyle: 'round',
          borderColor: 'red'
        }
      ));
    }

    console.log('');
  }

  async viewMarketplaceStatus(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ MARKETPLACE STATUS ━━━━━━━━\n'));

    // Check if web platform is available
    if (!this.marketplaceIntegration.isWebPlatformAvailable()) {
      const isAvailable = await this.marketplaceIntegration.checkAvailability();
      if (!isAvailable) {
        console.log(boxen(
          chalk.yellow('⚠ Web platform not running\n\n') +
          chalk.dim('Start it with:\n') +
          chalk.cyan('cd ../upscaled-crosslist && npm run dev'),
          {
            padding: 1,
            borderStyle: 'round',
            borderColor: 'yellow'
          }
        ));
        console.log('');
        return;
      }
    }

    // Get SKU from user
    const { sku } = await inquirer.prompt([
      {
        type: 'input',
        name: 'sku',
        message: chalk.bold('Enter product SKU to check:'),
        prefix: '🏷️',
        validate: (input: string) => {
          if (!input.trim()) {
            return 'SKU is required';
          }
          return true;
        }
      }
    ]);

    // Get marketplace status
    const spinner = ora(chalk.cyan('Fetching marketplace status...')).start();

    try {
      const listings = await this.marketplaceIntegration.getMarketplaceStatus(sku);
      spinner.succeed(chalk.green('Status retrieved'));

      console.log('');

      if (listings.length === 0) {
        console.log(boxen(
          chalk.yellow(`No marketplace listings found for SKU: ${sku}\n\n`) +
          chalk.dim('This product has not been cross-listed yet'),
          {
            padding: 1,
            borderStyle: 'round',
            borderColor: 'yellow'
          }
        ));
      } else {
        const statusBox = boxen(
          `MARKETPLACE STATUS: ${chalk.cyan(sku)}`,
          {
            padding: { top: 0, bottom: 0, left: 2, right: 2 },
            borderStyle: 'round',
            borderColor: 'cyan'
          }
        );
        console.log(statusBox);

        const statusTable = new Table({
          head: [
            chalk.cyan('Marketplace'),
            chalk.cyan('Status'),
            chalk.cyan('Price'),
            chalk.cyan('Listing URL')
          ],
          style: { head: ['cyan'], border: ['grey'] }
        });

        for (const listing of listings) {
          const statusColor = listing.status === 'active' ? chalk.green :
                            listing.status === 'pending' ? chalk.yellow :
                            listing.status === 'error' ? chalk.red :
                            chalk.dim;

          statusTable.push([
            chalk.white(listing.marketplace),
            statusColor(listing.status),
            listing.price ? chalk.green(`$${listing.price}`) : chalk.dim('-'),
            listing.listingUrl ? chalk.blue(listing.listingUrl.substring(0, 40) + '...') : chalk.dim('-')
          ]);
        }

        console.log(statusTable.toString());
      }

      console.log('');
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to retrieve status'));
      console.log('');
      console.log(boxen(
        chalk.bold.red('❌ Error:\n\n') +
        chalk.yellow(error.message),
        {
          padding: 1,
          borderStyle: 'round',
          borderColor: 'red'
        }
      ));
      console.log('');
    }
  }

  async run(): Promise<void> {
    await loadDotEnv();
    await this.initialize();

    let continueRunning = true;
    while (continueRunning) {
      continueRunning = await this.showMenu();
    }
  }

  async runDoctor(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ UPSCALED DOCTOR ━━━━━━━━\n'));

    const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];

    const repoPath = process.cwd();
    checks.push({ label: 'Repo path', ok: true, detail: repoPath });

    const distPath = path.join(repoPath, 'dist', 'index.js');
    try {
      await fs.access(distPath);
      checks.push({ label: 'Build output', ok: true, detail: distPath });
    } catch {
      checks.push({ label: 'Build output', ok: false, detail: distPath });
    }

    const intakeDir = this.photoManager.getIntakeDir();
    const outputDir = process.env.PHOTO_OUTPUT_DIR || path.join(repoPath, 'data', 'photos');

    const driveTestFile = path.join(outputDir, '.upscaled_doctor_test');

    try {
      await fs.access(intakeDir);
      checks.push({ label: 'Photo intake folder', ok: true, detail: intakeDir });
    } catch {
      checks.push({ label: 'Photo intake folder', ok: false, detail: intakeDir });
    }

    try {
      await fs.access(outputDir);
      checks.push({ label: 'Photo output folder', ok: true, detail: outputDir });
    } catch {
      checks.push({ label: 'Photo output folder', ok: false, detail: outputDir });
    }

    const pidFile = this.getPhotoWatcherPidFile();
    let watcherRunning = false;
    try {
      const pidText = (await fs.readFile(pidFile, 'utf-8')).trim();
      if (pidText) {
        watcherRunning = true;
      }
    } catch {
      watcherRunning = false;
    }
    checks.push({
      label: 'Photo watcher',
      ok: watcherRunning,
      detail: watcherRunning ? 'running' : 'not running'
    });

    const table = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [22, 10, 60]
    });
    table.push(['Check', 'Status', 'Details']);

    for (const check of checks) {
      table.push([
        check.label,
        check.ok ? chalk.green('OK') : chalk.red('FAIL'),
        check.detail || ''
      ]);
    }

    console.log(table.toString());
    console.log('');
  }

}

function printHelp(): void {
  console.log(`
Usage:
  upscaled [command]

Commands:
  doctor           Run diagnostics (Upscaled Doctor)
  auctions manifest analyze
                   Analyze manifest with eBay sold comps
  auctions alerts  Show TechLiquidators watchlist expiry alerts
  auctions alerts --notify
                   Show alerts and send macOS notifications
  sync sheets      Sync batch tabs + master manifests to Google Sheet
  -h, --help       Show this help menu

Menu Actions:
  Products:
    Add new product (no photos)
    Add new product (with photos)
    Receive manifest / generate PID-UID labels
  Sourcing:
    Sync TL watchlist + analyze
    TL watchlist expiry alerts
  Auctions:
    Analyze Manifest (eBay Sold Comps)
  Finance:
    Auction Bid Modeler (ROI + Safe Bid Ranges)
  Labels & Printing:
    Print last SKU label
    Photo intake (auto PID-UID)
    Start photo watcher (background)
    Stop photo watcher (background)
    List printers
  Inventory:
    Delete last product entered
    Delete product
    View inventory CSV
    View current batch CSV
    Analytics dashboard
    Sync Google Sheet
    Build inventory hub (master manifests)
  Batches:
    List batch on eBay
    View batch status
    Reset batch counter
    Complete current batch early
  Marketplaces:
    Cross-list batch to marketplaces
    View marketplace status (by SKU)
  General:
    Exit
`.trim());
  console.log('');
}

// Main entry point
const processor = new InventoryProcessor();
const args = process.argv.slice(2).map(arg => arg.toLowerCase());
if (args.includes('-h') || args.includes('--help') || args.includes('help')) {
  printHelp();
  process.exit(0);
} else if (args.includes('doctor')) {
  processor.runDoctor().catch(error => {
    console.error(chalk.red.bold('\n❌ Doctor failed:'), error);
    process.exit(1);
  });
} else if (args[0] === 'auctions' && args[1] === 'manifest' && args[2] === 'analyze') {
  processor.runEbayCompsManifestAnalyzer().catch(error => {
    console.error(chalk.red.bold('\n❌ Analyzer failed:'), error);
    process.exit(1);
  });
} else if (args[0] === 'auctions' && args[1] === 'alerts') {
  processor.showTechLiquidatorsAlerts().catch(error => {
    console.error(chalk.red.bold('\n❌ Alerts failed:'), error);
    process.exit(1);
  });
} else if (args[0] === 'sync' && args[1] === 'sheets') {
  processor.runGoogleSheetSync().catch(error => {
    console.error(chalk.red.bold('\n❌ Sheet sync failed:'), error);
    process.exit(1);
  });
} else if (args.length > 0) {
  console.log(chalk.red(`Unknown command: ${args.join(' ')}`));
  printHelp();
  process.exit(1);
} else {
  processor.run().catch(error => {
    console.error(chalk.red.bold('\n❌ Fatal error:'), error);
    process.exit(1);
  });
}
