package local.adam.tvtoolbox;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.RouteInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/** The Nuvio health check and the network check. Every request is HTTPS with 8 s connect and read timeouts and a 1 MB body
 *  cap, and at most 4 run at once; run() also gives each row 30 s, whatever the sockets do. Nothing here logs: a check's URL is a private link, so only its host ever reaches a row. Rows and
 *  answers are built with org.json; nothing from the network is passed on as text. */
public class Health {
    static final int TIMEOUT_MS = 8000;
    static final int MAX_BODY = 1 << 20;
    static final int PARALLEL = 4;
    static final long ROW_MS = 30000;                       // run() waits this long for a row, then shows "no answer" (the sockets' own timeouts are per step)
    static final long PING_MS = 15000;                      // ping -c 5 -W 2 ends within ~10 s; this is the backstop for an adbd that never answers
    static final long DAY_MS = 24L * 60 * 60 * 1000;
    static final String NUVIO = "com.nuvio.tv", NUVIO_PLAY = "com.nuvio.app";
    static final String NUVIO_STATUS = "https://status.nuvio.tv/api/status";
    static final String TORBOX_STATUS = "https://status.torbox.app/index.json";
    static final String MONITOR = "https://status.stremio-status.com/api/v1/endpoints/statuses?page=1&pageSize=1";
    static final String SPEED = "https://speed.cloudflare.com/__down?bytes=50000000";
    static final String DOH = "https://1.1.1.1/dns-query?name=";
    static final long SPEED_MS = 10000;
    static final String[] DNS_HOSTS = {"status.nuvio.tv", "status.torbox.app", "status.stremio-status.com",
            "barticom94.github.io", "github.com", "release-assets.githubusercontent.com"};
    static final int MAX_HOSTS = 30;                        // the page passes the few hosts of health.json; this only bounds a runaway list
    static final Set<String> TYPES = new LinkedHashSet<>(Arrays.asList("http", "manifest", "aiostreams"));
    static final Pattern BETA = Pattern.compile("alpha|beta|rc", Pattern.CASE_INSENSITIVE);
    static final Pattern HOST = Pattern.compile("[A-Za-z0-9][A-Za-z0-9.-]{0,252}");   // goes into a URL unescaped: letters, digits, dots, hyphens only
    /** What network() returns when the check itself fails (not when the TV has no network): `error` is only ever there. */
    static final String FAILED_NET = "{\"error\":true,\"type\":\"other\",\"vpn\":false,\"wifi\":null,\"dns\":[],\"privateDns\":{\"active\":false,\"name\":null},"
            + "\"gateway\":null,\"ping\":{\"gateway\":null,\"internet\":null},\"speedMbps\":null,\"lookups\":[]}";

    private final Context c;
    private final Store store;
    private final Adb adb;
    /** Health runs go one after another, so rows from two runs never mix. */
    private final ExecutorService runner = Executors.newSingleThreadExecutor();
    /** Pings go through here so a shell that never answers costs 15 s, not the network thread. */
    private final ExecutorService shell = Executors.newSingleThreadExecutor();

    public Health(Context c, Store s, Adb adb) {
        this.c = c.getApplicationContext();
        this.store = s;
        this.adb = adb;
    }

    public void close() { runner.shutdownNow(); shell.shutdownNow(); }

    // ---- health.json ----

    /** health.json in getExternalFilesDir(null), or null when it isn't there. Only Adam's Streamer has one, and it is also
     *  what lets the app try ADB at all. */
    public File file() {
        File dir = c.getExternalFilesDir(null);
        File f = dir == null ? null : new File(dir, "health.json");
        return f != null && f.isFile() ? f : null;
    }

    /** The text of health.json, null when the file is missing, "" when it is there but can't be read (the page treats that
     *  as invalid). A leading byte-order mark (a Windows editor adds one) is dropped. */
    public String healthText() {
        File f = file();
        if (f == null) return null;
        try (InputStream in = new FileInputStream(f)) {
            String s = slurp(in, Long.MAX_VALUE);
            return s == null ? "" : !s.isEmpty() && s.charAt(0) == (char) 0xFEFF ? s.substring(1) : s;
        } catch (IOException e) { return ""; }
    }

    // ---- the health check ----

    private interface Job extends Callable<List<JSONObject>> { }

