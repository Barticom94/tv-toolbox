package local.adam.tvtoolbox;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/** Serves assets/ui at https://toolbox.invalid/ (a name that can never resolve, so the page has a real origin and the
 *  bridge is only ever reachable from our own files). Java does every network call, install and shell command; the page
 *  only draws. Keys go to the page as app.key(cmd); answers come back through js(). */
public class MainActivity extends Activity {
    static final String HOST = "toolbox.invalid";
    /** The page only draws: its own files, fonts, card icons from the store's Pages host, nothing else, no network of its own. */
    static final String CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; "
            + "img-src 'self' https://barticom94.github.io data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
    WebView web;
    Store store;
    Installer installer;

    static boolean ours(Uri u) { return "https".equals(u.getScheme()) && HOST.equals(u.getHost()); }

    /** A JS string literal. Android's messages are untrusted text; U+2028/2029 break string literals in older WebViews. */
    static String q(String s) { return JSONObject.quote(s).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"); }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        store = new Store(this);
        installer = new Installer(this, store, new Installer.Callback() {
            @Override public void progress(String id, int pct) { js("app.onProgress(" + q(id) + "," + pct + ")"); }
            @Override public void done(String id, boolean ok, String m) { js("app.onInstalled(" + q(id) + "," + ok + "," + q(m) + ")"); }
        });
        installer.cleanup();
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setTextZoom(100);                                 // the layout scales with the screen; the TV's font size is for its own menus
        WebView.setWebContentsDebuggingEnabled(true);       // CDP checks; whoever can attach already has ADB
        web.addJavascriptInterface(new Bridge(), "TV");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                if (!ours(r.getUrl())) return null;         // card icons come from the store's own host
                String path = r.getUrl().getPath();
                path = path == null || path.length() < 2 ? "index.html" : path.substring(1);
                try {
                    WebResourceResponse res = new WebResourceResponse(mime(path), "utf-8", getAssets().open("ui/" + path));
                    Map<String, String> h = new HashMap<>();
                    h.put("Cache-Control", "no-store");
                    h.put("Content-Security-Policy", CSP);
                    res.setResponseHeaders(h);
                    return res;
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, new ByteArrayInputStream(new byte[0]));
                }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !ours(r.getUrl());                   // never navigate away from our UI
            }
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                recreate();
                return true;
            }
        });
        setContentView(web);
        web.loadUrl("https://" + HOST + "/index.html");
    }

    static String mime(String p) {
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(p.substring(p.lastIndexOf('.') + 1));
        return m != null ? m : "application/octet-stream";
    }

    /** Runs code in the page, from any thread. */
    void js(String code) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    /** D-pad, OK/Enter and Back go to the page as app.key(cmd). Arrows repeat when held; OK and Back act once per press.
     *  Back leaves the app unless the page says it used it. */
    @Override public boolean dispatchKeyEvent(KeyEvent e) {
        String cmd;
        boolean move = true;
        switch (e.getKeyCode()) {
            case KeyEvent.KEYCODE_DPAD_UP: cmd = "up"; break;
            case KeyEvent.KEYCODE_DPAD_DOWN: cmd = "down"; break;
            case KeyEvent.KEYCODE_DPAD_LEFT: cmd = "left"; break;
            case KeyEvent.KEYCODE_DPAD_RIGHT: cmd = "right"; break;
            case KeyEvent.KEYCODE_DPAD_CENTER: case KeyEvent.KEYCODE_ENTER: case KeyEvent.KEYCODE_NUMPAD_ENTER:
                cmd = "ok"; move = false; break;
            case KeyEvent.KEYCODE_BACK: cmd = "back"; move = false; break;
            default: return super.dispatchKeyEvent(e);
        }
        if (e.getAction() == KeyEvent.ACTION_DOWN && web != null && (move || e.getRepeatCount() == 0)) {
            if (cmd.equals("back")) web.evaluateJavascript("app.key('back')", r -> { if (!"true".equals(r)) finish(); });
            else web.evaluateJavascript("app.key('" + cmd + "')", null);
        }
        return true;
    }

    // web.onPause() is deliberately not called: there is no video to pause, and install progress is pushed from Java via js(), not polled by page timers.
    @Override protected void onResume() {
        super.onResume();
        installer.onResume();                               // a held confirm screen starts only while we are in front
        js("window.app&&app.onResume()");
    }

    @Override protected void onPause() {
        installer.onPause();
        super.onPause();
    }

    @Override protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    class Bridge {
        /** What this TV is: the page decides which cards and tools make sense from it. */
        @JavascriptInterface public String device() {
            try {
                PackageManager pm = getPackageManager();
                return new JSONObject().put("sdk", Build.VERSION.SDK_INT).put("abis", new JSONArray(Build.SUPPORTED_ABIS))
                        .put("fireTv", pm.hasSystemFeature("amazon.hardware.fire_tv"))
                        .put("canInstall", pm.canRequestPackageInstalls())
                        .put("self", getPackageName())
                        .put("version", pm.getPackageInfo(getPackageName(), 0).versionName).toString();
            } catch (Exception e) { return "{}"; }
        }

        /** Answers with app.onCatalog(...): the catalogue (fresh, or the saved copy when offline) and what is installed from it. */
        @JavascriptInterface public void loadCatalog() {
            store.load(s -> js("app.onCatalog(" + s + ")"));   // s is org.json output: a JS object literal, never raw network text
        }

        /** Answers with app.onProgress(id, pct) while downloading, then app.onInstalled(id, ok, message) once. */
        @JavascriptInterface public void install(String id, String abi) { installer.install(id, abi); }

        @JavascriptInterface public void open(String pkg) {
            PackageManager pm = getPackageManager();
            Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
            if (i == null) i = pm.getLaunchIntentForPackage(pkg);
            if (i == null) return;
            try { startActivity(i); } catch (ActivityNotFoundException | SecurityException e) { /* nothing to open */ }
        }

        /** The system uninstall screen, and only for packages the catalogue names; the page reloads on app.onResume(). */
        @JavascriptInterface public void uninstall(String pkg) {
            if (!store.isCatalogPackage(pkg)) return;
            try { startActivity(new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg))); } catch (ActivityNotFoundException e) { /* no uninstaller */ }
        }

        /** The "Install unknown apps" screen for this app; false when this TV has no such screen. */
        @JavascriptInterface public boolean openInstallSettings() {
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
                return true;
            } catch (ActivityNotFoundException e) { return false; }
        }
    }
}
