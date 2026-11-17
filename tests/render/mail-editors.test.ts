import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Attachment {
  name: string;
  size: number;
  lastModified: number;
}

function attachmentKey(file: Attachment): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function createAttachment(file: Attachment): HTMLElement {
  const item = document.createElement('div');
  item.className = 'mail-attachment';
  item.dataset.key = attachmentKey(file);
  item.textContent = `${file.name} (${file.size})`;
  return item;
}

describe('mail/editors', () => {
  it('keeps compose attachments keyed as files are added and removed', () => {
    const root = document.createElement('div');
    const files = signal<Attachment[]>([{ name: 'a.txt', size: 10, lastModified: 1 }]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => files(),
        attachmentKey,
        (file) => {
          const value = file();
          const item = createAttachment(value);
          return legacy(item, () => disposed.push(attachmentKey(value)));
        },
      ),
    );

    const first = root.querySelector<HTMLElement>('[data-key="a.txt:10:1"]');
    assert.ok(first);

    files.set([
      { name: 'a.txt', size: 10, lastModified: 1 },
      { name: 'b.png', size: 20, lastModified: 2 },
    ]);
    flushEffects();
    assert.equal(root.querySelector('[data-key="a.txt:10:1"]'), first);
    assert.ok(root.querySelector('[data-key="b.png:20:2"]'));

    files.set([{ name: 'a.txt', size: 10, lastModified: 1 }]);
    flushEffects();
    assert.deepEqual(disposed, ['b.png:20:2']);
    assert.equal(root.querySelector('[data-key="a.txt:10:1"]'), first);
  });

  it('renders the fixed security list as keyed rows', () => {
    const root = document.createElement('ul');
    const rows: Array<[string, string]> = [
      ['shield', 'E2EE'],
      ['lock', 'At rest'],
      ['mail-open', 'TLS'],
    ];

    mount(root, () =>
      each(
        () => rows,
        (row) => row[1],
        (row) => {
          const item = document.createElement('li');
          item.dataset.title = row()[1];
          item.textContent = row()[0] + ':' + row()[1];
          return legacy(item);
        },
      ),
    );

    assert.equal(root.querySelectorAll('li').length, 3);
    assert.equal(root.querySelector('[data-title="At rest"]')?.textContent, 'lock:At rest');
  });
});