    private static final class Planned {
        final String kind, host;
        final String[] names;                               // the rows this job makes, in order: what is shown if it fails or hangs
        final Job job;
        Planned(String kind, String host, Job job, String... names) { this.kind = kind; this.host = host; this.job = job; this.names = names; }
    }

    /** Built-in rows, then the page's checks; `row` gets each row's JSON text in this order as soon as it and the rows
     *  before it are done, then `done` runs once. Returns at once; the work is on another thread. */
    public void run(String checksJson, Consumer<String> row, Runnable done) {
        runner.execute(() -> {
            ExecutorService pool = Executors.newFixedThreadPool(PARALLEL);
            try {
                List<Planned> plan = plan(checksJson);
                List<Future<List<JSONObject>>> futures = new ArrayList<>();
                for (Planned p : plan) futures.add(pool.submit(p.job));
                for (int i = 0; i < plan.size(); i++) {
                    Planned pl = plan.get(i);
                    Future<List<JSONObject>> f = futures.get(i);
                    List<JSONObject> rows = new ArrayList<>();
                    try { rows = f.get(ROW_MS, TimeUnit.MILLISECONDS); }
                    catch (ExecutionException e) {
                        for (String n : pl.names) rows.add(row(n, pl.kind, pl.host, -1, 0, "", "Couldn't run this check."));
                    } catch (TimeoutException e) {
                        // ponytail: cancel(true) can't unblock a socket read, so a dripping server keeps its pool thread until it gives up; done still arrives
                        f.cancel(true);
                        for (String n : pl.names) rows.add(row(n, pl.kind, pl.host, 0, ROW_MS, "", ""));
                    }
                    for (JSONObject o : rows) row.accept(o.toString());
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                pool.shutdownNow();
                done.run();
            }
        });
    }

    private List<Planned> plan(String checksJson) {
        List<Planned> p = new ArrayList<>();
        p.add(new Planned("nuvio-app", "", () -> Collections.singletonList(appRow()), "Nuvio app"));
        p.add(new Planned("service", "status.nuvio.tv", this::nuvioStatus, "Nuvio sign-in", "Nuvio sync"));
        p.add(new Planned("service", "status.torbox.app", this::torbox, "TorBox"));
        p.add(new Planned("service", "status.stremio-status.com", this::monitor, "TorBox (independent monitor)", "Cinemeta (independent monitor)"));
        JSONArray checks = arr(checksJson);
        for (int i = 0; checks != null && i < checks.length(); i++) {
            JSONObject ch = checks.optJSONObject(i);
            String name = ch == null ? "" : ch.optString("name", "");
            if (name.isEmpty()) continue;
            String type = ch.optString("type", "");
            String url = ch.optString("aiostreams".equals(type) ? "base" : "url", "");
            String host = httpsHost(url);                   // the page checked all this; Java does not trust it
            if (host == null || !TYPES.contains(type)) {
                String h = host == null ? "" : host;
                p.add(new Planned("yours", h, () -> Collections.singletonList(row(name, "yours", h, -1, 0, "", "This check isn't valid.")), name));
            } else {
                p.add(new Planned("yours", host, () -> Collections.singletonList(yours(name, type, url, host)), name));
            }
        }
        return p;
    }

    /** Installed Nuvio against the store's stable and beta entries. The installed build counts as current when it is the
     *  newest name for its channel, or its version code is at least the entry's (a sideload can be ahead). */
    private JSONObject appRow() {
        PackageManager pm = c.getPackageManager();
        PackageInfo pi;
        try { pi = pm.getPackageInfo(NUVIO, 0); }
        catch (PackageManager.NameNotFoundException e) { return row("Nuvio app", "nuvio-app", "", -1, 0, "", "Nuvio isn't installed on this TV."); }
        String have = pi.versionName == null ? "" : pi.versionName;
        boolean beta = BETA.matcher(have).find();
        JSONObject stable = store.entry("nuvio"), test = store.entry("nuvio-beta"), mine = beta ? test : stable;
        StringBuilder d = new StringBuilder(have).append(" installed");
        if (test != null) d.append(" · newest beta ").append(test.optString("versionName", "?"));
        if (stable != null) d.append(" · newest stable ").append(stable.optString("versionName", "?"));
        try { pm.getPackageInfo(NUVIO_PLAY, 0); d.append(" · Play Store copy also installed"); }
        catch (PackageManager.NameNotFoundException e) { /* only the one copy */ }
        if (mine == null || mine.optString("versionName", "").isEmpty()) return row("Nuvio app", "nuvio-app", "", -1, 0, "", d + " · couldn't read the store list");
        boolean current = have.equals(mine.optString("versionName")) || pi.getLongVersionCode() >= mine.optLong("versionCode", Long.MAX_VALUE);
        return row("Nuvio app", "nuvio-app", "", 200, 0, current ? "operational" : "degraded", d.toString());
    }

    private List<JSONObject> nuvioStatus() {
        Reply r = get(NUVIO_STATUS, "application/json", true);
        JSONObject o = obj(r.body);
        JSONArray comps = o == null ? null : o.optJSONArray("components");
        return Arrays.asList(serviceRow("Nuvio sign-in", "status.nuvio.tv", r, worst(comps, "auth", "tv-login")),
                serviceRow("Nuvio sync", "status.nuvio.tv", r, worst(comps, "api", "sync")));
    }

    private List<JSONObject> torbox() {
        Reply r = get(TORBOX_STATUS, "application/json", true);
        JSONObject o = obj(r.body), data = o == null ? null : o.optJSONObject("data"), at = data == null ? null : data.optJSONObject("attributes");
        String state = at == null || !at.has("aggregate_state") ? null : norm(at.optString("aggregate_state", ""));
        return Collections.singletonList(serviceRow("TorBox", "status.torbox.app", r, state));
    }

    /** One fetch, two rows: the endpoints whose last result came from the TorBox API and from Cinemeta. */
    private List<JSONObject> monitor() {
        Reply r = get(MONITOR, "application/json", true);
        JSONArray endpoints = arr(r.body);
        return Arrays.asList(serviceRow("TorBox (independent monitor)", "status.stremio-status.com", r, monitorState(endpoints, "api.torbox.app")),
                serviceRow("Cinemeta (independent monitor)", "status.stremio-status.com", r, monitorState(endpoints, "v3-cinemeta.strem.io")));
    }

    private JSONObject yours(String name, String type, String url, String host) {
        switch (type) {
            case "manifest": {
                Reply r = get(url, "application/json", true);
                if (r.code / 100 != 2) return row(name, "yours", host, r.code, r.ms, "", "");
                JSONObject m = obj(r.body);
                boolean ok = m != null && !m.optString("id", "").isEmpty();
                return row(name, "yours", host, r.code, r.ms, ok ? "" : "outage", ok ? "" : "Answered, but it isn't an add-on.");
            }
            case "aiostreams": {
                String base = url.replaceAll("/+$", "");
                Reply r = get(base + "/api/v1/health", null, false);
                return row(name, "yours", host, r.code, r.ms, "", r.code == 200 ? aioInfo(base, host) : "");
            }
            default: {
                Reply r = get(url, null, false);
                return row(name, "yours", host, r.code, r.ms, "", "");
            }
        }
    }

    /** "2.37.0 (stable)" from /api/v1/status, which is ~390 KB: fetched at most once a day per host, kept in SharedPreferences
     *  `health`. "" when it can't be read. */
    private String aioInfo(String base, String host) {
        SharedPreferences p = c.getSharedPreferences("health", Context.MODE_PRIVATE);
        String key = "aio." + host;
        long now = System.currentTimeMillis();
        JSONObject saved = obj(p.getString(key, null));
        if (saved != null && now - saved.optLong("at") >= 0 && now - saved.optLong("at") < DAY_MS) return saved.optString("info", "");
        JSONObject o = obj(get(base + "/api/v1/status", "application/json", true).body), d = o == null ? null : o.optJSONObject("data");
        if (d == null) return "";
        String v = d.optString("version", ""), ch = d.optString("channel", "");
        String info = v.isEmpty() ? "" : ch.isEmpty() ? v : v + " (" + ch + ")";
        try { p.edit().putString(key, new JSONObject().put("at", now).put("info", info).toString()).apply(); }
        catch (JSONException e) { /* only the cache is lost */ }
        return info;
    }

    // ---- rows and status words ----

    private static JSONObject row(String name, String kind, String host, int code, long ms, String reported, String detail) {
        try {
            return new JSONObject().put("name", name).put("kind", kind).put("host", host).put("code", code).put("ms", ms)
                    .put("reported", reported).put("detail", detail);
        } catch (JSONException e) { throw new IllegalStateException(e); }   // only a null key throws
    }

    /** A status page's row. No answer is code 0 (red); an answer that can't be read is -1 (grey, never red). */
    private static JSONObject serviceRow(String name, String host, Reply r, String status) {
        if (r.code == 0) return row(name, "service", host, 0, r.ms, "", "");
        if (status == null) return row(name, "service", host, -1, r.ms, "", "Couldn't read the status.");
        return row(name, "service", host, r.code, r.ms, status, "operational".equals(status) ? "" : "Reported as " + status + ".");
    }

    /** operational, degraded, maintenance, outage or downtime as they are; any other word counts as degraded. */
    static String norm(String s) {
        switch (s == null ? "" : s) {
            case "operational": case "degraded": case "maintenance": case "outage": case "downtime": return s;
            default: return "degraded";
        }
    }

    static int rank(String s) { return "operational".equals(s) ? 0 : "outage".equals(s) || "downtime".equals(s) ? 2 : 1; }

    /** The worst status among the components with these ids; null when none of them is there. */
    static String worst(JSONArray comps, String... ids) {
        String w = null;
        List<String> want = Arrays.asList(ids);
        for (int i = 0; comps != null && i < comps.length(); i++) {
            JSONObject o = comps.optJSONObject(i);
            if (o == null || !want.contains(o.optString("id", ""))) continue;
            String s = norm(o.optString("status", ""));
            if (w == null || rank(s) > rank(w)) w = s;
        }
        return w;
    }

    /** operational/outage for the endpoint whose last result came from this hostname; null when there is none. */
    static String monitorState(JSONArray endpoints, String hostname) {
        for (int i = 0; endpoints != null && i < endpoints.length(); i++) {
            JSONObject e = endpoints.optJSONObject(i);
            JSONArray rs = e == null ? null : e.optJSONArray("results");
            JSONObject last = rs == null ? null : rs.optJSONObject(rs.length() - 1);
            if (last != null && hostname.equals(last.optString("hostname", "")) && last.opt("success") instanceof Boolean)
                return last.optBoolean("success") ? "operational" : "outage";
        }
        return null;
    }

    private static JSONObject obj(String s) {
        try { return s == null ? null : new JSONObject(s); } catch (JSONException e) { return null; }
    }

    private static JSONArray arr(String s) {
        try { return s == null ? null : new JSONArray(s); } catch (JSONException e) { return null; }
    }

    /** The host of an https URL, or null for anything else. */
    static String httpsHost(String u) {
        if (u == null) return null;
        try {
            URL x = new URL(u);
            return "https".equals(x.getProtocol()) && !x.getHost().isEmpty() ? x.getHost() : null;
        } catch (MalformedURLException e) { return null; }
    }

    // ---- HTTPS ----

    private static final class Reply {
        final int code;                                     // 0 = no answer (including a body that was too slow)
        final long ms;
        final String body;                                  // only for a 2xx when asked for; null when over the cap
        Reply(int code, long ms, String body) { this.code = code; this.ms = ms; this.body = body; }
    }

    /** One GET. Never throws: a failure is code 0. The connect and every read have 8 s each, and the body must finish within
     *  8 s of the start, checked between reads. That is not a bound on the whole request (DNS, redirects and a dripping server
     *  can run longer), which is why run() waits at most ROW_MS for a row. */
    private static Reply get(String url, String accept, boolean wantBody) {
        long t0 = SystemClock.elapsedRealtime();
        HttpURLConnection h = null;
        try {
            URL u = new URL(url);
            if (!"https".equals(u.getProtocol())) throw new IOException("not https");
            h = (HttpURLConnection) u.openConnection();
            h.setConnectTimeout(TIMEOUT_MS);
            h.setReadTimeout(TIMEOUT_MS);
            h.setUseCaches(false);
            if (accept != null) h.setRequestProperty("Accept", accept);
            int code = h.getResponseCode();
            String body = null;
            if (wantBody && code / 100 == 2) try (InputStream in = h.getInputStream()) { body = slurp(in, t0 + TIMEOUT_MS); }
            return new Reply(code, SystemClock.elapsedRealtime() - t0, body);
        } catch (IOException e) {
            return new Reply(0, SystemClock.elapsedRealtime() - t0, null);
        } finally { if (h != null) h.disconnect(); }
    }

    /** The stream as UTF-8, null when it is over the cap, IOException when a read ends after the deadline (elapsedRealtime). */
    private static String slurp(InputStream in, long deadline) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        for (int n; (n = in.read(b)) > 0; ) {
            if (SystemClock.elapsedRealtime() > deadline) throw new IOException("too slow");
            if (o.size() + n > MAX_BODY) return null;
            o.write(b, 0, n);
        }
        return new String(o.toByteArray(), StandardCharsets.UTF_8);
    }

