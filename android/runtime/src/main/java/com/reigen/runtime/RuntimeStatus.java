package com.reigen.runtime;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Immutable, secret-free snapshot of public Runtime state.
 *
 * <p>A {@code RuntimeStatus} carries only what the UI is allowed to render: Runtime
 * state, versions, capability flags, session IDs, and reconnect metadata. Bearer
 * tokens, provider secrets, and filesystem paths live in {@link RuntimeLease} or
 * Runtime-private state and must never appear here. {@link #toJson()} is therefore
 * safe to include verbatim in redacted diagnostics.
 */
public final class RuntimeStatus {

    /** Lifecycle states surfaced to the UI, each with a stable wire name. */
    public enum RuntimeState {
        STARTING("starting"),
        CONNECTED("connected"),
        INTERRUPTED("interrupted"),
        UNAVAILABLE("unavailable"),
        UPGRADE_REQUIRED("upgrade_required");

        private final String wireName;

        RuntimeState(String wireName) {
            this.wireName = wireName;
        }

        public String wireName() {
            return wireName;
        }

        /** Unknown or null wire names resolve to {@link #UNAVAILABLE}, never to a live state. */
        public static RuntimeState fromWireName(String wireName) {
            if (wireName == null) {
                return UNAVAILABLE;
            }
            for (RuntimeState state : values()) {
                if (state.wireName.equals(wireName)) {
                    return state;
                }
            }
            return UNAVAILABLE;
        }
    }

    private final RuntimeState state;
    private final String runtimeVersion;
    private final String coreState;
    private final Set<String> capabilities;
    private final List<String> sessionIds;
    private final String lastReconnect;
    private final int reconnectAttempt;

    private RuntimeStatus(Builder builder) {
        this.state = Objects.requireNonNull(builder.state, "state");
        this.runtimeVersion = nullToEmpty(builder.runtimeVersion);
        this.coreState = nullToEmpty(builder.coreState);
        this.capabilities = immutableSet(builder.capabilities);
        this.sessionIds = immutableList(builder.sessionIds);
        this.lastReconnect = builder.lastReconnect;
        this.reconnectAttempt = builder.reconnectAttempt;
    }

    public RuntimeState state() {
        return state;
    }

    public String runtimeVersion() {
        return runtimeVersion;
    }

    public String coreState() {
        return coreState;
    }

    public Set<String> capabilities() {
        return capabilities;
    }

    public List<String> sessionIds() {
        return sessionIds;
    }

    public String lastReconnect() {
        return lastReconnect;
    }

    public int reconnectAttempt() {
        return reconnectAttempt;
    }

    /** Safe for diagnostics: contains only public state, never secrets. */
    public String toJson() {
        StringBuilder json = new StringBuilder();
        json.append("{\"protocolVersion\":").append(RuntimeProtocol.PROTOCOL_VERSION);
        json.append(",\"state\":\"").append(escape(state.wireName())).append('"');
        json.append(",\"runtimeVersion\":\"").append(escape(runtimeVersion)).append('"');
        json.append(",\"coreState\":\"").append(escape(coreState)).append('"');
        json.append(",\"capabilities\":[");
        appendQuoted(json, capabilities);
        json.append("],\"sessionIds\":[");
        appendQuoted(json, sessionIds);
        json.append("],\"reconnectAttempt\":").append(reconnectAttempt);
        if (lastReconnect == null) {
            json.append(",\"lastReconnect\":null}");
        } else {
            json.append(",\"lastReconnect\":\"").append(escape(lastReconnect)).append("\"}");
        }
        return json.toString();
    }

    public static Builder builder(RuntimeState state) {
        return new Builder(state);
    }

    public static final class Builder {
        private final RuntimeState state;
        private String runtimeVersion;
        private String coreState;
        private List<String> capabilities;
        private List<String> sessionIds;
        private String lastReconnect;
        private int reconnectAttempt;

        private Builder(RuntimeState state) {
            this.state = Objects.requireNonNull(state, "state");
        }

        public Builder runtimeVersion(String runtimeVersion) {
            this.runtimeVersion = runtimeVersion;
            return this;
        }

        public Builder coreState(String coreState) {
            this.coreState = coreState;
            return this;
        }

        public Builder capabilities(List<String> capabilities) {
            this.capabilities = capabilities;
            return this;
        }

        public Builder capabilities(String... capabilities) {
            this.capabilities = Arrays.asList(capabilities);
            return this;
        }

        public Builder sessionIds(List<String> sessionIds) {
            this.sessionIds = sessionIds;
            return this;
        }

        public Builder sessionIds(String... sessionIds) {
            this.sessionIds = Arrays.asList(sessionIds);
            return this;
        }

        public Builder lastReconnect(String lastReconnect) {
            this.lastReconnect = lastReconnect;
            return this;
        }

        public Builder reconnectAttempt(int reconnectAttempt) {
            this.reconnectAttempt = reconnectAttempt;
            return this;
        }

        public RuntimeStatus build() {
            return new RuntimeStatus(this);
        }
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private static <T> List<T> immutableList(List<T> values) {
        if (values == null || values.isEmpty()) {
            return Collections.emptyList();
        }
        return Collections.unmodifiableList(new ArrayList<>(values));
    }

    private static <T> Set<T> immutableSet(List<T> values) {
        if (values == null || values.isEmpty()) {
            return Collections.emptySet();
        }
        return Collections.unmodifiableSet(new LinkedHashSet<>(values));
    }

    private static void appendQuoted(StringBuilder json, Iterable<String> values) {
        boolean first = true;
        for (String value : values) {
            if (!first) {
                json.append(',');
            }
            first = false;
            json.append('"').append(escape(value)).append('"');
        }
    }

    private static String escape(String value) {
        StringBuilder escaped = new StringBuilder(value.length());
        char[] hex = "0123456789abcdef".toCharArray();
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
            } else if (c == '\t') {
                escaped.append("\\t");
            } else if (c < 0x20) {
                escaped.append("\\u00")
                        .append(hex[(c >>> 4) & 0xf])
                        .append(hex[c & 0xf]);
            } else {
                escaped.append(c);
            }
        }
        return escaped.toString();
    }
}
