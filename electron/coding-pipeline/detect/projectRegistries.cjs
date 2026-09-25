const PROJECT_MANIFESTS = [
  { type: 'node', language: 'javascript', files: ['package.json'], extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'], priority: 100 },
  { type: 'php', language: 'php', files: ['composer.json'], extensions: ['.php'], priority: 95 },
  { type: 'java-maven', language: 'java', files: ['pom.xml'], extensions: ['.java'], priority: 90 },
  { type: 'java-gradle', language: 'java', files: ['build.gradle', 'build.gradle.kts'], extensions: ['.java', '.kt'], priority: 89 },
  { type: 'go', language: 'go', files: ['go.mod'], extensions: ['.go'], priority: 88 },
  { type: 'ruby', language: 'ruby', files: ['Gemfile'], extensions: ['.rb'], priority: 87 },
  { type: 'dotnet', language: 'dotnet', files: ['*.csproj', '*.sln'], extensions: ['.cs', '.fs', '.vb'], priority: 86 },
  { type: 'rust', language: 'rust', files: ['Cargo.toml'], extensions: ['.rs'], priority: 85 },
  { type: 'python', language: 'python', files: ['requirements.txt', 'pyproject.toml'], extensions: ['.py'], priority: 84 },
];

const VERIFICATION_PROFILES = {
  node: { checks: ['test', 'lint', 'build'], fallbacks: [] },
  php: { checks: ['phpunit', 'composer-test', 'php-lint'], fallbacks: ['php-lint'] },
  'java-maven': { checks: ['maven-test', 'maven-build'], fallbacks: [] },
  'java-gradle': { checks: ['gradle-test', 'gradle-build'], fallbacks: [] },
  go: { checks: ['go-test', 'go-vet', 'go-build'], fallbacks: [] },
  ruby: { checks: ['ruby-test', 'ruby-lint'], fallbacks: [] },
  dotnet: { checks: ['dotnet-test', 'dotnet-build'], fallbacks: [] },
  rust: { checks: ['cargo-test', 'cargo-clippy', 'cargo-build'], fallbacks: [] },
  python: { checks: ['python-test', 'python-lint'], fallbacks: [] },
};

module.exports = { PROJECT_MANIFESTS, VERIFICATION_PROFILES };
