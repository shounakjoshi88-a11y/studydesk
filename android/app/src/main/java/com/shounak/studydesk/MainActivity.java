package com.shounak.studydesk;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    registerPlugin(NativeHttpPlugin.class);
    // Local (in-app) plugins are not auto-registered by `cap sync` the way
    // npm-packaged ones are, so each has to be named here explicitly.
    registerPlugin(DeviceFilesPlugin.class);
    registerPlugin(DrivePlugin.class);
    registerPlugin(IncomingFilePlugin.class);
    // The launch intent is only "new" on a fresh start. A recreation (the
    // process was killed and the user came back) reuses the same intent, and
    // re-importing a file that was already consumed would be wrong.
    if (savedInstanceState == null) IncomingFilePlugin.captureIntent(getIntent());
    super.onCreate(savedInstanceState);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    IncomingFilePlugin.captureIntent(intent);
  }
}
