package com.shounak.studydesk;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

@CapacitorPlugin(name = "NativeHttp")
public class NativeHttpPlugin extends Plugin {

  static {
    // HttpURLConnection installs a default CookieHandler that APPENDS its own
    // cookies to any Cookie header we set. For a session-authenticated portal
    // that means two JSESSIONIDs in one request; the server can pick the
    // anonymous one and 302 us to the login page. We own the cookie jar in
    // TypeScript, so the JVM must stay out of it.
    try {
      java.net.CookieHandler.setDefault(null);
    } catch (Throwable ignored) {
    }
  }

  @PluginMethod
  public void request(PluginCall call) {
    final String url = call.getString("url", "");
    final String method = call.getString("method", "GET");
    final JSObject headers = call.getObject("headers", new JSObject());
    final String body = call.getString("body", null);

    new Thread(() -> {
      try {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method.toUpperCase());
        conn.setInstanceFollowRedirects(false);
        conn.setConnectTimeout(30000);
        conn.setReadTimeout(60000);
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
          String k = keys.next();
          try {
            conn.setRequestProperty(k, headers.getString(k));
          } catch (Exception ignored) {}
        }
        if (body != null && (method.equalsIgnoreCase("POST") || method.equalsIgnoreCase("PUT"))) {
          conn.setDoOutput(true);
          byte[] b = body.getBytes(StandardCharsets.UTF_8);
          conn.setFixedLengthStreamingMode(b.length);
          try (OutputStream os = conn.getOutputStream()) {
            os.write(b);
          }
        }
        int status;
        String respBody = "";
        try {
          status = conn.getResponseCode();
          InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
          if (is != null) {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) {
              baos.write(buf, 0, n);
            }
            respBody = baos.toString("UTF-8");
            is.close();
          }
        } catch (Exception e) {
          call.reject(e.getMessage() != null ? e.getMessage() : "request failed");
          return;
        }
        JSObject ret = new JSObject();
        ret.put("status", status);
        ret.put("body", respBody);
        JSObject hh = new JSObject();
        Map<String, List<String>> h = conn.getHeaderFields();
        if (h != null) {
          for (Map.Entry<String, List<String>> e : h.entrySet()) {
            if (e.getKey() == null) continue;
            hh.put(e.getKey(), String.join("\n", e.getValue()));
          }
        }
        ret.put("headers", hh);
        String loc = conn.getHeaderField("Location");
        if (loc != null) {
          ret.put("location", loc);
        }
        android.util.Log.i("NativeHttp", method + " " + url + " -> " + status
            + " bodyLen=" + respBody.length()
            + " cookieSent=" + (conn.getRequestProperty("Cookie") == null ? "none" : "yes")
            + " setCookie=" + (conn.getHeaderField("Set-Cookie") == null ? "none" : "yes")
            + (loc != null ? " loc=" + loc : ""));
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "request failed");
      }
    }).start();
  }
}
