package com.reigen.runtime.probe;

public enum ProbeCheck {
    DEVICE_PROFILE("deviceProfile"),
    ARTIFACTS("artifactIntegrity"),
    ROOTFS("rootfs"),
    SHELL("debianShell"),
    FILESYSTEM("filesystem"),
    GIT("git"),
    PTY("pty"),
    OMP_VERSION("ompVersion"),
    CHILDREN("childProcesses"),
    OMP_WORKFLOW("ompWorkflow"),
    FOREGROUND_SERVICE("foregroundService"),
    REPORT_PERSISTENCE("reportPersistence"),
    SD_CARD("sdCard");

    private final String id;

    ProbeCheck(String id) {
        this.id = id;
    }

    public String id() {
        return id;
    }
}
