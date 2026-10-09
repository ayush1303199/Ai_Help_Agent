const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { authorizeAppOwnedMutation } = require('./appOwnedPersistence.cjs');

const MAX_SECRET_BYTES = 16 * 1024;
const SECRET_ID = /^(?:provider-instance:[A-Za-z0-9._:-]{1,160}|[a-z0-9._:-]{1,80})$/i;

class ProviderSecretVault {
  constructor({ storageDirectory, safeStorage, fileSystem = fs }) {
    if (!storageDirectory) throw new TypeError('Secure provider storage directory is required.');
    this.storageDirectory = path.resolve(storageDirectory);
    this.safeStorage = safeStorage || null;
    this.fileSystem = fileSystem;
    this.filePath = path.join(this.storageDirectory, 'provider-secrets.enc.json');
  }

  _assertAvailable() {
    if (!this.safeStorage || typeof this.safeStorage.isEncryptionAvailable !== 'function'
      || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed secure storage is unavailable; provider credentials were not saved.');
    }
  }

  assertAvailable() {
    return Boolean(this.safeStorage
      && typeof this.safeStorage.isEncryptionAvailable === 'function'
      && this.safeStorage.isEncryptionAvailable());
  }

  _normalize(secrets) {
    if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
      throw new TypeError('Provider secrets must be an object.');
    }
    const normalized = {};
    for (const [key, value] of Object.entries(secrets)) {
      if (!SECRET_ID.test(key) || typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
        throw new TypeError('Provider secret entry is invalid.');
      }
      if (value) normalized[key] = value;
    }
    return normalized;
  }

  async readAll() {
    let raw;
    try {
      raw = await this.fileSystem.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw new Error('Could not read secure provider credentials.', { cause: error });
    }
    this._assertAvailable();
    let envelope;
    try {
      envelope = JSON.parse(raw);
      if (envelope?.version !== 1 || typeof envelope.payload !== 'string') throw new Error('Invalid vault format.');
      const decrypted = this.safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'));
      return this._normalize(JSON.parse(decrypted));
    } catch (error) {
      throw new Error('Could not decrypt secure provider credentials.', { cause: error });
    }
  }

  async writeAll(secrets) {
    this._assertAvailable();
    const normalized = this._normalize(secrets);
    const payload = this.safeStorage.encryptString(JSON.stringify(normalized)).toString('base64');
    const content = JSON.stringify({ version: 1, payload });
    await authorizeAppOwnedMutation({
      root: this.storageDirectory,
      target: this.filePath,
      resource: 'credential',
      operation: 'replace',
    });
    await this.fileSystem.mkdir(this.storageDirectory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      await authorizeAppOwnedMutation({
        root: this.storageDirectory,
        target: temporaryPath,
        resource: 'credential',
        operation: 'write',
      });
      await this.fileSystem.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await authorizeAppOwnedMutation({
        root: this.storageDirectory,
        target: this.filePath,
        resource: 'credential',
        operation: 'replace',
      });
      await this.fileSystem.rename(temporaryPath, this.filePath);
    } catch (error) {
      await authorizeAppOwnedMutation({
        root: this.storageDirectory,
        target: temporaryPath,
        resource: 'credential',
        operation: 'remove',
      });
      await this.fileSystem.rm(temporaryPath, { force: true });
      throw new Error('Could not persist secure provider credentials.', { cause: error });
    }
    console.info(JSON.stringify({
      event: 'app_persistence_mutation',
      resource: 'provider_secrets',
      operation: 'write',
      count: Object.keys(normalized).length,
    }));
  }
}

module.exports = { ProviderSecretVault };
