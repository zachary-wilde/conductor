package com.reigen.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.junit.Test;

public final class RuntimeStatusTest {

    @Test
    public void eachStateSerializesToItsStableWireName() {
        assertEquals("starting", RuntimeStatus.RuntimeState.STARTING.wireName());
        assertEquals("connected", RuntimeStatus.RuntimeState.CONNECTED.wireName());
        assertEquals("interrupted", RuntimeStatus.RuntimeState.INTERRUPTED.wireName());
        assertEquals("unavailable", RuntimeStatus.RuntimeState.UNAVAILABLE.wireName());
        assertEquals("upgrade_required", RuntimeStatus.RuntimeState.UPGRADE_REQUIRED.wireName());
    }

    @Test
    public void roundTripsWireNameBackToState() {
        for (RuntimeStatus.RuntimeState state : RuntimeStatus.RuntimeState.values()) {
            assertEquals(state, RuntimeStatus.RuntimeState.fromWireName(state.wireName()));
        }
    }

    @Test
    public void unknownWireNameIsUnavailable() {
        assertEquals(
                RuntimeStatus.RuntimeState.UNAVAILABLE,
                RuntimeStatus.RuntimeState.fromWireName("nope"));
    }

    @Test
    public void toJsonIncludesPublicStateButNeverSecrets() {
        RuntimeStatus status = RuntimeStatus.builder(RuntimeStatus.RuntimeState.CONNECTED)
                .runtimeVersion("0.1.0")
                .coreState("healthy")
                .capabilities(Arrays.asList("pty", "git", "backup"))
                .sessionIds(Arrays.asList("sess-1", "sess-2"))
                .lastReconnect("2026-08-10T01:02:03Z")
                .reconnectAttempt(0)
                .build();

        String json = status.toJson();

        assertTrue(json.contains("\"state\":\"connected\""));
        assertTrue(json.contains("\"runtimeVersion\":\"0.1.0\""));
        assertTrue(json.contains("\"coreState\":\"healthy\""));
        assertTrue(json.contains("\"protocolVersion\":1"));
        assertTrue(json.contains("pty"));
        assertTrue(json.contains("sess-1"));
        assertTrue(json.contains("\"lastReconnect\":\"2026-08-10T01:02:03Z\""));
        // Status carries no secrets at all; prove the secret vocabulary is absent.
        assertNoSecrets(json);
    }

    @Test
    public void serializationCoversEveryContractState() {
        for (RuntimeStatus.RuntimeState state : RuntimeStatus.RuntimeState.values()) {
            String json = RuntimeStatus.builder(state).build().toJson();
            assertTrue("state " + state + " missing from " + json, json.contains(state.wireName()));
            assertNoSecrets(json);
        }
    }

    @Test
    public void capabilitiesAndSessionsAreDefensivelyCopiedAndUnmodifiable() {
        List<String> sessions = Arrays.asList("s1");
        List<String> caps = Arrays.asList("git");
        RuntimeStatus status = RuntimeStatus.builder(RuntimeStatus.RuntimeState.STARTING)
                .capabilities(caps)
                .sessionIds(sessions)
                .build();

        assertEquals(sessions, status.sessionIds());
        assertEquals(new LinkedHashSet<>(caps), status.capabilities());

        assertThrows(UnsupportedOperationException.class, () -> status.sessionIds().add("s2"));
        assertThrows(UnsupportedOperationException.class, () -> status.capabilities().add("x"));
    }

    @Test
    public void emptyCollectionsSerializeStably() {
        RuntimeStatus status = RuntimeStatus.builder(RuntimeStatus.RuntimeState.UNAVAILABLE).build();
        String json = status.toJson();
        assertTrue(json.contains("\"capabilities\":[]"));
        assertTrue(json.contains("\"sessionIds\":[]"));
        assertEquals(Collections.emptyList(), status.sessionIds());
        assertEquals(Collections.emptySet(), status.capabilities());
    }

    @Test
    public void builderRejectsNullState() {
        assertThrows(NullPointerException.class, () -> RuntimeStatus.builder(null));
    }

    private static void assertNoSecrets(String json) {
        assertFalse("bearer leaked into JSON", json.toLowerCase().contains("bearer"));
        assertFalse("token leaked into JSON", json.toLowerCase().contains("token"));
        assertFalse("secret leaked into JSON", json.toLowerCase().contains("secret"));
        assertFalse("password leaked into JSON", json.toLowerCase().contains("password"));
    }
}
