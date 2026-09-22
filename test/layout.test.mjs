// 目录布局不变量：这一组断言专门防"挪文件时漏改路径"这类问题。
//
// 背景：src/ 按领域分了子目录（core / llm / tools / onebot / pricing / memory /
// identity / pilots / features / console），凡是**用自己的位置推算仓库根**的模块
// （`path.resolve(__dirname, '..')`）在挪动后都会少算一层 —— 之前就因此踩过：
// config 的 ROOT 指向 src/，导致 app 读不到 package.json、控制台静态目录也错了。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ROOT 指向仓库根（用自身位置推算的路径不能少退一层）', async () => {
  const { ROOT } = await import('../src/core/config-legacy.js');
  assert.equal(path.resolve(ROOT), repoRoot);
});

test('仓库根的关键文件/目录都在', () => {
  for (const rel of [
    'package.json',
    'package-lock.json',
    'deploy.sh',
    'manage.sh',
    'prices.json',
    'src/server.js',
    'src/ops.js',
    'src/auto-update.js',
    'scripts/auto-update.mjs',
    'ui/index.html',
    'ui/app.js',
    'roles/xiaojingyu.md',
    'roles/xiaojingyu-game-client.md',
    'roles/duzui-sunyou.md',
    'roles/wenrou-peiliao.md',
    'roles/jishu-zhai.md',
    'roles/maoniang.md'
  ]) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `缺少 ${rel}`);
  }
});

test('src/ 下所有相对 import 都能解析到真实文件', () => {
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  const missing = [];
  let checked = 0;
  for (const dir of ['src', 'scripts', 'test', 'ui']) {
    for (const file of walk(path.join(repoRoot, dir))) {
      const from = path.dirname(file);
      // 也要认 .mjs（新增相对 .mjs import 时不能被静默跳过）；
      // 必须是 ./ 或 ../ 开头的真相对路径 —— 免得把 '.test.mjs' 这种文件名过滤串当 import
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/['"]((?:\.\.?\/)[^'"]*\.(?:js|mjs))['"]/g)) {
        checked += 1;
        const target = path.resolve(from, match[1]);
        if (!fs.existsSync(target)) missing.push(`${path.relative(repoRoot, file)} → ${match[1]}`);
      }
    }
  }
  assert.ok(checked > 100, `扫描到的相对 import 太少（${checked}），检查一下 glob`);
  assert.deepEqual(missing, [], `这些相对 import 指向不存在的文件：\n${missing.join('\n')}`);
});

test('按硬编码路径部署/更新的入口文件没被挪走', () => {
  // deploy.sh 的必需清单 + scripts/auto-update.mjs 的 validateCheckout / --check
  for (const rel of ['src/server.js', 'src/auto-update.js', 'scripts/auto-update.mjs', 'scripts/configure-linux.mjs', 'scripts/install-service.mjs', 'scripts/manage.mjs']) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} 被移动了，会让旧版更新器的校验失败`);
  }
  const updater = fs.readFileSync(path.join(repoRoot, 'scripts/auto-update.mjs'), 'utf8');
  for (const rel of ['src/server.js', 'scripts/auto-update.mjs']) {
    assert.ok(updater.includes(`'${rel}'`), `auto-update.mjs 里的校验清单应包含 ${rel}`);
  }
  const deploy = fs.readFileSync(path.join(repoRoot, 'deploy.sh'), 'utf8');
  for (const rel of ['src/server.js', 'src/auto-update.js', 'scripts/configure-linux.mjs']) {
    assert.ok(deploy.includes(rel), `deploy.sh 的必需清单应包含 ${rel}`);
  }
});
