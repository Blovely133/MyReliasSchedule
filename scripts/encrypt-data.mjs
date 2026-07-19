import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const pin = process.env.MY_RELIAS_PIN;
if (!pin) throw new Error('Set MY_RELIAS_PIN before running this script.');

/* optional argv: output path — lets us publish a second copy under the
   scheduler PIN (e.g. node scripts/encrypt-data.mjs data/schedule-data.admin.enc.json) */
const inputPath = resolve('data/schedule-data.json');
const outputPath = resolve(process.argv[2] || 'data/schedule-data.enc.json');
const clear = await readFile(inputPath);
const salt = randomBytes(16);
const iv = randomBytes(12);
const iterations = 250_000;
const key = pbkdf2Sync(pin, salt, iterations, 32, 'sha256');
const cipher = createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]);

const payload = {
  version: 1,
  algorithm: 'AES-256-GCM',
  kdf: 'PBKDF2-SHA256',
  iterations,
  salt: salt.toString('base64'),
  iv: iv.toString('base64'),
  ciphertext: ciphertext.toString('base64'),
};

await writeFile(outputPath, JSON.stringify(payload));
console.log(`Encrypted schedule written to ${outputPath}`);
