package com.fgocodex.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Bridge exposed to the web UI as window.AndroidApp.
 * Downloads a release APK from GitHub and hands it to the system installer.
 */
public class Updater {

    private final Activity activity;
    private final WebView webView;
    private volatile boolean busy = false;
    private File pendingApk = null;

    Updater(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    @JavascriptInterface
    public int getVersionCode() {
        return BuildConfig.VERSION_CODE;
    }

    @JavascriptInterface
    public String getVersionName() {
        return BuildConfig.VERSION_NAME;
    }

    private String launchAction = "";
    private int launchServant = 0;

    void setLaunch(String action, int servant) {
        launchAction = action == null ? "" : action;
        launchServant = servant;
    }

    /** Returns "update", "servant:<id>" or "" once, then clears it. */
    @JavascriptInterface
    public String consumeLaunchAction() {
        String a = launchAction;
        if ("servant".equals(a) && launchServant > 0) a = "servant:" + launchServant;
        launchAction = "";
        launchServant = 0;
        return a;
    }

    @JavascriptInterface
    public void setLanguage(String lang) {
        activity.getSharedPreferences(CheckWorker.PREFS, android.content.Context.MODE_PRIVATE)
                .edit().putString("lang", lang).apply();
        CheckWorker.ensureChannel(activity, lang);
    }

    @JavascriptInterface
    public boolean getNotifications() {
        return activity.getSharedPreferences(CheckWorker.PREFS, android.content.Context.MODE_PRIVATE)
                .getBoolean("notify", true);
    }

    @JavascriptInterface
    public void setNotifications(boolean on) {
        activity.getSharedPreferences(CheckWorker.PREFS, android.content.Context.MODE_PRIVATE)
                .edit().putBoolean("notify", on).apply();
        if (on) activity.runOnUiThread(this::requestNotificationPermission);
    }

    void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(
                android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 42);
        }
    }

    @JavascriptInterface
    public void downloadAndInstall(final String url) {
        if (busy || url == null || !url.startsWith("https://")) return;
        busy = true;
        new Thread(() -> {
            try {
                File dir = new File(activity.getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("mkdir");
                File apk = new File(dir, "update.apk");
                download(url, apk);
                activity.runOnUiThread(() -> install(apk));
            } catch (Exception e) {
                js("window.__updateError && window.__updateError()");
            } finally {
                busy = false;
            }
        }).start();
    }

    private void download(String url, File out) throws Exception {
        HttpURLConnection conn = null;
        // Follow redirects manually (GitHub release assets redirect to another host)
        for (int i = 0; i < 6; i++) {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("Accept", "application/octet-stream");
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                url = conn.getHeaderField("Location");
                conn.disconnect();
                continue;
            }
            if (code != 200) throw new Exception("HTTP " + code);
            break;
        }
        long total = conn.getContentLengthLong();
        try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[64 * 1024];
            long done = 0;
            int lastPct = -1;
            int n;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                done += n;
                if (total > 0) {
                    int pct = (int) (done * 100 / total);
                    if (pct != lastPct) {
                        lastPct = pct;
                        js("window.__updateProgress && window.__updateProgress(" + pct + ")");
                    }
                }
            }
        } finally {
            conn.disconnect();
        }
    }

    private void install(File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            pendingApk = apk;
            js("window.__updateNeedsPermission && window.__updateNeedsPermission()");
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(settings);
            return;
        }
        Uri uri = FileProvider.getUriForFile(activity,
                activity.getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(intent);
        js("window.__updateInstalling && window.__updateInstalling()");
    }

    /** Called from the activity when the user comes back from the permission screen. */
    void onResume() {
        if (pendingApk != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && activity.getPackageManager().canRequestPackageInstalls()) {
            File apk = pendingApk;
            pendingApk = null;
            install(apk);
        }
    }

    private void js(String code) {
        activity.runOnUiThread(() -> webView.evaluateJavascript(code, null));
    }
}
