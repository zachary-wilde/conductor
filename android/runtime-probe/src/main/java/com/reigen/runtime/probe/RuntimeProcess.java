package com.reigen.runtime.probe;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class RuntimeProcess {
    private static final int MAX_CAPTURE_BYTES = 1024 * 1024;

    private RuntimeProcess() {}

    public static Result run(RuntimeInstaller.Runtime runtime, String shellCommand, long timeoutSeconds)
            throws IOException, InterruptedException {
        ProotCommand command = ProotCommand.forShell(
                runtime.proot, runtime.loader, runtime.loader32, runtime.rootfs, runtime.temp, shellCommand);
        ProcessBuilder builder = new ProcessBuilder(command.argv());
        builder.environment().putAll(command.environment());
        builder.redirectErrorStream(true);
        Process process = builder.start();
        ByteArrayOutputStream capture = new ByteArrayOutputStream();
        InputStream processOutput = process.getInputStream();
        AtomicReference<IOException> readFailure = new AtomicReference<>();
        Thread reader = new Thread(() -> {
            try {
                copyBounded(processOutput, capture);
            } catch (IOException error) {
                readFailure.set(error);
            }
        }, "probe-command-output");
        reader.setDaemon(true);
        reader.start();
        boolean finished;
        try {
            finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            process.destroyForcibly();
            try {
                processOutput.close();
            } catch (IOException cleanup) {
                interrupted.addSuppressed(cleanup);
            }
            Thread.currentThread().interrupt();
            throw interrupted;
        }
        if (!finished) {
            process.destroyForcibly();
            process.waitFor(5, TimeUnit.SECONDS);
            processOutput.close();
        }
        reader.join(5_000);
        if (reader.isAlive()) throw new IOException("Command output reader did not terminate");
        if (finished && readFailure.get() != null) throw readFailure.get();
        return new Result(
                finished ? process.exitValue() : -1,
                !finished,
                new String(capture.toByteArray(), StandardCharsets.UTF_8));
    }

    private static void copyBounded(InputStream source, ByteArrayOutputStream destination) throws IOException {
        byte[] buffer = new byte[4096];
        int total = 0;
        int read;
        while ((read = source.read(buffer)) >= 0) {
            int accepted = Math.min(read, MAX_CAPTURE_BYTES - total);
            if (accepted > 0) destination.write(buffer, 0, accepted);
            total += accepted;
        }
    }

    public static final class Result {
        public final int exitCode;
        public final boolean timedOut;
        public final String output;

        private Result(int exitCode, boolean timedOut, String output) {
            this.exitCode = exitCode;
            this.timedOut = timedOut;
            this.output = output;
        }

        public boolean succeeded() {
            return !timedOut && exitCode == 0;
        }

        public String summary() {
            String normalized = output.replace('\r', ' ').replace('\n', ' ').trim();
            if (normalized.length() > 240) normalized = normalized.substring(normalized.length() - 240);
            if (timedOut) return "timed out; " + normalized;
            return "exit " + exitCode + (normalized.isEmpty() ? "" : "; " + normalized);
        }
    }
}
