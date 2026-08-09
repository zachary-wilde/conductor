import type { CapacitorConfig } from '@capacitor/cli'

// Capacitor wraps the built web operator UI (out/web) as an installable Android
// app. The shell bundles the UI and talks to a Conductor core over the LAN
// (the operator enters the core URL + token in the app's Connect screen), so
// cleartext HTTP to a private address must be allowed for the debug build.
const config: CapacitorConfig = {
  appId: 'com.conductor.app',
  appName: 'Conductor',
  webDir: 'out/web',
  android: {
    allowMixedContent: true
  },
  server: {
    androidScheme: 'http',
    cleartext: true
  }
}

export default config
