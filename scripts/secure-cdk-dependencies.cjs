const fs = require('node:fs');
const path = require('node:path');

// CDK bundles minimatch, so npm overrides cannot replace its vulnerable copy.
// Use the lockfile-pinned patched dependency, including its own dependency tree.
const cdk = path.dirname(require.resolve('aws-cdk-lib/package.json'));
const bundled = path.join(cdk, 'node_modules/minimatch');
const patched = path.dirname(require.resolve('minimatch/package.json'));
if (JSON.parse(fs.readFileSync(path.join(patched, 'package.json'))).version !== '11.0.1') {
  throw new Error('Review the pinned minimatch security replacement');
}
if (fs.realpathSync(bundled) !== fs.realpathSync(patched)) {
  if (JSON.parse(fs.readFileSync(path.join(bundled, 'package.json'))).version !== '10.2.6') {
    throw new Error('CDK bundled minimatch changed; review whether the security replacement is still needed');
  }
  fs.rmSync(bundled, { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(bundled), patched), bundled, 'dir');
}
