/**
 * GodBridge — connects a Paper server to the Cloudflare platform.
 *
 * It does three things and nothing else:
 *   1. heartbeat  — process/TPS/memory/player state, so the platform can tell
 *                   a live server from a dead one
 *   2. players    — join/quit, so the panel and leaderboards know who is online
 *   3. anticheat  — raw numeric observations (movement, combat, clicks). The
 *                   plugin never decides anything; all judgement happens in the
 *                   Worker where the calibrated engine lives.
 *
 * Everything is fire-and-forget over async HTTP. A slow or unreachable platform
 * must never lag the game thread.
 */
package com.godmc.bridge;

import com.google.gson.Gson;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public final class GodBridge extends JavaPlugin implements Listener {

    private static final Gson GSON = new Gson();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    private String platformUrl;
    private String secret;
    private String serverId;

    /** Ring buffer of raw samples per player, flushed with each heartbeat. */
    private final Map<UUID, Deque<Map<String, Object>>> samples = new ConcurrentHashMap<>();
    private final Map<UUID, Long> lastBreak = new ConcurrentHashMap<>();

    @Override
    public void onEnable() {
        platformUrl = System.getenv().getOrDefault("PLATFORM_URL", "");
        secret = System.getenv().getOrDefault("PLATFORM_SECRET", "");
        serverId = System.getenv().getOrDefault("SERVER_ID", "");

        if (platformUrl.isEmpty() || secret.isEmpty()) {
            getLogger().warning("PLATFORM_URL/PLATFORM_SECRET not set - bridge disabled");
            return;
        }
        Bukkit.getPluginManager().registerEvents(this, this);

        long every = 20L * Long.parseLong(System.getenv().getOrDefault("HEARTBEAT_SECONDS", "15"));
        Bukkit.getScheduler().runTaskTimerAsynchronously(this, this::sendHeartbeat, every, every);
        getLogger().info("GodBridge enabled for server " + serverId);
    }

    // ------------------------------------------------------------ heartbeat
    private void sendHeartbeat() {
        try {
            Runtime rt = Runtime.getRuntime();
            long usedMb = (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024);
            long maxMb = rt.maxMemory() / (1024 * 1024);

            Map<String, Object> body = new HashMap<>();
            body.put("serverId", serverId);
            body.put("processAlive", true);
            body.put("players", Bukkit.getOnlinePlayers().size());
            body.put("tps", tps0());
            body.put("memUsedMb", usedMb);
            body.put("memMaxMb", maxMb);
            body.put("version", Bukkit.getVersion());
            body.put("motd", Bukkit.getMotd());
            post("/api/server/heartbeat", body);

            flushSamples();
        } catch (Exception e) {
            // Never let platform problems surface on the game thread.
            getLogger().fine("heartbeat failed: " + e.getMessage());
        }
    }

    private double tps0() {
        try {
            double[] t = Bukkit.getTPS();
            return t.length > 0 ? t[0] : 20.0;
        } catch (Throwable ignored) {
            return 20.0;
        }
    }

    // --------------------------------------------------------------- events
    @EventHandler
    public void onJoin(PlayerJoinEvent e) {
        record(e.getPlayer(), "join", Collections.emptyMap());
        Map<String, Object> body = new HashMap<>();
        body.put("serverId", serverId);
        body.put("mcUuid", e.getPlayer().getUniqueId().toString());
        body.put("mcName", e.getPlayer().getName());
        body.put("edition", "java");
        post("/api/server/player", body);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        record(e.getPlayer(), "quit", Collections.emptyMap());
        samples.remove(e.getPlayer().getUniqueId());
    }

    /**
     * Combat observation. We send the NUMBERS only — distance, aim delta, line
     * of sight. The decision belongs to the calibrated engine in the Worker.
     */
    @EventHandler(ignoreCancelled = true)
    public void onDamage(EntityDamageByEntityEvent e) {
        if (!(e.getDamager() instanceof Player atk) || !(e.getEntity() instanceof Player vic)) return;
        Map<String, Object> m = new HashMap<>();
        m.put("t", System.currentTimeMillis());
        m.put("victimId", vic.getUniqueId().toString());
        m.put("distance", round(atk.getLocation().distance(vic.getLocation())));
        m.put("aimDeltaDeg", 0); // requires a rotation tracker; see MovementWatcher
        m.put("lineOfSight", atk.hasLineOfSight(vic));
        record(atk, "attack", m);
    }

    private void record(Player p, String kind, Map<String, Object> data) {
        Deque<Map<String, Object>> buf =
                samples.computeIfAbsent(p.getUniqueId(), k -> new ArrayDeque<>());
        Map<String, Object> entry = new HashMap<>(data);
        entry.put("type", kind);
        synchronized (buf) {
            buf.addLast(entry);
            // Hard cap so a burst cannot grow the buffer without bound.
            while (buf.size() > 512) buf.pollFirst();
        }
    }

    private void flushSamples() {
        for (Map.Entry<UUID, Deque<Map<String, Object>>> en : samples.entrySet()) {
            List<Map<String, Object>> batch;
            synchronized (en.getValue()) {
                batch = new ArrayList<>(en.getValue());
                en.getValue().clear();
            }
            if (batch.isEmpty()) continue;
            Map<String, Object> body = new HashMap<>();
            body.put("serverId", serverId);
            body.put("playerId", en.getKey().toString());
            body.put("samples", batch);
            post("/api/server/samples", body);
        }
    }

    // ----------------------------------------------------------------- http
    private void post(String path, Map<String, Object> body) {
        if (platformUrl.isEmpty()) return;
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(platformUrl + path))
                    .timeout(Duration.ofSeconds(8))
                    .header("content-type", "application/json")
                    .header("x-server-secret", secret)
                    .POST(HttpRequest.BodyPublishers.ofString(GSON.toJson(body)))
                    .build();
            http.sendAsync(req, HttpResponse.BodyHandlers.discarding());
        } catch (Exception ignored) {
            // Swallowed deliberately: telemetry loss must never affect gameplay.
        }
    }

    private static double round(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
