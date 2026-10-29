package local.adam.tvtoolbox;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.util.Base64;

import com.tananaev.adblib.AdbBase64;
import com.tananaev.adblib.AdbConnection;
import com.tananaev.adblib.AdbCrypto;
import com.tananaev.adblib.AdbStream;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/** This TV's own ADB over loopback, for the Tools screen. Only AdbCommands lines are ever sent. The first connect makes
 *  the TV ask "Allow USB debugging?"; Adam answers it himself. Calls block: run them off the UI thread. */
public class Adb {
    static final int PORT = 5555;                           // fixed: service.adb.tcp.port is not readable by apps
    private final Context c;
    private AdbCrypto key;
    private volatile AdbConnection conn;                    // null until connected; volatile so connected() needs no lock

    public Adb(Context c) { this.c = c.getApplicationContext(); }

    /** Safe from the UI thread: never waits for a connect in progress. */
    public boolean connected() { return conn != null; }

    /** 127.0.0.1:5555 with a 3 s connect timeout, then up to 60 s for the TV's prompt to be answered. */
    public synchronized boolean connect() {
        close();
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress("127.0.0.1", PORT), 3000);
            AdbConnection a = AdbConnection.create(s, key());
            if (a.connect(60, TimeUnit.SECONDS, false)) { conn = a; return true; }
            a.close();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) { /* no ADB on this TV, or the prompt was refused */ }
        try { s.close(); } catch (IOException ignored) { }
        return false;
    }

    /** The command's whole output. One reconnect when the connection has died since the last call. */
    public synchronized String run(AdbCommands.Cmd cmd, String arg) throws IOException, InterruptedException {
        String line = "shell:" + AdbCommands.build(cmd, arg, installedPackages());
        if (conn == null) throw new IOException("Not connected");
        AdbStream st;
        try { st = open(line); }
        catch (IOException | IllegalStateException e) {    // reader thread gone (IllegalStateException) or the OPEN write failed: never sent
            if (!connect()) throw new IOException("Not connected");
            st = open(line);
        }
        if (st == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try {
            // ponytail: no read timeout; dumpsys has its own per-service timeout, add a watchdog if a command ever hangs
            while (true) { byte[] d = st.read(); out.write(d, 0, d.length); }
        } catch (IOException end) { /* the shell closed the stream: that is the end of the output */ }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    /** null when adblib calls the open "rejected". An authorised adbd never rejects shell:, so that is adblib's missed
     *  notify (an OKAY landing before open() waits): it then wakes only at the shell's CLSE and, for a command that printed
     *  nothing, the stream is already closed. The command ran, so it must not run again (kill-all, reboot, settings put).
     *  ponytail: a connection dying mid-open also lands here as ""; the next call's IllegalStateException reconnects. */
    private AdbStream open(String line) throws IOException, InterruptedException {
        try { return conn.open(line); } catch (ConnectException e) { return null; }
    }

    public Set<String> installedPackages() {
        Set<String> s = new HashSet<>();
        for (PackageInfo p : c.getPackageManager().getInstalledPackages(0)) s.add(p.packageName);
        return s;
    }

    public synchronized void close() {
        AdbConnection a = conn;
        conn = null;
        if (a != null) try { a.close(); } catch (IOException ignored) { }
    }

    /** Kept in getFilesDir() as adbkey / adbkey.pub so the TV's approval lasts; made on first use. */
    private AdbCrypto key() throws Exception {
        if (key != null) return key;
        AdbBase64 b64 = d -> Base64.encodeToString(d, Base64.NO_WRAP);
        File priv = new File(c.getFilesDir(), "adbkey"), pub = new File(c.getFilesDir(), "adbkey.pub");
        if (priv.exists() && pub.exists()) {
            try { return key = AdbCrypto.loadAdbKeyPair(b64, priv, pub); } catch (Exception e) { /* unreadable: make a new pair */ }
        }
        key = AdbCrypto.generateAdbKeyPair(b64);
        key.saveAdbKeyPair(priv, pub);
        return key;
    }
}
