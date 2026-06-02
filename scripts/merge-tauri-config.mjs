import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(__dirname, '..', 'src-tauri');

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

const PLATFORM_MAP = {
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux',
};

const VALID_TARGETS = {
  windows: 'windows',
  macos: 'macos',
  linux: 'linux',
};

function resolveTarget() {
  const env = process.env.TAURI_TARGET_PLATFORM;
  if (env && VALID_TARGETS[env]) return env;

  const platform = PLATFORM_MAP[process.platform];
  if (platform) return platform;

  console.error(`Unsupported platform: ${process.platform}. Set TAURI_TARGET_PLATFORM env var (windows|macos|linux).`);
  process.exit(1);
}

const target = resolveTarget();
const basePath = resolve(tauriDir, 'tauri.conf.base.json');
const osPath = resolve(tauriDir, `tauri.conf.${target}.json`);
const outPath = resolve(tauriDir, 'tauri.conf.json');

if (!existsSync(basePath)) {
  console.error('Missing base config: tauri.conf.base.json');
  process.exit(1);
}

const merged = JSON.parse(readFileSync(basePath, 'utf-8'));

if (existsSync(osPath)) {
  const osConfig = JSON.parse(readFileSync(osPath, 'utf-8'));
  deepMerge(merged, osConfig);
}

writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');
console.log(`Generated tauri.conf.json for ${target}`);
