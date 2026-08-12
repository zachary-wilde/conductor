package com.reigen.runtime.probe;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.EnumMap;
import java.util.Map;
import org.junit.Test;

public final class ProbeReportTest {
    @Test
    public void reportIsCompleteOnlyWhenEveryRequiredCheckRan() {
        Map<ProbeCheck, ProbeResult> results = new EnumMap<>(ProbeCheck.class);
        for (ProbeCheck check : ProbeCheck.values()) {
            results.put(check, ProbeResult.pass("ok"));
        }
        ProbeReport complete = new ProbeReport(results, "probe-device");
        assertTrue(complete.complete());
        assertTrue(complete.passed());
        assertTrue(complete.toJson().contains("\"ompVersion\":{\"status\":\"pass\""));

        results.remove(ProbeCheck.SD_CARD);
        ProbeReport incomplete = new ProbeReport(results, "probe-device");
        assertFalse(incomplete.complete());
        assertFalse(incomplete.passed());
    }

    @Test
    public void oneFailureMakesTheReportFail() {
        Map<ProbeCheck, ProbeResult> results = new EnumMap<>(ProbeCheck.class);
        for (ProbeCheck check : ProbeCheck.values()) results.put(check, ProbeResult.pass("ok"));
        results.put(ProbeCheck.PTY, ProbeResult.fail("not a tty"));

        assertFalse(new ProbeReport(results, "probe-device").passed());
    }

    @Test
    public void jsonEscapesTerminalControlCharacters() {
        Map<ProbeCheck, ProbeResult> results = new EnumMap<>(ProbeCheck.class);
        results.put(ProbeCheck.SHELL, ProbeResult.pass("tab\tansi\u001b[31m"));

        String json = new ProbeReport(results, "probe\u0001device").toJson();

        assertTrue(json.contains("tab\\u0009ansi\\u001b[31m"));
        assertTrue(json.contains("probe\\u0001device"));
    }
}
