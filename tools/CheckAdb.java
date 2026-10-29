// Checks AdbCommands, the only shell commands TV Toolbox can run. Run (Git Bash, from the repo root):
//   J=$(ls -d /e/Android/jdk-17*/bin); T=$(mktemp -d); "$J/javac" --release 11 -d "$T" src/local/adam/tvtoolbox/AdbCommands.java tools/CheckAdb.java && "$J/java" -cp "$T" local.adam.tvtoolbox.CheckAdb
package local.adam.tvtoolbox;

import static local.adam.tvtoolbox.AdbCommands.*;

import java.util.Set;

final class CheckAdb {
    static int failures;

    static void eq(String name, Object got, Object want) {
        boolean ok = want.equals(got);
        if (!ok) failures++;
        System.out.println((ok ? "PASS " : "FAIL ") + name + (ok ? "" : ": got " + got + ", want " + want));
    }

    static void throwsArg(String name, Runnable r) {
        String got;
        try { r.run(); got = "no exception"; }
        catch (IllegalArgumentException e) { got = null; }
        catch (RuntimeException e) { got = e.toString(); }
        if (got != null) failures++;
        System.out.println((got == null ? "PASS " : "FAIL ") + name + (got == null ? "" : ": " + got));
    }

    public static void main(String[] a) {
        Set<String> inst = Set.of("com.nuvio.tv");
        eq("stop app", build(Cmd.STOP_APP, "com.nuvio.tv", inst), "am stop-app com.nuvio.tv");
        throwsArg("injection", () -> build(Cmd.STOP_APP, "com.nuvio.tv; reboot", inst));
        throwsArg("newline injection", () -> build(Cmd.STOP_APP, "com.nuvio.tv\nreboot", inst));
        throwsArg("not installed", () -> build(Cmd.STOP_APP, "com.not.installed", inst));
        throwsArg("missing package", () -> build(Cmd.FORCE_STOP, null, inst));
        eq("clear cache", build(Cmd.CLEAR_CACHE, "com.nuvio.tv", inst), "pm clear --cache-only com.nuvio.tv");
        eq("ping", build(Cmd.PING, "192.0.2.1", inst), "ping -c 5 -W 2 192.0.2.1");
        throwsArg("ping injection", () -> build(Cmd.PING, "1.1.1.1 && reboot", inst));
        throwsArg("ping hostname", () -> build(Cmd.PING, "example.com", inst));
        throwsArg("ping octet out of range", () -> build(Cmd.PING, "256.1.1.1", inst));
        throwsArg("ping missing", () -> build(Cmd.PING, null, inst));
        eq("reboot", build(Cmd.REBOOT, null, inst), "reboot");
        throwsArg("no-arg command with arg", () -> build(Cmd.REBOOT, "now", inst));
        eq("expiry off", build(Cmd.EXPIRY_OFF, null, inst), "settings put global adb_allowed_connection_time 0");
        eq("keep list name", isPackage("local.adam.tvtoolbox"), true);
        eq("keep list rejects shell text", isPackage("com.nuvio.tv && reboot"), false);
        eq("keep list rejects empty", isPackage(""), false);
        if (failures > 0) { System.out.println(failures + " FAILED"); System.exit(1); }
    }
}
