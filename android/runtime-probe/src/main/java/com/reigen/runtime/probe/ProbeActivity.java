package com.reigen.runtime.probe;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import androidx.core.content.ContextCompat;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

@SuppressLint("SetTextI18n")
public final class ProbeActivity extends Activity {
    private static final int PICK_SD_TREE = 74;
    private static final int MAX_TERMINAL_CHARS = 50_000;
    private TextView status;
    private TextView report;
    private TextView terminal;
    private EditText command;
    private String latestReport = "";

    private final BroadcastReceiver updates = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String text = intent.getStringExtra(ProbeService.EXTRA_TEXT);
            if (ProbeService.BROADCAST_TERMINAL.equals(intent.getAction())) {
                appendTerminal(text == null ? "" : text);
                return;
            }
            if (text != null) status.setText(text);
            String json = intent.getStringExtra(ProbeService.EXTRA_REPORT);
            if (json != null) showReport(json);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(buildContent());
        registerUpdates();
        confirmServiceReattach();
        loadLatestReport();
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    private View buildContent() {
        ScrollView page = new ScrollView(this);
        page.setFillViewport(true);
        page.setBackgroundColor(Color.rgb(12, 17, 24));
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(24), dp(20), dp(32));
        page.addView(content);

        TextView title = text("Reigen Runtime Probe", 26, Color.WHITE);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        content.addView(title);
        TextView subtitle = text(
                "Physical-device gate for Debian ARM64, PRoot, PTY, Git, OMP, child processes, persistence, and SD-card backup access.",
                14, Color.rgb(164, 180, 199));
        subtitle.setPadding(0, dp(8), 0, dp(18));
        content.addView(subtitle);

        status = text("Ready. Local checks do not spend model quota.", 15, Color.rgb(115, 215, 255));
        status.setPadding(dp(14), dp(12), dp(14), dp(12));
        status.setBackgroundColor(Color.rgb(22, 34, 46));
        content.addView(status, matchWrap());

        LinearLayout actions = row();
        actions.addView(button("Run local checks", () -> service(ProbeService.ACTION_RUN, null)), weighted());
        actions.addView(button("Run paid OMP gate", () -> service(ProbeService.ACTION_RUN_PAID, null)), weighted());
        content.addView(actions, matchWrapTop(14));

        LinearLayout storage = row();
        storage.addView(button("Choose SD backup folder", this::chooseSdCard), weighted());
        storage.addView(button("Share latest report", this::shareReport), weighted());
        content.addView(storage, matchWrapTop(8));

        report = text("No report yet.", 12, Color.rgb(214, 222, 232));
        report.setTypeface(android.graphics.Typeface.MONOSPACE);
        report.setTextIsSelectable(true);
        report.setPadding(dp(12), dp(12), dp(12), dp(12));
        report.setBackgroundColor(Color.rgb(17, 24, 33));
        content.addView(report, matchWrapTop(16));

        TextView terminalTitle = text("Persistent Debian PTY", 19, Color.WHITE);
        terminalTitle.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        content.addView(terminalTitle, matchWrapTop(22));
        TextView terminalHelp = text(
                "Start the shell, sign in to providers if required, and run OMP manually. The foreground service and PTY remain alive when this screen closes.",
                13, Color.rgb(164, 180, 199));
        content.addView(terminalHelp, matchWrapTop(6));

        LinearLayout terminalActions = row();
        terminalActions.addView(button("Start / reattach", () -> service(ProbeService.ACTION_START_TERMINAL, null)), weighted());
        terminalActions.addView(button("Stop runtime", () -> service(ProbeService.ACTION_STOP, null)), weighted());
        content.addView(terminalActions, matchWrapTop(10));

        ScrollView terminalScroll = new ScrollView(this);
        terminal = text("", 12, Color.rgb(161, 255, 177));
        terminal.setTypeface(android.graphics.Typeface.MONOSPACE);
        terminal.setTextIsSelectable(true);
        terminal.setPadding(dp(12), dp(12), dp(12), dp(12));
        terminalScroll.setBackgroundColor(Color.BLACK);
        terminalScroll.addView(terminal);
        LinearLayout.LayoutParams terminalParams = new LinearLayout.LayoutParams(-1, dp(320));
        terminalParams.topMargin = dp(8);
        content.addView(terminalScroll, terminalParams);