    // ---- the network check ----

    /** The IPv4 router on the default route, or null. A VPN's default route has 0.0.0.0 there (no router), which pings this TV. */
    static String gateway(LinkProperties lp) {
        if (lp != null) for (RouteInfo r : lp.getRoutes())
            if (r.isDefaultRoute() && r.getGateway() instanceof Inet4Address && !r.getGateway().isAnyLocalAddress()) return r.getGateway().getHostAddress();
        return null;
    }

    /** Blocks (normally ~30 s; at most ~100 s if everything hangs: two pings 15 s each, a download ~26 s, lookups 40 s): call it
     *  off the UI thread. Always returns an answer; whatever can't be read is null or empty, and a section that throws loses
     *  only itself. `error: true` (with nothing filled in) means the check itself broke. Ping text is the shell's raw output. */
    public String network(String hostsJson) {
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network n = cm.getActiveNetwork();
            NetworkCapabilities caps = n == null ? null : cm.getNetworkCapabilities(n);
            LinkProperties lp = n == null ? null : cm.getLinkProperties(n);
            // With a VPN on, the active network is the tunnel: DNS stays its (that is what the TV uses), while the
            // connection type and the router come from the real network underneath.
            boolean vpn = caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
            Network base = vpn ? underlying(cm) : n;
            NetworkCapabilities baseCaps = base == null ? null : cm.getNetworkCapabilities(base);
            String type = baseCaps == null ? "other" : baseCaps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ? "ethernet"
                    : baseCaps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi" : "other";
            JSONArray dns = new JSONArray();
            if (lp != null) for (InetAddress a : lp.getDnsServers()) dns.put(a.getHostAddress());
            String gw = gateway(base == null ? null : cm.getLinkProperties(base));
            JSONObject o = new JSONObject().put("type", type).put("vpn", vpn).put("wifi", "wifi".equals(type) ? nz(wifi()) : JSONObject.NULL).put("dns", dns)
                    .put("privateDns", new JSONObject().put("active", lp != null && lp.isPrivateDnsActive())
                            .put("name", nz(lp == null ? null : lp.getPrivateDnsServerName())))
                    .put("gateway", nz(gw));
            o.put("ping", new JSONObject().put("gateway", nz(ping(gw))).put("internet", nz(ping("1.1.1.1"))));
            Double mbps = null;
            try { mbps = speed(); } catch (RuntimeException e) { /* only the speed is lost */ }
            JSONArray found = new JSONArray();
            try { found = lookups(hostsJson); } catch (JSONException | RuntimeException e) { /* only the lookups are lost */ }
            return o.put("speedMbps", nz(mbps)).put("lookups", found).toString();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return FAILED_NET;
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "network failed: " + e.getClass().getSimpleName());   // class only: a message could hold a URL
            return FAILED_NET;
        }
    }

    private static Object nz(Object v) { return v == null ? JSONObject.NULL : v; }

    /** The network a VPN runs over: the first one with internet that isn't a VPN itself, or null. */
    @SuppressWarnings("deprecation")                        // getAllNetworks is deprecated from API 31 but still lists every network
    private static Network underlying(ConnectivityManager cm) {
        for (Network m : cm.getAllNetworks()) {
            NetworkCapabilities mc = cm.getNetworkCapabilities(m);
            if (mc != null && !mc.hasTransport(NetworkCapabilities.TRANSPORT_VPN) && mc.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return m;
        }
        return null;
    }

    @SuppressWarnings("deprecation")                        // getConnectionInfo is deprecated from API 31 but still answers rssi and link speed
    private JSONObject wifi() throws JSONException {
        WifiManager wm = (WifiManager) c.getSystemService(Context.WIFI_SERVICE);
        WifiInfo wi = wm == null ? null : wm.getConnectionInfo();
        return wi == null ? null : new JSONObject().put("rssi", wi.getRssi()).put("mbps", wi.getLinkSpeed());
    }

    /** The shell's ping output, or null when there is nothing to ping, ADB isn't connected (checked first: connected() never
     *  blocks, while run() waits behind a connect that is still waiting for the TV's "Allow USB debugging?" answer) or the
     *  shell is silent for PING_MS. */
    private String ping(String ip) throws InterruptedException {
        if (ip == null || !adb.connected()) return null;
        Future<String> f = shell.submit(() -> adb.run(AdbCommands.Cmd.PING, ip));
        try { return f.get(PING_MS, TimeUnit.MILLISECONDS); }
        catch (ExecutionException e) { return null; }       // IOException, or a rejected argument
        catch (TimeoutException e) { f.cancel(true); return null; }   // the interrupt ends Adb.run's wait and frees its lock
    }

    /** Mbit/s over at most 10 s of a 50 MB download; null if it never got going. A line that stalls part-way is judged on
     *  what arrived. The connection is dropped, not closed, so a half-read download is never drained. */
    private static Double speed() {
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL(SPEED).openConnection();
            h.setConnectTimeout(TIMEOUT_MS);
            h.setReadTimeout(TIMEOUT_MS);
            h.setUseCaches(false);
            if (h.getResponseCode() != 200) return null;
            InputStream in = h.getInputStream();
            byte[] b = new byte[65536];
            long t0 = SystemClock.elapsedRealtime(), total = 0;
            try { for (int n; SystemClock.elapsedRealtime() - t0 < SPEED_MS && (n = in.read(b)) > 0; ) total += n; }
            catch (IOException stalled) { /* keep what arrived */ }
            long ms = SystemClock.elapsedRealtime() - t0;
            return total == 0 || ms <= 0 ? null : Math.round(total * 8.0 / ms / 100) / 10.0;   // bits per ms = kbit/s; /1000 = Mbit/s, one decimal
        } catch (IOException e) {
            return null;
        } finally { if (h != null) h.disconnect(); }
    }

    /** The page's hosts, then the built-in ones, each looked up through this TV's DNS and through Cloudflare's DNS-over-HTTPS. */
    private JSONArray lookups(String hostsJson) throws InterruptedException, JSONException {
        Set<String> hosts = new LinkedHashSet<>();
        JSONArray given = arr(hostsJson);
        for (int i = 0; given != null && i < given.length() && hosts.size() < MAX_HOSTS; i++) {
            String h = given.optString(i, "");
            if (HOST.matcher(h).matches()) hosts.add(h.toLowerCase(Locale.ROOT));
        }
        hosts.addAll(Arrays.asList(DNS_HOSTS));
        List<String> list = new ArrayList<>(hosts);
        List<Callable<JSONObject>> jobs = new ArrayList<>();
        for (String h : list) jobs.add(() -> lookup(h));
        ExecutorService pool = Executors.newFixedThreadPool(PARALLEL);
        JSONArray out = new JSONArray();
        try {
            List<Future<JSONObject>> fs = pool.invokeAll(jobs, 40, TimeUnit.SECONDS);   // a host the TV's DNS never answers must not hold the screen
            for (int i = 0; i < fs.size(); i++) {
                JSONObject o;
                try { o = fs.get(i).get(); }
                catch (ExecutionException | CancellationException e) {
                    o = new JSONObject().put("host", list.get(i)).put("system", new JSONArray()).put("doh", new JSONArray());
                }
                out.put(o);
            }
        } finally { pool.shutdownNow(); }
        return out;
    }

    private static JSONObject lookup(String host) throws JSONException {
        JSONArray sys = new JSONArray(), doh = new JSONArray();
        try { for (InetAddress a : InetAddress.getAllByName(host)) if (a instanceof Inet4Address) sys.put(a.getHostAddress()); }
        catch (UnknownHostException e) { /* the TV's DNS has no answer */ }
        JSONObject o = obj(get(DOH + host + "&type=A", "application/dns-json", true).body);
        JSONArray answers = o == null ? null : o.optJSONArray("Answer");
        for (int i = 0; answers != null && i < answers.length(); i++) {
            JSONObject a = answers.optJSONObject(i);
            if (a != null && a.optInt("type") == 1 && !a.optString("data", "").isEmpty()) doh.put(a.optString("data"));
        }
        return new JSONObject().put("host", host).put("system", sys).put("doh", doh);
    }
}
