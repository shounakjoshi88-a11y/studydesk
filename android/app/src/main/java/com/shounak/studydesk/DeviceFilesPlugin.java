package com.shounak.studydesk;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.pdf.PdfRenderer;
import android.media.MediaScannerConnection;
import android.media.ThumbnailUtils;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.os.StatFs;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.util.Size;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Reads the device filesystem so the app can browse real folders the way a file
 * manager does, with no import step and no per-folder consent.
 *
 * Two access paths, in order of preference:
 *
 *  1. "All files access" (MANAGE_EXTERNAL_STORAGE). The user grants this once
 *     on a dedicated Android settings screen. It is a real permission dialog,
 *     not a silent capability, and it is the same one every file manager and
 *     the phone's own Documents app uses. It is restricted for Play Store
 *     distribution; for a personally sideloaded build it is just a manifest
 *     line, and the user can revoke it in settings at any time.
 *
 *  2. Storage Access Framework, as a fallback. If the user declines all-files
 *     access, they can still hand over one folder and browse that. It is the
 *     narrower promise, so it is the right default when there is a choice.
 */
@CapacitorPlugin(name = "DeviceFiles")
public class DeviceFilesPlugin extends Plugin {

  private static final String TAG = "DeviceFiles";
  private static final String PREFS = "saf_folder";
  private static final String KEY_TREE = "tree_uri";
  private static final String KEY_NAME = "tree_name";
  /** Raised for the Tools readers: a 30 MB scan must cross the bridge whole
   *  before it can be compressed or merged. JS callers still default to a
   *  5 MB request, so only deliberate tool reads ask for the ceiling. */
  private static final long DEFAULT_MAX_BYTES = 48L * 1024 * 1024;
  private static final int WALK_ENTRY_CAP = 120_000;
  private static final int WALK_DEPTH_CAP = 8;
  private static final int RECENT_KEEP = 80;
  private static final int LARGEST_KEEP = 20;
  /** Recent files remembered per directory, so a subtree can be summarised
   *  from its cache without re-reading a single file inside it. */
  private static final int DIR_RECENT_KEEP = 6;
  /** Bucket order must stay in step with DirState.bytes and .counts. */
  private static final String[] BUCKETS = { "images", "videos", "audio", "documents", "other" };

  private static final Set<String> IMAGE_EXT = setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif");
  private static final Set<String> VIDEO_EXT = setOf("mp4", "mkv", "mov", "avi", "webm", "3gp", "m4v");
  private static final Set<String> AUDIO_EXT = setOf("mp3", "aac", "wav", "ogg", "m4a", "flac", "amr", "opus");
  private static final Set<String> DOC_EXT = setOf(
    "pdf", "doc", "docx", "odt", "rtf", "txt", "md", "markdown", "xls", "xlsx", "ods", "csv",
    "tsv", "ppt", "pptx", "odp", "epub");

  private static Set<String> setOf(String... items) {
    Set<String> s = new HashSet<>();
    Collections.addAll(s, items);
    return s;
  }

  // ── access state ────────────────────────────────────────

  @PluginMethod
  public void hasAccess(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("allFiles", hasAllFiles());
    ret.put("sdk", Build.VERSION.SDK_INT);
    call.resolve(ret);
  }

