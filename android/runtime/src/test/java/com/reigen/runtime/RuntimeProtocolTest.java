package com.reigen.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

public final class RuntimeProtocolTest {

    @Test
    public void protocolVersionIsOneAndStable() {
        assertEquals(1, RuntimeProtocol.PROTOCOL_VERSION);
    }

    @Test
    public void operationNamesAreStableWireIdentifiers() {
        assertEquals("get_status", RuntimeProtocol.OP_GET_STATUS);
        assertEquals("connect", RuntimeProtocol.OP_CONNECT);
        assertEquals("disconnect", RuntimeProtocol.OP_DISCONNECT);
        assertEquals("diagnostics", RuntimeProtocol.OP_DIAGNOSTICS);
        assertEquals("backup", RuntimeProtocol.OP_BACKUP);
        assertEquals("restore", RuntimeProtocol.OP_RESTORE);
    }

    @Test
    public void operationNamesAreUnique() {
        Set<String> names = new HashSet<>();
        names.add(RuntimeProtocol.OP_GET_STATUS);
        names.add(RuntimeProtocol.OP_CONNECT);
        names.add(RuntimeProtocol.OP_DISCONNECT);
        names.add(RuntimeProtocol.OP_DIAGNOSTICS);
        names.add(RuntimeProtocol.OP_BACKUP);
        names.add(RuntimeProtocol.OP_RESTORE);
        assertEquals(6, names.size());
    }

    @Test
    public void onlyTheCurrentProtocolVersionIsCompatible() {
        assertTrue(RuntimeProtocol.isCompatible(RuntimeProtocol.PROTOCOL_VERSION));
        assertFalse(RuntimeProtocol.isCompatible(0));
        assertFalse(RuntimeProtocol.isCompatible(2));
        assertFalse(RuntimeProtocol.isCompatible(RuntimeProtocol.PROTOCOL_VERSION + 1));
    }

    @Test
    public void lowerPeerVersionsRequireUpgradeAndHigherPeerVersionsMismatch() {
        // The Runtime is the source of truth at PROTOCOL_VERSION. A peer reporting a
        // lower version must upgrade to talk to this Runtime.
        assertEquals(
                RuntimeProtocol.RuntimeError.UPGRADE_REQUIRED,
                RuntimeProtocol.classifyVersion(RuntimeProtocol.PROTOCOL_VERSION - 1));
        // A peer claiming a version newer than the Runtime is a hard mismatch: this
        // Runtime cannot honour a protocol it does not know.
        assertEquals(
                RuntimeProtocol.RuntimeError.PROTOCOL_MISMATCH,
                RuntimeProtocol.classifyVersion(RuntimeProtocol.PROTOCOL_VERSION + 1));
        // The current version is accepted and yields no error.
        assertEquals(null, RuntimeProtocol.classifyVersion(RuntimeProtocol.PROTOCOL_VERSION));
    }

    @Test
    public void errorCodesAreStableStringsForTheJsBridge() {
        assertEquals("unavailable", RuntimeProtocol.RuntimeError.UNAVAILABLE.code());
        assertEquals("upgrade_required", RuntimeProtocol.RuntimeError.UPGRADE_REQUIRED.code());
        assertEquals("interrupted", RuntimeProtocol.RuntimeError.INTERRUPTED.code());
        assertEquals("protocol_mismatch", RuntimeProtocol.RuntimeError.PROTOCOL_MISMATCH.code());
        assertEquals("forbidden", RuntimeProtocol.RuntimeError.FORBIDDEN.code());
        assertEquals("storage_low", RuntimeProtocol.RuntimeError.STORAGE_LOW.code());
        assertEquals("storage_missing", RuntimeProtocol.RuntimeError.STORAGE_MISSING.code());
        assertEquals("backup_failed", RuntimeProtocol.RuntimeError.BACKUP_FAILED.code());
        assertEquals("restore_unsafe", RuntimeProtocol.RuntimeError.RESTORE_UNSAFE.code());
        assertEquals("internal", RuntimeProtocol.RuntimeError.INTERNAL.code());
    }
}
