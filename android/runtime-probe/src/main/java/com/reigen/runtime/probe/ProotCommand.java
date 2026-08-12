package com.reigen.runtime.probe;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class ProotCommand {
    private final List<String> argv;
    private final Map<String, String> environment;

    private ProotCommand(List<String> argv, Map<String, String> environment) {
        this.argv = Collections.unmodifiableList(new ArrayList<>(argv));
        this.environment = Collections.unmodifiableMap(new LinkedHashMap<>(environment));
    }

    public static ProotCommand forShell(
            Path proot,
            Path loader,
            Path loader32,
            Path rootfs,
            Path temp,
            String shellCommand) {
        List<String> argv = List.of(
                linuxPath(proot),
                "-r", linuxPath(rootfs),
                "-0",
                "--link2symlink",
                "--kill-on-exit",
                "-b", "/dev",
                "-b", "/proc",
                "-b", "/sys",
                "-w", "/root",
                "/bin/bash", "-lc", shellCommand);
        Map<String, String> environment = new LinkedHashMap<>();
        environment.put("PROOT_LOADER", linuxPath(loader));
        environment.put("PROOT_LOADER_32", linuxPath(loader32));
        environment.put("PROOT_TMP_DIR", linuxPath(temp));
        environment.put("HOME", "/root");
        environment.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        environment.put("LANG", "C.UTF-8");
        return new ProotCommand(argv, environment);
    }

    private static String linuxPath(Path path) {
        return path.toString().replace('\\', '/');
    }

    public List<String> argv() {
        return argv;
    }

    public Map<String, String> environment() {
        return environment;
    }
}
