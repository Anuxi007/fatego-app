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
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
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
    private static final String BANNERS = "https://raw.githubusercontent.com/Anuxi007/fatego-app/main/data/banners.json";

    public CheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context ctx) {
        Constraints c = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(CheckWorker.class, 1, TimeUnit.HOURS)
                .setConstraints(c).build();
        // UPDATE (not KEEP) so phones that scheduled the old 6 h check switch to hourly
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("fgocodex-check",
                ExistingPeriodicWorkPolicy.UPDATE, req);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String lang = p.getString("lang", "en");
        // servant banner alerts are an explicit opt-in per servant, so they run even if general alerts are off
        try {
            checkWatched(ctx, p, lang);
        } catch (Exception ignored) {
        }
        if (getInputData().getBoolean("watchOnly", false) || !p.getBoolean("notify", true)) return Result.success();
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

    static void runWatchCheckNow(Context ctx) {
        Constraints c = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(CheckWorker.class)
                .setConstraints(c)
                .setInputData(new Data.Builder().putBoolean("watchOnly", true).build())
                .build();
        WorkManager.getInstance(ctx).enqueueUniqueWork("fgocodex-watch-now", ExistingWorkPolicy.REPLACE, req);
    }

    /** Servants the user asked to follow: notify when one shows up in a banner (announced / started). */
    private void checkWatched(Context ctx, SharedPreferences p, String lang) throws Exception {
        JSONObject watch = new JSONObject(p.getString("watch", "{}"));
        if (watch.length() == 0) return;
        JSONObject data = new JSONObject(fetch(BANNERS + "?t=" + (System.currentTimeMillis() / 600000)));
        JSONObject regions = data.optJSONObject("regions");
        if (regions == null) return;
        java.util.Set<String> done = new java.util.HashSet<>(p.getStringSet("watchDone", new java.util.HashSet<>()));
        long now = System.currentTimeMillis() / 1000;
        for (String region : new String[]{"NA", "JP"}) {
            JSONObject r = regions.optJSONObject(region);
            if (r == null) continue;
            JSONArray banners = r.optJSONArray("banners");
            if (banners == null) continue;
            String tz = region.equals("JP") ? "Asia/Tokyo" : "America/Los_Angeles";
            for (int i = 0; i < banners.length(); i++) {
                JSONObject b = banners.optJSONObject(i);
                if (b == null) continue;
                long start = b.optLong("start"), end = b.optLong("end");
                if (end <= now) continue;
                JSONArray f = b.optJSONArray("f");
                if (f == null) continue;
                for (int k = 0; k < f.length(); k++) {
                    String id = String.valueOf(f.optLong(k));
                    JSONObject w = watch.optJSONObject(id);
                    if (w == null || !w.optBoolean(region.toLowerCase())) continue;
                    String key = region + ":" + b.optLong("id") + ":" + id;
                    if (done.contains(key)) continue;
                    done.add(key);
                    String name = w.optString("name", "Servant");
                    int sid = Integer.parseInt(id);
                    if (start > now) {
                        post(ctx, key.hashCode(), S.get(lang, "watchAnn").replace("{name}", name).replace("{r}", region),
                                S.get(lang, "watchAnnText").replace("{date}", fmtDate(start, tz, lang)) + " (" + region + ")",
                                "servant", sid);
                        ReminderWorker.schedule(ctx, "start-" + key, start * 1000L,
                                S.get(lang, "watchStart").replace("{name}", name).replace("{r}", region),
                                S.get(lang, "watchStartText").replace("{date}", fmtDate(end, tz, lang)),
                                "servant", sid);
                    } else {
                        post(ctx, key.hashCode(), S.get(lang, "watchStart").replace("{name}", name).replace("{r}", region),
                                S.get(lang, "watchStartText").replace("{date}", fmtDate(end, tz, lang)),
                                "servant", sid);
                    }
                }
            }
        }
        p.edit().putStringSet("watchDone", done).apply();
    }

    private static String fmtDate(long ts, String tz, String lang) {
        java.util.Locale loc = lang.equals("ja") ? java.util.Locale.JAPAN : lang.equals("es") ? new java.util.Locale("es") : java.util.Locale.US;
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat(lang.equals("ja") ? "M/d (E) HH:mm z" : "EEE d MMM, HH:mm z", loc);
        f.setTimeZone(java.util.TimeZone.getTimeZone(tz));
        return f.format(new java.util.Date(ts * 1000L));
    }

    static void ensureChannel(Context ctx, String lang) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, S.get(lang, "channel"),
                    NotificationManager.IMPORTANCE_DEFAULT);
            ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    private void notify(Context ctx, int id, String title, String text, String action, int servantId) {
        post(ctx, id, title, text, action, servantId);
    }

    static void post(Context ctx, int id, String title, String text, String action, int servantId) {
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
                        case "watchAnn": return "📢 {name}: banner anunciado en {r}";
                        case "watchAnnText": return "Empieza el {date}";
                        case "watchStart": return "🎉 {name} ya tiene banner en {r}";
                        case "watchStartText": return "Disponible hasta el {date}";
                    }
                    break;
                case "ja":
                    switch (key) {
                        case "updTitle": return "FGO Codexの新しいバージョン";
                        case "updText": return "タップしてアップデート";
                        case "newJP": return "JPに新サーヴァント";
                        case "newNA": return "NAに新サーヴァント";
                        case "channel": return "アップデートと新サーヴァント";
                        case "watchAnn": return "📢 {name}：{r}でピックアップ予告";
                        case "watchAnnText": return "開始 {date}";
                        case "watchStart": return "🎉 {name}：{r}でピックアップ開始";
                        case "watchStartText": return "{date} まで";
                    }
                    break;
            }
            switch (key) {
                case "updTitle": return "New FGO Codex version";
                case "updText": return "Tap to update";
                case "newJP": return "New servant in JP";
                case "newNA": return "New servant in NA";
                case "watchAnn": return "📢 {name}: banner announced in {r}";
                case "watchAnnText": return "Starts {date}";
                case "watchStart": return "🎉 {name} is on a banner in {r}";
                case "watchStartText": return "Available until {date}";
                default: return "Updates and new servants";
            }
        }
    }
}
