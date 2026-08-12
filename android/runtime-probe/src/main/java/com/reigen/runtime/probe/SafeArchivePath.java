package com.reigen.runtime.probe;

import java.nio.file.Path;

public final class SafeArchivePath {
    private SafeArchivePath() {}

    public static Path resolve(Path root, String memberName) {
        if (memberName.isEmpty() || memberName.startsWith("/") || memberName.startsWith("\\")
                || memberName.matches("^[A-Za-z]:.*")) {
            throw new IllegalArgumentException("Unsafe archive member: " + memberName);
        }
        Path normalizedRoot = root.toAbsolutePath().normalize();
        Path resolved = normalizedRoot.resolve(memberName).normalize();
        if (!resolved.startsWith(normalizedRoot)) {
            throw new IllegalArgumentException("Archive member escapes destination: " + memberName);
        }
        return resolved;
    }

    public static String safeLinkTarget(Path root, Path linkPath, String target) {
        if (target.isEmpty() || target.startsWith("/") || target.startsWith("\\")
                || target.matches("^[A-Za-z]:.*")) {
            throw new IllegalArgumentException("Unsafe link target: " + target);
        }
        Path normalizedRoot = root.toAbsolutePath().normalize();
        Path parent = linkPath.toAbsolutePath().normalize().getParent();
        if (parent == null || !parent.resolve(target).normalize().startsWith(normalizedRoot)) {
            throw new IllegalArgumentException("Link target escapes destination: " + target);
        }
        return target;
    }
}
