import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class ThermalPrinter {
  private printerName: string | null = null;

  async initialize(): Promise<void> {
    const configuredPrinter = await this.loadConfiguredPrinter();
    if (configuredPrinter) {
      this.printerName = configuredPrinter;
      return;
    }

    // Try to detect thermal printer
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execAsync(
          'powershell -NoProfile -Command "Get-Printer | Select-Object -Property Name,Default | ConvertTo-Json"'
        );
        const printers = this.parseWindowsPrinters(stdout);
        const defaultPrinter = printers.find(p => p.default);
        if (defaultPrinter) {
          this.printerName = defaultPrinter.name;
        } else if (printers.length > 0) {
          this.printerName = printers[0].name;
        }
        return;
      }

      const { stdout } = await execAsync('lpstat -p -d');
      const lines = stdout.split('\n');

      // Look for a thermal printer or use default
      for (const line of lines) {
        if (line.includes('printer') && !line.includes('disabled')) {
          const match = line.match(/printer (\S+)/);
          if (match) {
            this.printerName = match[1];
            break;
          }
        }
      }

      if (!this.printerName) {
        // Try to get default printer
        const defaultMatch = stdout.match(/system default destination: (\S+)/);
        if (defaultMatch) {
          this.printerName = defaultMatch[1];
        }
      }
    } catch (error) {
      console.warn('Warning: Could not detect printer. Printing may fail.');
    }
  }

  async print(imagePath: string): Promise<void> {
    if (!this.printerName) {
      throw new Error('No printer configured. Please set up a printer.');
    }

    try {
      if (process.platform === 'win32') {
        const safePath = imagePath.replace(/'/g, "''");
        const safePrinter = this.printerName.replace(/'/g, "''");
        const command =
          `powershell -NoProfile -Command "Start-Process -FilePath '` +
          `${safePath}' -Verb PrintTo -ArgumentList '${safePrinter}'"`;
        await execAsync(command);
        console.log(`✓ Label printed successfully to ${this.printerName}`);
        return;
      }

      // Use lp command to print the image
      // Options:
      // -d: specify printer
      // -o fit-to-page: scale image to fit label
      // -o media=Custom.51x25mm: set label size (2" x 1")
      const command = `lp -d "${this.printerName}" -o fit-to-page -o media=Custom.51x25mm "${imagePath}"`;

      await execAsync(command);
      console.log(`✓ Label printed successfully to ${this.printerName}`);
    } catch (error) {
      throw new Error(`Failed to print label: ${error}`);
    }
  }

  getPrinterName(): string | null {
    return this.printerName;
  }

  setPrinterName(name: string | null): void {
    this.printerName = name;
  }

  async listPrinters(): Promise<string[]> {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execAsync(
          'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"'
        );
        return stdout
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean);
      }

      const { stdout } = await execAsync('lpstat -p');
      const lines = stdout.split('\n').filter(line => line.startsWith('printer'));
      return lines.map(line => {
        const match = line.match(/printer (\S+)/);
        return match ? match[1] : '';
      }).filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  private async loadConfiguredPrinter(): Promise<string | null> {
    const envPrinter = process.env.UPSCALED_PRINTER_NAME || process.env.PRINTER_NAME;
    if (envPrinter) {
      return envPrinter;
    }

    const configPath = path.join(process.cwd(), 'data', 'printer.json');
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw) as { name?: string };
      if (parsed?.name) {
        return parsed.name;
      }
    } catch {
      return null;
    }

    return null;
  }

  async saveConfiguredPrinter(name: string): Promise<void> {
    const configPath = path.join(process.cwd(), 'data', 'printer.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const payload = {
      name,
      platform: process.platform,
      configuredAt: new Date().toISOString()
    };
    await fs.writeFile(configPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  private parseWindowsPrinters(raw: string): Array<{ name: string; default: boolean }> {
    try {
      const parsed = JSON.parse(raw) as Array<{ Name?: string; Default?: boolean }> | { Name?: string; Default?: boolean };
      const items = Array.isArray(parsed) ? parsed : [parsed];
      return items
        .map(item => ({
          name: item?.Name ?? '',
          default: Boolean(item?.Default),
        }))
        .filter(item => item.name.length > 0);
    } catch {
      return [];
    }
  }
}
