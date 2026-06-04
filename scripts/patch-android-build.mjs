import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// launcher icons (generate from assets/icon.png via capacitor-assets)
try {
  execSync('npx capacitor-assets generate --android --assetPath assets', {
    stdio: 'pipe',
    timeout: 30000,
  });
  console.log('Generated Android launcher icons');
} catch {
  // non-fatal: icons may already exist or tool may not be installed
  console.log('Skipped launcher icon generation');
}

// notification small icon (always ensure it exists, even in CI fresh checkout)
const drawableDir = resolve('android/app/src/main/res/drawable');
const iconPath = resolve(drawableDir, 'ic_notification.xml');
mkdirSync(drawableDir, { recursive: true });
if (!existsSync(iconPath)) {
  writeFileSync(
    iconPath,
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n' +
      '    android:width="24dp" android:height="24dp"\n' +
      '    android:viewportWidth="24" android:viewportHeight="24">\n' +
      '  <path android:fillColor="#FFFFFF"\n' +
      '        android:pathData="M12,22c1.1,0 2,-0.9 2,-2h-4c0,1.1 0.89,2 2,2zM18,16v-5c0,-3.07 -1.64,-5.64 -4.5,-6.32V4c0,-0.83 -0.67,-1.5 -1.5,-1.5s-1.5,0.67 -1.5,1.5v0.68C7.63,5.36 6,7.92 6,11v5l-2,2v1h16v-1l-2,-2z"/>\n' +
      '</vector>\n',
  );
  console.log('Created notification icon');
}

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
  /(buildTypes\s*\{[^}]*?release\s*\{)/,
  '$1\n            signingConfig signingConfigs.release',
);

writeFileSync(buildGradlePath, content);
console.log('Signing config patched into build.gradle');
