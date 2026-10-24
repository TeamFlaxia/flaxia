import { readFileSync, writeFileSync } from 'node:fs';

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
