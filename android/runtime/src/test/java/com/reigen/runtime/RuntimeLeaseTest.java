package com.reigen.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class RuntimeLeaseTest {

    private static final String SECRET = "bearer-token-do-not-leak-9f3c";

    @Test
    public void exposesLoopbackUrlAndExpiryButNotTheBearer() {
        RuntimeLease lease = RuntimeLease.of("http://127.0.0.1:8443", SECRET, 5_000L);

        assertEquals("http://127.0.0.1:8443", lease.loopbackUrl());
        assertEquals(5_000L, lease.expiresAtEpochMillis());
        // The authorization header is the single legitimate consumer of the token,
        // and it lives entirely on the native binder/plugin boundary.
        assertEquals("Bearer " + SECRET, lease.authorizationHeader());
    }

    @Test
    public void loopbackUrlNeverLeavesLoopback() {
        RuntimeLease lease = RuntimeLease.of("http://127.0.0.1:8443", SECRET, 1L);
        assertTrue(lease.loopbackUrl(), lease.loopbackUrl().contains("127.0.0.1"));
    }

    @Test
    public void jsonNeverContainsTheBearer() {
        RuntimeLease lease = RuntimeLease.of("http://127.0.0.1:8443", SECRET, 5_000L);
        String json = lease.toJson();

        assertTrue(json.contains("\"loopbackUrl\":\"http://127.0.0.1:8443\""));
        assertTrue(json.contains("\"expiresAt\":5000"));
        assertNoSecret(json, SECRET);
    }

    @Test
    public void displayStringNeverContainsTheBearer() {
        RuntimeLease lease = RuntimeLease.of("http://127.0.0.1:8443", SECRET, 5_000L);
        assertNoSecret(lease.toDisplayString(), SECRET);
    }

    @Test
    public void toStringNeverContainsTheBearer() {
        RuntimeLease lease = RuntimeLease.of("http://127.0.0.1:8443", SECRET, 5_000L);
        assertNoSecret(lease.toString(), SECRET);
    }

    @Test
    public void isExpiredReflectsTheProvidedClock() {
        RuntimeLease lease = RuntimeLease.of("http://127.0.0.1:8443", SECRET, 10_000L);
        assertFalse(lease.isExpired(9_999L));
        assertTrue(lease.isExpired(10_000L));
        assertTrue(lease.isExpired(20_000L));
    }

    @Test
    public void rejectsNonLoopbackUrlAtConstruction() {
        try {
            RuntimeLease.of("http://10.0.0.5:8443", SECRET, 1L);
            throw new AssertionError("expected IllegalArgumentException for non-loopback URL");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage(), expected.getMessage().contains("loopback"));
        }
    }

    @Test
    public void rejectsBlankBearerToken() {
        try {
            RuntimeLease.of("http://127.0.0.1:8443", "  ", 1L);
            throw new AssertionError("expected IllegalArgumentException for blank bearer");
        } catch (IllegalArgumentException expected) {
            // expected
        }
    }

    private static void assertNoSecret(String text, String secret) {
        assertFalse("bearer value leaked: " + text, text.contains(secret));
        assertFalse("word 'bearer' leaked: " + text, text.toLowerCase().contains("bearer"));
    }
}
