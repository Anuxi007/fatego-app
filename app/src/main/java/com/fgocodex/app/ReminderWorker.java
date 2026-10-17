package com.fgocodex.app;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/** Shows one scheduled notification (banner ending soon, followed servant's banner starting). */
public class ReminderWorker extends Worker {

    public ReminderWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context ctx, String key, long atMillis, String title, String text, String action, int servant) {
        long delay = Math.max(0, atMillis - System.currentTimeMillis());
        Data data = new Data.Builder()
                .putString("key", key).putString("title", title).putString("text", text)
                .putString("action", action).putInt("servant", servant).build();
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(ReminderWorker.class)
                .setInitialDelay(delay, TimeUnit.MILLISECONDS)
                .setInputData(data)
                .addTag("reminder")
                .build();
        WorkManager.getInstance(ctx).enqueueUniqueWork("rem-" + key, ExistingWorkPolicy.REPLACE, req);
    }

    static void cancel(Context ctx, String key) {
        WorkManager.getInstance(ctx).cancelUniqueWork("rem-" + key);
    }

    @NonNull
    @Override
    public Result doWork() {
        Data d = getInputData();
        String key = d.getString("key");
        CheckWorker.post(getApplicationContext(), key == null ? 7 : key.hashCode(),
                d.getString("title"), d.getString("text"), d.getString("action"), d.getInt("servant", 0));
        return Result.success();
    }
}
