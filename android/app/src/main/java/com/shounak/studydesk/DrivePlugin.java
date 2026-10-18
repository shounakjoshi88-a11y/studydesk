package com.shounak.studydesk;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The Google Drive half of the file story. It lives in its own plugin because
 * Drive is network code, not filesystem code, and mixing the two would make
 * both harder to reason about.
 *
 * There are two ways in, and they are genuinely different promises:
 *
 *  - The Drive app route (Storage Access Framework). Android's own picker
 *    hands over one Drive area — My Drive or a folder inside it — and the
 *    phone's Drive app answers every listing and transfer behind it. No OAuth
 *    client exists anywhere in this route, which is why it is the default.
 *    The cost is scope: only what was picked is visible, and Google formats
 *    open in the Drive app because their bytes live inside Google.
 *
 *  - The own-client route. The loopback sign-in flow every desktop CLI uses:
 *    the consent page opens in the system browser (Google refuses OAuth inside
 *    a WebView, and rightly so), and the redirect comes back to a one-shot
 *    listener on 127.0.0.1 that this plugin holds open. That means no SHA-1
 *    fingerprint to register, no deep-link scheme, and no backend. The client
 *    belongs to the user's own Cloud console account; unlimited scope, in
 *    exchange for that setup.
 *
 * Everything that touches the wire happens here rather than in the WebView:
 * transfers stream through HttpURLConnection (or the content resolver) straight
 * to and from disk, so a 400 MB video never becomes a base64 string on the
 * bridge, and the token exchange cannot fail on a CORS rule nobody here
 * controls.
 */
@CapacitorPlugin(name = "Drive")
public class DrivePlugin extends Plugin {

  private static final String TAG = "Drive";
  private static final int CONNECT_TIMEOUT_MS = 20_000;
  private static final int READ_TIMEOUT_MS = 120_000;
  /** How long the browser is given to come back with a redirect. */
  private static final int OAUTH_WAIT_MS = 240_000;

  /** The one listener a sign-in is allowed to have; a fresh attempt closes
   *  the previous one rather than failing on the busy port. */
  private ServerSocket oauthServer;

  private static String str(PluginCall call, String key, String fallback) {
    String v = call.getString(key);
    return v == null ? fallback : v;
  }

  // ── sign-in ─────────────────────────────────────────────

  /**
   * Holds the loopback port open until the browser delivers the redirect.
   * The call stays pending for the whole sign-in, so JavaScript never has to
   * poll a flag: when the promise resolves, the code is in hand.
   */
  @PluginMethod
  public void oauthListen(PluginCall call) {
    Integer portArg = call.getInt("port");
    final int port = portArg == null ? 8976 : portArg;
    new Thread(() -> {
      ServerSocket server = null;
      try {
        synchronized (DrivePlugin.this) {
          if (oauthServer != null) {
            try {
              oauthServer.close();
            } catch (Exception ignored) {
            }
          }
        }
        server = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"));
        server.setSoTimeout(OAUTH_WAIT_MS);
        synchronized (DrivePlugin.this) {
          oauthServer = server;
        }

        Socket sock = server.accept();
        // Only the request line matters: "GET /oauth2redirect?code=… HTTP/1.1".
        InputStream in = sock.getInputStream();
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int b;
        int guard = 0;
        while ((b = in.read()) != -1 && b != '\n' && guard++ < 8192) head.write(b);
        String requestLine = head.toString("UTF-8").trim();
        String path = "/";
        String[] parts = requestLine.split(" ");
        if (parts.length >= 2 && !parts[1].isEmpty()) path = parts[1];

        // The page the user sees for the two seconds before they go back.
        // Deliberately the app's own dark surface, not Google's or anyone's.
        String html = "<!doctype html><html><head><meta charset=\"utf-8\">"
          + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
          + "<title>StudyDesk</title></head>"
          + "<body style=\"margin:0;display:grid;place-items:center;min-height:100vh;"
          + "background:#0f1116;color:#e8ecf4;font:16px/1.6 system-ui,sans-serif;text-align:center\">"
          + "<div><div style=\"font-size:44px;line-height:1\">&#10003;</div>"
          + "<p style=\"margin:14px 0 4px\">Signed in.</p>"
          + "<p style=\"margin:0;opacity:.55;font-size:14px\">You can close this tab and return to StudyDesk.</p>"
          + "</div></body></html>";
        byte[] htmlBytes = html.getBytes(StandardCharsets.UTF_8);
        String resp = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
          + "Content-Length: " + htmlBytes.length + "\r\nConnection: close\r\n\r\n";
        OutputStream out = sock.getOutputStream();
        out.write(resp.getBytes(StandardCharsets.UTF_8));
        out.write(htmlBytes);
        out.flush();
        sock.close();

        JSObject ret = new JSObject();
        ret.put("url", "http://127.0.0.1:" + port + path);
        call.resolve(ret);
      } catch (SocketTimeoutException e) {
        call.reject("The sign-in window timed out. Try connecting again.");
      } catch (Exception e) {
        String msg = e.getMessage() != null ? e.getMessage() : "";
        // A closed socket is the cancel path (or a newer attempt taking the
        // port over): the user asked for it, so say so plainly.
        if (msg.toLowerCase().contains("closed")) {
          call.reject("Sign-in was cancelled.");
        } else {
          call.reject("Could not finish sign-in: " + (msg.isEmpty() ? "unknown error" : msg));
        }
      } finally {
        try {
          if (server != null) server.close();
        } catch (Exception ignored) {
        }
        synchronized (DrivePlugin.this) {
          if (oauthServer == server) oauthServer = null;
        }
      }
    }).start();
  }

