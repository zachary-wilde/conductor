package com.reigen.runtime.probe;

import android.app.ActivityManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.StatFs;
import androidx.documentfile.provider.DocumentFile;
import java.io.File;
import java.io.InterruptedIOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.nio.file.StandardCopyOption;
import java.util.EnumMap;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

public final class ProbeEngine {
    public static final String PREFERENCES = "runtime-probe";
    public static final String SD_TREE_URI = "sd-tree-uri";

    public static final String SERVICE_ID = "service-id";
    public static final String SERVICE_CONFIRMED_ID = "service-confirmed-id";
    public static final String ACTIVITY_CLOSED_SERVICE_ID = "activity-closed-service-id";
    private ProbeEngine() {}

    public static ProbeReport run(Context context, boolean paidOmpGate, Consumer<String> status) {
        Map<ProbeCheck, ProbeResult> results = new EnumMap<>(ProbeCheck.class);
        ProbeResult profile = deviceProfile(context);
        results.put(ProbeCheck.DEVICE_PROFILE, profile);
        if (!profile.passed()) return finish(context, results);
        RuntimeInstaller.Runtime runtime;
        try {
            runtime = RuntimeInstaller.install(context, status);
            results.put(ProbeCheck.ARTIFACTS, ProbeResult.pass("Pinned SHA-256 checks passed; runtime " + runtime.version));
        } catch (InterruptedIOException interrupted) {
            throw new IllegalStateException("Probe cancelled", interrupted);
        } catch (Exception error) {
            results.put(ProbeCheck.ARTIFACTS, ProbeResult.fail(error.getClass().getSimpleName() + ": " + error.getMessage()));
            return finish(context, results);
        }

        check(results, ProbeCheck.ROOTFS, runtime,
                "test -x /bin/bash && test -x /usr/local/bin/omp && (command -v git >/dev/null && command -v script >/dev/null || (export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq git ca-certificates util-linux)) && echo ROOTFS_OK",
                600, status);
        check(results, ProbeCheck.SHELL, runtime, "printf SHELL_OK", 20, status);
        check(results, ProbeCheck.FILESYSTEM, runtime,
                "f=/root/reigen-probe-file; printf probe-ok > \"$f\" && test \"$(cat \"$f\")\" = probe-ok && rm \"$f\" && echo FS_OK",
                20, status);
        check(results, ProbeCheck.GIT, runtime,
                "d=/root/reigen-git-probe; rm -rf \"$d\"; mkdir -p \"$d\" && cd \"$d\" && git init -q && git config user.name Probe && git config user.email probe@localhost && printf ok > result.txt && git add result.txt && git commit -qm probe && test \"$(git rev-parse --is-inside-work-tree)\" = true && echo GIT_OK",
                45, status);
        check(results, ProbeCheck.PTY, runtime,
                "script -qec 'test -t 0 && test -t 1 && echo PTY_OK' /dev/null",
                20, status);
        check(results, ProbeCheck.OMP_VERSION, runtime, "omp --version", 30, status);
        check(results, ProbeCheck.CHILDREN, runtime,
                "sh -c 'sleep 1 & first=$!; sleep 1 & second=$!; wait $first && wait $second && echo CHILDREN_OK'",
                20, status);
        results.put(ProbeCheck.FOREGROUND_SERVICE, foregroundService(context));
        results.put(ProbeCheck.SD_CARD, sdCard(context));
        if (paidOmpGate) {
            check(results, ProbeCheck.OMP_WORKFLOW, runtime,
                    "d=/root/reigen-omp-gate; rm -rf \"$d\"; mkdir -p \"$d\" && cd \"$d\" && git init -q && git config user.name Probe && git config user.email probe@localhost && printf 'Create result.txt containing exactly OMP_GATE_OK, run a shell check for that exact content, then git add and commit the change.' > TASK.txt && git add TASK.txt && git commit -qm baseline && omp --auto-approve -p \"$(cat TASK.txt)\" && test \"$(cat result.txt)\" = OMP_GATE_OK && test \"$(git rev-list --count HEAD)\" -ge 2 && echo OMP_WORKFLOW_OK",
                    600, status);
        } else {
            results.put(ProbeCheck.OMP_WORKFLOW, ProbeResult.fail("Not run; tap Run paid OMP gate after provider login"));
        }
        return finish(context, results);
    }

    private static ProbeResult deviceProfile(Context context) {
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
        manager.getMemoryInfo(memory);
        long free = new StatFs(context.getFilesDir().getPath()).getAvailableBytes();
        DeviceProfile profile = new DeviceProfile(Arrays.asList(Build.SUPPORTED_ABIS), memory.totalMem, free);
        List<String> failures = profile.failures();
        String detail = Build.MODEL + "; ABI " + String.join(",", Build.SUPPORTED_ABIS)
                + "; RAM " + gib(memory.totalMem) + " GiB; free internal " + gib(free) + " GiB";
        if (failures.isEmpty()) return ProbeResult.pass(detail);
        return ProbeResult.fail(detail + "; " + String.join("; ", failures));
    }

