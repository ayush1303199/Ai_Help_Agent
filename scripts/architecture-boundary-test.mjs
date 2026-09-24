import fs from 'node:fs';
import path from 'node:path';

const featureRoot = path.resolve('src', 'features');
const features = ['meeting', 'coding', 'general'];
const forbiddenImports = features
  .flatMap((feature) => features
    .filter((other) => other !== feature)
    .map((other) => ({
      feature,
      other,
      pattern: new RegExp(`(?:features/|\\.\\./)+${other}[/"']`),
    })));

function collectSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(entryPath);
    return /\.(?:ts|tsx|js|jsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

const violations = [];
for (const feature of features) {
  const files = collectSourceFiles(path.join(featureRoot, feature));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const rule of forbiddenImports.filter((item) => item.feature === feature)) {
      if (rule.pattern.test(source)) {
        violations.push(`${path.relative(process.cwd(), file)} imports sibling feature "${rule.other}"`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Architecture boundary violations found:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('Architecture boundary test passed.');
