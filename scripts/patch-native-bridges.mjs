import { readFileSync, writeFileSync } from 'node:fs';

// Capacitor 8's config reader calls the compiler API removed in TypeScript 7.
// Node 22 loads this type-only TS config without that compiler API.
const cli = 'node_modules/@capacitor/cli/dist/config.js';
const cliSource = readFileSync(cli, 'utf8');
const configReader = 'const extConfigObject = (0, node_1.requireTS)(ts, extConfigFilePath);';
const nativeReader =
  "const extConfigObject = await import(require('node:url').pathToFileURL(extConfigFilePath).href); // Flaxia: Node type stripping";
if (!cliSource.includes(configReader) && !cliSource.includes(nativeReader))
  throw new Error('Capacitor config loader changed; review TypeScript compatibility');
writeFileSync(cli, cliSource.replace(configReader, nativeReader));

// Sandboxed games must not invoke native plugins, including through Capacitor's
// legacy Android fallback or WKScriptMessageHandler in a child frame.
const android = 'node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/MessageHandler.java';
const androidSource = readFileSync(android, 'utf8');
const androidPatched = androidSource.replaceAll(
  'webView.addJavascriptInterface(this, "androidBridge");',
  'Logger.error("A current Android System WebView is required for secure plugin access");',
);
if (!androidPatched.includes('secure plugin access'))
  throw new Error('Capacitor Android bridge changed; review isolation');
writeFileSync(android, androidPatched);

const ios = 'node_modules/@capacitor/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift';
const iosSource = readFileSync(ios, 'utf8');
const signature =
  'open func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {';
if (!iosSource.includes(signature)) throw new Error('Capacitor iOS bridge changed; review isolation');
const guard = '\n        guard message.frameInfo.isMainFrame else { return } // Flaxia: no game plugin access';
writeFileSync(ios, iosSource.includes(guard) ? iosSource : iosSource.replace(signature, signature + guard));
