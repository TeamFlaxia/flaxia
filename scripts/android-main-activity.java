package app.flaxia.app;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getBridge().getWebView().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Sandboxed game frames may navigate on their own origin.
                // Only top-level navigation may launch an external browser;
                // the sandbox must never become the privileged app document.
                if (!request.isForMainFrame()) return false;
                return super.shouldOverrideUrlLoading(view, request);
            }
        });
    }
}
