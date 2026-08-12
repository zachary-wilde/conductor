package com.reigen.runtime.probe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.Test;

public final class DeviceProfileTest {
    private static final long GIB = 1024L * 1024L * 1024L;

    @Test
    public void tabS9ProfileIsEligible() {
        DeviceProfile profile = new DeviceProfile(List.of("arm64-v8a"), 8 * GIB, 40 * GIB);

        assertTrue(profile.eligible());
        assertTrue(profile.failures().isEmpty());
    }


    @Test
    public void rejectsUnsupportedAbiAndInsufficientResources() {
        DeviceProfile profile = new DeviceProfile(List.of("x86_64"), 4 * GIB, 8 * GIB);

        assertEquals(
                List.of(
                        "ARM64 ABI is required",
                        "At least 6 GiB RAM is required",
                        "At least 12 GiB free internal storage is required"),
                profile.failures());
    }
}
