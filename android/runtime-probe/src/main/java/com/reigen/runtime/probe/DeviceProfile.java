package com.reigen.runtime.probe;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class DeviceProfile {
    private static final long GIB = 1024L * 1024L * 1024L;
    private static final long MIN_RAM = 6L * GIB;
    private static final long MIN_FREE_STORAGE = 12L * GIB;

    private final List<String> supportedAbis;
    private final long totalRamBytes;
    private final long freeStorageBytes;

    public DeviceProfile(List<String> supportedAbis, long totalRamBytes, long freeStorageBytes) {
        this.supportedAbis = List.copyOf(supportedAbis);
        this.totalRamBytes = totalRamBytes;
        this.freeStorageBytes = freeStorageBytes;
    }

    public boolean eligible() {
        return failures().isEmpty();
    }

    public List<String> failures() {
        List<String> failures = new ArrayList<>();
        if (!supportedAbis.contains("arm64-v8a")) failures.add("ARM64 ABI is required");
        if (totalRamBytes < MIN_RAM) failures.add("At least 6 GiB RAM is required");
        if (freeStorageBytes < MIN_FREE_STORAGE) {
            failures.add("At least 12 GiB free internal storage is required");
        }
        return Collections.unmodifiableList(failures);
    }
}
