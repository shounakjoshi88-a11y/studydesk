package com.shounak.studydesk;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.webkit.MimeTypeMap;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Files Android hands to the app through "Open with" (ACTION_VIEW) and the
 * share sheet (ACTION_SEND).
 *
 * The intents arrive on a schedule this plugin does not control: the launch
 * intent lands before the bridge exists, and a share while the app is open
 * lands on a running bridge. Both are captured statically from MainActivity
 * into one stash, and the JS side drains the stash with consume() whenever
 * the app starts or returns to the foreground.
 *
 * Content is copied out of the sender's URI here, while the grant is still
 * valid, and travels to JS as base64 — the same currency the rest of the
 * app's file pipeline already speaks.
 */
@CapacitorPlugin(name = "IncomingFile")
public class IncomingFilePlugin extends Plugin {

  private static final String TAG = "IncomingFile";

  /** Far above any note a person edits on a phone, but a hard stop so a
   *  multi-gigabyte share cannot take the WebView down. Truncation is
   *  flagged rather than silent. */
  private static final long MAX_BYTES = 16L * 1024 * 1024;

  private static final class Stashed {
    Uri uri;
    String mime;
    String text;
  }

  private static final List<Stashed> stashed = new ArrayList<>();
  private static final Object lock = new Object();

  /**
   * Called by MainActivity for the launch intent and for every onNewIntent.
   * Static on purpose: the launch intent arrives before this plugin instance
   * exists, so there is nowhere to keep it but here.
   */
  public static void captureIntent(Intent intent) {
    if (intent == null) return;
    final String action = intent.getAction();
    if (Intent.ACTION_VIEW.equals(action)) {
      stashUri(intent.getData(), intent.getType());
    } else if (Intent.ACTION_SEND.equals(action)) {
      Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
      if (stream != null) {
        stashUri(stream, intent.getType());
      } else {
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text != null && text.length() > 0) stashText(text.toString());
      }
    }
  }

  private static void stashUri(Uri uri, String mime) {
    if (uri == null) return;
    synchronized (lock) {
      Stashed s = new Stashed();
      s.uri = uri;
      s.mime = mime;
      stashed.add(s);
    }
  }

  private static void stashText(String text) {
    synchronized (lock) {
      Stashed s = new Stashed();
      s.text = text;
      stashed.add(s);
    }
  }

  /** Drain everything captured since the last call. */
  @PluginMethod
  public void consume(PluginCall call) {
    List<Stashed> taken;
    synchronized (lock) {
      taken = new ArrayList<>(stashed);
      stashed.clear();
    }
    JSArray items = new JSArray();
    for (Stashed s : taken) {
      JSObject o = new JSObject();
      try {
        if (s.text != null) {
          o.put("kind", "text");
          o.put("text", s.text);
        } else {
          fillFileItem(o, s);
        }
      } catch (Exception e) {
        Log.w(TAG, "could not read shared item", e);
        try {
          o.put("kind", "file");
          o.put("error", String.valueOf(e.getMessage()));
        } catch (Exception ignored) {
          /* JSObject.put only throws on JSON trouble; nothing to do */
        }
      }
      items.put(o);
    }
    JSObject ret = new JSObject();
    ret.put("items", items);
    call.resolve(ret);
  }

  private void fillFileItem(JSObject o, Stashed s) throws Exception {
    ContentResolver cr = getContext().getContentResolver();
    String name = displayName(cr, s.uri);
    if (name == null || name.isEmpty()) {
      String last = s.uri.getLastPathSegment();
      name = (last == null || last.isEmpty()) ? "shared-file" : last;
    }
    String mime = s.mime != null ? s.mime : cr.getType(s.uri);
    if (mime == null) mime = "";
    o.put("kind", "file");
    o.put("name", name);
    o.put("mime", mime);
    o.put("ext", extFor(name, mime));

    InputStream in = cr.openInputStream(s.uri);
    if (in == null) throw new Exception("Could not open the shared file.");
    try {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[8192];
      long total = 0;
      boolean truncated = false;
      int n;
      while ((n = in.read(buf)) > 0) {
        if (total + n > MAX_BYTES) {
          out.write(buf, 0, (int) (MAX_BYTES - total));
          truncated = true;
          break;
        }
        out.write(buf, 0, n);
        total += n;
      }
      o.put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
      if (truncated) o.put("truncated", true);
    } finally {
      try {
        in.close();
      } catch (Exception ignored) {
        /* the stream is done either way */
      }
    }
  }

  private static String displayName(ContentResolver cr, Uri uri) {
    Cursor c = null;
    try {
      c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null);
      if (c != null && c.moveToFirst()) {
        int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
        if (idx >= 0) return c.getString(idx);
      }
    } catch (Exception e) {
      Log.w(TAG, "display name query failed", e);
    } finally {
      if (c != null) {
        try {
          c.close();
        } catch (Exception ignored) {
          /* nothing to release */
        }
      }
    }
    return null;
  }

  /**
   * The file name's extension is the ground truth — a markdown file shared
   * as text/plain must still arrive as .md, not .txt. The MIME type is only
   * consulted when the name has nothing after the dot.
   */
  private static String extFor(String name, String mime) {
    int dot = name.lastIndexOf('.');
    if (dot >= 0 && dot < name.length() - 1) {
      String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
      if (ext.matches("[a-z0-9]{1,8}")) return ext;
    }
    if (mime != null) {
      if (mime.contains("markdown")) return "md";
      String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
      if (ext != null && !ext.isEmpty()) return ext.toLowerCase(Locale.ROOT);
    }
    return "";
  }
}
