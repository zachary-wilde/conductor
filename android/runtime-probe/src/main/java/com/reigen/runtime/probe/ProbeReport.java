package com.reigen.runtime.probe;

import java.time.Instant;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Objects;
import java.util.Map;

public final class ProbeReport {
    private final Map<ProbeCheck, ProbeResult> results;
    private final String device;
    private final String createdAt;

    public ProbeReport(Map<ProbeCheck, ProbeResult> results, String device) {
        EnumMap<ProbeCheck, ProbeResult> copy = new EnumMap<>(ProbeCheck.class);
        copy.putAll(Objects.requireNonNull(results, "results"));
        if (copy.containsValue(null)) throw new IllegalArgumentException("Probe results cannot contain null");
        this.results = Collections.unmodifiableMap(copy);
        this.device = Objects.requireNonNull(device, "device");
        this.createdAt = Instant.now().toString();
    }

    public boolean complete() {
        return results.size() == ProbeCheck.values().length;
    }

    public boolean passed() {
        if (!complete()) return false;
        for (ProbeResult result : results.values()) if (!result.passed()) return false;
        return true;
    }

    public Map<ProbeCheck, ProbeResult> results() {
        return results;
    }

    public String toJson() {
        StringBuilder json = new StringBuilder();
        json.append("{\"schemaVersion\":1,\"device\":\"")
                .append(escape(device))
                .append("\",\"createdAt\":\"")
                .append(escape(createdAt))
                .append("\",\"complete\":")
                .append(complete())
                .append(",\"passed\":")
                .append(passed())
                .append(",\"checks\":{");
        boolean first = true;
        for (ProbeCheck check : ProbeCheck.values()) {
            ProbeResult result = results.get(check);
            if (result == null) continue;
            if (!first) json.append(',');
            first = false;
            json.append('\"').append(check.id()).append("\":{\"status\":\"")
                    .append(result.passed() ? "pass" : "fail")
                    .append("\",\"detail\":\"")
                    .append(escape(result.detail()))
                    .append("\"}");
        }
        return json.append("}}\n").toString();
    }

    private static String escape(String value) {
        StringBuilder escaped = new StringBuilder(value.length());
        char[] hex = "0123456789abcdef".toCharArray();
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (current == '\\') escaped.append("\\\\");
            else if (current == '"') escaped.append("\\\"");
            else if (current == '\n') escaped.append("\\n");
            else if (current == '\r') escaped.append("\\r");
            else if (current < 0x20) {
                escaped.append("\\u00")
                        .append(hex[(current >>> 4) & 0xf])
                        .append(hex[current & 0xf]);
            } else {
                escaped.append(current);
            }
        }
        return escaped.toString();
    }
}
