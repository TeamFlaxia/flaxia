import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyDevicePlatform } from '../src/lib/device-platform.ts';

describe('classifyDevicePlatform', () => {
  it('detects Android before its Linux user-agent token', () => {
    assert.equal(
      classifyDevicePlatform({
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        platform: 'Linux armv8l',
      }),
      'android',
    );
  });

  it('detects Windows from client hints or the user agent', () => {
    assert.equal(classifyDevicePlatform({ userAgentDataPlatform: 'Windows' }), 'windows');
    assert.equal(
      classifyDevicePlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }),
      'windows',
    );
  });

  it('detects Linux desktops', () => {
    assert.equal(classifyDevicePlatform({ platform: 'Linux x86_64' }), 'linux');
    assert.equal(classifyDevicePlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }), 'linux');
  });

  it('returns other for macOS, iOS, and ChromeOS', () => {
    assert.equal(classifyDevicePlatform({ platform: 'MacIntel' }), 'other');
    assert.equal(
      classifyDevicePlatform({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      }),
      'other',
    );
    assert.equal(
      classifyDevicePlatform({
        userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36',
        platform: 'Linux x86_64',
      }),
      'other',
    );
  });
});
