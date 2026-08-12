package com.reigen.runtime.probe;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.nio.file.Path;
import java.util.List;
import org.junit.Test;

public final class ProotCommandTest {
    @Test
    public void buildsIsolatedRootCommandWithPinnedLoaders() {
        ProotCommand command = ProotCommand.forShell(
                Path.of("/native/libproot.so"),
                Path.of("/native/libproot-loader.so"),
                Path.of("/native/libproot-loader32.so"),
                Path.of("/data/rootfs"),
                Path.of("/data/tmp"),
                "printf probe-ok");

        assertEquals("/native/libproot.so", command.argv().get(0));
        assertTrue(command.argv().containsAll(List.of("-r", "/data/rootfs", "-0", "--link2symlink")));
        assertEquals(List.of("/bin/bash", "-lc", "printf probe-ok"), command.argv().subList(command.argv().size() - 3, command.argv().size()));
        assertEquals("/native/libproot-loader.so", command.environment().get("PROOT_LOADER"));
        assertEquals("/native/libproot-loader32.so", command.environment().get("PROOT_LOADER_32"));
        assertEquals("/data/tmp", command.environment().get("PROOT_TMP_DIR"));
        assertFalse(command.environment().containsKey("PROOT_NO_SECCOMP"));
    }
}
