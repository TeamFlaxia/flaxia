#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE_URL = process.env.GEONAMES_URL || 'https://download.geonames.org/export/dump/cities500.zip';
const DB_NAME = process.env.D1_DB || 'flaxia';
const REMOTE = process.env.D1_REMOTE === '1';
const BATCH = 500;

if (!/^[A-Za-z0-9_-]+$/.test(DB_NAME)) {
  console.error('D1_DB must be a plain identifier');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} failed with exit code ${result.status} (${args.join(' ')})`);
}

function slugify(value) {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'place'
  );
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'flaxia-geonames-'));
  const zipPath = join(dir, 'cities500.zip');
  console.log(`downloading ${SOURCE_URL}`);
  run('curl', ['-fL', '-o', zipPath, SOURCE_URL]);
  const admZipPath = join(dir, 'cities500.txt');
  if (!existsSync(admZipPath)) {
    const result = spawnSync('unzip', ['-p', zipPath, 'cities500.txt'], { maxBuffer: 256 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('unzip failed');
    writeFileSync(admZipPath, result.stdout);
  }
  const txt = readFileSync(admZipPath, 'utf8');
  const lines = txt.split('\n').filter(Boolean);
  console.log(`rows: ${lines.length}`);
  const values = [];
  for (const line of lines) {
    const cols = line.split('\t');
    const geonameid = cols[0];
    const name = cols[1];
    const asciiname = cols[2];
    const lat = Number(cols[4]);
    const lon = Number(cols[5]);
    const country = cols[8] || 'xx';
    if (!/^\d+$/.test(geonameid || '') || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const id = `gn-${geonameid}`;
    const norm = (asciiname || name).toLowerCase();
    const cityId = slugify(`${name}-${country.toLowerCase()}`);
    values.push(`('${id}','${sqlEscape(name)}','${sqlEscape(norm)}',${lat},${lon},'city','${sqlEscape(cityId)}')`);
    if (values.length >= BATCH) {
      await flush(values.splice(0, values.length), dir);
    }
  }
  if (values.length > 0) await flush(values, dir);
  console.log('done');
}

async function flush(rows, dir) {
  const sql = `INSERT OR IGNORE INTO maps_places (id, name, name_norm, lat, lon, kind, city_id) VALUES ${rows.join(',')};`;
  const sqlPath = join(dir, `batch-${Date.now()}-${Math.floor(Math.random() * 1e9)}.sql`);
  writeFileSync(sqlPath, sql, 'utf8');
  run('wrangler', ['d1', 'execute', DB_NAME, REMOTE ? '--remote' : '--local', '--file', sqlPath, '--json']);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
