package com.rmyndharis.openwa.http;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.errors.OpenWAApiError;
import com.rmyndharis.openwa.errors.OpenWATimeoutError;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.time.Duration;
import java.time.temporal.ChronoUnit;
import java.util.Map;
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
    void mapsABodyStallToOpenWATimeoutErrorAndDropsTheConnection() throws Exception {
        CountDownLatch clientClosed = new CountDownLatch(1);
        server.createContext("/stall", ex -> {
            try {
                // A body that never ends: keeps writing until the client hangs up.
                ex.sendResponseHeaders(200, 0);
                while (!release.await(20, TimeUnit.MILLISECONDS)) {
                    ex.getResponseBody().write(' ');
                    ex.getResponseBody().flush();
                }
            } catch (IOException e) {
                clientClosed.countDown();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                ex.close();
            }
        });

        assertThrows(OpenWATimeoutError.class,
            () -> client(Duration.ofMillis(100)).requestVoid(HttpMethod.GET, "/stall", null, null));
        assertTrue(clientClosed.await(5, TimeUnit.SECONDS), "the timed-out exchange was not cancelled");
    }

    @Test
    void reportsAFailedExchangeAsAnIOException() {
        AtomicInteger hits = new AtomicInteger();
        server.createContext("/ok", ex -> {
            hits.incrementAndGet();
            ex.sendResponseHeaders(204, -1);
            ex.close();
        });
        // HttpClient fails this exchange with an ArithmeticException; it must not escape as one.
        HttpRequestData req = new HttpRequestData(
            HttpMethod.GET, baseUrl + "/ok", Map.of(), null, ChronoUnit.FOREVER.getDuration());

        IOException err = assertThrows(IOException.class, () -> new DefaultHttpTransport().send(req));

        assertInstanceOf(ArithmeticException.class, err.getCause());
        assertEquals(0, hits.get());
    }

    @Test
    void passesThroughOnlyTheFailuresHttpClientSendDoes() {
        IOException io = new IOException("reset");
        assertSame(io, DefaultHttpTransport.transportFailure(io));

        IllegalArgumentException bad = new IllegalArgumentException("bad header");
        assertSame(bad, assertThrows(IllegalArgumentException.class, () -> DefaultHttpTransport.transportFailure(bad)));
        SecurityException denied = new SecurityException("denied");
        assertSame(denied, assertThrows(SecurityException.class, () -> DefaultHttpTransport.transportFailure(denied)));

        IllegalStateException closed = new IllegalStateException("selector manager closed");
        IOException wrapped = DefaultHttpTransport.transportFailure(closed);
        assertSame(closed, wrapped.getCause());
        assertEquals("selector manager closed", wrapped.getMessage());
        AssertionError fatal = new AssertionError("boom");
        assertSame(fatal, DefaultHttpTransport.transportFailure(fatal).getCause());
    }
}
