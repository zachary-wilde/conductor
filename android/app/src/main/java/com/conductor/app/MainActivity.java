package com.conductor.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.reigen.app.RuntimeBridgePlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the protected Runtime bridge before the bridge is created so the
        // UI can call RuntimeBridge.getStatus/connect/reconnect/diagnostics/backup/restore.
        registerPlugin(RuntimeBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
