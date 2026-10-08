package com.rmyndharis.openwa.http;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.errors.OpenWAApiError;
import com.rmyndharis.openwa.errors.OpenWATimeoutError;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Runs the real transport against a local server: no client test covers it otherwise. */
class DefaultHttpTransportTest {
    private HttpServer server;
    private String baseUrl;
    private final CountDownLatch release = new CountDownLatch(1);

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        release.countDown();
        server.stop(0);
    }

    private OpenWAClient client(Duration timeout) {
        return new OpenWAClient(ClientConfig.builder().baseUrl(baseUrl).apiKey("owa_k1_x").timeout(timeout).build());
    }

    @Test
    void neverFollowsARedirect() {
        AtomicReference<String> keySeen = new AtomicReference<>();
        AtomicInteger targetHits = new AtomicInteger();
        server.createContext("/a", ex -> {
            keySeen.set(ex.getRequestHeaders().getFirst("X-API-Key"));
            ex.getResponseHeaders().add("Location", baseUrl + "/b");
            ex.sendResponseHeaders(302, -1);
            ex.close();
        });
        server.createContext("/b", ex -> {
            targetHits.incrementAndGet();
            ex.sendResponseHeaders(204, -1);
            ex.close();
        });

        OpenWAApiError err = assertThrows(OpenWAApiError.class,
            () -> client(Duration.ofSeconds(5)).requestVoid(HttpMethod.GET, "/a", null, null));

        assertEquals(302, err.status());
        assertEquals("owa_k1_x", keySeen.get());
        assertEquals(0, targetHits.get());
    }

    @Test
    void mapsATimeoutToOpenWATimeoutError() {
        server.createContext("/slow", ex -> {
            try {
                Thread.sleep(1000);
                ex.sendResponseHeaders(204, -1);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                ex.close();
            }
        });

        assertThrows(OpenWATimeoutError.class,
            () -> client(Duration.ofMillis(100)).requestVoid(HttpMethod.GET, "/slow", null, null));
    }

    @Test
    void mapsABodyStallToOpenWATimeoutError() {
        server.createContext("/stall", ex -> {
            try {
                ex.sendResponseHeaders(200, 2);
                ex.getResponseBody().write('{');
                ex.getResponseBody().flush();
                release.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                ex.close();
            }
        });

        assertThrows(OpenWATimeoutError.class,
            () -> client(Duration.ofMillis(100)).requestVoid(HttpMethod.GET, "/stall", null, null));
    }
}
