package local.adam.tvtoolbox;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.StatFs;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

/** Downloads a catalogue APK, checks it byte for byte (SHA-256) and by signer, then installs that same file through a
 *  PackageInstaller session, falling back once to the system Install screen. One install at a time, and every install
 *  that starts ends with exactly one done() (finish() is the only way out). Spec 5.3. */
public class Installer {
    public interface Callback { void progress(String id, int pct); void done(String id, boolean ok, String message); }

    static final String AUTHORITY = "local.adam.tvtoolbox.apk", MIME = "application/vnd.android.package-archive";
    static final String BUSY = "Another install is running", NO_SPACE = "Not enough space on this TV",
            DOWNLOAD = "Download failed, try again", MISMATCH = "This download doesn't match, not installing", FAILED = "Install failed";
    static final long MARGIN = 50L << 20;
    static final int RETRIES = 3;
    static final long STALE_MS = 5000;      // in front this long with a confirm screen unanswered: it was left with Home

    /** The live installer, for the manifest receiver (the activity is single-instance). */
    static volatile Installer current;

    /** One install. Everything it needs is copied from the catalogue entry once, so a reload mid-install changes nothing. */
    private static final class Job {
        final String id, pkg, signer, sha, url;
        final long size, code;
        final File apk;
        volatile int session = -1;          // this install's session; -1 = none, so no session result matches
        Intent held;                        // main thread only: a screen waiting for the activity to come to the front
        Intent confirm;                     // main thread only: the confirm screen started, until the session answers again
        boolean fellBack, viewShown;        // main thread only: the fallback was used / its screen started

        Job(String id, JSONObject e, JSONObject f, File apk) {
            this.id = id;
            this.apk = apk;
            pkg = e.optString("package", "");
            signer = e.optString("signer", "").toLowerCase(Locale.ROOT);
            sha = f.optString("sha256", "").toLowerCase(Locale.ROOT);
            url = f.optString("url", "");
            size = f.optLong("size", 0);
            code = f.optLong("versionCode", e.optLong("versionCode", Long.MAX_VALUE));
        }

        boolean valid() {
            return pkg.matches("[A-Za-z0-9_.]+") && signer.matches("[0-9a-f]{64}") && sha.matches("[0-9a-f]{64}")
                    && size > 0 && url.startsWith("https://");
        }
    }

    private final Activity a;
    private final Store store;
    private final Callback cb;
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final AtomicReference<Job> running = new AtomicReference<>();
    private boolean front;                  // main thread only: the activity is resumed
    private long frontSince;                // main thread only: elapsedRealtime of the last onResume

    public Installer(Activity a, Store s, Callback cb) {
        this.a = a;
        this.store = s;
        this.cb = cb;
        current = this;
    }

    /** From the bridge. Answers with progress() while downloading, then one done(). A request made while another install
     *  is running can go unanswered (busy()); the page never sends one, it queues the card and calls nudge() instead. */
    public void install(String id, String abi) {
        Job j = job(id, abi);
        if (j == null) { cb.done(id, false, FAILED); return; }
        if (!running.compareAndSet(null, j)) { a.runOnUiThread(() -> busy(id)); return; }
        exec.execute(() -> {
            try { run(j); } catch (Throwable t) { finish(j, false, FAILED); }
        });
    }

    /** Main thread: a request while another install runs. If that install's confirm screen was started, the session hasn't
     *  answered, and we have been in front for STALE_MS, the screen was left with Home: show it again (same session, never
     *  abandoned, since an approved install may still be running) and give this request no answer. */
    private void busy(String id) {
        Job j = running.get();
        if (left(j)) show(j, j.confirm); else cb.done(id, false, BUSY);
    }

    /** An install is downloading, installing or waiting on its confirm screen. */
    public boolean active() { return running.get() != null; }

    /** Main thread, from the page: a card was pressed while its own queue is busy. Shows a confirm screen left with Home
     *  again, as busy() does. Never answers. */
    public void nudge() {
        Job j = running.get();
        if (left(j)) show(j, j.confirm);
    }

    /** Main thread. This job's confirm screen was started, the session hasn't answered, and we have been in front for STALE_MS. */
    private boolean left(Job j) {
        return j != null && j.confirm != null && front && SystemClock.elapsedRealtime() - frontSince >= STALE_MS;
    }

