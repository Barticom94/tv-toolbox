package local.adam.tvtoolbox;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.os.StatFs;
import android.provider.Settings;
import android.util.Log;
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
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import static local.adam.tvtoolbox.AdbCommands.Cmd.*;

/** Serves assets/ui at https://toolbox.invalid/ (a name that can never resolve, so the page has a real origin and the
 *  bridge is only ever reachable from our own files). Java does every network call, install and shell command; the page
 *  only draws. Keys go to the page as app.key(cmd); answers come back through js(). */
public class MainActivity extends Activity {
    static final String HOST = "toolbox.invalid", TAG = "TVToolbox";
    /** The page only draws: its own files, fonts, card icons from the store's Pages host, nothing else, no network of its own. */
    static final String CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; "
            + "img-src 'self' https://barticom94.github.io data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    WebView web;
    Store store;
    Installer installer;
    Adb adb;
    Health health;
    /** Tools run one at a time, in the order the page asked, so answers to the same tool come back in order. */
    final ExecutorService tools = Executors.newSingleThreadExecutor();
    final AtomicBoolean connecting = new AtomicBoolean();
    /** An attempt failed (refused, timed out, no ADB): the TV's prompt is not asked again until the process restarts. */
    static volatile boolean adbGaveUp;
    /** The network check blocks for up to a minute, so it has its own thread and never holds up the tools. */
    final ExecutorService net = Executors.newSingleThreadExecutor();

    static boolean ours(Uri u) { return "https".equals(u.getScheme()) && HOST.equals(u.getHost()); }

    /** A JS string literal. Android's messages are untrusted text; U+2028/2029 break string literals in older WebViews. */
    static String q(String s) { return JSONObject.quote(s).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"); }

    /** org.json output ready to sit in a call to the page: legal JSON can still hold U+2028/2029, which older WebViews reject in JS. */
    static String esc(String json) { return json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"); }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        store = new Store(this);
        installer = new Installer(this, store, new Installer.Callback() {
            @Override public void progress(String id, int pct) { js("app.onProgress(" + q(id) + "," + pct + ")"); }
            @Override public void done(String id, boolean ok, String m) { js("app.onInstalled(" + q(id) + "," + ok + "," + q(m) + ")"); }
        });
        installer.cleanup();
        adb = new Adb(this);
        health = new Health(this, store, adb);
        connectTools();
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
            /** connectTools' answer can land before app.js has run (an approved loopback connect takes under a second). */
            @Override public void onPageFinished(WebView v, String url) { js("window.app&&app.onTools(" + adb.connected() + ")"); }
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
            if (cmd.equals("back")) web.evaluateJavascript("app.key('back')", r -> {
                if ("true".equals(r)) return;
                if (installer.active()) moveTaskToBack(true);   // finish() would orphan the install; this way it carries on
                else finish();
            });
            else web.evaluateJavascript("app.key('" + cmd + "')", null);
        }
        return true;
    }

    // web.onPause() is deliberately not called: there is no video to pause, and install progress is pushed from Java via js(), not polled by page timers.
    @Override protected void onResume() {
        super.onResume();
        installer.onResume();                               // a held confirm screen starts only while we are in front
        js("window.app&&app.onResume()");
        if (!adb.connected()) connectTools();
    }

    @Override protected void onPause() {
        installer.onPause();
        super.onPause();
    }

