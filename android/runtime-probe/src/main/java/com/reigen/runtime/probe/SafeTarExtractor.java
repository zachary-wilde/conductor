package com.reigen.runtime.probe;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.List;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;

public final class SafeTarExtractor {
    private SafeTarExtractor() {}

    public static void extract(InputStream source, Path root, int maxEntries, long maxBytes)
            throws IOException {
        Files.createDirectories(root);
        List<DirectoryMode> directories = new ArrayList<>();
        List<HardLink> hardLinks = new ArrayList<>();
        Set<Path> destinations = new HashSet<>();
        int entries = 0;
        long bytes = 0;

        try (TarArchiveInputStream tar = new TarArchiveInputStream(source)) {
            TarArchiveEntry entry;
            byte[] buffer = new byte[64 * 1024];
            while ((entry = tar.getNextTarEntry()) != null) {
                if (Thread.currentThread().isInterrupted()) {
                    throw new InterruptedIOException("Runtime extraction cancelled");
                }
                if (++entries > maxEntries) throw new IOException("Archive entry limit exceeded");
                if (entry.isCharacterDevice() || entry.isBlockDevice() || entry.isFIFO()) {
                    throw new IOException("Unsupported special archive entry: " + entry.getName());
                }
                if (entry.isSparse()) throw new IOException("Sparse archive entries are not supported");

                Path output = SafeArchivePath.resolve(root, entry.getName());
                if (!destinations.add(output)) {
                    throw new IOException("Duplicate archive destination: " + entry.getName());
                }
                ensureSafeAncestors(root, output.getParent());
                if (Files.isSymbolicLink(output)) {
                    throw new IOException("Duplicate archive member targets a symlink: " + entry.getName());
                }
                if (entry.isDirectory()) {
                    Files.createDirectories(output);
                    directories.add(new DirectoryMode(output, entry.getMode()));
                } else if (entry.isSymbolicLink()) {
                    Files.createDirectories(output.getParent());
                    Files.deleteIfExists(output);
                    Files.createSymbolicLink(output, symlinkTarget(root, output, entry.getLinkName()));
                } else if (entry.isLink()) {
                    hardLinks.add(new HardLink(output, SafeArchivePath.resolve(root, entry.getLinkName()), entry.getMode()));
                } else if (entry.isFile()) {
                    long size = entry.getSize();
                    if (size < 0 || size > maxBytes - bytes) {
                        throw new IOException("Archive uncompressed size limit exceeded");
                    }
                    Files.createDirectories(output.getParent());
                    try (OutputStream destination = Files.newOutputStream(output)) {
                        long remaining = size;
                        while (remaining > 0) {
                            int read = tar.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                            if (Thread.currentThread().isInterrupted()) {
                                throw new InterruptedIOException("Runtime extraction cancelled");
                            }
                            if (read < 0) throw new IOException("Truncated archive entry: " + entry.getName());
                            destination.write(buffer, 0, read);
                            remaining -= read;
                        }
                    }
                    bytes += size;
                    applyOwnerMode(output, entry.getMode());
                } else {
                    throw new IOException("Unsupported archive entry: " + entry.getName());
                }
            }
        }

        for (HardLink link : hardLinks) {
            ensureSafeAncestors(root, link.output.getParent());
            if (Files.isSymbolicLink(link.output)) {
                throw new IOException("Hard-link output already exists as a symlink: " + link.output);
            }
            if (!Files.isRegularFile(link.target, LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("Hard-link target is not a regular file: " + link.target);
            }
            Files.createDirectories(link.output.getParent());
            Files.deleteIfExists(link.output);
            Files.copy(link.target, link.output, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            applyOwnerMode(link.output, link.mode);
        }
        for (int index = directories.size() - 1; index >= 0; index--) {
            DirectoryMode directory = directories.get(index);
            applyOwnerMode(directory.path, directory.mode);
        }
    }

    private static Path symlinkTarget(Path root, Path link, String target) {
        if (target.startsWith("/")) {
            Path resolved = SafeArchivePath.resolve(root, target.substring(1));
            return link.getParent().relativize(resolved);
        }
        SafeArchivePath.safeLinkTarget(root, link, target);
        return Paths.get(target);
    }

    private static void ensureSafeAncestors(Path root, Path parent) throws IOException {
        if (parent == null) return;
        Path normalizedRoot = root.toAbsolutePath().normalize();
        Path relative = normalizedRoot.relativize(parent.toAbsolutePath().normalize());
        Path current = normalizedRoot;
        for (Path part : relative) {
            current = current.resolve(part);
            if (Files.isSymbolicLink(current)) {
                throw new IOException("Archive member traverses symlink: " + current);
            }
        }
    }

    private static void applyOwnerMode(Path path, int mode) {
        path.toFile().setReadable((mode & 0400) != 0, true);
        path.toFile().setWritable((mode & 0200) != 0, true);
        path.toFile().setExecutable((mode & 0100) != 0, true);
    }

    private static final class DirectoryMode {
        private final Path path;
        private final int mode;

        private DirectoryMode(Path path, int mode) {
            this.path = path;
            this.mode = mode;
        }
    }

    private static final class HardLink {
        private final Path output;
        private final Path target;
        private final int mode;

        private HardLink(Path output, Path target, int mode) {
            this.output = output;
            this.target = target;
            this.mode = mode;
        }
    }
}
