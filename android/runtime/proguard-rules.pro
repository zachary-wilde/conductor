# Reigen Runtime library consumer rules.
# Keep the public bridge contract; the service binder is only ever used
# in-process by the Reigen UI, so no remote stub rules are required.
-keep class com.reigen.runtime.RuntimeProtocol { *; }
-keep class com.reigen.runtime.RuntimeStatus { *; }
-keep class com.reigen.runtime.RuntimeStatus$RuntimeState { *; }
-keep class com.reigen.runtime.RuntimeLease { *; }