    private static ProbeResult sdCard(Context context) {
        String value = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .getString(SD_TREE_URI, "");
        if (value == null || value.isEmpty()) return ProbeResult.fail("No SD-card backup folder selected");
        DocumentFile directory = DocumentFile.fromTreeUri(context, Uri.parse(value));
        if (directory == null || !directory.canWrite()) return ProbeResult.fail("Selected SD-card folder is not writable");
        DocumentFile probe = directory.createFile("application/octet-stream", "reigen-runtime-probe.bin");
        if (probe == null) return ProbeResult.fail("Cannot create SD-card probe file");
        ProbeResult outcome;
        byte[] payload = "REIGEN_SD_CHECKSUM_OK".getBytes(StandardCharsets.UTF_8);
        try {
            try (OutputStream output = context.getContentResolver().openOutputStream(probe.getUri())) {
                if (output == null) throw new java.io.IOException("Cannot open SD-card probe file for writing");
                output.write(payload);
            }
            byte[] actual;
            try (InputStream input = context.getContentResolver().openInputStream(probe.getUri())) {
                if (input == null) throw new java.io.IOException("Cannot open SD-card probe file for reading");
                actual = sha256(input);
            }
            byte[] expected = MessageDigest.getInstance("SHA-256").digest(payload);
            outcome = MessageDigest.isEqual(expected, actual)
                    ? ProbeResult.pass("SAF write/read SHA-256 verified: " + hex(actual))
                    : ProbeResult.fail("SD-card checksum mismatch");
        } catch (Exception error) {
            outcome = ProbeResult.fail(error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        if (!probe.delete()) {
            String cleanup = "SD-card probe file could not be deleted";
            return outcome.passed() ? ProbeResult.fail(cleanup) : ProbeResult.fail(outcome.detail() + "; " + cleanup);
        }
        return outcome;
    }

    private static ProbeResult foregroundService(Context context) {
        android.content.SharedPreferences preferences =
                context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        String active = preferences.getString(SERVICE_ID, "");
        String confirmed = preferences.getString(SERVICE_CONFIRMED_ID, "");
        if (active != null && active.equals(confirmed) && !active.isEmpty()) {
            return ProbeResult.pass("Same foreground service survived Activity close and reopen");
        }
        return ProbeResult.fail("Close the Activity, reopen it, then rerun checks to prove service persistence");
    }

    private static byte[] sha256(InputStream input) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) >= 0) digest.update(buffer, 0, read);
        return digest.digest();
    }

    private static String hex(byte[] bytes) {
        char[] hex = "0123456789abcdef".toCharArray();
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte current : bytes) {
            value.append(hex[(current >>> 4) & 0xf]).append(hex[current & 0xf]);
        }
        return value.toString();
    }

    private static void check(
            Map<ProbeCheck, ProbeResult> results,
            ProbeCheck check,
            RuntimeInstaller.Runtime runtime,
            String command,
            long timeoutSeconds,
            Consumer<String> status) {
        status.accept("Checking " + check.id() + "…");
        try {
            RuntimeProcess.Result result = RuntimeProcess.run(runtime, command, timeoutSeconds);
            results.put(check, result.succeeded()
                    ? ProbeResult.pass(result.summary())
                    : ProbeResult.fail(result.summary()));
        } catch (InterruptedException interrupted) {
            throw new IllegalStateException("Probe cancelled", interrupted);
        } catch (Exception error) {
            results.put(check, ProbeResult.fail(error.getClass().getSimpleName() + ": " + error.getMessage()));
        }
    }

    private static ProbeReport finish(Context context, Map<ProbeCheck, ProbeResult> results) {
        results.put(ProbeCheck.REPORT_PERSISTENCE, ProbeResult.pass("Atomic latest.json write succeeded"));
        ProbeReport report = new ProbeReport(results, deviceName());
        try {
            Path reports = new File(context.getFilesDir(), "runtime-probe/reports").toPath();
            Files.createDirectories(reports);
            Path temporary = reports.resolve("latest.json.tmp");
            Files.write(temporary, report.toJson().getBytes(StandardCharsets.UTF_8));
            Files.move(temporary, reports.resolve("latest.json"), StandardCopyOption.REPLACE_EXISTING);
            return report;
        } catch (Exception error) {
            results.put(ProbeCheck.REPORT_PERSISTENCE,
                    ProbeResult.fail(error.getClass().getSimpleName() + ": " + error.getMessage()));
            return new ProbeReport(results, deviceName());
        }
    }

    private static String deviceName() {
        return Build.MANUFACTURER + " " + Build.MODEL + " / Android " + Build.VERSION.RELEASE;
    }

    private static String gib(long bytes) {
        return String.format(java.util.Locale.US, "%.1f", bytes / (1024d * 1024d * 1024d));
    }
}