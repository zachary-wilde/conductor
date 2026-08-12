package com.reigen.runtime;

/**
 * Raised by the Runtime binder when an operation cannot complete and the caller
 * (the Capacitor plugin) must surface a stable {@link RuntimeProtocol.RuntimeError}
 * code to JavaScript. Carrying the typed error keeps JS error mapping deterministic
 * and free of string parsing.
 */
public final class RuntimeOperationException extends RuntimeException {

    private final RuntimeProtocol.RuntimeError error;

    public RuntimeOperationException(RuntimeProtocol.RuntimeError error, String message) {
        super(message);
        this.error = error;
    }

    public RuntimeOperationException(
            RuntimeProtocol.RuntimeError error, String message, Throwable cause) {
        super(message, cause);
        this.error = error;
    }

    public RuntimeProtocol.RuntimeError error() {
        return error;
    }
}
