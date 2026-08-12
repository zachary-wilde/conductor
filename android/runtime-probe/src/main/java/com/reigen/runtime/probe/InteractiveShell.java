package com.reigen.runtime.probe;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

public final class InteractiveShell implements AutoCloseable {
    private final Process process;
    private final OutputStream input;
    private final AtomicBoolean closed = new AtomicBoolean();

    public InteractiveShell(RuntimeInstaller.Runtime runtime, Consumer<String> output) throws IOException {
        ProotCommand command = ProotCommand.forShell(
                runtime.proot,
                runtime.loader,
                runtime.loader32,
                runtime.rootfs,
                runtime.temp,
                "exec /usr/bin/script -qefc /bin/bash /dev/null");
        ProcessBuilder builder = new ProcessBuilder(command.argv());
        builder.environment().putAll(command.environment());
        builder.redirectErrorStream(true);
        process = builder.start();
        input = process.getOutputStream();
        Thread reader = new Thread(() -> readOutput(process.getInputStream(), output), "probe-terminal-output");
        reader.setDaemon(true);
        reader.start();
    }

    public synchronized void sendLine(String line) throws IOException {
        if (closed.get()) throw new IOException("Terminal is closed");
        input.write((line + "\n").getBytes(StandardCharsets.UTF_8));
        input.flush();
    }

    public boolean isAlive() {
        return process.isAlive();
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        try {
            input.write("exit\n".getBytes(StandardCharsets.UTF_8));
            input.flush();
        } catch (IOException ignored) {
            // The shell may already have exited.
        }
        process.destroy();
        try {
            if (!process.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) process.destroyForcibly();
        } catch (InterruptedException interrupted) {
            process.destroyForcibly();
            Thread.currentThread().interrupt();
        }
    }

    private void readOutput(InputStream source, Consumer<String> output) {
        byte[] buffer = new byte[4096];
        try {
            int read;
            while ((read = source.read(buffer)) >= 0) {
                output.accept(new String(buffer, 0, read, StandardCharsets.UTF_8));
            }
        } catch (IOException error) {
            if (!closed.get()) output.accept("\n[terminal closed: " + error.getMessage() + "]\n");
        }
    }
}
