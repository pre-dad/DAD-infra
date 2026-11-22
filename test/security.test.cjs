const assert = require('node:assert/strict');
const { test } = require('node:test');
const merge = require('deepmerge');

test('installed Jest merge dependency rejects prototype keys from source and target', () => {
  assert.equal(require('deepmerge/package.json').name, '@dad-infra/deepmerge');
  for (const payload of [
    JSON.parse('{"__proto__":{"isAdmin":true}}'),
    JSON.parse('{"constructor":{"prototype":{"isAdmin":true}}}'),
    Object.assign(Object.create(null), JSON.parse('{"__proto__":{"isAdmin":true}}')),
  ]) {
    for (const result of [merge({}, payload), merge(Object.create(null), payload), merge(payload, {}), merge({ nested: payload }, {}), merge({}, { nested: payload })]) {
      const object = result.nested || result;
      assert.equal(Object.getPrototypeOf(object), Object.prototype);
      assert.equal(object.isAdmin, undefined);
      assert.equal(Object.hasOwn(object, '__proto__'), false);
      assert.equal(Object.hasOwn(object, 'constructor'), false);
    }
  }
  assert.equal({}.isAdmin, undefined);
});

test('Jest preset merging preserves nested values, array concatenation and source immutability', () => {
  const preset = { compiler: { strict: true, paths: ['preset'] } };
  const globals = { compiler: { paths: ['project'], diagnostics: false } };
  assert.deepEqual(merge(preset, globals), { compiler: { strict: true, paths: ['preset', 'project'], diagnostics: false } });
  assert.deepEqual(preset.compiler.paths, ['preset']);
});

test('CDK bundles a patched minimatch and preserves ordinary asset globs', () => {
  const path = require('node:path');
  const cdk = path.dirname(require.resolve('aws-cdk-lib/package.json'));
  const fixed = require(path.join(cdk, 'node_modules/minimatch'));
  const [major, minor, patch] = require(path.join(cdk, 'node_modules/minimatch/package.json'))
    .version.split('.')
    .map(Number);
  // 11.0.9 fixes GHSA-g3hv-75wg-m249 and GHSA-cf2h-pxjq-68xw.
  assert.ok(major > 11 || (major === 11 && (minor > 0 || patch >= 9)), 'CDK bundles a vulnerable minimatch');
  assert.equal(fixed.minimatch('assets/image.png', 'assets/**/*.png'), true);
  assert.equal(fixed.minimatch('assets/image.svg', 'assets/**/*.png'), false);
});