        LinearLayout input = row();
        command = new EditText(this);
        command.setSingleLine(true);
        command.setHint("Command or login input");
        command.setTextColor(Color.WHITE);
        command.setHintTextColor(Color.rgb(110, 124, 140));
        command.setBackgroundColor(Color.rgb(22, 34, 46));
        command.setPadding(dp(12), dp(8), dp(12), dp(8));
        input.addView(command, new LinearLayout.LayoutParams(0, dp(48), 1));
        LinearLayout.LayoutParams sendParams = new LinearLayout.LayoutParams(dp(90), dp(48));
        sendParams.leftMargin = dp(8);
        input.addView(button("Send", this::sendCommand), sendParams);
        content.addView(input, matchWrapTop(8));
        return page;
    }

    private void chooseSdCard() {
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(picker, PICK_SD_TREE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_SD_TREE || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        if ((data.getFlags() & flags) != flags) {
            status.setText("The selected folder did not grant persistent read/write access.");
            return;
        }
        getContentResolver().takePersistableUriPermission(uri, flags);
        getSharedPreferences(ProbeEngine.PREFERENCES, MODE_PRIVATE)
                .edit().putString(ProbeEngine.SD_TREE_URI, uri.toString()).apply();
        status.setText("SD-card folder saved. Run checks to verify write/delete access.");
    }

    private void sendCommand() {
        String value = command.getText().toString();
        if (value.isEmpty()) return;
        service(ProbeService.ACTION_SEND_TERMINAL, value);
        command.setText("");
    }

    private void shareReport() {
        if (latestReport.isEmpty()) {
            status.setText("No report available to share.");
            return;
        }
        startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND)
                .setType("application/json")
                .putExtra(Intent.EXTRA_TEXT, latestReport), "Share probe report"));
    }

    private void service(String action, String text) {
        Intent intent = new Intent(this, ProbeService.class).setAction(action);
        if (text != null) intent.putExtra(ProbeService.EXTRA_TEXT, text);
        startForegroundService(intent);
    }

    private void showReport(String json) {
        latestReport = json;
        report.setText(json);
    }

    private void loadLatestReport() {
        File file = new File(getFilesDir(), "runtime-probe/reports/latest.json");
        if (!file.isFile()) return;
        try {
            showReport(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        } catch (Exception error) {
            status.setText("Could not load latest report: " + error.getMessage());
        }
    }

    private void appendTerminal(String value) {
        String combined = terminal.getText().toString() + value;
        if (combined.length() > MAX_TERMINAL_CHARS) combined = combined.substring(combined.length() - MAX_TERMINAL_CHARS);
        terminal.setText(combined);
    }

    private void registerUpdates() {
        IntentFilter filter = new IntentFilter();
        filter.addAction(ProbeService.BROADCAST_STATUS);
        filter.addAction(ProbeService.BROADCAST_TERMINAL);
        ContextCompat.registerReceiver(this, updates, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void onDestroy() {
        if (isFinishing() && !isChangingConfigurations()) {
            String activeService = getSharedPreferences(ProbeEngine.PREFERENCES, MODE_PRIVATE)
                    .getString(ProbeEngine.SERVICE_ID, "");
            if (activeService != null && !activeService.isEmpty()) {
                getSharedPreferences(ProbeEngine.PREFERENCES, MODE_PRIVATE)
                        .edit().putString(ProbeEngine.ACTIVITY_CLOSED_SERVICE_ID, activeService).apply();
            }
        }
        unregisterReceiver(updates);
        super.onDestroy();
    }

    private void confirmServiceReattach() {
        String closedService = getSharedPreferences(ProbeEngine.PREFERENCES, MODE_PRIVATE)
                .getString(ProbeEngine.ACTIVITY_CLOSED_SERVICE_ID, "");
        if (closedService != null && !closedService.isEmpty()) {
            service(ProbeService.ACTION_CONFIRM_REATTACH, closedService);
        }
    }


    private Button button(String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setAllCaps(false);
        button.setBackgroundColor(Color.rgb(33, 91, 122));
        button.setOnClickListener(view -> action.run());
        return button;
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        return view;
    }

    private LinearLayout row() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        return row;
    }

    private LinearLayout.LayoutParams weighted() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(48), 1);
        params.setMargins(dp(4), 0, dp(4), 0);
        return params;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(-1, -2);
    }

    private LinearLayout.LayoutParams matchWrapTop(int top) {
        LinearLayout.LayoutParams params = matchWrap();
        params.topMargin = dp(top);
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
