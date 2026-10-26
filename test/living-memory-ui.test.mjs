import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('living-memory page owns a stable vertical scroll container', () => {
  const css = fs.readFileSync(path.join(ROOT, 'ui', 'style.css'), 'utf8');
  assert.match(css, /#view-living-memory\.view\.active\s*\{[\s\S]*?display:\s*block;[\s\S]*?overflow-y:\s*auto;[\s\S]*?scrollbar-gutter:\s*stable;/);
  assert.match(css, /\.living-memory-page\s*\{\s*width:\s*min\(100%,\s*1480px\)/);
});

test('living-memory settings expose the recall time budget', () => {
  const page = fs.readFileSync(path.join(ROOT, 'ui', 'pages', 'living-memory.js'), 'utf8');
  assert.match(page, /id="lm-recall-timeout"/);
  assert.match(page, /recallTimeoutMs:\s*Number\(\$\('#lm-recall-timeout'\)\?\.value\)/);
});
