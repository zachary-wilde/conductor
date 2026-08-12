package com.reigen.runtime;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import androidx.core.app.NotificationCompat;

/** Foreground Runtime owner exposed to the signed Reigen UI through Messenger IPC. */
public final class RuntimeService extends Service {
    public static final String PERMISSION = "com.reigen.permission.RUNTIME";
    public static final String ACTION_STOP = "com.reigen.runtime.STOP";
    public static final int GET_STATUS = 1;
    public static final int CONNECT = 2;
    public static final int DISCONNECT = 3;
    public static final int DIAGNOSTICS = 4;
    public static final int BACKUP = 5;
    public static final int RESTORE = 6;
    public static final String KEY_STATE = "state";
    public static final String KEY_RUNTIME_VERSION = "runtimeVersion";
    public static final String KEY_CORE_STATE = "coreState";
    public static final String KEY_CAPABILITIES = "capabilities";
    public static final String KEY_SESSION_IDS = "sessionIds";
    public static final String KEY_RECONNECT_ATTEMPT = "reconnectAttempt";
    public static final String KEY_LAST_RECONNECT = "lastReconnect";
    public static final String KEY_LOOPBACK_URL = "loopbackUrl";
    public static final String KEY_EXPIRES_AT = "expiresAt";
    public static final String KEY_ERROR = "error";
    public static final String KEY_MESSAGE = "message";
    public static final String KEY_PROTOCOL_VERSION = "protocolVersion";
    public static final String KEY_FOLDER_URI = "folderUri";

    private static final String CHANNEL_ID = "reigen-runtime";
    private static final int NOTIFICATION_ID = 4108;
    private static final String RUNTIME_VERSION = "0.1.0";

    private final Handler handler = new Handler(Looper.getMainLooper(), this::handleMessage);
    private final Messenger messenger = new Messenger(handler);
    private boolean foregrounded;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID, "Reigen Runtime", NotificationManager.IMPORTANCE_LOW));
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopRuntime();
            return START_NOT_STICKY;
        }
        enterForeground();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        if (checkCallingPermission(PERMISSION) != PackageManager.PERMISSION_GRANTED) return null;
        enterForeground();
        return messenger.getBinder();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        foregrounded = false;
        super.onDestroy();
    }

    private boolean handleMessage(Message request) {
        Message response = Message.obtain(null, request.what);
        Bundle payload = new Bundle();
        payload.putInt(KEY_PROTOCOL_VERSION, RuntimeProtocol.PROTOCOL_VERSION);
        try {
            switch (request.what) {
                case GET_STATUS:
                case DIAGNOSTICS:
                    appendStatus(payload);
                    break;
                case CONNECT:
                    throw unavailable();
                case DISCONNECT:
                    break;
                case BACKUP:
                case RESTORE:
                    payload.putString(KEY_FOLDER_URI, request.getData().getString(KEY_FOLDER_URI, ""));
                    throw unavailable();
                default:
                    payload.putString(KEY_ERROR, RuntimeProtocol.RuntimeError.INTERNAL.code());
                    payload.putString(KEY_MESSAGE, "Unknown Runtime operation");
            }
        } catch (RuntimeOperationException error) {
            payload.putString(KEY_ERROR, error.error().code());
            payload.putString(KEY_MESSAGE, error.getMessage());
        }
        response.setData(payload);
        if (request.replyTo != null) {
            try {
                request.replyTo.send(response);
            } catch (RemoteException ignored) {
                // The UI disconnected; Runtime work remains owned by this service.
            }
        }
        return true;
    }

    private void appendStatus(Bundle payload) {
        RuntimeStatus status = currentStatus();
        payload.putString(KEY_STATE, status.state().wireName());
        payload.putString(KEY_RUNTIME_VERSION, status.runtimeVersion());
        payload.putString(KEY_CORE_STATE, status.coreState());
        payload.putStringArrayList(KEY_CAPABILITIES, new java.util.ArrayList<>(status.capabilities()));
        payload.putStringArrayList(KEY_SESSION_IDS, new java.util.ArrayList<>(status.sessionIds()));
        payload.putInt(KEY_RECONNECT_ATTEMPT, status.reconnectAttempt());
        if (status.lastReconnect() != null) payload.putString(KEY_LAST_RECONNECT, status.lastReconnect());
    }

    private RuntimeOperationException unavailable() {
        return new RuntimeOperationException(
                RuntimeProtocol.RuntimeError.UNAVAILABLE,
                "Runtime Core is unavailable until the verified Runtime image is active");
    }

    private RuntimeStatus currentStatus() {
        return RuntimeStatus.builder(RuntimeStatus.RuntimeState.UNAVAILABLE)
                .runtimeVersion(RUNTIME_VERSION)
                .coreState("uninitialized")
                .build();
    }

    private void enterForeground() {
        if (foregrounded) return;
        startForeground(NOTIFICATION_ID, new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Reigen Runtime")
                .setContentText("Runtime is keeping your work available")
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build());
        foregrounded = true;
    }

    private void stopRuntime() {
        if (foregrounded) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foregrounded = false;
        }
        stopSelf();
    }
}
