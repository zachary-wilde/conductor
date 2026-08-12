package com.reigen.runtime;

/**
 * Stable wire contract between the Reigen UI (Capacitor) and the Reigen Runtime
 * foreground service.
 *
 * <p>The Runtime is the source of truth for the protocol version. The UI adapter
 * validates every handshake against {@link #PROTOCOL_VERSION} and surfaces a typed
 * {@link RuntimeError} when the peer is incompatible. Operation names are fixed
 * identifiers shared by the local binder, the Capacitor plugin, and (eventually)
 * the TypeScript bridge adapter.
 */
public final class RuntimeProtocol {

    private RuntimeProtocol() {}

    /** Current bridge protocol version. Bumped only on a breaking wire change. */
    public static final int PROTOCOL_VERSION = 1;

    public static final String OP_GET_STATUS = "get_status";
    public static final String OP_CONNECT = "connect";
    public static final String OP_DISCONNECT = "disconnect";
    public static final String OP_DIAGNOSTICS = "diagnostics";
    public static final String OP_BACKUP = "backup";
    public static final String OP_RESTORE = "restore";

    /**
     * @return {@code true} only when the peer speaks exactly the current protocol.
     */
    public static boolean isCompatible(int peerVersion) {
        return peerVersion == PROTOCOL_VERSION;
    }

    /**
     * Classifies a peer-reported version against the Runtime's protocol version.
     *
     * @return {@code null} when the peer is compatible; {@link RuntimeError#UPGRADE_REQUIRED}
     *         when the peer is behind the Runtime (it must upgrade); or
     *         {@link RuntimeError#PROTOCOL_MISMATCH} when the peer claims a version newer
     *         than the Runtime understands.
     */
    public static RuntimeError classifyVersion(int peerVersion) {
        if (peerVersion == PROTOCOL_VERSION) {
            return null;
        }
        if (peerVersion < PROTOCOL_VERSION) {
            return RuntimeError.UPGRADE_REQUIRED;
        }
        return RuntimeError.PROTOCOL_MISMATCH;
    }

    /**
     * Typed, stable error vocabulary surfaced across the binder/plugin boundary and
     * mapped verbatim to JS error {@code code} strings by the Capacitor plugin.
     */
    public enum RuntimeError {
        UNAVAILABLE("unavailable"),
        UPGRADE_REQUIRED("upgrade_required"),
        INTERRUPTED("interrupted"),
        PROTOCOL_MISMATCH("protocol_mismatch"),
        FORBIDDEN("forbidden"),
        STORAGE_LOW("storage_low"),
        STORAGE_MISSING("storage_missing"),
        BACKUP_FAILED("backup_failed"),
        RESTORE_UNSAFE("restore_unsafe"),
        INTERNAL("internal");

        private final String code;

        RuntimeError(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }
}
