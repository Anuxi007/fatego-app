package com.fgocodex.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.Constraints;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Periodic background check: new app release on GitHub and new servants (JP / NA). */
public class CheckWorker extends Worker {

    static final String PREFS = "fgocodex";
    static final String CHANNEL = "updates";
    private static final String RELEASES = "https://api.github.com/repos/Anuxi007/fatego-app/releases/latest";
    private static final String INDEX = "https://raw.githubusercontent.com/Anuxi007/fatego-app/main/data/index.json";

    public CheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context ctx) {
        Constraints c = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(CheckWorker.class, 6, TimeUnit.HOURS)
                .setConstraints(c).build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("fgocodex-check",
                ExistingPeriodicWorkPolicy.KEEP, req);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!p.getBoolean("notify", true)) return Result.success();
        String lang = p.getString("lang", "en");
        try {
            checkRelease(ctx, p, lang);
        } catch (Exception ignored) {
        }
        try {
            checkServants(ctx, p, lang);
        } catch (Exception ignored) {
        }
        return Result.success();
    }

    private void checkRelease(Context ctx, SharedPreferences p, String lang) throws Exception {
        JSONObject rel = new JSONObject(fetch(RELEASES));
        Matcher m = Pattern.compile("(\\d+)").matcher(rel.optString("tag_name", ""));
        if (!m.find()) return;
        int build = Integer.parseInt(m.group(1));
        if (build > BuildConfig.VERSION_CODE && build != p.getInt("notifiedBuild", 0)) {
            p.edit().putInt("notifiedBuild", build).apply();
            notify(ctx, 1, S.get(lang, "updTitle"), S.get(lang, "updText") + " (build " + build + ")", "update", 0);
        }
    }

    private void checkServants(Context ctx, SharedPreferences p, String lang) throws Exception {
        JSONObject idx = new JSONObject(fetch(INDEX + "?t=" + (System.currentTimeMillis() / 3600000)));
        handleNewest(ctx, p, lang, idx.optJSONArray("newestJP"), "lastJP", "JP", 2);
        handleNewest(ctx, p, lang, idx.optJSONArray("newestNA"), "lastNA", "NA", 3);
    }

    private void handleNewest(Context ctx, SharedPreferences p, String lang, JSONArray arr,
                              String key, String region, int notifId) {
        if (arr == null || arr.length() == 0) return;
        int last = p.getInt(key, -1);
        int top = arr.optJSONObject(0).optInt("no", 0);
        if (last < 0) {               // first run: remember, don't notify
            p.edit().putInt(key, top).apply();
            return;
        }
        if (top <= last) return;
        StringBuilder names = new StringBuilder();
        int count = 0;
        int firstId = 0;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject s = arr.optJSONObject(i);
            if (s == null || s.optInt("no", 0) <= last) continue;
            if (count > 0) names.append(", ");
            names.append(s.optString("name"));
            if (firstId == 0) firstId = s.optInt("id", 0);
            count++;
        }
        p.edit().putInt(key, top).apply();
        if (count == 0) return;
        String title = S.get(lang, region.equals("JP") ? "newJP" : "newNA");
        notify(ctx, notifId, title, names.toString(), "servant", count == 1 ? firstId : 0);
    }

    static void ensureChannel(Context ctx, String lang) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, S.get(lang, "channel"),
                    NotificationManager.IMPORTANCE_DEFAULT);
            ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    private void notify(Context ctx, int id, String title, String text, String action, int servantId) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(ctx,
                android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ensureChannel(ctx, ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("lang", "en"));
        Intent open = new Intent(ctx, MainActivity.class);
        open.putExtra("action", action);
        open.putExtra("servant", servantId);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, id, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(pi)
                .setAutoCancel(true);
        NotificationManagerCompat.from(ctx).notify(id, b.build());
    }

    private static String fetch(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "fgo-codex");
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            return sb.toString();
        } finally {
            c.disconnect();
        }
    }

    /** Tiny string table for notifications. */
    static class S {
        static String get(String lang, String key) {
            switch (lang) {
                case "es":
                    switch (key) {
                        case "updTitle": return "Nueva versión de FGO Codex";
                        case "updText": return "Toca para actualizar";
                        case "newJP": return "Nuevo servant en JP";
                        case "newNA": return "Nuevo servant en NA";
                        case "channel": return "Actualizaciones y servants nuevos";
                    }
                    break;
                case "ja":
                    switch (key) {
                        case "updTitle": return "FGO Codexの新しいバージョン";
                        case "updText": return "タップしてアップデート";
                        case "newJP": return "JPに新サーヴァント";
                        case "newNA": return "NAに新サーヴァント";
                        case "channel": return "アップデートと新サーヴァント";
                    }
                    break;
            }
            switch (key) {
                case "updTitle": return "New FGO Codex version";
                case "updText": return "Tap to update";
                case "newJP": return "New servant in JP";
                case "newNA": return "New servant in NA";
                default: return "Updates and new servants";
            }
        }
    }
}
