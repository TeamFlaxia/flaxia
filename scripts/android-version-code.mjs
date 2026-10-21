#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

export function androidVersionCode(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? '');
  if (!match) throw new Error(`Invalid Android release tag: ${tag}`);

  const [, majorText, minorText, patchText] = match;
  const [major, minor, patch] = [majorText, minorText, patchText].map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Release tag components must be safe integers: ${tag}`);
  }
  if (minor > 99 || patch > 9999) {
    throw new Error(`Release tag components exceed supported encoding: ${tag}`);
  }

  const versionCode = major * 1_000_000 + minor * 10_000 + patch;
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
    throw new Error(`Computed Android versionCode is invalid: ${versionCode}`);
  }
  return versionCode;
}

export function patchAndroidVersionCode(content, versionCode) {
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
    throw new Error(`ANDROID_VERSION_CODE is invalid: ${versionCode}`);
  }
  const defaultConfigPattern = /defaultConfig\s*\{/;
  if (!defaultConfigPattern.test(content)) {
    throw new Error('Could not locate defaultConfig in android/app/build.gradle');
  }
  const defaultConfigContent = content.match(/defaultConfig\s*\{([^}]*)\}/)?.[1] ?? '';
  if (/versionCode\s+\d+/.test(defaultConfigContent)) {
    return content.replace(/(defaultConfig\s*\{[^}]*?versionCode\s+)\d+/, `$1${versionCode}`);
  }
  return content.replace(defaultConfigPattern, (match) => `${match}\n        versionCode ${versionCode}`);
}

export function verifyAndroidBundleVersionCode(bundlePath, expectedVersionCode) {
  const bundletoolJar = process.env.BUNDLETOOL_JAR;
  const command = bundletoolJar ? 'java' : 'bundletool';
  const args = bundletoolJar
    ? ['-jar', bundletoolJar, 'dump', 'manifest', '--bundle', bundlePath, '--xpath', '/manifest/@android:versionCode']
    : ['dump', 'manifest', '--bundle', bundlePath, '--xpath', '/manifest/@android:versionCode'];
  const actual = execFileSync(command, args, { encoding: 'utf8' }).trim();
  if (actual !== String(expectedVersionCode)) {
    throw new Error(`Expected AAB versionCode ${expectedVersionCode}, got ${actual}`);
  }
  return actual;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'code' && args.length === 1) {
      console.log(androidVersionCode(args[0]));
    } else if (command === 'verify' && args.length === 2) {
      console.log(verifyAndroidBundleVersionCode(args[0], Number(args[1])));
    } else {
      throw new Error(
        'Usage: node scripts/android-version-code.mjs code vMAJOR.MINOR.PATCH | verify <aab> <expected-code>',
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
