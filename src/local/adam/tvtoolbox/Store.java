package local.adam.tvtoolbox;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.function.Consumer;

/** The catalogue and what is installed from it. The catalogue is fetched over HTTPS, saved for offline use, parsed and
 *  re-serialised with org.json (the raw response never reaches the page), and answered together with the install state
 *  of every package it names. */
public class Store {
    static final String CATALOG_URL = "https://barticom94.github.io/tv-toolbox/catalog.json";
    static final long FRESH_MS = 10 * 60 * 1000;
    static final int MAX_BYTES = 8 << 20;                   // the catalogue is a few KB; anything this big is not ours
    private static final String EMPTY = "{\"catalog\":null,\"savedAt\":null,\"offline\":true,\"installed\":{}}";

    private final Context c;
    private volatile JSONObject catalog;                    // the last one loaded; read from other threads by the installer

    public Store(Context c) { this.c = c.getApplicationContext(); }

    /** Background thread; `done` gets the whole app.onCatalog argument (a JSON object text). Always answers. */
    public void load(Consumer<String> done) {
        new Thread(() -> {
            String s;
            try { s = answer(); } catch (Exception e) { s = EMPTY; }
            done.accept(s);
        }, "catalog").start();
    }

    /** One load at a time: a second call waits, then finds the copy just saved and reuses it. */
    private synchronized String answer() throws JSONException {
        SharedPreferences p = c.getSharedPreferences("store", Context.MODE_PRIVATE);
        File f = new File(c.getFilesDir(), "catalog.json");
        long savedAt = p.getLong("savedAt", 0), age = System.currentTimeMillis() - savedAt;
        boolean offline = false;
        JSONObject cat = savedAt > 0 && age >= 0 && age < FRESH_MS ? parse(read(f)) : null;
        if (cat == null) {
            cat = parse(fetch());
            if (cat != null) {
                savedAt = System.currentTimeMillis();
                save(f, cat, p, savedAt);
            } else {
                offline = true;
                cat = parse(read(f));
                if (cat == null) savedAt = 0;
            }
        }
        catalog = cat;
        String out = new JSONObject().put("catalog", cat == null ? JSONObject.NULL : cat)
                .put("savedAt", savedAt > 0 ? (Object) savedAt : JSONObject.NULL).put("offline", offline)
                .put("installed", installed(cat)).toString();
        return out.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");   // legal in JSON, not in older JS string literals
    }

    /** The app object for this id from the last loaded catalogue, or null. */
    public JSONObject entry(String id) {
        JSONObject cat = catalog;
        JSONArray apps = cat == null ? null : cat.optJSONArray("apps");
        for (int i = 0; apps != null && i < apps.length(); i++) {
            JSONObject a = apps.optJSONObject(i);
            if (a != null && id != null && id.equals(a.optString("id", null))) return a;
        }
        return null;
    }

    /** True when the last loaded catalogue names this package, as an app or as one it replaces. */
    public boolean isCatalogPackage(String pkg) { return pkg != null && packages(catalog).contains(pkg); }

    /** Lowercase hex SHA-256 of the installed package's signing certificate, or null when it is not installed. */
    public String installedSigner(String pkg) {
        try { return signer(c.getPackageManager().getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)); }
        catch (PackageManager.NameNotFoundException e) { return null; }
    }

    public static String sha256Hex(byte[] b) {
        try {
            StringBuilder sb = new StringBuilder();
            for (byte x : MessageDigest.getInstance("SHA-256").digest(b)) sb.append(String.format("%02x", x & 0xff));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }   // SHA-256 is always present
    }

    private static String signer(PackageInfo pi) {
        SigningInfo si = pi.signingInfo;
        Signature[] s = si == null ? null : si.getApkContentsSigners();
        return s == null || s.length == 0 ? "" : sha256Hex(s[0].toByteArray());
    }

    /** Only installed packages appear, so the page can tell "not installed" from "installed". */
    private JSONObject installed(JSONObject cat) throws JSONException {
        PackageManager pm = c.getPackageManager();
        JSONObject out = new JSONObject();
        for (String pkg : packages(cat)) {
            try {
                PackageInfo pi = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
                out.put(pkg, new JSONObject().put("code", pi.getLongVersionCode()).put("name", pi.versionName == null ? "" : pi.versionName)
                        .put("enabled", pi.applicationInfo.enabled).put("signer", signer(pi))
                        .put("launch", pm.getLeanbackLaunchIntentForPackage(pkg) != null || pm.getLaunchIntentForPackage(pkg) != null));
            } catch (PackageManager.NameNotFoundException e) { /* not installed: left out */ }
        }
        return out;
    }

    private static Set<String> packages(JSONObject cat) {
        Set<String> s = new LinkedHashSet<>();
        JSONArray apps = cat == null ? null : cat.optJSONArray("apps");
        for (int i = 0; apps != null && i < apps.length(); i++) {
            JSONObject a = apps.optJSONObject(i);
            if (a == null) continue;
            String p = a.optString("package", "");
            if (!p.isEmpty()) s.add(p);
            JSONArray r = a.optJSONArray("replaces");
            for (int j = 0; r != null && j < r.length(); j++) {
                String q = r.optString(j, "");
                if (!q.isEmpty()) s.add(q);
            }
        }
        return s;
    }

    /** A catalogue is a JSON object with an apps array that serialises back out; anything else is null. */
    private static JSONObject parse(String text) {
        if (text == null) return null;
        try {
            JSONObject o = new JSONObject(text);
            if (o.optJSONArray("apps") == null) return null;
            o.toString();                                   // throws on values org.json cannot write back (NaN)
            return o;
        } catch (JSONException e) { return null; }
    }

    private static String fetch() {
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL(CATALOG_URL).openConnection();
            h.setConnectTimeout(10000);
            h.setReadTimeout(10000);
            h.setUseCaches(false);
            if (h.getResponseCode() != 200) return null;
            try (InputStream in = h.getInputStream()) { return slurp(in); }
        } catch (IOException e) { return null; }
        finally { if (h != null) h.disconnect(); }
    }

    private static String read(File f) {
        try (FileInputStream in = new FileInputStream(f)) { return slurp(in); } catch (IOException e) { return null; }
    }

    private static String slurp(InputStream in) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        for (int n; (n = in.read(b)) > 0; ) {
            if (o.size() + n > MAX_BYTES) throw new IOException("too big");
            o.write(b, 0, n);
        }
        return new String(o.toByteArray(), StandardCharsets.UTF_8);
    }

    /** Written beside, then renamed in, so a half-written file never replaces the good copy. A failed save only costs the offline copy. */
    private static void save(File f, JSONObject cat, SharedPreferences p, long at) {
        File t = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(t)) {
            o.write(cat.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) { return; }
        if (t.renameTo(f)) p.edit().putLong("savedAt", at).apply();
    }
}
