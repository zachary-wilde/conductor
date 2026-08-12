package com.reigen.runtime;

import java.util.Objects;

/**
 * A short-lived authenticated loopback Core lease.
 *
 * <p>The bearer token is the single secret in this object. It is exposed ONLY through
 * {@link #authorizationHeader()}, which the native binder/plugin applies directly to the
 * Core HTTP client. It is never returned to JavaScript, never persisted in UI state, and
 * deliberately absent from {@link #toJson()}, {@link #toDisplayString()}, and
 * {@link #toString()} so that diagnostics and logs cannot leak it.
 *
 * <p>Leases are constrained to loopback (127.0.0.1 / localhost); a non-loopback URL is
 * rejected at construction so the Runtime can never be asked to hand a bearer to a LAN
 * endpoint.
 */
public final class RuntimeLease {

    private final String loopbackUrl;
    private final String bearerToken;
    private final long expiresAtEpochMillis;

    private RuntimeLease(String loopbackUrl, String bearerToken, long expiresAtEpochMillis) {
        this.loopbackUrl = requireLoopback(loopbackUrl);
        this.bearerToken = requireBearer(bearerToken);
        this.expiresAtEpochMillis = expiresAtEpochMillis;
    }

    public static RuntimeLease of(String loopbackUrl, String bearerToken, long expiresAtEpochMillis) {
        return new RuntimeLease(loopbackUrl, bearerToken, expiresAtEpochMillis);
    }

    public String loopbackUrl() {
        return loopbackUrl;
    }

    public long expiresAtEpochMillis() {
        return expiresAtEpochMillis;
    }

    /**
     * The only accessor that reveals the token. Reserved for the native Core client
     * factory; the UI adapter must never forward this to JavaScript.
     */
    public String authorizationHeader() {
        return "Bearer " + bearerToken;
    }

    public boolean isExpired(long nowEpochMillis) {
        return nowEpochMillis >= expiresAtEpochMillis;
    }

    public boolean isExpired() {
        return isExpired(System.currentTimeMillis());
    }

    /** Safe for diagnostics: loopback URL and expiry only, never the bearer. */
    public String toJson() {
        return "{\"loopbackUrl\":\""
                + escape(loopbackUrl)
                + "\",\"expiresAt\":"
                + expiresAtEpochMillis
                + '}';
    }

    /** Safe for display: loopback URL and expiry only, never the bearer. */
    public String toDisplayString() {
        return "Runtime lease on " + loopbackUrl + " (expires " + expiresAtEpochMillis + "ms)";
    }

    @Override
    public String toString() {
        return "RuntimeLease{loopbackUrl=" + loopbackUrl + ", expiresAt=" + expiresAtEpochMillis + '}';
    }

    private static String requireLoopback(String url) {
        Objects.requireNonNull(url, "loopbackUrl");
        String host = hostOf(url);
        if (!"127.0.0.1".equals(host) && !"localhost".equals(host)) {
            throw new IllegalArgumentException(
                    "Runtime lease must target a loopback URL, got: " + url);
        }
        return url;
    }

    private static String hostOf(String url) {
        String rest = url;
        int scheme = rest.indexOf("://");
        if (scheme >= 0) {
            rest = rest.substring(scheme + 3);
        }
        int end = rest.length();
        int colon = rest.indexOf(':');
        int slash = rest.indexOf('/');
        if (colon >= 0) {
            end = Math.min(end, colon);
        }
        if (slash >= 0) {
            end = Math.min(end, slash);
        }
        return rest.substring(0, end);
    }

    private static String requireBearer(String token) {
        Objects.requireNonNull(token, "bearerToken");
        if (token.trim().isEmpty()) {
            throw new IllegalArgumentException("Runtime lease bearer token must not be blank");
        }
        return token;
    }

    private static String escape(String value) {
        StringBuilder escaped = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\\') {
                escaped.append("\\\\");
            } else if (c == '"') {
                escaped.append("\\\"");
            } else if (c == '\n') {
                escaped.append("\\n");
            } else if (c == '\r') {
                escaped.append("\\r");
            } else if (c < 0x20) {
                escaped.append("\\u00")
                        .append("0123456789abcdef".charAt((c >>> 4) & 0xf))
                        .append("0123456789abcdef".charAt(c & 0xf));
            } else {
                escaped.append(c);
            }
        }
        return escaped.toString();
    }
}
