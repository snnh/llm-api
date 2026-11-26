import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

test('published package ships dist, declarations and runnable examples', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.ok(pkg.files.includes('dist'));
  assert.equal(pkg.exports['.'].types, './dist/index.d.ts');
  assert.equal(pkg.exports['.'].import, './dist/index.js');

  for (const script of ['example', 'web']) {
    const target = pkg.scripts[script].split(' ').at(-1);
    assert.ok(existsSync(target), `${script} 指向不存在的文件：${target}`);
  }
  assert.ok(existsSync('LICENSE'));

  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const [pack] = JSON.parse(raw);
  const paths = new Set(pack.files.map((file) => file.path));
  for (const required of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/config.js',
    'dist/responses.js',
    'dist/gemini.js',
    'examples/basic.mjs',
    'examples/web/server.mjs',
    'CHANGELOG.md',
    'LICENSE',
  ]) {
    assert.ok(paths.has(required), `发布包缺少 ${required}`);
  }
});
