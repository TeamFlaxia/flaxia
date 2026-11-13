// Left nav width model: clamping, icon-rail snapping, and persistence.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  clampLeftNavWidth,
  LEFT_NAV_ICON_THRESHOLD,
  LEFT_NAV_ICON_WIDTH,
  LEFT_NAV_WIDTH_DEFAULT,
  LEFT_NAV_WIDTH_MAX,
  LEFT_NAV_WIDTH_MIN,
  LEFT_NAV_WIDTH_STORAGE_KEY,
  readLeftNavWidth,
  resolveLeftNavWidth,
  writeLeftNavWidth,
} from '../src/lib/left-nav-layout.ts';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  (globalThis as { localStorage?: Storage }).localStorage = storage as unknown as Storage;
  return storage;
}

function clearStorage(): void {
  delete (globalThis as { localStorage?: Storage }).localStorage;
}

describe('clampLeftNavWidth', () => {
  it('clamps to the supported range', () => {
    assert.equal(clampLeftNavWidth(100), LEFT_NAV_WIDTH_MIN);
    assert.equal(clampLeftNavWidth(250), 250);
    assert.equal(clampLeftNavWidth(9999), LEFT_NAV_WIDTH_MAX);
  });

  it('rounds fractional widths', () => {
    assert.equal(clampLeftNavWidth(250.6), 251);
  });
});

describe('resolveLeftNavWidth', () => {
  it('snaps at or below the threshold to the icon rail', () => {
    assert.deepEqual(resolveLeftNavWidth(LEFT_NAV_ICON_THRESHOLD), {
      width: LEFT_NAV_ICON_WIDTH,
      icons: true,
    });
    assert.deepEqual(resolveLeftNavWidth(10), { width: LEFT_NAV_ICON_WIDTH, icons: true });
  });

  it('keeps normal widths above the threshold', () => {
    assert.deepEqual(resolveLeftNavWidth(250), { width: 250, icons: false });
  });

  it('clamps normal widths into the range', () => {
    assert.deepEqual(resolveLeftNavWidth(LEFT_NAV_ICON_THRESHOLD + 1), {
      width: LEFT_NAV_WIDTH_MIN,
      icons: false,
    });
    assert.deepEqual(resolveLeftNavWidth(9999), { width: LEFT_NAV_WIDTH_MAX, icons: false });
  });

  it('falls back to the default for non-finite input', () => {
    assert.deepEqual(resolveLeftNavWidth(Number.NaN), {
      width: LEFT_NAV_WIDTH_DEFAULT,
      icons: false,
    });
  });
});

describe('left nav width persistence', () => {
  afterEach(clearStorage);

  it('defaults without storage', () => {
    clearStorage();
    assert.equal(readLeftNavWidth(), LEFT_NAV_WIDTH_DEFAULT);
  });

  it('round-trips a stored width', () => {
    const storage = installStorage();
    writeLeftNavWidth(320);
    assert.equal(storage.getItem(LEFT_NAV_WIDTH_STORAGE_KEY), '320');
    assert.equal(readLeftNavWidth(), 320);
  });

  it('persists the compact rail width', () => {
    installStorage();
    writeLeftNavWidth(LEFT_NAV_ICON_WIDTH);
    assert.equal(readLeftNavWidth(), LEFT_NAV_ICON_WIDTH);
  });

  it('ignores malformed stored values', () => {
    const storage = installStorage();
    storage.setItem(LEFT_NAV_WIDTH_STORAGE_KEY, 'abc');
    assert.equal(readLeftNavWidth(), LEFT_NAV_WIDTH_DEFAULT);
  });

  it('ignores non-positive stored values', () => {
    const storage = installStorage();
    storage.setItem(LEFT_NAV_WIDTH_STORAGE_KEY, '-5');
    assert.equal(readLeftNavWidth(), LEFT_NAV_WIDTH_DEFAULT);
  });
});
