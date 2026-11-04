const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const vsixName = `device-screenshot-${pkg.version}.vsix`;
const vsixPath = path.join(rootDir, vsixName);

console.log(`\n========================================`);
console.log(`📦 Packaging extension v${pkg.version}...`);
console.log(`========================================\n`);

execSync('npm run package', { stdio: 'inherit', cwd: rootDir });

if (!fs.existsSync(vsixPath)) {
  console.error(`❌ Error: ${vsixName} not found after packaging!`);
  process.exit(1);
}

console.log(`\n========================================`);
console.log(`🚀 Deploying v${pkg.version} to local IDEs...`);
console.log(`========================================\n`);

// 1. Deploy to Visual Studio Code
const vscodeCandidates = [
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  '/usr/local/bin/code',
  'code'
];

let vscodeInstalled = false;
for (const cmd of vscodeCandidates) {
  try {
    if (cmd.startsWith('/') && !fs.existsSync(cmd)) {
      continue;
    }
    console.log(`Installing to VS Code using: ${cmd}`);
    execSync(`"${cmd}" --install-extension "${vsixPath}" --force`, { stdio: 'inherit' });
    vscodeInstalled = true;
    console.log(`✅ Successfully deployed to Visual Studio Code!\n`);
    break;
  } catch (err) {
    // continue to next candidate
  }
}

if (!vscodeInstalled) {
  console.warn(`⚠️ Visual Studio Code CLI not found or installation failed.`);
}

// 2. Deploy to Antigravity IDE
const antigravityCandidates = [
  '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide',
  '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity-ide',
  'antigravity-ide'
];

let antigravityInstalled = false;
for (const cmd of antigravityCandidates) {
  try {
    if (cmd.startsWith('/') && !fs.existsSync(cmd)) {
      continue;
    }
    console.log(`Installing to Antigravity IDE using: ${cmd}`);
    execSync(`"${cmd}" --install-extension "${vsixPath}" --force`, { stdio: 'inherit' });
    antigravityInstalled = true;
    console.log(`✅ Successfully deployed to Antigravity IDE!\n`);
    break;
  } catch (err) {
    // continue to next candidate
  }
}

if (!antigravityInstalled) {
  console.warn(`⚠️ Antigravity IDE CLI not found or installation failed.`);
}

console.log(`========================================`);
console.log(`🎉 Local Deployment Complete for v${pkg.version}!`);
console.log(`👉 Press 'Cmd+Shift+P' and run 'Developer: Reload Window' in each IDE to apply changes.`);
console.log(`========================================\n`);
