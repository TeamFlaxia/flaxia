import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

// notification small icon — now uses ic_launcher_foreground (generated above)
// no separate icon needed

const buildGradlePath = resolve('android/app/build.gradle');
if (!existsSync(buildGradlePath)) {
  console.log('build.gradle not found — skipping patches');
  process.exit(0);
}

let content = readFileSync(buildGradlePath, 'utf8');

// APK output filename
if (!content.includes('flaxia_install')) {
  content = content.replace(
    /(android\s*\{)/,
    `$1
    applicationVariants.all { variant ->
        variant.outputs.all {
            outputFileName = "flaxia_install.apk"
        }
    }`,
  );
  console.log('Patched APK output filename');
}

const keystoreFile = process.env.ANDROID_KEYSTORE_FILE;
const keystorePassword = process.env.ANDROID_KEYSTORE_PASSWORD;
const keyAlias = process.env.ANDROID_KEY_ALIAS;
const keyPassword = process.env.ANDROID_KEY_PASSWORD;

if (keystoreFile && keystorePassword && keyAlias && keyPassword) {
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
  console.log('Signing config patched into build.gradle');
} else {
  console.log('Missing signing env vars — skipping signing patch');
}

writeFileSync(buildGradlePath, content);
