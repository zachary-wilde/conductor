package com.reigen.runtime.probe;

import java.util.Objects;

public final class ProbeResult {
    private final boolean passed;
    private final String detail;

    private ProbeResult(boolean passed, String detail) {
        this.passed = passed;
        this.detail = Objects.requireNonNull(detail, "detail");
    }

    public static ProbeResult pass(String detail) {
        return new ProbeResult(true, detail);
    }

    public static ProbeResult fail(String detail) {
        return new ProbeResult(false, detail);
    }

    public boolean passed() {
        return passed;
    }

    public String detail() {
        return detail;
    }
}
