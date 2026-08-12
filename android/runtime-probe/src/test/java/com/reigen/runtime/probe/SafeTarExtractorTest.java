package com.reigen.runtime.probe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream;
import org.junit.Test;

public final class SafeTarExtractorTest {
    @Test
    public void extractsExecutableFileInsideDestination() throws Exception {
        byte[] archive = archive(entry("usr/bin/probe", "probe-ok", 0755));
        Path root = Files.createTempDirectory("reigen-rootfs");

        SafeTarExtractor.extract(new ByteArrayInputStream(archive), root, 10, 1024);

        assertEquals("probe-ok", new String(Files.readAllBytes(root.resolve("usr/bin/probe")), StandardCharsets.UTF_8));
        assertTrue(Files.isExecutable(root.resolve("usr/bin/probe")));
    }

    @Test
    public void extractsHardLinksByCopyingOnAndroidFilesystems() throws Exception {
        byte[] archive = archive(
                entry("usr/bin/perl", "perl", 0755),
                hardLink("usr/bin/perl5.36.0", "usr/bin/perl"));
        Path root = Files.createTempDirectory("reigen-hard-link");

        SafeTarExtractor.extract(new ByteArrayInputStream(archive), root, 10, 1024);

        assertEquals(
                "perl",
                new String(Files.readAllBytes(root.resolve("usr/bin/perl5.36.0")), StandardCharsets.UTF_8));
        assertFalse(Files.isSameFile(root.resolve("usr/bin/perl"), root.resolve("usr/bin/perl5.36.0")));
    }


    @Test
    public void rejectsTraversalBeforeWritingOutsideDestination() throws Exception {
        byte[] archive = archive(entry("../escape", "bad", 0644));
        Path parent = Files.createTempDirectory("reigen-parent");
        Path root = parent.resolve("root");

        assertThrows(
                IllegalArgumentException.class,
                () -> SafeTarExtractor.extract(new ByteArrayInputStream(archive), root, 10, 1024));
        assertTrue(Files.notExists(parent.resolve("escape")));
    }


    @Test
    public void enforcesEntryAndExpandedSizeLimits() throws Exception {
        byte[] archive = archive(
                entry("first", "abc", 0644),
                entry("second", "def", 0644));

        assertThrows(
                java.io.IOException.class,
                () -> SafeTarExtractor.extract(
                        new ByteArrayInputStream(archive),
                        Files.createTempDirectory("reigen-entry-limit"),
                        1,
                        1024));
        assertThrows(
                java.io.IOException.class,
                () -> SafeTarExtractor.extract(
                        new ByteArrayInputStream(archive),
                        Files.createTempDirectory("reigen-size-limit"),
                        10,
                        2));
    }

    @Test
    public void rejectsDuplicateArchiveDestinations() throws Exception {
        byte[] archive = archive(
                entry("usr/bin/probe", "first", 0755),
                entry("usr/bin/probe", "second", 0755));

        assertThrows(
                java.io.IOException.class,
                () -> SafeTarExtractor.extract(
                        new ByteArrayInputStream(archive),
                        Files.createTempDirectory("reigen-duplicate-path"),
                        10,
                        1024));
    }
    private static TarArchiveEntry hardLink(String name, String target) {
        TarArchiveEntry entry = new TarArchiveEntry(name, TarArchiveEntry.LF_LINK);
        entry.setLinkName(target);
        return entry;
    }

    private static TarArchiveEntry entry(String name, String content, int mode) {
        TarArchiveEntry entry = new TarArchiveEntry(name);
        entry.setMode(mode);
        entry.setSize(content.getBytes(StandardCharsets.UTF_8).length);
        entry.setUserName(content);
        return entry;
    }
    private static byte[] archive(TarArchiveEntry... entries) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (TarArchiveOutputStream tar = new TarArchiveOutputStream(bytes)) {
            for (TarArchiveEntry entry : entries) {
                tar.putArchiveEntry(entry);
                if (entry.isFile()) tar.write(entry.getUserName().getBytes(StandardCharsets.UTF_8));
                tar.closeArchiveEntry();
            }
        }
        return bytes.toByteArray();
    }
}
