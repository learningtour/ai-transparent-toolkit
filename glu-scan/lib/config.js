// Instellingen van de satelliet. Staan naast de config van `ait`, maar in een
// eigen bestand: de scanner heeft geen AI-Transparent-account nodig.

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'ai-transparent');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'glu-scan.json');

export const STANDAARD = {
  endpoint: 'http://localhost:1234/v1', // LM Studio
  model: null,                           // null = eerste beschikbare model
  visionModel: null,
  timeoutMs: 180000,
  maxTokens: 1200,
  stukGrootte: 6000,
  maxStukken: 40,
  drempel: 'middel'                      // vanaf deze ernst is uploaden af te raden
};

export async function laadConfig() {
  try {
    return { ...STANDAARD, ...JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...STANDAARD };
  }
}

export async function bewaarConfig(cfg) {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  const opslaan = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (STANDAARD[k] !== v) opslaan[k] = v;
  }
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(opslaan, null, 2), { mode: 0o600 });
  return CONFIG_FILE;
}