    @Override protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        health.close();
        net.shutdownNow();
        tools.execute(adb::close);                          // after any tool still running; the next launch connects afresh
        tools.shutdown();
        super.onDestroy();
    }

    /** This TV's own ADB, in the background, answered with app.onTools(ok). One attempt at a time: a call while one is
     *  running gets that attempt's answer (onCreate and the onResume right after it, or the TV's prompt pausing us).
     *  Only a TV with health.json (Adam's, pushed from his PC) tries, and only until an attempt fails, so a family TV
     *  left with USB debugging on never shows "Allow USB debugging?". No answer when it doesn't try: Tools stay off. */
    void connectTools() {
        if (adbGaveUp || health.file() == null) return;
        if (!connecting.compareAndSet(false, true)) return;
        tools.execute(() -> {
            boolean ok = adb.connected() || adb.connect();
            if (!ok) adbGaveUp = true;
            connecting.set(false);
            js("window.app&&app.onTools(" + ok + ")");
        });
    }

    /** One tool's answer as JSON text: "ok":true with "text" (the shell's output) and the tool's own fields, or
     *  "ok":false with "error". Tools thread. */
    String tool(String name, String arg) {
        try {
            JSONObject o = new JSONObject();
            switch (name == null ? "" : name) {
                case "meminfo": {
                    ActivityManager.MemoryInfo m = new ActivityManager.MemoryInfo();
                    ((ActivityManager) getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(m);
                    o.put("text", adb.run(MEMINFO, null)).put("avail", m.availMem).put("total", m.totalMem);
                    break;
                }
                case "userApps": o.put("text", adb.run(USER_APPS, null)); break;
                case "killAll": o.put("text", adb.run(KILL_ALL, null)); break;
                case "stopApp": o.put("text", adb.run(Build.VERSION.SDK_INT < 34 ? FORCE_STOP : STOP_APP, arg)); break;  // stop-app is new in 14
                case "forceStop": o.put("text", adb.run(FORCE_STOP, arg)); break;
                case "diskstats": o.put("text", adb.run(DISKSTATS, null)).put("free", freeBytes()); break;
                case "trimCaches": {
                    long before = freeBytes();
                    adb.run(TRIM, null);
                    o.put("before", before).put("after", freeBytes());
                    break;
                }
                case "clearCache":
                    if (Build.VERSION.SDK_INT < 34) throw new IOException("Needs Android 14");
                    o.put("text", adb.run(CLEAR_CACHE, arg));
                    break;
                case "reboot": o.put("text", adb.run(REBOOT, null)); break;
                case "expiryGet": o.put("text", adb.run(EXPIRY_GET, null).trim()); break;
                case "expiryOff": o.put("text", adb.run(EXPIRY_OFF, null)); break;
                case "home": {
                    ResolveInfo r = getPackageManager().resolveActivity(
                            new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY);
                    if (r == null || r.activityInfo == null) throw new IOException("No home app");
                    o.put("text", r.activityInfo.packageName);
                    break;
                }
                case "ime": o.put("text", adb.run(IME, null).trim()); break;
                case "ping": o.put("text", adb.run(PING, "gateway".equals(arg) ? gateway() : "internet".equals(arg) ? "1.1.1.1" : null)); break;
                case "vpnApps": {                           // apps that can run a VPN: Close background apps never stops them
                    Set<String> vpn = new TreeSet<>();
                    for (ResolveInfo r : getPackageManager().queryIntentServices(new Intent(VpnService.SERVICE_INTERFACE), 0))
                        if (r.serviceInfo != null) vpn.add(r.serviceInfo.packageName);
                    o.put("apps", new JSONArray(vpn));
                    break;
                }
                default: throw new IllegalArgumentException("Unknown tool");
            }
            return o.put("ok", true).toString();
        } catch (Exception e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            String m = e.getMessage();
            Log.w(TAG, "tool " + name + " failed: " + e.getClass().getSimpleName() + (m != null ? ": " + m : ""));   // no tool takes a URL
            return "{\"ok\":false,\"error\":" + JSONObject.quote(m != null ? m : e.getClass().getSimpleName()) + "}";
        }
    }

    static long freeBytes() { return new StatFs("/data").getAvailableBytes(); }

    /** The IPv4 router on the default route, or null (which ping refuses). */
    String gateway() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        return Health.gateway(cm.getLinkProperties(cm.getActiveNetwork()));
    }

    SharedPreferences toolPrefs() { return getSharedPreferences("tools", MODE_PRIVATE); }

    class Bridge {
        /** What this TV is: the page decides which cards and tools make sense from it. */
        @JavascriptInterface public String device() {
            try {
                PackageManager pm = getPackageManager();
                return new JSONObject().put("sdk", Build.VERSION.SDK_INT).put("abis", new JSONArray(Build.SUPPORTED_ABIS))
                        .put("fireTv", pm.hasSystemFeature("amazon.hardware.fire_tv"))
                        .put("canInstall", pm.canRequestPackageInstalls())
                        .put("healthFile", health.file() != null)
                        .put("self", getPackageName())
                        .put("version", pm.getPackageInfo(getPackageName(), 0).versionName).toString();
            } catch (Exception e) { return "{}"; }
        }

        /** Answers with app.onCatalog(...): the catalogue (fresh, or the saved copy when offline) and what is installed from it. */
        @JavascriptInterface public void loadCatalog() {
            store.load(s -> js("app.onCatalog(" + s + ")"));   // s is org.json output: a JS object literal, never raw network text
        }

        /** Answers with app.onProgress(id, pct) while downloading, then app.onInstalled(id, ok, message) once. A request made
         *  while another install is running can go unanswered, so the page never sends one: it queues and calls nudge(). */
        @JavascriptInterface public void install(String id, String abi) { installer.install(id, abi); }

        /** A card pressed while the page's queue is busy: a confirm screen left with Home comes back. No answer. */
        @JavascriptInterface public void nudge() { runOnUiThread(installer::nudge); }

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

        /** Answers with app.onTools(ok), unless this TV doesn't try (see connectTools above). */
        @JavascriptInterface public void connectTools() { MainActivity.this.connectTools(); }

        /** Answers with app.onResult(name, json). Only stopApp, forceStop, clearCache and ping read arg (a package name, or
         *  "gateway"/"internet"); every other tool gets null, whatever the page passed. */
        @JavascriptInterface public void tool(String name, String arg) {
            boolean takesArg = "stopApp".equals(name) || "forceStop".equals(name) || "clearCache".equals(name) || "ping".equals(name);
            tools.execute(() -> js("app.onResult(" + q(name == null ? "" : name) + ","
                    + MainActivity.this.tool(name, takesArg ? arg : null).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029") + ")"));
        }

        /** The text of health.json (the checks file on this TV), or null when it is missing. The page validates it. */
        @JavascriptInterface public String healthText() { return health.healthText(); }

        /** Runs the built-in rows and then checksJson, the page's validated checks: app.onHealthRow(row) per row in order, then
         *  app.onResult("healthDone", {}). Java refuses any check that isn't https or of a known type. */
        @JavascriptInterface public void health(String checksJson) {
            health.run(checksJson, r -> js("app.onHealthRow(" + esc(r) + ")"), () -> js("app.onResult(\"healthDone\",{})"));
        }

        /** Answers with app.onResult("network", json) after up to a minute; hostsJson = a JSON array of extra hosts to look up. */
        @JavascriptInterface public void network(String hostsJson) {
            net.execute(() -> js("app.onResult(\"network\"," + esc(health.network(hostsJson)) + ")"));
        }

        /** The saved "Never close" list as a JSON array, or null before the page has saved one (the page then fills in defaults). */
        @JavascriptInterface public String keepList() { return toolPrefs().getString("keep", null); }

        /** Saves a JSON array of package names and returns the list now saved; anything else is refused and the old list returned. */
        @JavascriptInterface public String setKeepList(String json) {
            try {
                JSONArray a = new JSONArray(json);
                for (int i = 0; i < a.length(); i++)
                    if (!(a.get(i) instanceof String) || !AdbCommands.isPackage(a.getString(i))) return keepList();
                toolPrefs().edit().putString("keep", a.toString()).apply();
                return a.toString();
            } catch (Exception e) { return keepList(); }
        }
    }
}
