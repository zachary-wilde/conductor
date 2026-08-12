package com.reigen.runtime.probe;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.UUID;

public final class ProbeService extends Service {
    public static final String ACTION_RUN = "com.reigen.runtime.probe.RUN";
    public static final String ACTION_RUN_PAID = "com.reigen.runtime.probe.RUN_PAID";
    public static final String ACTION_START_TERMINAL = "com.reigen.runtime.probe.START_TERMINAL";
    public static final String ACTION_SEND_TERMINAL = "com.reigen.runtime.probe.SEND_TERMINAL";
    public static final String ACTION_STOP = "com.reigen.runtime.probe.STOP";
    public static final String BROADCAST_STATUS = "com.reigen.runtime.probe.STATUS";
    public static final String BROADCAST_TERMINAL = "com.reigen.runtime.probe.TERMINAL";
    public static final String EXTRA_TEXT = "text";
    public static final String EXTRA_REPORT = "report";
    public static final String ACTION_CONFIRM_REATTACH = "com.reigen.runtime.probe.CONFIRM_REATTACH";

    private static final String CHANNEL = "runtime-probe";
    private static final int NOTIFICATION_ID = 4107;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final String instanceId = UUID.randomUUID().toString();
    private volatile InteractiveShell shell;

    @Override
    public void onCreate() {
        super.onCreate();
        getSharedPreferences(ProbeEngine.PREFERENCES, MODE_PRIVATE)
                .edit().putString(ProbeEngine.SERVICE_ID, instanceId).apply();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
                CHANNEL, "Reigen runtime probe", NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(this, ProbeActivity.class);
        PendingIntent content = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        startForeground(NOTIFICATION_ID, new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Reigen Runtime Probe")
                .setContentText("Runtime remains available while the UI is closed")
                .setOngoing(true)
                .setContentIntent(content)
                .build());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) return START_STICKY;
        String action = intent.getAction();
        if (ACTION_RUN.equals(action) || ACTION_RUN_PAID.equals(action)) {
            boolean paid = ACTION_RUN_PAID.equals(action);
            worker.execute(() -> runChecks(paid));
        } else if (ACTION_START_TERMINAL.equals(action)) {
            worker.execute(this::startTerminal);
        } else if (ACTION_SEND_TERMINAL.equals(action)) {
            String line = intent.getStringExtra(EXTRA_TEXT);
            worker.execute(() -> sendTerminal(line == null ? "" : line));
        } else if (ACTION_CONFIRM_REATTACH.equals(action)) {
            String expected = intent.getStringExtra(EXTRA_TEXT);
            if (instanceId.equals(expected)) {
                getSharedPreferences(ProbeEngine.PREFERENCES, MODE_PRIVATE)
                        .edit().putString(ProbeEngine.SERVICE_CONFIRMED_ID, instanceId).apply();
                sendStatus("Foreground service reattached after Activity restart", null);
            }
        } else if (ACTION_STOP.equals(action)) {
            stopRuntime();
        }
        return START_STICKY;
    }

    private void runChecks(boolean paid) {
        PowerManager.WakeLock lock = ((PowerManager) getSystemService(POWER_SERVICE))
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "reigen:runtime-probe");
        lock.acquire(15 * 60 * 1000L);
        try {
            sendStatus(paid ? "Running paid OMP acceptance gate…" : "Running local feasibility checks…", null);
            ProbeReport report = ProbeEngine.run(this, paid, text -> sendStatus(text, null));
            sendStatus(report.passed() ? "All required checks passed" : "Probe finished with failures", report.toJson());
        } catch (Exception error) {
            if (!Thread.currentThread().isInterrupted()) {
                sendStatus("Probe aborted: " + error.getClass().getSimpleName() + ": " + error.getMessage(), null);
            }
        } finally {
            if (lock.isHeld()) lock.release();
        }
    }

    private void startTerminal() {
        try {
            if (shell != null && shell.isAlive()) {
                sendTerminalOutput("\n[terminal already running]\n");
                return;
            }
            RuntimeInstaller.Runtime runtime = RuntimeInstaller.install(this, text -> sendTerminalOutput("\n[" + text + "]\n"));
            if (Thread.currentThread().isInterrupted()) return;
            shell = new InteractiveShell(runtime, this::sendTerminalOutput);
            sendTerminalOutput("\n[Debian PTY started]\n");
        } catch (Exception error) {
            if (!Thread.currentThread().isInterrupted()) {
                sendTerminalOutput("\n[terminal failed: " + error.getMessage() + "]\n");
            }
        }
    }

    private void sendTerminal(String line) {
        try {
            if (shell == null || !shell.isAlive()) startTerminal();
            if (shell != null && shell.isAlive()) shell.sendLine(line);
        } catch (Exception error) {
            sendTerminalOutput("\n[send failed: " + error.getMessage() + "]\n");
        }
    }

    private void stopRuntime() {
        worker.shutdownNow();
        if (shell != null) shell.close();
        shell = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void sendStatus(String text, String report) {
        Intent update = new Intent(BROADCAST_STATUS).setPackage(getPackageName()).putExtra(EXTRA_TEXT, text);
        if (report != null) update.putExtra(EXTRA_REPORT, report);
        sendBroadcast(update);
    }

    private void sendTerminalOutput(String text) {
        sendBroadcast(new Intent(BROADCAST_TERMINAL)
                .setPackage(getPackageName())
                .putExtra(EXTRA_TEXT, text));
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        getSharedPreferences(ProbeEngine.PREFERENCES, MODE_PRIVATE)
                .edit().putString(ProbeEngine.ACTIVITY_CLOSED_SERVICE_ID, instanceId).apply();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (shell != null) shell.close();
        worker.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