  @Override
  protected void handleOnDestroy() {
    synchronized (DrivePlugin.this) {
      try {
        if (oauthServer != null) oauthServer.close();
      } catch (Exception ignored) {
      }
      oauthServer = null;
    }
  }

  /** Closes the listener early — the Cancel button while the browser is up. */
  @PluginMethod
  public void oauthCancel(PluginCall call) {
    synchronized (DrivePlugin.this) {
      try {
        if (oauthServer != null) oauthServer.close();
      } catch (Exception ignored) {
      }
    }
    call.resolve();
  }

  // ── small HTTP verbs ────────────────────────────────────

  /** A form POST answered as text: token exchange, refresh and revoke. */
  @PluginMethod
  public void httpForm(PluginCall call) {
    final String url = str(call, "url", "");
    final String body = str(call, "body", "");
    new Thread(() -> {
      HttpURLConnection conn = null;
      try {
        conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(bytes.length);
        OutputStream out = conn.getOutputStream();
        out.write(bytes);
        out.close();
        int status = conn.getResponseCode();
        String text = readAll(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
        JSObject ret = new JSObject();
        ret.put("status", status);
        ret.put("body", text);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject("Network problem: " + (e.getMessage() != null ? e.getMessage() : "request failed"));
      } finally {
        if (conn != null) conn.disconnect();
      }
    }).start();
  }

  /** A bearer GET answered as text, for Drive's metadata endpoints. */
  @PluginMethod
  public void httpGet(PluginCall call) {
    final String url = str(call, "url", "");
    final String bearer = str(call, "bearer", "");
    new Thread(() -> {
      HttpURLConnection conn = null;
      try {
        conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setRequestProperty("Authorization", "Bearer " + bearer);
        int status = conn.getResponseCode();
        String text = readAll(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
        JSObject ret = new JSObject();
        ret.put("status", status);
        ret.put("body", text);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject("Network problem: " + (e.getMessage() != null ? e.getMessage() : "request failed"));
      } finally {
        if (conn != null) conn.disconnect();
      }
    }).start();
  }

  // ── transfers ───────────────────────────────────────────

  /**
   * One Drive file, streamed to the phone's Download folder (or wherever the
   * caller points). The name lands collision-safe — "name (1).ext" — because
   * overwriting a local file to satisfy a remote one would be a hole in the
   * app's one promise.
   */
  @PluginMethod
  public void downloadFile(PluginCall call) {
    final String url = str(call, "url", "");
    final String bearer = str(call, "bearer", "");
    final String name = str(call, "name", "download");
    final String dirPath = str(call, "dir", "");
    new Thread(() -> {
      HttpURLConnection conn = null;
      File outFile = null;
      try {
        File dir;
        if (!dirPath.isEmpty()) {
          dir = new File(dirPath);
        } else {
          dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        }
        if (!dir.exists() && !dir.mkdirs()) {
          call.reject("Could not create the download folder.");
          return;
        }

        conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setRequestProperty("Authorization", "Bearer " + bearer);
        int status = conn.getResponseCode();
        if (status < 200 || status >= 300) {
          String err = readAll(conn.getErrorStream());
          call.reject("Drive answered " + status + (err.isEmpty() ? "." : ": " + err));
          return;
        }

        outFile = uniqueFile(dir, sanitizeName(name));
        InputStream in = new BufferedInputStream(conn.getInputStream(), 64 * 1024);
        OutputStream out = new BufferedOutputStream(new FileOutputStream(outFile), 64 * 1024);
        byte[] buf = new byte[64 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
          out.write(buf, 0, n);
          total += n;
        }
        out.close();
        in.close();

        // A photo downloaded through Drive should show up in the phone's own
        // gallery, which only notices files the scanner has been told about.
        MediaScannerConnection.scanFile(
          getContext(), new String[] { outFile.getAbsolutePath() }, null, null);

        JSObject ret = new JSObject();
        ret.put("path", outFile.getAbsolutePath());
        ret.put("name", outFile.getName());
        ret.put("bytes", total);
        call.resolve(ret);
      } catch (Exception e) {
        if (outFile != null && outFile.exists()) outFile.delete();
        call.reject("Could not download that file: "
          + (e.getMessage() != null ? e.getMessage() : "unknown error"));
      } finally {
        if (conn != null) conn.disconnect();
      }
    }).start();
  }

  /**
   * One phone file, streamed into a Drive folder. Drive wants an upload
   * session first (that is where the name and parent folder ride), then a
   * single PUT carrying the whole file — set up with a fixed length so the
   * bytes go disk → socket without ever being assembled in memory.
   */
  @PluginMethod
  public void uploadFile(PluginCall call) {
    final String path = str(call, "path", "");
    final String folderId = str(call, "folderId", "root");
    final String bearer = str(call, "bearer", "");
    final String name = str(call, "name", "");
    final String mime = str(call, "mime", "application/octet-stream");
    new Thread(() -> {
      HttpURLConnection init = null;
      HttpURLConnection put = null;
      try {
        File file = new File(path);
        if (!file.isFile()) {
          call.reject("That file is not on the phone any more.");
          return;
        }
        long len = file.length();
        if (len <= 0) {
          call.reject("That file is empty — there is nothing to upload.");
          return;
        }

        init = (HttpURLConnection) new URL(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name")
          .openConnection();
        init.setConnectTimeout(CONNECT_TIMEOUT_MS);
        init.setReadTimeout(READ_TIMEOUT_MS);
        init.setRequestMethod("POST");
        init.setDoOutput(true);
        init.setRequestProperty("Authorization", "Bearer " + bearer);
        init.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        JSONObject meta = new JSONObject();
        meta.put("name", name.isEmpty() ? file.getName() : name);
        JSONArray parents = new JSONArray();
        parents.put(folderId);
        meta.put("parents", parents);
        byte[] metaBytes = meta.toString().getBytes(StandardCharsets.UTF_8);
        init.setFixedLengthStreamingMode(metaBytes.length);
        OutputStream metaOut = init.getOutputStream();
        metaOut.write(metaBytes);
        metaOut.close();
        int s1 = init.getResponseCode();
        if (s1 < 200 || s1 >= 300) {
          String err = readAll(init.getErrorStream());
          call.reject("Drive refused the upload (" + s1 + ")"
            + (err.isEmpty() ? "." : ": " + err));
          return;
        }
        String session = init.getHeaderField("Location");
        if (session == null || session.isEmpty()) {
          call.reject("Drive did not return an upload session.");
          return;
        }

        put = (HttpURLConnection) new URL(session).openConnection();
        put.setConnectTimeout(CONNECT_TIMEOUT_MS);
        put.setReadTimeout(READ_TIMEOUT_MS);
        put.setRequestMethod("PUT");
        put.setDoOutput(true);
        put.setFixedLengthStreamingMode(len);
        put.setRequestProperty("Content-Type", mime);
        OutputStream out = new BufferedOutputStream(put.getOutputStream(), 64 * 1024);
        InputStream in = new BufferedInputStream(new FileInputStream(file), 64 * 1024);
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        out.close();
        in.close();

        int s2 = put.getResponseCode();
        String body = readAll(s2 >= 400 ? put.getErrorStream() : put.getInputStream());
        if (s2 < 200 || s2 >= 300) {
          call.reject("Drive refused the upload (" + s2 + ")"
            + (body.isEmpty() ? "." : ": " + body));
          return;
        }
        JSObject ret = new JSObject();
        String id = "";
        String savedName = name.isEmpty() ? file.getName() : name;
        try {
          JSONObject saved = new JSONObject(body);
          id = saved.optString("id", "");
          savedName = saved.optString("name", savedName);
        } catch (Exception ignored) {
        }
        ret.put("id", id);
        ret.put("name", savedName);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject("Could not upload that file: "
          + (e.getMessage() != null ? e.getMessage() : "unknown error"));
      } finally {
        if (init != null) init.disconnect();
        if (put != null) put.disconnect();
      }
    }).start();
  }

  // ── the Drive app route (Storage Access Framework) ──────
  //
  // These methods let the phone's own Drive app be the account holder. The
  // user grants one tree through Android's picker (ACTION_OPEN_DOCUMENT_TREE),
  // the grant is persisted, and from then on every listing and byte moves
  // through the content resolver. Storage for that grant is deliberately its
  // own prefs file: the app already stores one SAF tree for the "shared
  // folder" fallback in DeviceFilesPlugin, and connecting Drive must not
  // quietly unhook that.

  private static final String SAF_PREFS = "drive_saf";
  private static final String SAF_KEY_TREE = "tree_uri";
  private static final String SAF_KEY_NAME = "tree_name";
  /** One folder listing is a cursor over a network-backed provider; a cap
   *  keeps a pathological folder from holding the thread forever. */
  private static final int SAF_LIST_CAP = 400;

  private SharedPreferences safPrefs() {
    return getContext().getSharedPreferences(SAF_PREFS, Context.MODE_PRIVATE);
  }

  /** The persisted grant, verified against Android's own permission list so a
   *  revocation in Settings reads as "not connected" rather than as an error
   *  two screens later. Returns null when there is no live grant. */
  private String liveTree() {
    String tree = safPrefs().getString(SAF_KEY_TREE, null);
    if (tree == null) return null;
    try {
      for (android.content.UriPermission p :
          getContext().getContentResolver().getPersistedUriPermissions()) {
        if (p.isReadPermission() && tree.equals(p.getUri().toString())) return tree;
      }
    } catch (Exception ignored) {
    }
    return null;
  }

  private void releaseTree(String treeUri) {
    try {
      getContext().getContentResolver().releasePersistableUriPermission(
        Uri.parse(treeUri),
        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
    } catch (Exception ignored) {
      // Already gone is the outcome we wanted anyway.
    }
  }

  /** DISPLAY_NAME for any document uri, or null when the provider stays mute. */
  private String displayNameOf(Uri docUri) {
    if (docUri == null) return null;
    try (Cursor c = getContext().getContentResolver().query(
        docUri, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME },
        null, null, null)) {
      if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
    } catch (Exception ignored) {
    }
    return null;
  }

  /** Opens Android's picker on the Drive provider. What comes back is one
   *  tree — "My Drive" itself or any folder inside it — and the grant sticks
   *  across restarts until it is released or revoked in Settings. */
  @PluginMethod
  public void safConnect(PluginCall call) {
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
    intent.addFlags(
      Intent.FLAG_GRANT_READ_URI_PERMISSION
        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
    );
    // A hint, not a demand: if the picker cannot resolve it, it opens at its
    // normal location and the user walks to Drive by hand.
    try {
      intent.putExtra(
        "android.provider.extra.INITIAL_URI",
        DocumentsContract.buildRootUri("com.google.android.apps.docs.storage", "root"));
    } catch (Exception ignored) {
    }
    startActivityForResult(call, intent, "onSafTreePicked");
  }

  @ActivityCallback
  private void onSafTreePicked(PluginCall call, ActivityResult result) {
    if (result == null || result.getResultCode() != Activity.RESULT_OK) {
      JSObject ret = new JSObject();
      ret.put("cancelled", true);
      call.resolve(ret);
      return;
    }
    Intent data = result.getData();
    Uri uri = data != null ? data.getData() : null;
    if (uri == null) {
      call.reject("The picker did not return a folder.");
      return;
    }
    try {
      int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION
        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
      if (flags != 0) {
        getContext().getContentResolver().takePersistableUriPermission(uri, flags);
      }
      // One Drive tree at a time: a re-pick replaces the old grant.
      String prev = safPrefs().getString(SAF_KEY_TREE, null);
      if (prev != null && !prev.equals(uri.toString())) releaseTree(prev);
      String docId = DocumentsContract.getTreeDocumentId(uri);
      String name = displayNameOf(DocumentsContract.buildDocumentUriUsingTree(uri, docId));
      if (name == null || name.isEmpty()) {
        int slash = docId.lastIndexOf('/');
        name = slash >= 0 && slash + 1 < docId.length() ? docId.substring(slash + 1) : "Drive";
      }
      safPrefs().edit()
        .putString(SAF_KEY_TREE, uri.toString())
        .putString(SAF_KEY_NAME, name)
        .apply();
      JSObject ret = new JSObject();
      ret.put("cancelled", false);
      ret.put("treeId", docId);
      ret.put("name", name);
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("Android did not keep access to that folder. Try again.");
    }
  }

  @PluginMethod
  public void safStatus(PluginCall call) {
    JSObject ret = new JSObject();
    String tree = liveTree();
    ret.put("connected", tree != null);
    if (tree != null) {
      String docId = "";
      try {
        docId = DocumentsContract.getTreeDocumentId(Uri.parse(tree));
      } catch (Exception ignored) {
      }
      ret.put("treeId", docId);
      ret.put("name", safPrefs().getString(SAF_KEY_NAME, "Drive"));
    }
    call.resolve(ret);
  }

  /** Ends the grant locally; nothing to revoke with Google because Google was
   *  never told about this app — Android held the permission all along. */
  @PluginMethod
  public void safForget(PluginCall call) {
    String tree = safPrefs().getString(SAF_KEY_TREE, null);
    safPrefs().edit().clear().apply();
    if (tree != null) releaseTree(tree);
    call.resolve();
  }

  /** One folder's children, shaped exactly like the OAuth listing so the
   *  screen does not care which route is behind it. */
  @PluginMethod
  public void safList(PluginCall call) {
    final String tree = liveTree();
    if (tree == null) {
      call.reject("No Drive folder has been shared with the app.");
      return;
    }
    final String docIdArg = call.getString("documentId");
    new Thread(() -> {
      try {
        Uri treeUri = Uri.parse(tree);
        String parentId = docIdArg == null || docIdArg.isEmpty()
          ? DocumentsContract.getTreeDocumentId(treeUri)
          : docIdArg;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId);
        String[] proj = new String[] {
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_MIME_TYPE,
          DocumentsContract.Document.COLUMN_SIZE,
          DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        };
        JSArray out = new JSArray();
        boolean truncated = false;
        try (Cursor c = getContext().getContentResolver().query(children, proj, null, null, null)) {
          if (c == null) {
            call.reject("The Drive app could not read that folder.");
            return;
          }
          int iId = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
          int iName = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
          int iMime = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE);
          int iSize = c.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
          int iMod = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
          while (c.moveToNext()) {
            if (out.length() >= SAF_LIST_CAP) {
              truncated = true;
              break;
            }
            String id = iId >= 0 ? c.getString(iId) : null;
            if (id == null) continue;
            String mime = iMime >= 0 ? c.getString(iMime) : "";
            boolean dir = DocumentsContract.Document.MIME_TYPE_DIR.equals(mime);
            JSObject o = new JSObject();
            o.put("id", id);
            o.put("name", iName >= 0 ? c.getString(iName) : "Untitled");
            o.put("mimeType", mime);
            o.put("folder", dir);
            o.put("size", !dir && iSize >= 0 && !c.isNull(iSize) ? c.getLong(iSize) : 0);
            o.put("modified", iMod >= 0 && !c.isNull(iMod) ? c.getLong(iMod) : 0);
            out.put(o);
          }
        }
        JSObject ret = new JSObject();
        ret.put("entries", out);
        ret.put("truncated", truncated);
        call.resolve(ret);
      } catch (SecurityException e) {
        JSObject ret = new JSObject();
        ret.put("revoked", true);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject("Could not read Drive: "
          + (e.getMessage() != null ? e.getMessage() : "unknown error"));
      }
    }).start();
  }

  /** One Drive file streamed onto the phone, name made collision-safe the
   *  same way the OAuth download does it. */
  @PluginMethod
  public void safDownload(PluginCall call) {
    final String tree = liveTree();
    final String docId = str(call, "documentId", "");
    final String name = str(call, "name", "download");
    final String dirPath = str(call, "dir", "");
    if (tree == null || docId.isEmpty()) {
      call.reject("No Drive file was given.");
      return;
    }
    new Thread(() -> {
      File outFile = null;
      try {
        Uri docUri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), docId);
        File dir = dirPath.isEmpty()
          ? Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
          : new File(dirPath);
        if (!dir.exists() && !dir.mkdirs()) {
          call.reject("Could not create the download folder.");
          return;
        }
        InputStream in = getContext().getContentResolver().openInputStream(docUri);
        if (in == null) {
          call.reject("The Drive app could not open that file.");
          return;
        }
        outFile = uniqueFile(dir, sanitizeName(name));
        InputStream bin = new BufferedInputStream(in, 64 * 1024);
        OutputStream out = new BufferedOutputStream(new FileOutputStream(outFile), 64 * 1024);
        byte[] buf = new byte[64 * 1024];
        long total = 0;
        int n;
        while ((n = bin.read(buf)) != -1) {
          out.write(buf, 0, n);
          total += n;
        }
        out.close();
        bin.close();
        MediaScannerConnection.scanFile(
          getContext(), new String[] { outFile.getAbsolutePath() }, null, null);
        JSObject ret = new JSObject();
        ret.put("path", outFile.getAbsolutePath());
        ret.put("name", outFile.getName());
        ret.put("bytes", total);
        call.resolve(ret);
      } catch (SecurityException e) {
        if (outFile != null && outFile.exists()) outFile.delete();
        JSObject ret = new JSObject();
        ret.put("revoked", true);
        call.resolve(ret);
      } catch (Exception e) {
        if (outFile != null && outFile.exists()) outFile.delete();
        call.reject("Could not save that file: "
          + (e.getMessage() != null ? e.getMessage() : "unknown error"));
      }
    }).start();
  }

  /** One phone file written into the granted Drive area through the Drive
   *  app. The provider creates the document (deduping the name its own way)
   *  and the bytes stream straight from disk into it. A failed write deletes
   *  the half-made document rather than leaving a stump on Drive. */
  @PluginMethod
  public void safUpload(PluginCall call) {
    final String tree = liveTree();
    final String parentId = str(call, "parentId", "");
    final String path = str(call, "path", "");
    final String name = str(call, "name", "");
    final String mime = str(call, "mime", "application/octet-stream");
    if (tree == null) {
      call.reject("Connect the Drive app first.");
      return;
    }
    new Thread(() -> {
      Uri created = null;
      try {
        File file = new File(path);
        if (!file.isFile()) {
          call.reject("That file is not on the phone any more.");
          return;
        }
        if (file.length() <= 0) {
          call.reject("That file is empty — there is nothing to upload.");
          return;
        }
        Uri treeUri = Uri.parse(tree);
        String parent = parentId.isEmpty()
          ? DocumentsContract.getTreeDocumentId(treeUri)
          : parentId;
        Uri parentDoc = DocumentsContract.buildDocumentUriUsingTree(treeUri, parent);
        created = DocumentsContract.createDocument(
          getContext().getContentResolver(), parentDoc, mime,
          name.isEmpty() ? file.getName() : name);
        if (created == null) {
          call.reject("The Drive app would not create that file.");
          return;
        }
        OutputStream out = getContext().getContentResolver().openOutputStream(created);
        if (out == null) {
          DocumentsContract.deleteDocument(getContext().getContentResolver(), created);
          call.reject("The Drive app would not accept those bytes.");
          return;
        }
        InputStream in = new BufferedInputStream(new FileInputStream(file), 64 * 1024);
        OutputStream bout = new BufferedOutputStream(out, 64 * 1024);
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) != -1) bout.write(buf, 0, n);
        bout.close();
        in.close();
        String saved = displayNameOf(created);
        JSObject ret = new JSObject();
        ret.put("id", DocumentsContract.getDocumentId(created));
        ret.put("name", saved != null && !saved.isEmpty() ? saved
          : (name.isEmpty() ? file.getName() : name));
        call.resolve(ret);
      } catch (SecurityException e) {
        if (created != null) {
          try {
            DocumentsContract.deleteDocument(getContext().getContentResolver(), created);
          } catch (Exception ignored) {
          }
        }
        JSObject ret = new JSObject();
        ret.put("revoked", true);
        call.resolve(ret);
      } catch (Exception e) {
        if (created != null) {
          try {
            DocumentsContract.deleteDocument(getContext().getContentResolver(), created);
          } catch (Exception ignored) {
          }
        }
        call.reject("Could not upload that file: "
          + (e.getMessage() != null ? e.getMessage() : "unknown error"));
      }
    }).start();
  }

  /** Hands one Drive item to whatever app claims it — for Google formats the
   *  claimant is the Drive app itself, which is exactly where they belong. */
  @PluginMethod
  public void safOpen(PluginCall call) {
    final String tree = liveTree();
    final String docId = call.getString("documentId");
    if (tree == null || docId == null) {
      call.reject("No Drive item was given.");
      return;
    }
    try {
      Uri docUri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), docId);
      Intent view = new Intent(Intent.ACTION_VIEW);
      String mime = call.getString("mime");
      if (mime == null || mime.isEmpty()) view.setData(docUri);
      else view.setDataAndType(docUri, mime);
      view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(view);
      call.resolve();
    } catch (ActivityNotFoundException e) {
      call.reject("No app on this phone opens that item.");
    } catch (Exception e) {
      call.reject("Could not open that item: "
        + (e.getMessage() != null ? e.getMessage() : "unknown error"));
    }
  }

  // ── helpers ─────────────────────────────────────────────

  private static String readAll(InputStream in) throws IOException {
    if (in == null) return "";
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    byte[] chunk = new byte[16 * 1024];
    int n;
    while ((n = in.read(chunk)) != -1) buf.write(chunk, 0, n);
    in.close();
    String text = buf.toString("UTF-8");
    // Error bodies are JSON that can run long; the caller only needs the gist.
    return text.length() > 600 ? text.substring(0, 600) + "…" : text;
  }

  /** Never overwrite: an existing name becomes "name (1).ext". */
  private static File uniqueFile(File dir, String name) {
    File f = new File(dir, name);
    if (!f.exists()) return f;
    int dot = name.lastIndexOf('.');
    String base = dot > 0 ? name.substring(0, dot) : name;
    String ext = dot > 0 ? name.substring(dot) : "";
    for (int i = 1; i < 10_000; i++) {
      File c = new File(dir, base + " (" + i + ")" + ext);
      if (!c.exists()) return c;
    }
    return new File(dir, base + "-" + System.currentTimeMillis() + ext);
  }

  /** Drive names may contain anything; a local filename may not. */
  private static String sanitizeName(String name) {
    String s = name == null ? "" : name.replace('/', '_').replace('\\', '_').trim();
    return s.isEmpty() ? "download" : s;
  }
}
