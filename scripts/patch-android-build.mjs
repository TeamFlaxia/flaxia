import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const buildGradlePath = resolve('android/app/build.gradle');
if (!existsSync(buildGradlePath)) {
  console.log('build.gradle not found — skipping signing patch');
  process.exit(0);
}

const keystoreFile = process.env.ANDROID_KEYSTORE_FILE;
const keystorePassword = process.env.ANDROID_KEYSTORE_PASSWORD;
const keyAlias = process.env.ANDROID_KEY_ALIAS;
const keyPassword = process.env.ANDROID_KEY_PASSWORD;

if (!keystoreFile || !keystorePassword || !keyAlias || !keyPassword) {
  console.log('Missing signing env vars — skipping signing patch');
  process.exit(0);
}

let content = readFileSync(buildGradlePath, 'utf8');

content = content.replace(
  /android\s*\{/,
  `android {
    signingConfigs {
        release {
            storeFile file('${keystoreFile.replace(/'/g, "\\'")}')
            storePassword '${keystorePassword.replace(/'/g, "\\'")}'
            keyAlias '${keyAlias.replace(/'/g, "\\'")}'
            keyPassword '${keyPassword.replace(/'/g, "\\'")}'
        }
    }`,
);

content = content.replace(
  /^\s+release\s*\{$/m,
  `        release {
            signingConfig signingConfigs.release`,
);

writeFileSync(buildGradlePath, content);
console.log('Signing config patched into build.gradle');
