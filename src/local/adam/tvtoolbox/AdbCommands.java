package local.adam.tvtoolbox;

import java.util.Set;
import java.util.regex.Pattern;

/** Every shell command TV Toolbox can run, and nothing else. A package argument must look like a package name and be
 *  installed, ping takes only an IPv4 literal, and the rest take no argument, so nothing typed by a user reaches the
 *  shell. No android imports: tools/CheckAdb.java runs this on the PC. */
public final class AdbCommands {
    private AdbCommands() {}

    enum Arg { NONE, PACKAGE, IPV4 }

    public enum Cmd {
        MEMINFO("dumpsys meminfo"),
        USER_APPS("pm list packages -3"),
        KILL_ALL("am kill-all"),
        STOP_APP("am stop-app", Arg.PACKAGE),
        FORCE_STOP("am force-stop", Arg.PACKAGE),
        TRIM("pm trim-caches 999G"),
        CLEAR_CACHE("pm clear --cache-only", Arg.PACKAGE),
        DISKSTATS("dumpsys diskstats"),
        PING("ping -c 5 -W 2", Arg.IPV4),
        REBOOT("reboot"),
        EXPIRY_GET("settings get global adb_allowed_connection_time"),
        EXPIRY_OFF("settings put global adb_allowed_connection_time 0"),
        IME("settings get secure default_input_method");

        final String line;
        final Arg arg;
        Cmd(String line) { this(line, Arg.NONE); }
        Cmd(String line, Arg arg) { this.line = line; this.arg = arg; }
    }

    // ASCII only: \d without UNICODE_CHARACTER_CLASS, and matches() anchors both ends, so no newline slips through.
    static final Pattern PACKAGE_RE = Pattern.compile("[A-Za-z0-9_.]+");
    static final Pattern IPV4_RE = Pattern.compile("((25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)");

    static boolean isPackage(String s) { return s != null && PACKAGE_RE.matcher(s).matches(); }

    /** The shell line for c. IllegalArgumentException when c takes no argument and gets one, or its argument fails its rule. */
    static String build(Cmd c, String arg, Set<String> installed) {
        switch (c.arg) {
            case PACKAGE: if (isPackage(arg) && installed.contains(arg)) return c.line + " " + arg; break;
            case IPV4: if (arg != null && IPV4_RE.matcher(arg).matches()) return c.line + " " + arg; break;
            default: if (arg == null) return c.line;
        }
        throw new IllegalArgumentException(c + " refused its argument");
    }
}