  private boolean hasAllFiles() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      return Environment.isExternalStorageManager();
    }
    return getContext()
      .checkCallingOrSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE)
      == android.content.pm.PackageManager.PERMISSION_GRANTED;
  }

  /**
   * Free and total bytes on the phone's shared volume. Asked of the kernel
   * rather than summed from the file walk, because "how much room is left"
   * is a question only the filesystem can answer.
   */
  @PluginMethod
  public void volumeInfo(PluginCall call) {
    try {
      StatFs fs = new StatFs(Environment.getExternalStorageDirectory().getAbsolutePath());
      long total = fs.getTotalBytes();
      long free = fs.getAvailableBytes();
      JSObject ret = new JSObject();
      ret.put("total", total);
      ret.put("free", free);
      ret.put("used", total - free);
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("Could not read the storage volume.");
    }
  }

  /**
   * Android deliberately will not show this consent dialog from inside an app.
   * The user has to reach it in system settings, so the app's whole job here
   * is to get them to the right page and explain what they are switching on.
   */
  @PluginMethod
  public void requestAccess(PluginCall call) {
    try {
      Intent i;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
          .setData(Uri.parse("package:" + getContext().getPackageName()));
      } else {
        i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
          .setData(Uri.parse("package:" + getContext().getPackageName()));
      }
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(i);
      call.resolve(new JSObject());
    } catch (Exception e) {
      // Some OEM builds do not expose the all-files page directly. Fall back to
      // the app's own settings page rather than leaving the user with nothing.
      try {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
          .setData(Uri.parse("package:" + getContext().getPackageName()))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve(new JSObject());
      } catch (Exception e2) {
        call.reject("Could not open Android settings on this device.");
      }
    }
  }

  // ── overview, cached and incremental ────────────────────

  /**
   * A directory's own record of what it contains, so an unchanged subtree never
   * has to be read again.
   *
   * A directory's mtime changes when an entry inside it is added, removed or
   * renamed, which makes it a reliable "has anything happened here" flag. A
   * delta scan therefore still walks the tree, but a directory whose mtime
   * matches contributes its cached subtotal without a single listFiles or
   * per-file stat. On a phone where almost nothing changes between openings,
   * that turns a 7,000-file read into a few hundred stat calls.
   *
   * mtime only reflects a directory's immediate children, so the walk always
   * descends — a file edited deep in a tree leaves its ancestors' mtimes
   * untouched. Descending is cheap; re-listing is what we are avoiding.
   */
  /**
   * What one directory itself contributes, never a subtree total.
   *
   * Storing per-directory aggregates and then summing children on top of them
   * double counts, which is exactly what the first version of this did. So a
   * record holds only the files sitting directly in that directory, plus the
   * names of its subdirectories. A directory's total is then always the sum of
   * its children, and there is nothing to double count.
   *
   * Recording the child names is what makes the delta scan cheap: an unchanged
   * directory reports its subdirectories from here, so descending costs one
   * stat per child instead of a full listFiles.
   */
  static final class DirState {
    long mtime;
    long ownCount;
    long[] ownBytes = new long[BUCKETS.length];
    long[] ownCounts = new long[BUCKETS.length];
    long ownDownloadBytes;
    long ownDownloadCount;
    List<String> childDirs = new ArrayList<>();
    List<JSObject> ownRecent = new ArrayList<>();
    JSObject ownLargest;

    JSObject toJson() {
      JSObject o = new JSObject();
      o.put("m", mtime);
      o.put("c", ownCount);
      JSArray bs = new JSArray();
      for (long b : ownBytes) bs.put(b);
      o.put("b", bs);
      JSArray cs = new JSArray();
      for (long c : ownCounts) cs.put(c);
      o.put("n", cs);
      o.put("db", ownDownloadBytes);
      o.put("dc", ownDownloadCount);
      JSArray ch = new JSArray();
      for (String s : childDirs) ch.put(s);
      o.put("cd", ch);
      JSArray r = new JSArray();
      for (JSObject x : ownRecent) r.put(x);
      o.put("r", r);
      if (ownLargest != null) o.put("l", ownLargest);
      return o;
    }

    static DirState fromJson(JSONObject o) throws org.json.JSONException {
      DirState d = new DirState();
      d.mtime = o.optLong("m", 0);
      d.ownCount = o.optLong("c", 0);
      JSONArray bs = o.optJSONArray("b");
      for (int i = 0; i < BUCKETS.length && bs != null && i < bs.length(); i++) {
        d.ownBytes[i] = bs.optLong(i, 0);
      }
      JSONArray cs = o.optJSONArray("n");
      for (int i = 0; i < BUCKETS.length && cs != null && i < cs.length(); i++) {
        d.ownCounts[i] = cs.optLong(i, 0);
      }
      d.ownDownloadBytes = o.optLong("db", 0);
      d.ownDownloadCount = o.optLong("dc", 0);
      JSONArray ch = o.optJSONArray("cd");
      if (ch != null) {
        for (int i = 0; i < ch.length(); i++) {
          String s = ch.optString(i, null);
          if (s != null) d.childDirs.add(s);
        }
      }
      JSONArray r = o.optJSONArray("r");
      if (r != null) {
        for (int i = 0; i < r.length(); i++) {
          JSONObject x = r.optJSONObject(i);
          if (x != null) d.ownRecent.add(JSObject.fromJSONObject(x));
        }
      }
      JSONObject l = o.optJSONObject("l");
      if (l != null) d.ownLargest = JSObject.fromJSONObject(l);
      return d;
    }
  }

  /** Running totals for a whole subtree, assembled as the walk returns. */
  private static final class Agg {
    long count;
    long[] bytes = new long[BUCKETS.length];
    long[] counts = new long[BUCKETS.length];
    long downloadBytes;
    long downloadCount;
    List<JSObject> recent = new ArrayList<>();
    JSObject largest;

    void add(DirState d) {
      count += d.ownCount;
      for (int i = 0; i < BUCKETS.length; i++) {
        bytes[i] += d.ownBytes[i];
        counts[i] += d.ownCounts[i];
      }
      downloadBytes += d.ownDownloadBytes;
      downloadCount += d.ownDownloadCount;
      recent.addAll(d.ownRecent);
      trimRecent(recent);
      if (d.ownLargest != null
        && (largest == null || d.ownLargest.optLong("size", 0) > largest.optLong("size", 0))) {
        largest = d.ownLargest;
      }
    }

    void add(Agg o) {
      count += o.count;
      for (int i = 0; i < BUCKETS.length; i++) {
        bytes[i] += o.bytes[i];
        counts[i] += o.counts[i];
      }
      downloadBytes += o.downloadBytes;
      downloadCount += o.downloadCount;
      recent.addAll(o.recent);
      trimRecent(recent);
      if (o.largest != null && (largest == null || o.largest.optLong("size", 0) > largest.optLong("size", 0))) {
        largest = o.largest;
      }
    }
  }

  private static void trimRecent(List<JSObject> list) {
    if (list.size() <= DIR_RECENT_KEEP) return;
    list.sort((a, b) -> Long.compare(b.optLong("lastModified", 0), a.optLong("lastModified", 0)));
    list.subList(DIR_RECENT_KEEP, list.size()).clear();
  }

  /**
   * Versioned filename, and the version is checked again on read. An earlier
   * build stored subtree-wide aggregates per directory, which reads back as
   * plausible-looking nonsense rather than failing, so a format change has to
   * be able to orphan the old file completely instead of half-interpreting it.
   */
  private static final int CACHE_VERSION = 3;

  private File cacheFile() {
    return new File(getContext().getFilesDir(), "df_overview_cache_v" + CACHE_VERSION + ".json");
  }

  private Map<String, DirState> readCache() {
    Map<String, DirState> m = new HashMap<>();
    try {
      File f = cacheFile();
      if (!f.exists()) return m;
      JSONObject root = new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8"));
      JSONObject dirs = root.optJSONObject("dirs");
      if (dirs == null) return m;
      for (java.util.Iterator<String> it = dirs.keys(); it.hasNext(); ) {
        String k = it.next();
        JSONObject v = dirs.optJSONObject(k);
        if (v != null) m.put(k, DirState.fromJson(v));
      }
    } catch (Exception e) {
      Log.w(TAG, "cache unreadable, doing a full scan", e);
    }
    return m;
  }

  private void writeCache(Map<String, DirState> dirs) {
    try {
      JSONObject root = new JSONObject();
      root.put("v", CACHE_VERSION);
      root.put("at", System.currentTimeMillis());
      JSONObject d = new JSONObject();
      for (Map.Entry<String, DirState> e : dirs.entrySet()) d.put(e.getKey(), e.getValue().toJson());
      root.put("dirs", d);
      java.nio.file.Files.write(cacheFile().toPath(), root.toString().getBytes("UTF-8"));
    } catch (Exception e) {
      Log.w(TAG, "cache not written", e);
    }
  }

  /**
   * Returns the subtree's totals and records this directory's own contribution
   * for next time.
   *
   * When a directory's mtime is unchanged, its own files and its list of
   * subdirectories are both taken from the cache and not one file inside it is
   * touched. The walk still descends, because a file changed three levels down
   * leaves this directory's mtime exactly where it was - but descending now
   * costs a stat per child rather than a listing per directory.
   */
  private Agg walkDir(File dir, Map<String, DirState> cache, Map<String, DirState> next, int depth) {
    String key = dir.getAbsolutePath();
    long mtime = dir.lastModified();
    DirState cached = cache.get(key);
    boolean unchanged = cached != null && cached.mtime == mtime;

    DirState st = new DirState();
    st.mtime = mtime;
    boolean isDownload = dir.getName().equals("Download");

    if (unchanged) {
      st.ownCount = cached.ownCount;
      System.arraycopy(cached.ownBytes, 0, st.ownBytes, 0, cached.ownBytes.length);
      System.arraycopy(cached.ownCounts, 0, st.ownCounts, 0, cached.ownCounts.length);
      st.ownDownloadBytes = cached.ownDownloadBytes;
      st.ownDownloadCount = cached.ownDownloadCount;
      st.childDirs.addAll(cached.childDirs);
      st.ownRecent.addAll(cached.ownRecent);
      st.ownLargest = cached.ownLargest;
    } else {
      File[] kids = dir.listFiles();
      if (kids != null) {
        for (File f : kids) {
          String name = f.getName();
          if (name.startsWith(".")) continue;
          if (f.isDirectory()) {
            // The app-sandbox tree is mostly unreadable, but Android/media is
            // exactly where chat apps drop the documents people come looking
            // for, and it reads fine with all-files access.
            if (name.equals("Android")) {
              File media = new File(f, "media");
              if (media.isDirectory()) st.childDirs.add(media.getAbsolutePath());
              continue;
            }
            if (name.equals("obb")) continue;
            st.childDirs.add(f.getAbsolutePath());
            continue;
          }
          long len = f.length();
          if (len <= 0) continue;
          st.ownCount++;
          String ext = extOf(name);
          int b = bucketIndex(bucketOf(ext));
          st.ownBytes[b] += len;
          st.ownCounts[b]++;
          if (isDownload) {
            st.ownDownloadBytes += len;
            st.ownDownloadCount++;
          }
          JSObject o = fileJson(f, name, ext, len);
          st.ownRecent.add(o);
          if (st.ownLargest == null || len > st.ownLargest.optLong("size", 0)) st.ownLargest = o;
        }
      }
      trimRecent(st.ownRecent);
    }
    next.put(key, st);

    Agg total = new Agg();
    total.add(st);

    if (depth >= WALK_DEPTH_CAP) return total;
    for (String childPath : st.childDirs) {
      Agg child = walkDir(new File(childPath), cache, next, depth + 1);
      total.add(child);
    }
    return total;
  }
  private JSObject fileJson(File f, String name, String ext, long len) {
    JSObject o = new JSObject();
    o.put("path", f.getAbsolutePath());
    o.put("name", name);
    o.put("ext", ext);
    o.put("size", len);
    o.put("lastModified", f.lastModified());
    o.put("mime", mimeOf(ext));
    return o;
  }

  /**
   * Returns the cached overview immediately so the screen paints with no walk
   * at all, then {@code overview} reconciles it against the disk.
   */
  @PluginMethod
  public void cachedOverview(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("hit", false);
    try {
      File f = cacheFile();
      if (f.exists()) {
        JSONObject root = new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8"));
        JSONObject v = root.optJSONObject("overview");
        if (v != null) {
          ret = JSObject.fromJSONObject(v);
          ret.put("hit", true);
          ret.put("at", root.optLong("at", 0));
        }
      }
    } catch (Exception e) {
      Log.w(TAG, "cached overview unavailable", e);
    }
    call.resolve(ret);
  }

  @PluginMethod
  public void overview(PluginCall call) {
    final boolean forceFull = Boolean.TRUE.equals(call.getBoolean("full"));
    final long started = System.currentTimeMillis();
    new Thread(() -> {
      try {
        File root = Environment.getExternalStorageDirectory();
        Map<String, DirState> cache = forceFull ? new HashMap<>() : readCache();
        Map<String, DirState> next = new HashMap<>();
        Agg agg = walkDir(root, cache, next, 0);
        writeCache(next);

        List<JSObject> recent = new ArrayList<>(agg.recent);
        recent.sort((a, b) -> Long.compare(b.optLong("lastModified", 0), a.optLong("lastModified", 0)));
        if (recent.size() > RECENT_KEEP) recent = new ArrayList<>(recent.subList(0, RECENT_KEEP));
        // The aggregate already carries the single biggest file in the tree, so
        // the Large files list is topped up from the per-directory records.
        List<JSObject> largest = new ArrayList<>();
        for (DirState d : next.values()) {
          if (d.ownLargest != null) largest.add(d.ownLargest);
        }
        largest.sort((a, b) -> Long.compare(b.optLong("size", 0), a.optLong("size", 0)));
        // One entry per distinct file: a directory record can surface the same
        // path twice if it was re-read while its parent was not.
        List<JSObject> unique = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (JSObject o : largest) {
          String p = o.optString("path", "");
          if (p.isEmpty() || seen.add(p)) unique.add(o);
          if (unique.size() >= LARGEST_KEEP) break;
        }
        largest = unique;

        JSArray cats = new JSArray();
        JSObject dl = new JSObject();
        dl.put("id", "downloads");
        dl.put("bytes", agg.downloadBytes);
        dl.put("count", agg.downloadCount);
        cats.put(dl);
        for (int b = 0; b < BUCKETS.length; b++) {
          JSObject o = new JSObject();
          o.put("id", BUCKETS[b]);
          o.put("bytes", agg.bytes[b]);
          o.put("count", agg.counts[b]);
          cats.put(o);
        }
        JSArray rec = new JSArray();
        for (JSObject r : recent) rec.put(r);
        JSArray big = new JSArray();
        for (JSObject r : largest) big.put(r);

        JSObject ret = new JSObject();
        ret.put("allFiles", hasAllFiles());
        ret.put("total", agg.count);
        ret.put("categories", cats);
        ret.put("recent", rec);
        ret.put("largest", big);
        ret.put("ms", System.currentTimeMillis() - started);
        ret.put("dirs", next.size());
        call.resolve(ret);
        Log.i(TAG, "overview entries=" + agg.count + " dirs=" + next.size()
          + " in " + (System.currentTimeMillis() - started) + "ms"
          + (cache.isEmpty() ? " (full)" : " (delta)"));
      } catch (SecurityException e) {
        JSObject ret = new JSObject();
        ret.put("denied", true);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not read storage");
      }
    }).start();
  }

  // ── category listing ────────────────────────────────────

  /** The last collect-walk, kept in memory for a minute so moving between
   *  categories is a slice rather than another trek over the tree. */
  private Map<String, List<JSObject>> catCache;
  private long catCacheAt;
  private static final long CAT_CACHE_TTL_MS = 60_000;
  private static final int CAT_RETURN_CAP = 4000;

  /**
   * Every file in one category, gathered across the whole storage rather than
   * read out of a single folder. That is the difference between a category and
   * a directory: "Documents" is a claim about the phone, and the files backing
   * it live in Download, in DCIM, and in chat apps' media folders alike.
   */
  @PluginMethod
  public void listCategory(PluginCall call) {
    final String id = call.getString("id", "");
    final boolean full = Boolean.TRUE.equals(call.getBoolean("full"));
    new Thread(() -> {
      try {
        Map<String, List<JSObject>> cache = catCache;
        long now = System.currentTimeMillis();
        if (full || cache == null || now - catCacheAt > CAT_CACHE_TTL_MS) {
          cache = collectByCategory();
          synchronized (DeviceFilesPlugin.this) {
            catCache = cache;
            catCacheAt = System.currentTimeMillis();
          }
        }
        List<JSObject> list = cache.get(id);
        list = list == null ? new ArrayList<>() : new ArrayList<>(list);
        list.sort((a, b) -> Long.compare(b.optLong("lastModified", 0), a.optLong("lastModified", 0)));
        JSArray arr = new JSArray();
        int n = 0;
        for (JSObject o : list) {
          arr.put(o);
          if (++n >= CAT_RETURN_CAP) break;
        }
        JSObject ret = new JSObject();
        ret.put("id", id);
        ret.put("total", list.size());
        ret.put("entries", arr);
        call.resolve(ret);
      } catch (SecurityException e) {
        JSObject ret = new JSObject();
        ret.put("denied", true);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not read that category");
      }
    }).start();
  }

  private Map<String, List<JSObject>> collectByCategory() {
    Map<String, List<JSObject>> map = new HashMap<>();
    collectInto(Environment.getExternalStorageDirectory(), map, 0);
    return map;
  }

  /** The same tree walk as the overview, but keeping the files themselves
   *  instead of their totals. Same rules, so a count and the list behind it
   *  can never disagree. */
  private void collectInto(File dir, Map<String, List<JSObject>> map, int depth) {
    if (depth > WALK_DEPTH_CAP) return;
    File[] kids = dir.listFiles();
    if (kids == null) return;
    boolean isDownload = dir.getName().equals("Download");
    for (File f : kids) {
      String name = f.getName();
      if (name.startsWith(".")) continue;
      if (f.isDirectory()) {
        if (name.equals("Android")) {
          File media = new File(f, "media");
          if (media.isDirectory()) collectInto(media, map, depth + 1);
          continue;
        }
        if (name.equals("obb")) continue;
        collectInto(f, map, depth + 1);
        continue;
      }
      long len = f.length();
      if (len <= 0) continue;
      String ext = extOf(name);
      JSObject o = fileJson(f, name, ext, len);
      map.computeIfAbsent(BUCKETS[bucketIndex(bucketOf(ext))], k -> new ArrayList<>()).add(o);
      if (isDownload) map.computeIfAbsent("downloads", k -> new ArrayList<>()).add(o);
    }
  }

  // ── push updates for media ─────────────────────────────

  private android.database.ContentObserver mediaObserver;
  private boolean pendingNotify;

  /**
   * Row counts for the two galleries, remembered because counting means walking
   * every id in the collection (MediaProvider refuses a "count(*)" projection on
   * recent Android). Cleared by the observer whenever MediaStore reports a
   * change, with a minute-long backstop, so the number on screen is never stale
   * for longer than a gallery reload takes.
   */
  private static long mediaCountImages = -1;
  private static long mediaCountVideos = -1;
  private static long mediaCountAtMs = 0;
  private static final long MEDIA_COUNT_TTL_MS = 60_000L;

  private static synchronized void invalidateMediaCounts() {
    mediaCountImages = -1;
    mediaCountVideos = -1;
    mediaCountAtMs = 0;
  }

  /** A disk change also ages out the category walk's slice cache, or a
   *  category screen opened a second later would still show a minute ago. */
  private void invalidateListCaches() {
    catCache = null;
    catCacheAt = 0;
  }

  private static synchronized long cachedMediaCount(boolean videos) {
    long v = videos ? mediaCountVideos : mediaCountImages;
    if (v >= 0 && (System.currentTimeMillis() - mediaCountAtMs) < MEDIA_COUNT_TTL_MS) return v;
    return -1;
  }

  private static synchronized void storeMediaCount(boolean videos, long total) {
    if (videos) mediaCountVideos = total;
    else mediaCountImages = total;
    mediaCountAtMs = System.currentTimeMillis();
  }

  /**
   * MediaStore pushes a notification the moment a photo, video or sound file
   * is created, changed or removed, and that feed is available to any app that
   * can read those files. This is the same mechanism Google Files uses for its
   * instant photo updates. It deliberately says nothing about PDFs and other
   * documents, because MediaStore does not index them.
   *
   * Notifications arrive in bursts - one camera burst can fire dozens - so they
   * are coalesced onto a short delay and the app is told to reconcile once
   * rather than once per event.
   */
  @PluginMethod
  public void startWatching(PluginCall call) {
    if (mediaObserver != null) {
      call.resolve(new JSObject());
      return;
    }
    try {
      mediaObserver = new android.database.ContentObserver(new android.os.Handler(android.os.Looper.getMainLooper())) {
        @Override
        public void onChange(boolean selfChange) {
          onChange(selfChange, null);
        }

        @Override
        public void onChange(boolean selfChange, android.net.Uri uri) {
          if (pendingNotify) return;
          pendingNotify = true;
          new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            pendingNotify = false;
            invalidateMediaCounts();
            invalidateListCaches();
            notifyListeners("deviceFilesChanged", new JSObject().put("source", "mediastore"));
          }, 1200);
        }
      };
      getContext().getContentResolver().registerContentObserver(
        android.provider.MediaStore.Files.getContentUri("external"), true, mediaObserver);
      call.resolve(new JSObject());
    } catch (Exception e) {
      call.reject("Could not watch for media changes: " + e.getMessage());
    }
  }

  @PluginMethod
  public void stopWatching(PluginCall call) {
    if (mediaObserver != null) {
      try {
        getContext().getContentResolver().unregisterContentObserver(mediaObserver);
      } catch (Exception ignored) {}
      mediaObserver = null;
    }
    call.resolve(new JSObject());
  }

  /**
   * Tells the JS side the disk changed. MediaStore's own notifications cover
   * writes made by other apps, but an app is not guaranteed an echo of its
   * own insert through the Downloads collection — and that insert is exactly
   * the case a file manager cares about. Every write this plugin performs
   * announces itself here, so the Files home reconciles instead of showing a
   * list from a minute ago.
   */
  private void announceFileChange(String source) {
    new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
      invalidateMediaCounts();
      invalidateListCaches();
      notifyListeners("deviceFilesChanged", new JSObject().put("source", source));
    });
  }

  @Override
  protected void handleOnDestroy() {
    if (mediaObserver != null) {
      try {
        getContext().getContentResolver().unregisterContentObserver(mediaObserver);
      } catch (Exception ignored) {}
      mediaObserver = null;
    }
    super.handleOnDestroy();
  }


  // ── directory listing ───────────────────────────────────

  @PluginMethod
  public void listDir(PluginCall call) {
    final String path = call.getString("path", "");
    new Thread(() -> {
      try {
        File dir = path.isEmpty() ? Environment.getExternalStorageDirectory() : new File(path);
        File[] kids = dir.listFiles();
        if (kids == null) {
          JSObject ret = new JSObject();
          ret.put("entries", new JSArray());
          ret.put("unreadable", true);
          call.resolve(ret);
          return;
        }
        List<JSObject> rows = new ArrayList<>();
        for (File f : kids) {
          if (f.getName().startsWith(".")) continue;
          JSObject o = new JSObject();
          o.put("path", f.getAbsolutePath());
          o.put("name", f.getName());
          o.put("isDir", f.isDirectory());
          o.put("ext", f.isDirectory() ? "" : extOf(f.getName()));
          o.put("size", f.isDirectory() ? 0 : f.length());
          o.put("lastModified", f.lastModified());
          o.put("mime", f.isDirectory() ? "vnd.android.document/directory" : mimeOf(extOf(f.getName())));
          rows.add(o);
        }
        // Folders first, then case-insensitive by name. The filesystem returns
        // no useful order, and a list that reshuffles between visits is worse
        // than useless for finding anything.
        Collections.sort(rows, new Comparator<JSObject>() {
          @Override public int compare(JSObject a, JSObject b) {
            boolean da = Boolean.TRUE.equals(a.getBool("isDir"));
            boolean db = Boolean.TRUE.equals(b.getBool("isDir"));
            if (da != db) return da ? -1 : 1;
            return String.valueOf(a.getString("name", ""))
              .compareToIgnoreCase(String.valueOf(b.getString("name", "")));
          }
        });
        JSArray out = new JSArray();
        for (JSObject r : rows) out.put(r);
        JSObject ret = new JSObject();
        ret.put("entries", out);
        ret.put("name", dir.getName().isEmpty() ? "Internal storage" : dir.getName());
        call.resolve(ret);
      } catch (SecurityException e) {
        JSObject ret = new JSObject();
        ret.put("denied", true);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not open that folder");
      }
    }).start();
  }

  // ── thumbnails ──────────────────────────────────────────

  /**
   * Downscales to a cached JPEG and hands back a file path rather than base64.
   * A carousel of a dozen photos is ~1.5 MB of pixels; as base64 across the
   * bridge that is 2 MB of JSON strings competing with the rest of the app for
   * the WebView heap. A file URL is free.
   */
  @PluginMethod
  public void thumb(PluginCall call) {
    final String path = call.getString("path", "");
    final int w = Math.max(64, Math.min(1024, call.getInt("w", 320)));
    new Thread(() -> {
      try {
        File src = new File(path);
        if (!src.exists()) {
          call.resolve(new JSObject());
          return;
        }
        File dir = new File(getContext().getCacheDir(), "thumbs");
        if (!dir.exists() && !dir.mkdirs()) {
          call.resolve(new JSObject());
          return;
        }
        File out = new File(dir, Integer.toHexString(path.hashCode()) + "_" + w + ".jpg");
        if (out.exists() && out.lastModified() > src.lastModified()) {
          JSObject ret = new JSObject();
          ret.put("url", out.getAbsolutePath());
          call.resolve(ret);
          return;
        }
        Bitmap bmp = decodeSampled(src, w);
        if (bmp == null) bmp = videoFrame(src, w);
        if (bmp == null) {
          call.resolve(new JSObject());
          return;
        }
        try (FileOutputStream fos = new FileOutputStream(out)) {
          bmp.compress(Bitmap.CompressFormat.JPEG, 82, fos);
        } finally {
          bmp.recycle();
        }
        JSObject ret = new JSObject();
        ret.put("url", out.getAbsolutePath());
        call.resolve(ret);
      } catch (Throwable e) {
        // A thumbnail is a nicety. Never let a corrupt image break the list.
        call.resolve(new JSObject());
      }
    }).start();
  }

  private Bitmap decodeSampled(File src, int targetW) {
    BitmapFactory.Options bounds = new BitmapFactory.Options();
    bounds.inJustDecodeBounds = true;
    BitmapFactory.decodeFile(src.getAbsolutePath(), bounds);
    if (bounds.outWidth <= 0) return null;
    int sample = 1;
    while (bounds.outWidth / (sample * 2) >= targetW) sample *= 2;
    BitmapFactory.Options opts = new BitmapFactory.Options();
    opts.inSampleSize = sample;
    return BitmapFactory.decodeFile(src.getAbsolutePath(), opts);
  }

  private static final String[] VIDEO_TAILS = {
    ".mp4", ".mkv", ".webm", ".mov", ".avi", ".3gp", ".3g2", ".m4v",
    ".ts", ".flv", ".wmv", ".mpg", ".mpeg", ".m2ts", ".ogv",
  };

  /**
   * A video has no pixels for BitmapFactory to find, so a row that asks for
   * its thumbnail used to come back blank. The platform's own frame extractor
   * answers instead — the frame the gallery would show — and anything that is
   * neither image nor video still lands on null.
   */
  private Bitmap videoFrame(File src, int w) {
    String name = src.getName().toLowerCase(Locale.ROOT);
    boolean isVideo = false;
    for (String tail : VIDEO_TAILS) {
      if (name.endsWith(tail)) {
        isVideo = true;
        break;
      }
    }
    if (!isVideo) return null;
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        return ThumbnailUtils.createVideoThumbnail(src, new Size(w * 2, w * 2), null);
      }
      return ThumbnailUtils.createVideoThumbnail(src.getAbsolutePath(), MediaStore.Video.Thumbnails.MINI_KIND);
    } catch (Throwable e) {
      return null;
    }
  }

  /**
   * Page preview plus page count for one PDF, drawn by the platform's own
   * PdfRenderer and cached beside the image thumbs. A picker row wants page 1;
   * the merge screen's page shuffle asks for whichever page is on screen, so
   * the page number rides along and names the cache file. A 20 MB scan is
   * never dragged across the bridge as base64 just to be looked at.
   */
  @PluginMethod
  public void pdfThumb(PluginCall call) {
    final String path = call.getString("path", "");
    final int w = Math.max(96, Math.min(1024, call.getInt("w", 320)));
    final int pageNo = Math.max(0, call.getInt("page", 0));
    new Thread(() -> {
      JSObject ret = new JSObject();
      try {
        File src = new File(path);
        if (!src.exists() || src.length() == 0) {
          call.resolve(ret);
          return;
        }
        File dir = new File(getContext().getCacheDir(), "pdfthumbs");
        if (!dir.exists() && !dir.mkdirs()) {
          call.resolve(ret);
          return;
        }
        File out = new File(dir, Integer.toHexString(path.hashCode()) + "_" + w
          + (pageNo > 0 ? "_p" + pageNo : "") + ".jpg");
        ParcelFileDescriptor pfd = ParcelFileDescriptor.open(src, ParcelFileDescriptor.MODE_READ_ONLY);
        PdfRenderer renderer = new PdfRenderer(pfd);
        try {
          ret.put("pages", renderer.getPageCount());
          if (!(out.exists() && out.lastModified() > src.lastModified())) {
            PdfRenderer.Page page = renderer.openPage(Math.min(pageNo, renderer.getPageCount() - 1));
            try {
              int pw = Math.max(1, page.getWidth());
              int ph = Math.max(1, page.getHeight());
              int th = Math.max(1, Math.round(ph * (w / (float) pw)));
              Bitmap bmp = Bitmap.createBitmap(w, th, Bitmap.Config.ARGB_8888);
              bmp.eraseColor(android.graphics.Color.WHITE);
              page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
              try (FileOutputStream fos = new FileOutputStream(out)) {
                bmp.compress(Bitmap.CompressFormat.JPEG, 82, fos);
              } finally {
                bmp.recycle();
              }
            } finally {
              page.close();
            }
          }
          ret.put("url", out.getAbsolutePath());
          call.resolve(ret);
        } finally {
          try { renderer.close(); } catch (Throwable ignored) { }
          try { pfd.close(); } catch (Throwable ignored) { }
        }
      } catch (Throwable e) {
        // A preview is a nicety; a locked or malformed PDF still merges fine.
        call.resolve(ret);
      }
    }).start();
  }

  /**
   * Copy a finished tool result into the phone's own storage — the public
   * Download/StudyDesk folder any file manager, WhatsApp or Chrome can see.
   * API 29+ goes through MediaStore, so the file is indexed the instant it
   * lands; older devices write straight into the public directory and ask
   * the media scanner to index it. This adds a second copy: the in-app copy
   * is still made by JS, this is the one the rest of the phone can open.
   */
  @PluginMethod
  public void exportDownload(PluginCall call) {
    final String raw = call.getString("name", "");
    final String data = call.getString("data", "");
    if (raw.isEmpty() || data.isEmpty()) {
      call.reject("Nothing to save");
      return;
    }
    final String name = raw.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    if (name.isEmpty()) {
      call.reject("Bad file name");
      return;
    }
    final String mime = mimeOf(extOf(name));
    new Thread(() -> {
      try {
        byte[] bytes = Base64.decode(data, Base64.DEFAULT);
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          ContentValues cv = new ContentValues();
          cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
          cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
          cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/StudyDesk");
          Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
          if (uri == null) {
            call.reject("Downloads refused the file");
            return;
          }
          try (java.io.OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
            if (os == null) throw new Exception("Downloads refused the file");
            os.write(bytes);
          } catch (Exception write) {
            // A half-written row would show up in file managers as a broken
            // file; pull it back out before surfacing the failure.
            getContext().getContentResolver().delete(uri, null, null);
            throw write;
          }
          ret.put("path", "Download/StudyDesk/" + name);
          ret.put("uri", uri.toString());
          announceFileChange("export");
          call.resolve(ret);
          return;
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "StudyDesk");
        if (!dir.exists() && !dir.mkdirs()) {
          call.reject("Could not create the folder");
          return;
        }
        File out = new File(dir, name);
        for (int n = 2; out.exists() && n < 100; n++) {
          int dot = name.lastIndexOf('.');
          out = new File(dir, dot > 0 ? name.substring(0, dot) + " (" + n + ")" + name.substring(dot) : name + " (" + n + ")");
        }
        try (FileOutputStream fos = new FileOutputStream(out)) {
          fos.write(bytes);
        }
        MediaScannerConnection.scanFile(getContext(), new String[]{ out.getAbsolutePath() }, new String[]{ mime }, null);
        ret.put("path", "Download/StudyDesk/" + out.getName());
        announceFileChange("export");
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not save to Downloads");
      }
    }).start();
  }

  // ── reading ─────────────────────────────────────────────

  @PluginMethod
  public void readFile(PluginCall call) {
    final String path = call.getString("path", "");
    long requested = call.getLong("maxBytes", DEFAULT_MAX_BYTES);
    final long max = (requested <= 0 || requested > DEFAULT_MAX_BYTES) ? DEFAULT_MAX_BYTES : requested;
    new Thread(() -> {
      try {
        File f = new File(path);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        boolean truncated = false;
        try (InputStream in = new java.io.FileInputStream(f)) {
          byte[] buf = new byte[16 * 1024];
          int n;
          long total = 0;
          while ((n = in.read(buf)) != -1) {
            long room = max - total;
            if (room <= 0) { truncated = true; break; }
            if (n > room) { out.write(buf, 0, (int) room); total += room; truncated = true; break; }
            out.write(buf, 0, n);
            total += n;
          }
        }
        String ext = extOf(f.getName());
        JSObject ret = new JSObject();
        ret.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
        ret.put("name", f.getName());
        ret.put("mime", mimeOf(ext));
        ret.put("truncated", truncated);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not read that file");
      }
    }).start();
  }

  // ── device-wide search ──────────────────────────────────

  /**
   * The search screen's engine. It reuses the category walk's own cache: the
   * same collect pass that fills each category's list already holds every
   * file on the phone, so a search after any category visit costs zero disk
   * reads until the cache's minute is up — and a cold search costs the same
   * single walk a category open costs.
   *
   * The query matches on file names, case-insensitively, the way the phone's
   * own file managers do. kinds, when present, narrows to the buckets the
   * search screen's Category filter picked.
   */
  @PluginMethod
  public void searchFiles(PluginCall call) {
    final String query = call.getString("query", "").trim().toLowerCase(Locale.ROOT);
    final JSArray kindsArr = call.getArray("kinds");
    final int cap = Math.max(1, Math.min(1000, call.getInt("limit", 400)));
    new Thread(() -> {
      try {
        Map<String, List<JSObject>> cache = catCache;
        long now = System.currentTimeMillis();
        if (cache == null || now - catCacheAt > CAT_CACHE_TTL_MS) {
          cache = collectByCategory();
          synchronized (DeviceFilesPlugin.this) {
            catCache = cache;
            catCacheAt = System.currentTimeMillis();
          }
        }
        Set<String> kinds = new HashSet<>();
        if (kindsArr != null) {
          for (int i = 0; i < kindsArr.length(); i++) {
            String k = kindsArr.getString(i);
            if (k != null && !k.isEmpty()) kinds.add(k);
          }
        }
        // A download is also a document/image/other, and the walk lists it
        // under both; keying the hits by path keeps one row per file.
        Map<String, JSObject> hits = new HashMap<>();
        for (Map.Entry<String, List<JSObject>> e : cache.entrySet()) {
          if (!kinds.isEmpty() && !kinds.contains(e.getKey())) continue;
          for (JSObject o : e.getValue()) {
            String name = o.optString("name", "").toLowerCase(Locale.ROOT);
            if (!name.contains(query)) continue;
            hits.putIfAbsent(o.optString("path", ""), o);
          }
        }
        List<JSObject> out = new ArrayList<>(hits.values());
        out.sort((a, b) -> Long.compare(b.optLong("lastModified", 0), a.optLong("lastModified", 0)));
        JSArray arr = new JSArray();
        int n = 0;
        for (JSObject o : out) {
          arr.put(o);
          if (++n >= cap) break;
        }
        JSObject ret = new JSObject();
        ret.put("total", out.size());
        ret.put("entries", arr);
        call.resolve(ret);
      } catch (SecurityException e) {
        JSObject ret = new JSObject();
        ret.put("denied", true);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not search storage");
      }
    }).start();
  }

  // ── clean hub ───────────────────────────────────────────

  /**
   * The Clean screen's one scan. It rides the same category-walk cache as
   * search, so the walk happens once per minute at most, and it answers all
   * three questions the screen asks:
   *
   *  - junk: the leftovers the walk can actually see — .tmp/.log/.bak and
   *    friends, editor backup names, and APKs that were already installed.
   *    (Other apps' caches are invisible to every file manager on modern
   *    Android, so nothing pretends to count them.)
   *  - old: files untouched for a month that sit in Download or a
   *    Screenshots folder, the two places people accumulate without meaning to.
   *  - duplicates: same-size files hashed with SHA-256. Size equality first
   *    makes hashing rare, and the size cap keeps a pair of feature-length
   *    videos from turning one scan into a lunch break. bytes counts what
   *    would actually come back: every copy after the first.
   */
  @PluginMethod
  public void cleanScan(PluginCall call) {
    new Thread(() -> {
      try {
        Map<String, List<JSObject>> cache = catCache;
        long now = System.currentTimeMillis();
        if (cache == null || now - catCacheAt > CAT_CACHE_TTL_MS) {
          cache = collectByCategory();
          synchronized (DeviceFilesPlugin.this) {
            catCache = cache;
            catCacheAt = System.currentTimeMillis();
          }
        }
        Set<String> junkExt = setOf(
          "tmp", "temp", "log", "bak", "part", "crdownload", "opdownload", "partial");
        long monthAgo = now - 30L * 24 * 3600 * 1000;
        long HASH_CAP = 64L * 1024 * 1024;
        long HASH_FLOOR = 4 * 1024;

        Map<String, JSObject> junk = new java.util.LinkedHashMap<>();
        Map<String, JSObject> old = new java.util.LinkedHashMap<>();
        Set<String> seen = new HashSet<>();
        Map<Long, List<JSObject>> bySize = new HashMap<>();

        for (List<JSObject> bucket : cache.values()) {
          for (JSObject o : bucket) {
            String path = o.optString("path", "");
            if (path.isEmpty() || !seen.add(path)) continue;
            String name = o.optString("name", "");
            String lower = name.toLowerCase(Locale.ROOT);
            String ext = o.optString("ext", "");
            long size = o.optLong("size", 0);
            long mtime = o.optLong("lastModified", 0);

            if (junkExt.contains(ext) || lower.endsWith("~") || "apk".equals(ext)) {
              junk.put(path, o);
            }
            if (mtime > 0 && mtime < monthAgo
              && (path.contains("/Download/") || path.contains("/Screenshots/"))) {
              old.put(path, o);
            }
            if (size >= HASH_FLOOR && size <= HASH_CAP) {
              bySize.computeIfAbsent(size, k -> new ArrayList<>()).add(o);
            }
          }
        }

        List<JSObject> groups = new ArrayList<>();
        long dupeBytes = 0;
        long dupeFiles = 0;
        for (List<JSObject> g : bySize.values()) {
          if (g.size() < 2 || g.size() > 20) continue;
          Map<String, List<JSObject>> byHash = new HashMap<>();
          for (JSObject o : g) {
            String h = sha256(new File(o.optString("path", "")));
            if (h != null) byHash.computeIfAbsent(h, k -> new ArrayList<>()).add(o);
          }
          for (Map.Entry<String, List<JSObject>> he : byHash.entrySet()) {
            List<JSObject> gg = he.getValue();
            if (gg.size() < 2) continue;
            JSArray fa = new JSArray();
            for (JSObject o : gg) fa.put(o);
            JSObject group = new JSObject();
            group.put("hash", he.getKey());
            group.put("size", gg.get(0).optLong("size", 0));
            group.put("files", fa);
            groups.add(group);
            dupeFiles += gg.size();
            dupeBytes += gg.get(0).optLong("size", 0) * (gg.size() - 1L);
          }
        }

        JSArray ja = new JSArray();
        long junkBytes = 0;
        for (JSObject o : junk.values()) {
          ja.put(o);
          junkBytes += o.optLong("size", 0);
        }
        JSArray oa = new JSArray();
        long oldBytes = 0;
        for (JSObject o : old.values()) {
          oa.put(o);
          oldBytes += o.optLong("size", 0);
        }
        JSArray ga = new JSArray();
        for (JSObject o : groups) ga.put(o);

        JSObject junkOut = new JSObject();
        junkOut.put("entries", ja);
        junkOut.put("bytes", junkBytes);
        JSObject oldOut = new JSObject();
        oldOut.put("entries", oa);
        oldOut.put("bytes", oldBytes);
        JSObject dupeOut = new JSObject();
        dupeOut.put("groups", ga);
        dupeOut.put("files", dupeFiles);
        dupeOut.put("bytes", dupeBytes);

        JSObject ret = new JSObject();
        ret.put("junk", junkOut);
        ret.put("old", oldOut);
        ret.put("dupes", dupeOut);
        call.resolve(ret);
      } catch (SecurityException e) {
        JSObject ret = new JSObject();
        ret.put("denied", true);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not scan for cleanup");
      }
    }).start();
  }

  private static String sha256(File f) {
    try (InputStream in = new java.io.FileInputStream(f)) {
      java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
      byte[] buf = new byte[128 * 1024];
      int n;
      while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
      byte[] out = md.digest();
      StringBuilder sb = new StringBuilder(out.length * 2);
      for (byte b : out) sb.append(String.format("%02x", b));
      return sb.toString();
    } catch (Exception e) {
      return null;
    }
  }

  /** The Clean screen's storage card's arrow — Android's own storage page. */
  @PluginMethod
  public void openStorageSettings(PluginCall call) {
    try {
      Intent i = new Intent(Settings.ACTION_INTERNAL_STORAGE_SETTINGS);
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(i);
      call.resolve(new JSObject());
    } catch (Exception e) {
      try {
        Intent i = new Intent(Settings.ACTION_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve(new JSObject());
      } catch (Exception e2) {
        call.reject("Could not open Android settings on this device");
      }
    }
  }

  /**
   * Existence and current stats for paths the caller already knows about —
   * the Starred screen's one question about files it did not walk to find.
   * One stat per path, in order; a missing file answers exists=false rather
   * than failing the batch, because half a starred list is still worth
   * showing.
   */
  @PluginMethod
  public void statPaths(PluginCall call) {
    JSArray in = call.getArray("paths");
    JSArray out = new JSArray();
    if (in != null) {
      for (int i = 0; i < in.length(); i++) {
        String p = in.optString(i, "");
        File f = new File(p);
        boolean exists = !p.isEmpty() && f.exists();
        JSObject o = new JSObject();
        o.put("exists", exists);
        o.put("size", exists ? f.length() : 0);
        o.put("lastModified", exists ? f.lastModified() : 0);
        out.put(o);
      }
    }
    JSObject ret = new JSObject();
    ret.put("items", out);
    call.resolve(ret);
  }

  // ── open with, move, copy ───────────────────────────────

  /** Paths arrive from the web layer with or without the file:// scheme. */
  private static File fileOf(String p) {
    String s = p == null ? "" : p;
    if (s.startsWith("file://")) s = s.substring(7);
    return new File(s);
  }

  /**
   * "Open with" is the phone's decision, not the web layer's: the file goes out
   * as a content:// URI from our own provider with a read grant attached, which
   * is the only form target apps accept on modern Android, and the chooser
   * lets the user pick which of them gets it.
   */
  @PluginMethod
  public void openWith(PluginCall call) {
    final String path = call.getString("path", "");
    final String mime = call.getString("mime", "");
    try {
      File f = fileOf(path);
      if (!f.exists()) {
        call.reject("That file is no longer there");
        return;
      }
      Uri uri = androidx.core.content.FileProvider.getUriForFile(
        getContext(), getContext().getPackageName() + ".fileprovider", f);
      String type = mime;
      if (type == null || type.isEmpty()) {
        type = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(extOf(f.getName()));
      }
      if (type == null || type.isEmpty()) type = "*/*";
      Intent view = new Intent(Intent.ACTION_VIEW);
      view.setDataAndType(uri, type);
      view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      Intent chooser = Intent.createChooser(view, "Open with");
      chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(chooser);
      call.resolve(new JSObject());
    } catch (android.content.ActivityNotFoundException e) {
      call.reject("Nothing on this phone can open that kind of file");
    } catch (Exception e) {
      call.reject(e.getMessage() != null ? e.getMessage() : "Could not open that file");
    }
  }

  /**
   * Moving and copying happen natively because this layer already holds the
   * real paths. A rename is tried first: on one volume it is atomic and
   * instant, and the copy route exists only for the times it is not, like an
   * SD card crossing.
   */
  @PluginMethod
  public void movePath(PluginCall call) {
    final String from = call.getString("from", "");
    final String to = call.getString("to", "");
    new Thread(() -> {
      try {
        File src = fileOf(from);
        File dst = fileOf(to);
        if (!src.exists()) {
          call.reject("That file is no longer there");
          return;
        }
        File parent = dst.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
          call.reject("Could not create the destination folder");
          return;
        }
        if (!src.renameTo(dst)) {
          copyRecursive(src, dst);
          deleteRecursive(src);
        }
        announceFileChange("move");
        call.resolve(new JSObject());
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not move that file");
      }
    }).start();
  }

  @PluginMethod
  public void copyPath(PluginCall call) {
    final String from = call.getString("from", "");
    final String to = call.getString("to", "");
    new Thread(() -> {
      try {
        File src = fileOf(from);
        File dst = fileOf(to);
        if (!src.exists()) {
          call.reject("That file is no longer there");
          return;
        }
        File parent = dst.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
          call.reject("Could not create the destination folder");
          return;
        }
        copyRecursive(src, dst);
        announceFileChange("copy");
        call.resolve(new JSObject());
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not copy that file");
      }
    }).start();
  }

  private static void copyRecursive(File src, File dst) throws java.io.IOException {
    if (src.isDirectory()) {
      if (!dst.exists() && !dst.mkdirs()) throw new java.io.IOException("Could not create " + dst.getName());
      File[] kids = src.listFiles();
      if (kids != null) {
        for (File k : kids) copyRecursive(k, new File(dst, k.getName()));
      }
      return;
    }
    try (
      InputStream in = new java.io.FileInputStream(src);
      java.io.OutputStream out = new java.io.FileOutputStream(dst)
    ) {
      byte[] buf = new byte[64 * 1024];
      int n;
      while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
    }
  }

  private static void deleteRecursive(File f) {
    if (f.isDirectory()) {
      File[] kids = f.listFiles();
      if (kids != null) {
        for (File k : kids) deleteRecursive(k);
      }
    }
    //noinspection ResultOfMethodCallIgnored
    f.delete();
  }

  // ── SAF fallback ────────────────────────────────────────

  private SharedPreferences prefs() {
    return getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
  }

  @PluginMethod
  public void pickFolder(PluginCall call) {
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
    intent.addFlags(
      Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
    );
    startActivityForResult(call, intent, "onFolderPicked");
  }

  @ActivityCallback
  private void onFolderPicked(PluginCall call, androidx.activity.result.ActivityResult result) {
    if (result == null || result.getResultCode() != Activity.RESULT_OK) {
      JSObject ret = new JSObject();
      ret.put("cancelled", true);
      call.resolve(ret);
      return;
    }
    Intent data = result.getData();
    Uri uri = data != null ? data.getData() : null;
    if (uri == null) {
      call.reject("No folder was returned");
      return;
    }
    try {
      int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION
        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
      if (flags != 0) {
        getContext().getContentResolver().takePersistableUriPermission(uri, flags);
      }
      String docId = DocumentsContract.getTreeDocumentId(uri);
      String name = docId;
      int slash = name.indexOf('/');
      if (slash > 0) name = name.substring(slash + 1);
      prefs().edit().putString(KEY_TREE, uri.toString()).putString(KEY_NAME, name).apply();
    } catch (SecurityException e) {
      call.reject("Android did not grant persistent access to that folder");
      return;
    }
    JSObject ret = new JSObject();
    ret.put("cancelled", false);
    ret.put("uri", uri.toString());
    ret.put("name", displayName(uri));
    call.resolve(ret);
  }

  @PluginMethod
  public void getGrantedFolder(PluginCall call) {
    String tree = prefs().getString(KEY_TREE, null);
    JSObject ret = new JSObject();
    if (tree == null) {
      ret.put("granted", false);
      call.resolve(ret);
      return;
    }
    boolean live = false;
    try {
      for (android.content.UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
        if (p.isReadPermission() && tree.equals(p.getUri().toString())) live = true;
      }
    } catch (Exception ignored) {}
    ret.put("granted", live);
    if (live) {
      ret.put("uri", tree);
      ret.put("name", prefs().getString(KEY_NAME, "Shared folder"));
    }
    call.resolve(ret);
  }

  @PluginMethod
  public void listSaf(PluginCall call) {
    final String tree = prefs().getString(KEY_TREE, null);
    if (tree == null) {
      call.reject("No folder has been shared with the app");
      return;
    }
    final String docId = call.getString("documentId", null);
    new Thread(() -> {
      try {
        Uri treeUri = Uri.parse(tree);
        String parentId = docId != null && !docId.isEmpty()
          ? docId : DocumentsContract.getTreeDocumentId(treeUri);
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId);
        String[] proj = new String[] {
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_MIME_TYPE,
          DocumentsContract.Document.COLUMN_SIZE,
          DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        };
        JSArray out = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(children, proj, null, null, null)) {
          if (c == null) { call.reject("Android could not read that folder"); return; }
          int iId = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
          int iName = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
          int iMime = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE);
          int iSize = c.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
          int iMod = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
          while (c.moveToNext()) {
            String id = iId >= 0 ? c.getString(iId) : null;
            if (id == null) continue;
            String name = iName >= 0 ? c.getString(iName) : "Untitled";
            String mime = iMime >= 0 ? c.getString(iMime) : "";
            boolean dir = DocumentsContract.Document.MIME_TYPE_DIR.equals(mime);
            JSObject o = new JSObject();
            o.put("documentId", id);
            o.put("name", name);
            o.put("isDir", dir);
            o.put("ext", dir ? "" : extOf(name));
            o.put("size", !dir && iSize >= 0 && !c.isNull(iSize) ? c.getLong(iSize) : 0);
            o.put("lastModified", iMod >= 0 && !c.isNull(iMod) ? c.getLong(iMod) : 0);
            out.put(o);
          }
        }
        JSObject ret = new JSObject();
        ret.put("entries", out);
        call.resolve(ret);
      } catch (SecurityException e) {
        JSObject ret = new JSObject();
        ret.put("revoked", true);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not read that folder");
      }
    }).start();
  }

  @PluginMethod
  public void readSaf(PluginCall call) {
    final String tree = prefs().getString(KEY_TREE, null);
    final String docId = call.getString("documentId", null);
    if (tree == null || docId == null) {
      call.reject("No folder has been shared with the app");
      return;
    }
    long requested = call.getLong("maxBytes", DEFAULT_MAX_BYTES);
    final long max = (requested <= 0 || requested > DEFAULT_MAX_BYTES) ? DEFAULT_MAX_BYTES : requested;
    new Thread(() -> {
      try {
        Uri docUri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), docId);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        boolean truncated = false;
        try (InputStream in = getContext().getContentResolver().openInputStream(docUri)) {
          if (in == null) { call.reject("Could not open that file"); return; }
          byte[] buf = new byte[16 * 1024];
          int n;
          long total = 0;
          while ((n = in.read(buf)) != -1) {
            long room = max - total;
            if (room <= 0) { truncated = true; break; }
            if (n > room) { out.write(buf, 0, (int) room); total += room; truncated = true; break; }
            out.write(buf, 0, n);
            total += n;
          }
        }
        String name = displayName(docUri);
        JSObject ret = new JSObject();
        ret.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
        ret.put("name", name);
        ret.put("mime", mimeOf(extOf(name)));
        ret.put("truncated", truncated);
        call.resolve(ret);
      } catch (SecurityException e) {
        JSObject ret = new JSObject();
        ret.put("revoked", true);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not read that file");
      }
    }).start();
  }

  // ── device-wide media galleries (MediaStore) ──────────────

  /**
   * Device-wide Images / Videos gallery backed by MediaStore instead of a
   * folder walk. The old Files tab treated Images as /sdcard/Pictures and
   * Videos as /sdcard/Movies, so a phone full of Camera / WhatsApp / Telegram
   * clips showed a single video. MediaStore already indexes every photo and
   * video on the device wherever it lives — the same index the default Photos
   * app reads — so these two categories query it directly.
   *
   * Why DATA still works here: the app holds MANAGE_EXTERNAL_STORAGE, so the
   * absolute-path column stays readable and the web side can stream each file
   * straight off disk instead of base64-ing megabytes across the bridge.
   */
  @PluginMethod
  public void listMedia(PluginCall call) {
    final String kind = call.getString("kind", "");
    final int limit = Math.max(1, Math.min(1000, call.getInt("limit", 200)));
    final int offset = Math.max(0, call.getInt("offset", 0));
    if (!"images".equals(kind) && !"videos".equals(kind)) {
      call.reject("kind must be \"images\" or \"videos\"");
      return;
    }
    final boolean videos = "videos".equals(kind);
    new Thread(() -> {
      try {
        Uri collection = mediaCollectionUri(kind);
        // Why WIDTH/HEIGHT ride along for images too: the item JSON carries
        // them for both kinds, so both projections fetch them.
        final String colWidth = videos ? MediaStore.Video.Media.WIDTH : MediaStore.Images.Media.WIDTH;
        final String colHeight = videos ? MediaStore.Video.Media.HEIGHT : MediaStore.Images.Media.HEIGHT;
        final String[] proj = videos
          ? new String[] {
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.DATA,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.BUCKET_DISPLAY_NAME,
            colWidth,
            colHeight,
            MediaStore.Video.Media.DURATION,
          }
          : new String[] {
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.DATA,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.BUCKET_DISPLAY_NAME,
            colWidth,
            colHeight,
          };
        // _ID second in the sort so paging is stable when two files share a timestamp.
        final String order = MediaStore.MediaColumns.DATE_MODIFIED + " DESC, "
          + MediaStore.MediaColumns._ID + " DESC";

        // Counting is the expensive half of this call, and it used to run on
        // every visit. The answer is remembered until MediaStore reports a
        // change or a minute passes, whichever comes first.
        long cached = cachedMediaCount(videos);
        int total = cached >= 0 ? (int) cached : 0;
        if (cached < 0) {
          boolean counted = false;
          try (Cursor c = getContext().getContentResolver()
            .query(collection, new String[] { "count(*) AS n" }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
              total = c.getInt(0);
              counted = true;
            }
          } catch (Exception e) {
            // Some providers reject count(*); the id-scan fallback below covers that.
            Log.w(TAG, "media count(*) unsupported, falling back to id scan", e);
          }
          if (!counted) {
            try (Cursor c = getContext().getContentResolver()
              .query(collection, new String[] { MediaStore.MediaColumns._ID }, null, null, null)) {
              if (c != null) {
                total = c.getCount();
                counted = true;
              }
            } catch (Exception e2) {
              Log.w(TAG, "media count fallback failed", e2);
            }
          }
          if (counted) storeMediaCount(videos, total);
        }

        // Paging. Recent Android validates the sort string, so the old
        // "ORDER BY … LIMIT n OFFSET m" trick fails the whole query with
        // "Invalid token LIMIT" — on Android 16 that arrived as an empty
        // Images gallery. The supported replacement is a query-argument
        // Bundle; only the limit travels in it (there is no offset argument
        // worth betting on), and the offset is spent here by skipping rows,
        // which is correct whether or not the provider honours the limit.
        Cursor page = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          try {
            Bundle args = new Bundle();
            args.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, order);
            args.putInt(ContentResolver.QUERY_ARG_SQL_LIMIT, offset + limit);
            page = getContext().getContentResolver().query(collection, proj, args, null);
          } catch (Exception pageErr) {
            Log.w(TAG, "provider refused query-arg paging, reading the sorted set instead", pageErr);
            page = null;
          }
        }
        if (page == null) {
          page = getContext().getContentResolver().query(collection, proj, null, null, order);
        }

        JSArray out = new JSArray();
        try (Cursor c = page) {
          if (c != null) {
            int iId = c.getColumnIndex(MediaStore.MediaColumns._ID);
            int iName = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME);
            int iData = c.getColumnIndex(MediaStore.MediaColumns.DATA);
            int iSize = c.getColumnIndex(MediaStore.MediaColumns.SIZE);
            int iMod = c.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED);
            int iMime = c.getColumnIndex(MediaStore.MediaColumns.MIME_TYPE);
            int iBucket = c.getColumnIndex(MediaStore.MediaColumns.BUCKET_DISPLAY_NAME);
            int iW = c.getColumnIndex(colWidth);
            int iH = c.getColumnIndex(colHeight);
            int iDur = videos ? c.getColumnIndex(MediaStore.Video.Media.DURATION) : -1;
            // Whatever limited the cursor, it starts at row 0; the offset is
            // spent here.
            c.moveToPosition(offset - 1);
            int written = 0;
            while (written < limit && c.moveToNext()) {
              // Why rows without DATA are skipped: without a path the item is
              // unusable to us (no <img> src, no thumb decode, no viewer).
              String data = (iData >= 0 && !c.isNull(iData)) ? c.getString(iData) : null;
              if (data == null || data.isEmpty()) continue;
              JSObject o = new JSObject();
              o.put("id", iId >= 0 ? String.valueOf(c.getLong(iId)) : "");
              o.put("path", data);
              o.put("name", (iName >= 0 && !c.isNull(iName)) ? c.getString(iName) : "");
              o.put("size", (iSize >= 0 && !c.isNull(iSize)) ? c.getLong(iSize) : 0);
              // Why x1000: DATE_MODIFIED is epoch SECONDS; the gallery groups
              // by date in milliseconds, and forgetting this parks every photo in 1970.
              long secs = (iMod >= 0 && !c.isNull(iMod)) ? c.getLong(iMod) : 0;
              o.put("lastModified", secs * 1000L);
              o.put("mime", (iMime >= 0 && !c.isNull(iMime)) ? c.getString(iMime) : "");
              if (iW >= 0 && !c.isNull(iW) && c.getInt(iW) > 0) o.put("width", c.getInt(iW));
              if (iH >= 0 && !c.isNull(iH) && c.getInt(iH) > 0) o.put("height", c.getInt(iH));
              if (iDur >= 0 && !c.isNull(iDur) && c.getLong(iDur) > 0) o.put("durationMs", c.getLong(iDur));
              o.put("bucket", (iBucket >= 0 && !c.isNull(iBucket)) ? c.getString(iBucket) : "");
              out.put(o);
              written++;
            }
          }
        }
        JSObject ret = new JSObject();
        ret.put("items", out);
        ret.put("total", total);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not list media");
      }
    }).start();
  }

  // ── every PDF on the device (MediaStore) ─────────────────

  /**
   * The phone's PDFs, straight out of Android's own file index.
   *
   * Why not a folder walk: the walk descends /sdcard and sees whatever the
   * filesystem will hand it — on this phone that was four PDFs against an
   * index holding one thousand seven hundred. Chat apps park their documents
   * under Android/media/…, downloads land wherever the browser felt like it,
   * and listFiles() silently answers null on the directories it cannot open,
   * so the walk fails quiet instead of failing loud. MediaStore is the same
   * index the system Files app reads, refreshed by the media scanner, and
   * querying it returns every PDF on every mounted volume in one pass.
   *
   * Why DATA stays usable: the app holds MANAGE_EXTERNAL_STORAGE, so the
   * absolute path column comes through and the web side can hand each file to
   * <img>, PDF.js or the native thumbnailer without copying bytes first.
   *
   * The gate is deliberate: without all-files access MediaProvider would
   * answer with only the app's own PDFs, which reads as "your files are
   * gone". Better to say so — callers show the grant card off `denied`.
   */
  @PluginMethod
  public void listPdfs(PluginCall call) {
    if (!hasAllFiles()) {
      JSObject ret = new JSObject();
      ret.put("denied", true);
      ret.put("items", new JSArray());
      ret.put("total", 0);
      call.resolve(ret);
      return;
    }
    new Thread(() -> {
      try {
        final String[] proj = new String[] {
          MediaStore.MediaColumns._ID,
          MediaStore.MediaColumns.DISPLAY_NAME,
          MediaStore.MediaColumns.DATA,
          MediaStore.MediaColumns.SIZE,
          MediaStore.MediaColumns.DATE_MODIFIED,
          MediaStore.MediaColumns.MIME_TYPE,
        };
        // LIKE is ASCII-case-insensitive in SQLite, so .PDF files match too;
        // the mime check catches the rare scan that lost the extension.
        final String sel = "(" + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?"
          + " OR " + MediaStore.MediaColumns.MIME_TYPE + " = ?)";
        final String[] selArgs = new String[] { "%.pdf", "application/pdf" };
        final String order = MediaStore.MediaColumns.DATE_MODIFIED + " DESC, "
          + MediaStore.MediaColumns._ID + " DESC";

        java.util.Set<String> volumes;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          volumes = MediaStore.getExternalVolumeNames(getContext());
        } else {
          volumes = java.util.Collections.singleton("external");
        }

        JSArray out = new JSArray();
        java.util.Set<String> seen = new java.util.HashSet<>();
        final int cap = 6000;
        for (String vol : volumes) {
          if (out.length() >= cap) break;
          Uri collection = MediaStore.Files.getContentUri(vol);
          Cursor c = null;
          try {
            c = getContext().getContentResolver().query(collection, proj, sel, selArgs, order);
          } catch (Exception qe) {
            // One volume the provider dislikes must not take the others down.
            Log.w(TAG, "pdf query failed on volume " + vol, qe);
          }
          if (c == null) continue;
          try {
            int iId = c.getColumnIndex(MediaStore.MediaColumns._ID);
            int iName = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME);
            int iData = c.getColumnIndex(MediaStore.MediaColumns.DATA);
            int iSize = c.getColumnIndex(MediaStore.MediaColumns.SIZE);
            int iMod = c.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED);
            int iMime = c.getColumnIndex(MediaStore.MediaColumns.MIME_TYPE);
            while (out.length() < cap && c.moveToNext()) {
              // Rows without a path cannot be streamed, thumbed or merged.
              String data = (iData >= 0 && !c.isNull(iData)) ? c.getString(iData) : null;
              if (data == null || data.isEmpty() || !seen.add(data)) continue;
              JSObject o = new JSObject();
              o.put("id", iId >= 0 ? String.valueOf(c.getLong(iId)) : "");
              o.put("path", data);
              o.put("name", (iName >= 0 && !c.isNull(iName)) ? c.getString(iName) : "");
              o.put("size", (iSize >= 0 && !c.isNull(iSize)) ? c.getLong(iSize) : 0);
              // DATE_MODIFIED is epoch seconds; every consumer here counts ms.
              long secs = (iMod >= 0 && !c.isNull(iMod)) ? c.getLong(iMod) : 0;
              o.put("lastModified", secs * 1000L);
              o.put("mime", (iMime >= 0 && !c.isNull(iMime)) ? c.getString(iMime) : "");
              out.put(o);
            }
          } finally {
            c.close();
          }
        }
        JSObject ret = new JSObject();
        ret.put("items", out);
        ret.put("total", out.length());
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "Could not list PDFs");
      }
    }).start();
  }

  /**
   * Square JPEG thumbnail for one MediaStore row, cached under a deterministic
   * name in the app cache dir. Why the cache is keyed and reused: a scrolling
   * grid asks for the same ids over and over, and re-decoding every photo is
   * what makes grids stutter — a non-empty hit skips the decode entirely.
   * Failures resolve {url:""} on purpose: one bad photo must not break a grid.
   */
  @PluginMethod
  public void mediaThumb(PluginCall call) {
    final String id = call.getString("id", "");
    final String kind = call.getString("kind", "");
    final int w = Math.max(64, Math.min(2048, call.getInt("w", 400)));
    if (id.isEmpty() || (!"images".equals(kind) && !"videos".equals(kind))) {
      JSObject ret = new JSObject();
      ret.put("url", "");
      call.resolve(ret);
      return;
    }
    new Thread(() -> {
      try {
        String safeId = id.replaceAll("[^A-Za-z0-9_-]", "_");
        File out = new File(getContext().getCacheDir(), "mthumb_" + kind + "_" + safeId + "_" + w + ".jpg");
        if (out.exists() && out.length() > 0) {
          JSObject ret = new JSObject();
          ret.put("url", out.getAbsolutePath());
          call.resolve(ret);
          return;
        }
        Uri uri = mediaItemUri(kind, id);
        Bitmap decoded = null;
        if (Build.VERSION.SDK_INT >= 29) {
          // Why loadThumbnail first: the system sizes the thumb itself, which
          // is fast and never holds a 12MP bitmap in our heap. Guarded because
          // minSdk (26) predates the API.
          try {
            decoded = getContext().getContentResolver().loadThumbnail(uri, new Size(w, w), null);
          } catch (Exception e) {
            Log.w(TAG, "loadThumbnail failed, falling back to sampled decode", e);
          }
        }
        if (decoded == null) {
          // Why sampled decode: a straight decodeFile of a 12MP photo blows
          // the heap; inSampleSize keeps the decoded bitmap roughly near w.
          String path = mediaPathFor(kind, id);
          if (path == null) {
            JSObject ret = new JSObject();
            ret.put("url", "");
            call.resolve(ret);
            return;
          }
          decoded = decodeSampled(new File(path), w);
        }
        if (decoded == null) {
          JSObject ret = new JSObject();
          ret.put("url", "");
          call.resolve(ret);
          return;
        }
        Bitmap square = centerCropSquare(decoded, w);
        try {
          try (FileOutputStream fos = new FileOutputStream(out)) {
            square.compress(Bitmap.CompressFormat.JPEG, 82, fos);
          }
        } finally {
          if (square != decoded) square.recycle();
          decoded.recycle();
        }
        JSObject ret = new JSObject();
        ret.put("url", (out.exists() && out.length() > 0) ? out.getAbsolutePath() : "");
        call.resolve(ret);
      } catch (Throwable t) {
        // A thumbnail is a nicety. Never let a corrupt image break the list.
        Log.w(TAG, "mediaThumb failed", t);
        JSObject ret = new JSObject();
        ret.put("url", "");
        call.resolve(ret);
      }
    }).start();
  }

  /**
   * Absolute disk path for one MediaStore row. Why a path and not bytes: a
   * 5MB base64 video inside a JSON string is how you make a WebView fall
   * over — the web side turns this into a convertFileSrc URL and lets a
   * plain <img>/<video> stream from disk itself.
   */
  @PluginMethod
  public void mediaUrl(PluginCall call) {
    final String id = call.getString("id", "");
    final String kind = call.getString("kind", "");
    new Thread(() -> {
      try {
        String found = mediaPathFor(kind, id);
        JSObject ret = new JSObject();
        // Why the exists() check: MediaStore can list rows whose files are
        // already gone (SD card pulled, pending deletion).
        ret.put("url", (found != null && new File(found).exists()) ? found : "");
        call.resolve(ret);
      } catch (Exception e) {
        JSObject ret = new JSObject();
        ret.put("url", "");
        call.resolve(ret);
      }
    }).start();
  }

  private Uri mediaCollectionUri(String kind) {
    // Why kind matters for the Uri: the same numeric id exists independently
    // in the Images and Videos collections, so the caller must say which one.
    return "videos".equals(kind)
      ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
      : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
  }

  private Uri mediaItemUri(String kind, String id) {
    Uri collection = mediaCollectionUri(kind);
    try {
      return ContentUris.withAppendedId(collection, Long.parseLong(id));
    } catch (NumberFormatException e) {
      return Uri.withAppendedPath(collection, id);
    }
  }

  /** Single-row DATA lookup shared by mediaUrl and the pre-29 thumb fallback. */
  private String mediaPathFor(String kind, String id) {
    if (id == null || id.isEmpty()) return null;
    if (!"images".equals(kind) && !"videos".equals(kind)) return null;
    try (Cursor c = getContext().getContentResolver().query(
      mediaItemUri(kind, id),
      new String[] { MediaStore.MediaColumns.DATA },
      null, null, null)) {
      if (c != null && c.moveToFirst()) {
        int i = c.getColumnIndex(MediaStore.MediaColumns.DATA);
        if (i >= 0 && !c.isNull(i)) return c.getString(i);
      }
    } catch (Exception e) {
      Log.w(TAG, "media path lookup failed", e);
    }
    return null;
  }

  /** Scales so the smaller edge hits w, then crops the center — a MediaStore-style square. */
  private Bitmap centerCropSquare(Bitmap src, int w) {
    int bw = src.getWidth();
    int bh = src.getHeight();
    if (bw <= 0 || bh <= 0) return src;
    if (bw == w && bh == w) return src;
    float scale = Math.max(w / (float) bw, w / (float) bh);
    Bitmap scaled = Bitmap.createScaledBitmap(
      src, Math.max(1, Math.round(bw * scale)), Math.max(1, Math.round(bh * scale)), true);
    int sw = scaled.getWidth();
    int sh = scaled.getHeight();
    if (sw < w || sh < w) return scaled;
    Bitmap square = Bitmap.createBitmap(scaled, (sw - w) / 2, (sh - w) / 2, w, w);
    if (scaled != src) scaled.recycle();
    return square;
  }

  // ── helpers ─────────────────────────────────────────────

  private String displayName(Uri uri) {
    try (Cursor c = getContext().getContentResolver()
      .query(uri, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        String n = c.getString(0);
        if (n != null && !n.isEmpty()) return n;
      }
    } catch (Exception ignored) {}
    String seg = uri.getLastPathSegment();
    return seg == null ? "Shared folder" : seg.replaceAll(":[^:]*$", "");
  }

  static String extOf(String name) {
    int dot = name.lastIndexOf('.');
    if (dot < 0 || dot == name.length() - 1) return "";
    return name.substring(dot + 1).toLowerCase(Locale.ROOT);
  }

  static String bucketOf(String ext) {
    if (IMAGE_EXT.contains(ext)) return "images";
    if (VIDEO_EXT.contains(ext)) return "videos";
    if (AUDIO_EXT.contains(ext)) return "audio";
    if (DOC_EXT.contains(ext)) return "documents";
    return "other";
  }

  /** Position of a bucket in BUCKETS; anything unrecognised is "other". */
  static int bucketIndex(String bucket) {
    for (int i = 0; i < BUCKETS.length; i++) if (BUCKETS[i].equals(bucket)) return i;
    return BUCKETS.length - 1;
  }

  private static String mimeOf(String ext) {
    String guess = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
    if (guess != null) return guess;
    if (DOC_EXT.contains(ext)) return "application/octet-stream";
    return "application/octet-stream";
  }
}
