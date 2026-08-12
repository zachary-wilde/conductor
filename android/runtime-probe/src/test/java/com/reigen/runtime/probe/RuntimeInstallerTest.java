package com.reigen.runtime.probe;

import static org.junit.Assert.assertFalse;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

public final class RuntimeInstallerTest {
    @Test
    public void deletesDanglingSymlinksDuringStagingCleanup() throws Exception {
        Path root = Files.createTempDirectory("reigen-cleanup");
        Path alternatives = Files.createDirectories(root.resolve("etc/alternatives"));
        Files.createSymbolicLink(alternatives.resolve("missing"), Path.of("../../missing"));

        Method cleanup = RuntimeInstaller.class.getDeclaredMethod("deleteRecursively", File.class);
        cleanup.setAccessible(true);
        try {
            cleanup.invoke(null, root.toFile());
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw error;
        }

        assertFalse(Files.exists(root, java.nio.file.LinkOption.NOFOLLOW_LINKS));
    }
}
