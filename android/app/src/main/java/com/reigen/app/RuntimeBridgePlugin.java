package com.reigen.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** Signed Messenger bridge to the separate Reigen Runtime APK. */
@CapacitorPlugin(name = "RuntimeBridge")
public final class RuntimeBridgePlugin extends Plugin {
    private static final String RUNTIME_PACKAGE = "com.reigen.runtime";
    private static final String RUNTIME_SERVICE = "com.reigen.runtime.RuntimeService";
    private static final int GET_STATUS = 1;
    private static final int CONNECT = 2;
    private static final int DISCONNECT = 3;
    private static final int DIAGNOSTICS = 4;
    private static final int BACKUP = 5;
    private static final int RESTORE = 6;
    private static final String KEY_STATE = "state";
    private static final String KEY_RUNTIME_VERSION = "runtimeVersion";
    private static final String KEY_CORE_STATE = "coreState";
    private static final String KEY_CAPABILITIES = "capabilities";
    private static final String KEY_SESSION_IDS = "sessionIds";
    private static final String KEY_RECONNECT_ATTEMPT = "reconnectAttempt";
    private static final String KEY_LAST_RECONNECT = "lastReconnect";
    private static final String KEY_LOOPBACK_URL = "loopbackUrl";
    private static final String KEY_EXPIRES_AT = "expiresAt";
    private static final String KEY_ERROR = "error";
    private static final String KEY_MESSAGE = "message";
    private static final String KEY_PROTOCOL_VERSION = "protocolVersion";
    private static final String KEY_FOLDER_URI = "folderUri";
    private static final int PROTOCOL_VERSION = 1;

    private final AtomicInteger nextRequest = new AtomicInteger(1);
    private final Map<Integer, PluginCall> pending = new HashMap<>();
    private final Messenger client = new Messenger(new Handler(Looper.getMainLooper(), this::handleResponse));
    private volatile Messenger service;
    private volatile boolean bound;
    private volatile boolean disconnected;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = new Messenger(binder);
            bound = true;
            disconnected = false;
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            service = null;
            bound = false;
            disconnected = true;
            rejectPending("interrupted", "Runtime service disconnected");
        }

        @Override
        public void onNullBinding(ComponentName name) {
            service = null;
            bound = false;
            disconnected = false;
            rejectPending("unavailable", "Runtime service rejected the binding");
        }
    };

    @Override
    public void load() {
        super.load();
        ensureBound();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        send(call, GET_STATUS, null);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        send(call, CONNECT, null);
    }

    @PluginMethod
    public void reconnect(PluginCall call) {
        send(call, CONNECT, null);
    }

    @PluginMethod
    public void diagnostics(PluginCall call) {
        send(call, DIAGNOSTICS, null);
    }

    @PluginMethod
    public void backup(PluginCall call) {
        send(call, BACKUP, call.getString(KEY_FOLDER_URI, ""));
    }

    @PluginMethod
    public void restore(PluginCall call) {
        send(call, RESTORE, call.getString(KEY_FOLDER_URI, ""));
    }

    private void ensureBound() {
        Context context = getContext();
        Intent intent = new Intent().setComponent(new ComponentName(RUNTIME_PACKAGE, RUNTIME_SERVICE));
        try {
            ContextCompat.startForegroundService(context, intent);
            bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
            if (!bound) disconnected = false;
        } catch (RuntimeException error) {
            bound = false;
            disconnected = false;
        }
    }

    private void send(PluginCall call, int operation, String folderUri) {
        Messenger active = service;
        if (active == null || !bound) {
            ensureBound();
            active = service;
        }
        if (active == null) {
            call.reject("Runtime service unavailable", "unavailable");
            return;
        }
        int requestId = nextRequest.getAndIncrement();
        Message request = Message.obtain(null, operation);
        request.arg1 = requestId;
        request.replyTo = client;
        Bundle data = new Bundle();
        data.putInt(KEY_PROTOCOL_VERSION, PROTOCOL_VERSION);
        if (folderUri != null) data.putString(KEY_FOLDER_URI, folderUri);
        request.setData(data);
        synchronized (pending) {
            pending.put(requestId, call);
        }
        try {
            active.send(request);
        } catch (RemoteException error) {
            synchronized (pending) { pending.remove(requestId); }
            call.reject("Runtime service disconnected", "interrupted");
        }
    }

    private boolean handleResponse(Message response) {
        PluginCall call;
        synchronized (pending) {
            call = pending.remove(response.arg1);
        }
        if (call == null) return true;
        Bundle payload = response.getData();
        String error = payload.getString(KEY_ERROR);
        if (error != null) {
            call.reject(payload.getString(KEY_MESSAGE, error), error);
            return true;
        }
        if (response.what == CONNECT) {
            JSObject lease = new JSObject();
            lease.put(KEY_LOOPBACK_URL, payload.getString(KEY_LOOPBACK_URL, ""));
            lease.put(KEY_EXPIRES_AT, payload.getLong(KEY_EXPIRES_AT, 0L));
            call.resolve(lease);
        } else if (response.what == DIAGNOSTICS) {
            JSObject diagnostics = statusToJs(payload);
            diagnostics.put("redacted", true);
            call.resolve(diagnostics);
        } else {
            call.resolve(statusToJs(payload));
        }
        return true;
    }

    private JSObject statusToJs(Bundle payload) {
        JSObject result = new JSObject();
        result.put(KEY_PROTOCOL_VERSION, payload.getInt(KEY_PROTOCOL_VERSION, 0));
        result.put(KEY_STATE, payload.getString(KEY_STATE, "unavailable"));
        result.put(KEY_RUNTIME_VERSION, payload.getString(KEY_RUNTIME_VERSION, ""));
        result.put(KEY_CORE_STATE, payload.getString(KEY_CORE_STATE, ""));
        result.put(KEY_CAPABILITIES, toArray(payload.getStringArrayList(KEY_CAPABILITIES)));
        result.put(KEY_SESSION_IDS, toArray(payload.getStringArrayList(KEY_SESSION_IDS)));
        result.put(KEY_RECONNECT_ATTEMPT, payload.getInt(KEY_RECONNECT_ATTEMPT, 0));
        result.put(KEY_LAST_RECONNECT, payload.getString(KEY_LAST_RECONNECT, null));
        return result;
    }

    private static JSArray toArray(java.util.ArrayList<String> values) {
        JSArray result = new JSArray();
        if (values != null) for (String value : values) result.put(value);
        return result;
    }

    private void rejectPending(String code, String message) {
        Map<Integer, PluginCall> snapshot;
        synchronized (pending) {
            snapshot = new HashMap<>(pending);
            pending.clear();
        }
        for (PluginCall call : snapshot.values()) call.reject(message, code);
    }

    @Override
    protected void handleOnDestroy() {
        rejectPending("interrupted", "Runtime bridge destroyed");
        if (bound) {
            try { getContext().unbindService(connection); } catch (RuntimeException ignored) { }
        }
        super.handleOnDestroy();
    }
}
