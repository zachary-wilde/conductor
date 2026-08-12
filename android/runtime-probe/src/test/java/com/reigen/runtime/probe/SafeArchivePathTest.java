package com.reigen.runtime.probe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.nio.file.Path;
import org.junit.Test;

public final class SafeArchivePathTest {
    private final Path root = Path.of("runtime-root").toAbsolutePath().normalize();

    @Test
    public void resolvesRelativeArchiveMemberInsideRoot() {
        assertEquals(root.resolve("usr/bin/git"), SafeArchivePath.resolve(root, "usr/bin/git"));
    }

    @Test
    public void rejectsTraversalAndAbsoluteMembers() {
        assertThrows(IllegalArgumentException.class, () -> SafeArchivePath.resolve(root, "../../escape"));
        assertThrows(IllegalArgumentException.class, () -> SafeArchivePath.resolve(root, "/etc/shadow"));
        assertThrows(IllegalArgumentException.class, () -> SafeArchivePath.resolve(root, "C:/escape"));
    }

    @Test
    public void rejectsLinksThatEscapeRoot() {
        Path link = root.resolve("usr/bin/tool");
        assertEquals("../lib/tool", SafeArchivePath.safeLinkTarget(root, link, "../lib/tool"));
        assertThrows(
                IllegalArgumentException.class,
                () -> SafeArchivePath.safeLinkTarget(root, link, "../../../../outside"));
    }
}