    /** The job for this id and abi, or null when the entry, its file or any value the checks need is missing, or the URL isn't HTTPS. */
    private Job job(String id, String abi) {
        if (id == null || !id.matches("[A-Za-z0-9_-]+") || abi == null) return null;   // the id names a cache file
        JSONObject e = store.entry(id);                                                  // once: the reference is kept
        JSONArray files = e == null ? null : e.optJSONArray("files");
        for (int i = 0; files != null && i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f != null && abi.equals(f.optString("abi", null))) {
                // Its own file: a job left running by a closed activity never shares bytes with a new one between verify and commit.
                Job j = new Job(id, e, f, new File(a.getCacheDir(), id + "-" + System.nanoTime() + ".apk"));
                return j.valid() ? j : null;
            }
        }
        return null;
    }

    private void run(Job j) throws Exception {
        if (new StatFs(a.getCacheDir().getPath()).getAvailableBytes() < j.size + MARGIN) { finish(j, false, NO_SPACE); return; }
        if (!download(j)) { finish(j, false, DOWNLOAD); return; }
        if (!verified(j)) { finish(j, false, MISMATCH); return; }
        commit(j);
    }

    /** True once exactly `size` bytes are on disk. A drop resumes with Range on the next try. */
    private boolean download(Job j) throws InterruptedException {
        int[] last = {-1};
        for (int tries = 0; tries <= RETRIES; tries++) {
            if (tries > 0) Thread.sleep(2000L * tries);
            try { if (fetch(j, last)) return true; } catch (IOException e) { /* resumed by the next try */ }
        }
        return false;
    }

    /** One request: appends on a matching 206, starts over on 200, throws on anything else. */
    private boolean fetch(Job j, int[] last) throws IOException {
        long have = j.apk.length();
        HttpURLConnection h = (HttpURLConnection) new URL(j.url).openConnection();   // follows redirects
        try {
            h.setConnectTimeout(15000);
            h.setReadTimeout(30000);
            h.setUseCaches(false);
            h.setRequestProperty("Accept-Encoding", "identity");   // never gzip-decoded, so byte offsets for Range stay the file's
            if (have > 0) h.setRequestProperty("Range", "bytes=" + have + "-");
            int code = h.getResponseCode();
            if (!"https".equals(h.getURL().getProtocol())) throw new IOException("redirected off HTTPS");
            boolean resume = have > 0 && code == 206 && String.valueOf(h.getHeaderField("Content-Range")).startsWith("bytes " + have + "-");
            if (!resume && code != 200) { j.apk.delete(); throw new IOException("HTTP " + code); }
            if (!resume) have = 0;
            try (InputStream in = h.getInputStream(); OutputStream o = new FileOutputStream(j.apk, resume)) {
                byte[] b = new byte[1 << 16];
                for (int n; (n = in.read(b)) > 0; ) {
                    if (have + n > j.size) { j.apk.delete(); throw new IOException("bigger than the catalogue says"); }
                    o.write(b, 0, n);
                    have += n;
                    int pct = (int) (have * 100 / j.size);
                    if (pct != last[0]) cb.progress(j.id, last[0] = pct);
                }
            }
            return have == j.size;
        } finally { h.disconnect(); }
    }

    /** The file is the catalogue's to the byte, signed by the catalogue's signer alone, and by the installed app's when there is one.
     *  The checksum comes first, so only the catalogue's exact file is ever parsed. */
    private boolean verified(Job j) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(j.apk)) {
            byte[] b = new byte[1 << 16];
            for (int n; (n = in.read(b)) > 0; ) md.update(b, 0, n);
        }
        if (!j.sha.equals(String.format("%064x", new BigInteger(1, md.digest())))) return false;
        PackageManager pm = a.getPackageManager();
        String path = j.apk.getPath();
        PackageInfo p = pm.getPackageArchiveInfo(path, PackageManager.GET_SIGNING_CERTIFICATES);
        Signature[] s = p != null && p.signingInfo != null ? p.signingInfo.getApkContentsSigners() : null;
        if (s == null) {                                    // API 28 leaves signingInfo empty for archives
            p = pm.getPackageArchiveInfo(path, PackageManager.GET_SIGNATURES);
            s = p == null ? null : p.signatures;
        }
        if (p == null || s == null || s.length != 1 || !j.pkg.equals(p.packageName)) return false;
        String got = Store.sha256Hex(s[0].toByteArray()), inst = store.installedSigner(j.pkg);
        return got.equals(j.signer) && (inst == null || got.equalsIgnoreCase(inst));   // installed with no signer ("") fails
    }

    /** Executor thread. Any failure before the commit goes to the fallback; after it, the session's result ends the install. */
    private void commit(Job j) {
        PackageInstaller pi = a.getPackageManager().getPackageInstaller();
        boolean committed = false;
        try {
            PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            p.setAppPackageName(j.pkg);
            if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            j.session = pi.createSession(p);
            try (PackageInstaller.Session s = pi.openSession(j.session)) {
                try (OutputStream o = s.openWrite("base.apk", 0, j.apk.length()); InputStream in = new FileInputStream(j.apk)) {
                    byte[] b = new byte[1 << 16];
                    for (int n; (n = in.read(b)) > 0; ) o.write(b, 0, n);
                    s.fsync(o);
                }
                s.commit(PendingIntent.getBroadcast(a, 0, new Intent(a, Result.class),
                        PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT).getIntentSender());
                committed = true;
            }
        } catch (Exception e) {
            if (!committed) a.runOnUiThread(() -> fallback(j));
        }
    }

    /** Main thread. The system Install screen, reading the verified file through ApkProvider. Once per install:
     *  a second call means the fallback itself failed, which ends the install. */
    private void fallback(Job j) {
        if (running.get() != j) return;
        if (j.fellBack) { finish(j, false, FAILED); return; }
        j.fellBack = true;
        int sid = j.session;
        j.session = -1;                                     // results from that session no longer count
        j.confirm = null;                                   // nor does its confirm screen: nudge() must not show it again
        if (sid != -1) try { a.getPackageManager().getPackageInstaller().abandonSession(sid); } catch (RuntimeException e) { /* already gone */ }
        Intent v = new Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse("content://" + AUTHORITY + "/" + j.apk.getName()), MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        // Only the system's own installer gets the read grant, never another app that claims APKs.
        List<ResolveInfo> r = a.getPackageManager().queryIntentActivities(v, PackageManager.MATCH_SYSTEM_ONLY | PackageManager.MATCH_DEFAULT_ONLY);
        if (r.isEmpty()) { finish(j, false, FAILED); return; }
        show(j, v.setPackage(r.get(0).activityInfo.packageName));
    }

    /** Main thread. Starts a confirm or Install screen now when we are in front, else on the next onResume(). */
    private void show(Job j, Intent i) {
        if (!front) { j.held = i; return; }
        try {
            a.startActivity(i);
            if (j.fellBack) j.viewShown = true; else j.confirm = i;
        } catch (RuntimeException e) { fallback(j); }       // ActivityNotFoundException and friends
    }

    /** From MainActivity.onResume. Back from the fallback screen, the install ends with what is installed now. */
    public void onResume() {
        front = true;
        frontSince = SystemClock.elapsedRealtime();
        Job j = running.get();
        if (j == null) return;
        if (j.viewShown) {
            boolean ok = installedNow(j);
            finish(j, ok, ok ? "" : FAILED);
            return;
        }
        Intent i = j.held;
        j.held = null;
        if (i != null) show(j, i);
    }

    /** From MainActivity.onPause. */
    public void onPause() { front = false; }

    /** From onCreate: APKs left by an earlier run (a killed download, a fallback screen the app never came back from). */
    public void cleanup() {
        File[] fs = a.getCacheDir().listFiles((d, n) -> n.endsWith(".apk"));
        for (int i = 0; fs != null && i < fs.length; i++) fs[i].delete();
    }

    /** The fallback screen gives no result, so read what it left: this version or newer, from the catalogue's signer. */
    private boolean installedNow(Job j) {
        try {
            return a.getPackageManager().getPackageInfo(j.pkg, 0).getLongVersionCode() >= j.code && j.signer.equalsIgnoreCase(store.installedSigner(j.pkg));
        } catch (PackageManager.NameNotFoundException e) { return false; }
    }

    /** The one way an install ends: frees the slot, deletes the APK, answers once. While the fallback screen is up nothing
     *  calls this; once we are back in front, the system installer has its own copy. */
    private void finish(Job j, boolean ok, String message) {
        if (!running.compareAndSet(j, null)) return;
        j.apk.delete();
        cb.done(j.id, ok, message);
    }

    /** Main thread. */
    private void result(Intent i) {
        Job j = running.get();
        int sid = i.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        if (j == null || sid == -1 || sid != j.session) return;   // another install's session, or one we left for the fallback
        j.confirm = null;                                   // the session answered: any confirm screen started earlier is done with
        int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm == null) fallback(j);
            else show(j, confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } else if (status == PackageInstaller.STATUS_SUCCESS) {
            finish(j, true, "");
        } else {
            String m = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            finish(j, false, m == null || m.isEmpty() ? FAILED : m);
        }
    }

    /** PackageInstaller's answers. Not exported: only the system, through our PendingIntent, can send it. */
    public static class Result extends BroadcastReceiver {
        @Override public void onReceive(Context c, Intent i) {
            Installer in = current;
            if (in != null) in.result(i);                   // null: the process restarted, the install is gone
        }
    }
}
