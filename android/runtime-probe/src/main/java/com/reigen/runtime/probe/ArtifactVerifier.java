package com.reigen.runtime.probe;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

public final class ArtifactVerifier {
    private ArtifactVerifier() {}

    public static void verifySha256(Path path, String expected) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("Android runtime omitted SHA-256", error);
        }

        byte[] buffer = new byte[64 * 1024];
        try (InputStream input = Files.newInputStream(path)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Digest verification cancelled");
                digest.update(buffer, 0, read);
            }
        }

        char[] hex = "0123456789abcdef".toCharArray();
        StringBuilder actual = new StringBuilder(64);
        for (byte value : digest.digest()) {
            actual.append(hex[(value >>> 4) & 0xf]).append(hex[value & 0xf]);
        }
        if (!actual.toString().equals(expected)) {
            throw new SecurityException(
                    "SHA-256 mismatch for " + path.getFileName() + ": expected " + expected
                            + ", received " + actual);
        }
    }
}
