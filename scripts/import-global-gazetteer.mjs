#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE_URL = process.env.GEONAMES_URL || 'https://download.geonames.org/export/dump/cities500.zip';
const DB_NAME = process.env.D1_DB || 'flaxia';
const REMOTE = process.env.D1_REMOTE === '1';
const BATCH = 500;

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
  execSync(`curl -fL -o ${zipPath} ${SOURCE_URL}`, { stdio: 'inherit' });
  const admZipPath = join(dir, 'cities500.txt');
  if (!existsSync(admZipPath)) {
    execSync(`unzip -p ${zipPath} cities500.txt > ${admZipPath}`, { stdio: 'inherit' });
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
    const lat = cols[4];
    const lon = cols[5];
    const country = cols[8] || 'xx';
    if (!geonameid || !name || !lat || !lon) continue;
    const id = `gn-${geonameid}`;
    const norm = (asciiname || name).toLowerCase();
    const cityId = slugify(`${name}-${country.toLowerCase()}`);
    values.push(
      `('${id}','${sqlEscape(name)}','${sqlEscape(norm)}',${Number(lat)},${Number(lon)},'city','${sqlEscape(cityId)}')`,
    );
    if (values.length >= BATCH) {
      await flush(values.splice(0, values.length), dir);
    }
  }
  if (values.length > 0) await flush(values, dir);
  console.log('done');
}

async function flush(rows, dir) {
  const sql = `INSERT OR IGNORE INTO maps_places (id, name, name_norm, lat, lon, kind, city_id) VALUES ${rows.join(',')};`;
  const sqlPath = join(dir, `batch-${Date.now()}.sql`);
  writeFileSync(sqlPath, sql, 'utf8');
  const flag = REMOTE ? '--remote' : '--local';
  execSync(`wrangler d1 execute ${DB_NAME} ${flag} --file ${sqlPath} --json`, { stdio: 'inherit' });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
