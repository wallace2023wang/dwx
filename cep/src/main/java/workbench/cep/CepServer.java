package workbench.cep;

import com.espertech.esper.common.client.EPCompiled;
import com.espertech.esper.common.client.EventBean;
import com.espertech.esper.common.client.configuration.Configuration;
import com.espertech.esper.compiler.client.CompilerArguments;
import com.espertech.esper.compiler.client.EPCompileException;
import com.espertech.esper.compiler.client.EPCompiler;
import com.espertech.esper.compiler.client.EPCompilerProvider;
import com.espertech.esper.runtime.client.EPDeployment;
import com.espertech.esper.runtime.client.EPDeployException;
import com.espertech.esper.runtime.client.EPDeploymentService;
import com.espertech.esper.runtime.client.EPRuntime;
import com.espertech.esper.runtime.client.EPRuntimeProvider;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class CepServer {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final String ESPER_VERSION = "8.8.0";
  private static final int MAX_BODY = 2 * 1024 * 1024;
  private static final Path DATA_DIR = Path.of(System.getenv().getOrDefault("CEP_DATA_DIR", "data/cep"));
  private static final String API_KEY = System.getenv().getOrDefault("CEP_API_KEY", "").trim();
  private static final Map<String, Deployment> DEPLOYMENTS = new ConcurrentHashMap<>();
  private static final Map<String, AlertState> ALERTS = new ConcurrentHashMap<>();
  private static final Object DEPLOY_LOCK = new Object();
  private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(3)).build();
  private static final ScheduledExecutorService SCHEDULER = Executors.newSingleThreadScheduledExecutor();
  private static final Metrics METRICS = new Metrics();

  private record Deployment(JsonNode release, EPRuntime runtime, String deployedAt, Map<String, Map<String, String>> schemaTypes, CopyOnWriteArrayList<DetectionCollector> collectors) {}
  private record CompileResult(EPCompiled compiled, String epl, List<Map<String, Object>> statements, Map<String, Map<String, String>> schemaTypes) {}
  private record AlertState(String releaseId, String statement, String eventType, String key, long lastFiredAt, JsonNode webhook, boolean cleared) {}
  private static final class DetectionCollector {
    private final List<Map<String, Object>> detections = Collections.synchronizedList(new ArrayList<>());

    void add(Map<String, Object> detection) {
      detections.add(detection);
    }

    List<Map<String, Object>> snapshot() {
      synchronized (detections) {
        return new ArrayList<>(detections);
      }
    }
  }
  private static final class Metrics {
    final AtomicLong compileRequests = new AtomicLong();
    final AtomicLong testRequests = new AtomicLong();
    final AtomicLong deployRequests = new AtomicLong();
    final AtomicLong executeRequests = new AtomicLong();
    final AtomicLong eventsRequests = new AtomicLong();
    final AtomicLong eventsIn = new AtomicLong();
    final AtomicLong detections = new AtomicLong();
    final AtomicLong webhookFired = new AtomicLong();
    final AtomicLong webhookCleared = new AtomicLong();
    final AtomicLong webhookFailed = new AtomicLong();
  }

  public static void main(String[] args) throws IOException {
    Files.createDirectories(DATA_DIR);
    loadDeployments();
    Runtime.getRuntime().addShutdownHook(new Thread(CepServer::shutdown));
    int port = Integer.parseInt(System.getenv().getOrDefault("CEP_PORT", "8791"));
    HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
    server.createContext("/health", CepServer::health);
    server.createContext("/compile", CepServer::compile);
    server.createContext("/test", CepServer::test);
    server.createContext("/deployments", CepServer::listDeployments);
    server.createContext("/deploy", CepServer::deploy);
    server.createContext("/undeploy", CepServer::undeploy);
    server.createContext("/execute", CepServer::execute);
    server.createContext("/events", CepServer::events);
    server.createContext("/webhook", CepServer::webhook);
    server.createContext("/metrics", CepServer::metrics);
    server.createContext("/openapi.json", CepServer::openapi);
    server.setExecutor(Executors.newFixedThreadPool(Math.max(4, Runtime.getRuntime().availableProcessors())));
    SCHEDULER.scheduleAtFixedRate(CepServer::publishClearedAlerts, 1, 1, TimeUnit.SECONDS);
    server.start();
    System.out.println("Esper CEP service listening on " + port + ", loaded " + DEPLOYMENTS.size() + " release(s)");
  }

  private static void health(HttpExchange exchange) throws IOException {
    if (!method(exchange, "GET")) return;
    send(exchange, 200, Map.of("service", "CEP Runtime", "engine", "Esper", "version", ESPER_VERSION, "deployments", DEPLOYMENTS.size()));
  }

  private static void compile(HttpExchange exchange) throws IOException {
    if (!method(exchange, "POST")) return;
    if (!requireAuth(exchange)) return;
    METRICS.compileRequests.incrementAndGet();
    JsonNode input;
    try { input = readBody(exchange); }
    catch (IllegalArgumentException exception) { send(exchange, 400, Map.of("error", exception.getMessage())); return; }
    try {
      CompileResult compiled = compileModule(input);
      send(exchange, 200, Map.of("ok", true, "engine", "Esper", "version", ESPER_VERSION, "statements", compiled.statements(), "epl", compiled.epl()));
    } catch (IllegalArgumentException exception) {
      send(exchange, 400, Map.of("error", exception.getMessage()));
    } catch (EPCompileException exception) {
      send(exchange, 422, Map.of("ok", false, "errors", List.of(exception.getMessage())));
    } catch (Exception exception) {
      exception.printStackTrace();
      send(exchange, 500, Map.of("error", "CEP compile failed"));
    }
  }

  private static void test(HttpExchange exchange) throws IOException {
    if (!method(exchange, "POST")) return;
    if (!requireAuth(exchange)) return;
    METRICS.testRequests.incrementAndGet();
    JsonNode input;
    try { input = readBody(exchange); }
    catch (IllegalArgumentException exception) { send(exchange, 400, Map.of("error", exception.getMessage())); return; }
    try {
      List<Map<String, Object>> detections = executeEphemeral(input, eventsOf(input), waitMsOf(input));
      send(exchange, 200, Map.of("ok", true, "detections", detections));
    } catch (IllegalArgumentException exception) {
      send(exchange, 400, Map.of("error", exception.getMessage()));
    } catch (EPCompileException exception) {
      send(exchange, 422, Map.of("ok", false, "errors", List.of(exception.getMessage())));
    } catch (Exception exception) {
      exception.printStackTrace();
      send(exchange, 500, Map.of("error", "CEP test failed"));
    }
  }

  private static void listDeployments(HttpExchange exchange) throws IOException {
    if (!method(exchange, "GET")) return;
    if (!requireAuth(exchange)) return;
    List<Map<String, Object>> result = DEPLOYMENTS.entrySet().stream()
        .map(entry -> deploymentResponse(entry.getValue().release(), entry.getValue().deployedAt()))
        .sorted((left, right) -> String.valueOf(right.get("deployedAt")).compareTo(String.valueOf(left.get("deployedAt"))))
        .toList();
    send(exchange, 200, result);
  }

  private static void deploy(HttpExchange exchange) throws IOException {
    if (!method(exchange, "POST")) return;
    if (!requireAuth(exchange)) return;
    METRICS.deployRequests.incrementAndGet();
    JsonNode release;
    try { release = readBody(exchange); }
    catch (IllegalArgumentException exception) { send(exchange, 400, Map.of("error", exception.getMessage())); return; }
    String validation = validateRelease(release);
    if (validation != null) { send(exchange, 400, Map.of("error", validation)); return; }
    String id = release.path("id").asText();
    synchronized (DEPLOY_LOCK) {
      Deployment existing = DEPLOYMENTS.get(id);
      if (existing != null) {
        if (!existing.release().path("checksum").asText().equals(release.path("checksum").asText())) {
          send(exchange, 409, Map.of("error", "相同 CEP Release ID 已存在不同内容")); return;
        }
        send(exchange, 200, deploymentResponse(existing.release(), existing.deployedAt())); return;
      }
      try {
        Deployment deployment = buildDeployment(release, Instant.now().toString());
        persist(release);
        DEPLOYMENTS.put(id, deployment);
        send(exchange, 201, deploymentResponse(release, deployment.deployedAt()));
      } catch (EPCompileException exception) {
        send(exchange, 422, Map.of("ok", false, "errors", List.of(exception.getMessage())));
      } catch (IllegalArgumentException exception) {
        send(exchange, 400, Map.of("error", exception.getMessage()));
      } catch (Exception exception) {
        exception.printStackTrace();
        send(exchange, 500, Map.of("error", "CEP deploy failed"));
      }
    }
  }

  private static void undeploy(HttpExchange exchange) throws IOException {
    if (!method(exchange, "POST")) return;
    if (!requireAuth(exchange)) return;
    JsonNode request;
    try { request = readBody(exchange); }
    catch (IllegalArgumentException exception) { send(exchange, 400, Map.of("error", exception.getMessage())); return; }
    String releaseId = request.path("releaseId").asText("");
    if (releaseId.isBlank()) { send(exchange, 400, Map.of("error", "releaseId 不能为空")); return; }

    synchronized (DEPLOY_LOCK) {
      Deployment deployment = DEPLOYMENTS.remove(releaseId);
      Files.deleteIfExists(releaseFile(releaseId));
      ALERTS.entrySet().removeIf(entry -> releaseId.equals(entry.getValue().releaseId()));
      if (deployment != null) deployment.runtime().destroy();
      send(exchange, 200, Map.of(
          "ok", true,
          "releaseId", releaseId,
          "removed", deployment != null,
          "stoppedAt", Instant.now().toString()));
    }
  }

  private static void execute(HttpExchange exchange) throws IOException {
    if (!method(exchange, "POST")) return;
    if (!requireAuth(exchange)) return;
    METRICS.executeRequests.incrementAndGet();
    JsonNode request;
    try { request = readBody(exchange); }
    catch (IllegalArgumentException exception) { send(exchange, 400, Map.of("error", exception.getMessage())); return; }
    String releaseId = request.path("releaseId").asText("");
    Deployment deployment = DEPLOYMENTS.get(releaseId);
    if (deployment == null) { send(exchange, 404, Map.of("error", "CEP Release 未部署")); return; }
    try {
      List<Map<String, Object>> events = eventsOf(request);
      List<Map<String, Object>> detections = runDeployedEvents(deployment, events, waitMsOf(request));
      METRICS.eventsIn.addAndGet(events.size());
      send(exchange, 200, Map.of("ok", true, "releaseId", releaseId, "requestId", request.path("requestId").asText(UUID.randomUUID().toString()), "detections", detections));
    } catch (IllegalArgumentException exception) {
      send(exchange, 400, Map.of("error", exception.getMessage()));
    } catch (Exception exception) {
      exception.printStackTrace();
      send(exchange, 500, Map.of("error", "CEP execute failed"));
    }
  }

  private static void events(HttpExchange exchange) throws IOException {
    if (!method(exchange, "POST")) return;
    if (!requireAuth(exchange)) return;
    METRICS.eventsRequests.incrementAndGet();
    String prefix = "/events/";
    String path = exchange.getRequestURI().getPath();
    if (!path.startsWith(prefix) || path.length() <= prefix.length()) { send(exchange, 404, Map.of("error", "缺少 Release ID")); return; }
    String releaseId = path.substring(prefix.length());
    Deployment deployment = DEPLOYMENTS.get(releaseId);
    if (deployment == null) { send(exchange, 404, Map.of("error", "CEP Release 未部署")); return; }
    JsonNode request;
    try { request = readBody(exchange); }
    catch (IllegalArgumentException exception) { send(exchange, 400, Map.of("error", exception.getMessage())); return; }
    try {
      List<Map<String, Object>> events = eventsOf(request);
      List<Map<String, Object>> detections = runDeployedEvents(deployment, events, waitMsOf(request));
      METRICS.eventsIn.addAndGet(events.size());
      send(exchange, 202, Map.of("ok", true, "releaseId", releaseId, "accepted", events.size(), "detections", detections));
    } catch (IllegalArgumentException exception) {
      send(exchange, 400, Map.of("error", exception.getMessage()));
    } catch (Exception exception) {
      exception.printStackTrace();
      send(exchange, 500, Map.of("error", "CEP events failed"));
    }
  }

  private static void webhook(HttpExchange exchange) throws IOException {
    if (!method(exchange, "POST")) return;
    if (!requireAuth(exchange)) return;
    JsonNode input;
    try { input = readBody(exchange); }
    catch (IllegalArgumentException exception) { send(exchange, 400, Map.of("error", exception.getMessage())); return; }
    String releaseId = input.path("releaseId").asText("");
    Deployment deployment = DEPLOYMENTS.get(releaseId);
    if (deployment == null) { send(exchange, 404, Map.of("error", "CEP Release 未部署")); return; }
    if (!input.path("webhook").isObject()) { send(exchange, 400, Map.of("error", "webhook 配置无效")); return; }
    ObjectNode next = deployment.release().deepCopy();
    next.set("webhook", input.path("webhook"));
    try {
      persist(next);
      Deployment rebuilt = buildDeployment(next, deployment.deployedAt());
      deployment.runtime().destroy();
      DEPLOYMENTS.put(releaseId, rebuilt);
      ALERTS.entrySet().removeIf(entry -> entry.getValue().releaseId().equals(releaseId));
      send(exchange, 200, Map.of("ok", true, "releaseId", releaseId));
    } catch (Exception exception) {
      exception.printStackTrace();
      send(exchange, 500, Map.of("error", "Webhook 配置保存失败"));
    }
  }

  private static void metrics(HttpExchange exchange) throws IOException {
    if (!method(exchange, "GET")) return;
    String body = "# TYPE cep_deployments gauge\n"
      + "cep_deployments " + DEPLOYMENTS.size() + "\n"
      + "# TYPE cep_alerts_active gauge\n"
      + "cep_alerts_active " + ALERTS.values().stream().filter(alert -> !alert.cleared()).count() + "\n"
      + counter("cep_compile_requests_total", METRICS.compileRequests)
      + counter("cep_test_requests_total", METRICS.testRequests)
      + counter("cep_deploy_requests_total", METRICS.deployRequests)
      + counter("cep_execute_requests_total", METRICS.executeRequests)
      + counter("cep_events_requests_total", METRICS.eventsRequests)
      + counter("cep_events_in_total", METRICS.eventsIn)
      + counter("cep_detections_total", METRICS.detections)
      + counter("cep_webhook_fired_total", METRICS.webhookFired)
      + counter("cep_webhook_cleared_total", METRICS.webhookCleared)
      + counter("cep_webhook_failed_total", METRICS.webhookFailed);
    byte[] bytes = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    exchange.sendResponseHeaders(200, bytes.length);
    try (var stream = exchange.getResponseBody()) { stream.write(bytes); }
  }

  private static void openapi(HttpExchange exchange) throws IOException {
    if (!method(exchange, "GET")) return;
    send(exchange, 200, Map.of(
      "openapi", "3.0.3",
      "info", Map.of("title", "Decision Workbench CEP Runtime", "version", "1.0.0"),
      "paths", Map.of(
        "/health", Map.of("get", Map.of("summary", "Health check")),
        "/compile", Map.of("post", Map.of("summary", "Compile CEP module")),
        "/test", Map.of("post", Map.of("summary", "Run ephemeral CEP test")),
        "/deploy", Map.of("post", Map.of("summary", "Deploy immutable CEP release")),
        "/execute", Map.of("post", Map.of("summary", "Execute deployed release with events")),
        "/events/{releaseId}", Map.of("post", Map.of("summary", "Continuously append events to deployed release")),
        "/webhook", Map.of("post", Map.of("summary", "Configure release webhook")),
        "/undeploy", Map.of("post", Map.of("summary", "Unload a deployed release")),
        "/metrics", Map.of("get", Map.of("summary", "Prometheus metrics"))
      )
    ));
  }

  private static Deployment buildDeployment(JsonNode release, String deployedAt) throws Exception {
    EPRuntime runtime = newRuntime(release.path("id").asText());
    CompileResult compiled = compileModule(release);
    runtime.getDeploymentService().deploy(compiled.compiled());
    Deployment deployment = new Deployment(release, runtime, deployedAt, compiled.schemaTypes(), new CopyOnWriteArrayList<>());
    installDeploymentListeners(deployment);
    return deployment;
  }

  private static List<Map<String, Object>> executeEphemeral(JsonNode input, List<Map<String, Object>> events, long waitMs) throws Exception {
    EPRuntime runtime = newRuntime("test-" + UUID.randomUUID());
    try {
      CompileResult compiled = compileModule(input);
      runtime.getDeploymentService().deploy(compiled.compiled());
      return runEphemeralEvents(runtime, events, compiled.schemaTypes(), waitMs);
    } finally {
      runtime.destroy();
    }
  }

  private static void installDeploymentListeners(Deployment deployment) {
    EPDeploymentService service = deployment.runtime().getDeploymentService();
    for (String deploymentId : service.getDeployments()) {
      EPDeployment deployed = service.getDeployment(deploymentId);
      if (deployed == null) continue;
      for (var statement : deployed.getStatements()) {
        statement.addListener((newEvents, oldEvents, stmt, rt) -> {
          if (newEvents == null) return;
          for (EventBean event : newEvents) {
            Map<String, Object> item = detection(stmt.getName(), event);
            METRICS.detections.incrementAndGet();
            for (DetectionCollector collector : deployment.collectors()) collector.add(item);
            publishWebhookEvents(deployment.release().path("id").asText(), deployment.release(), List.of(item));
          }
        });
      }
    }
  }

  private static List<Map<String, Object>> runEphemeralEvents(EPRuntime runtime, List<Map<String, Object>> events, Map<String, Map<String, String>> schemaTypes, long waitMs) {
    DetectionCollector collector = new DetectionCollector();
    EPDeploymentService service = runtime.getDeploymentService();
    for (String deploymentId : service.getDeployments()) {
      EPDeployment deployment = service.getDeployment(deploymentId);
      if (deployment == null) continue;
      for (var statement : deployment.getStatements()) {
        statement.removeAllListeners();
        statement.addListener((newEvents, oldEvents, stmt, rt) -> {
          if (newEvents == null) return;
          for (EventBean event : newEvents) {
            Map<String, Object> item = detection(stmt.getName(), event);
            METRICS.detections.incrementAndGet();
            collector.add(item);
          }
        });
      }
    }
    sendEvents(runtime, events, schemaTypes);
    await(waitMs);
    return collector.snapshot();
  }

  private static List<Map<String, Object>> runDeployedEvents(Deployment deployment, List<Map<String, Object>> events, long waitMs) {
    DetectionCollector collector = new DetectionCollector();
    deployment.collectors().add(collector);
    try {
      sendEvents(deployment.runtime(), events, deployment.schemaTypes());
      await(waitMs);
      return collector.snapshot();
    } finally {
      deployment.collectors().remove(collector);
    }
  }

  private static void sendEvents(EPRuntime runtime, List<Map<String, Object>> events, Map<String, Map<String, String>> schemaTypes) {
    for (Map<String, Object> event : events) {
      String type = String.valueOf(event.get("type"));
      Object raw = event.get("data");
      if (!(raw instanceof Map<?, ?> map)) throw new IllegalArgumentException("事件 data 必须是对象");
      Map<String, String> types = schemaTypes.getOrDefault(type, Map.of());
      Map<String, Object> payload = new LinkedHashMap<>();
      putIfPresent(payload, "eventId", firstPresent(event, "eventId", "id"));
      putIfPresent(payload, "eventTime", firstPresent(event, "eventTime", "timestamp"));
      putIfPresent(payload, "ingestTime", firstPresent(event, "ingestTime", "receivedAt"));
      putIfPresent(payload, "source", event.get("source"));
      putIfPresent(payload, "eventKey", firstPresent(event, "eventKey", "key"));
      putIfPresent(payload, "schemaVersion", event.get("schemaVersion"));
      Object traceId = event.get("traceId");
      Object headers = event.get("headers");
      if (traceId == null && headers instanceof Map<?, ?> headerMap) traceId = headerMap.get("traceId");
      putIfPresent(payload, "traceId", traceId);
      for (Map.Entry<?, ?> entry : map.entrySet()) payload.put(String.valueOf(entry.getKey()), entry.getValue());
      Map<String, Object> data = new LinkedHashMap<>();
      for (Map.Entry<String, Object> entry : payload.entrySet()) data.put(entry.getKey(), coerceValue(entry.getValue(), types.get(entry.getKey())));
      runtime.getEventService().sendEventMap(data, type);
    }
  }

  private static void await(long waitMs) {
    if (waitMs > 0) {
      try {
        Thread.sleep(waitMs);
      } catch (InterruptedException exception) {
        Thread.currentThread().interrupt();
        throw new IllegalArgumentException("等待窗口输出时被中断");
      }
    }
  }

  private static String counter(String name, AtomicLong value) {
    return "# TYPE " + name + " counter\n" + name + " " + value.get() + "\n";
  }

  private static boolean requireAuth(HttpExchange exchange) throws IOException {
    if (API_KEY.isEmpty()) return true;
    String key = exchange.getRequestHeaders().getFirst("X-Api-Key");
    String auth = exchange.getRequestHeaders().getFirst("Authorization");
    if (API_KEY.equals(key) || (auth != null && auth.equals("Bearer " + API_KEY))) return true;
    send(exchange, 401, Map.of("error", "Unauthorized"));
    return false;
  }

  private static JsonNode webhookOf(JsonNode release) {
    JsonNode webhook = release.path("webhook");
    if (!webhook.isObject()) webhook = release.path("runtime").path("webhook");
    if (!webhook.isObject() || !webhook.path("enabled").asBoolean(false) || !webhook.path("callbackUrl").isTextual()) return null;
    return webhook;
  }

  private static void publishWebhookEvents(String releaseId, JsonNode release, List<Map<String, Object>> detections) {
    JsonNode webhook = webhookOf(release);
    if (webhook == null || detections.isEmpty()) return;
    for (Map<String, Object> detection : detections) {
      long now = System.currentTimeMillis();
      String key = alertKey(releaseId, detection);
      AlertState previous = ALERTS.get(key);
      long minIntervalMs = Math.max(0, webhook.path("minIntervalMs").asLong(0));
      ALERTS.put(key, new AlertState(releaseId, String.valueOf(detection.get("statement")), String.valueOf(detection.get("eventType")), key, now, webhook, false));
      if (previous != null && !previous.cleared() && minIntervalMs > 0 && now - previous.lastFiredAt() < minIntervalMs) continue;
      sendWebhook(webhook, Map.of("type", "alert.fired", "releaseId", releaseId, "detection", detection));
      METRICS.webhookFired.incrementAndGet();
    }
  }

  private static void publishClearedAlerts() {
    long now = System.currentTimeMillis();
    for (Map.Entry<String, AlertState> entry : ALERTS.entrySet()) {
      AlertState alert = entry.getValue();
      if (alert.cleared()) continue;
      long clearedAfterMs = Math.max(0, alert.webhook().path("clearedAfterMs").asLong(0));
      if (clearedAfterMs <= 0 || now - alert.lastFiredAt() < clearedAfterMs) continue;
      if (!ALERTS.replace(entry.getKey(), alert, new AlertState(alert.releaseId(), alert.statement(), alert.eventType(), alert.key(), alert.lastFiredAt(), alert.webhook(), true))) continue;
      sendWebhook(alert.webhook(), Map.of("type", "alert.cleared", "releaseId", alert.releaseId(), "statement", alert.statement(), "eventType", alert.eventType(), "key", alert.key(), "clearedAt", Instant.now().toString()));
      METRICS.webhookCleared.incrementAndGet();
    }
  }

  private static String alertKey(String releaseId, Map<String, Object> detection) {
    Object rawData = detection.get("data");
    Object key = null;
    if (rawData instanceof Map<?, ?> data) {
      key = data.get("eventKey");
      if (key == null) key = data.get("warehouseId");
      if (key == null) key = data.get("sensorId");
    }
    return releaseId + ":" + detection.get("statement") + ":" + detection.get("eventType") + ":" + String.valueOf(key == null ? "default" : key);
  }

  private static void sendWebhook(JsonNode webhook, Object payload) {
    SCHEDULER.execute(() -> {
      try {
        String json = JSON.writeValueAsString(payload);
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(webhook.path("callbackUrl").asText()))
          .timeout(java.time.Duration.ofSeconds(5))
          .header("content-type", "application/json")
          .header("x-cep-event", payload instanceof Map<?, ?> map ? String.valueOf(map.get("type")) : "alert")
          .POST(HttpRequest.BodyPublishers.ofString(json));
        if (webhook.path("secret").isTextual() && !webhook.path("secret").asText().isBlank()) builder.header("x-dw-signature", signature(webhook.path("secret").asText(), json));
        int maxRetries = Math.max(0, Math.min(5, webhook.path("maxRetries").asInt(0)));
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
          HttpResponse<String> response = HTTP.send(builder.build(), HttpResponse.BodyHandlers.ofString());
          if (response.statusCode() < 400) return;
          if (attempt < maxRetries) Thread.sleep(Math.min(5000, 300L * (1L << attempt)));
        }
        METRICS.webhookFailed.incrementAndGet();
      } catch (Exception exception) {
        METRICS.webhookFailed.incrementAndGet();
      }
    });
  }

  private static String signature(String secret, String body) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256"));
    return "sha256=" + Base64.getEncoder().encodeToString(mac.doFinal(body.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
  }

  private static Object firstPresent(Map<String, Object> map, String first, String second) {
    Object value = map.get(first);
    return value != null ? value : map.get(second);
  }

  private static void putIfPresent(Map<String, Object> map, String key, Object value) {
    if (value != null) map.put(key, value);
  }

  private static Map<String, Object> detection(String statementName, EventBean event) {
    Map<String, Object> data = new LinkedHashMap<>();
    for (String property : event.getEventType().getPropertyNames()) data.put(property, event.get(property));
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("statement", statementName);
    result.put("eventType", event.getEventType().getName());
    result.put("timestamp", null);
    result.put("data", data);
    return result;
  }

  private static CompileResult compileModule(JsonNode input) throws EPCompileException {
    JsonNode module = input.path("module").isObject() ? input.path("module") : input;
    JsonNode schemas = module.path("schemas").isArray() ? module.path("schemas") : input.path("schemas");
    JsonNode statements = module.path("statements").isArray() ? module.path("statements") : input.path("statements");
    if (!schemas.isArray() || !statements.isArray() || statements.size() == 0) throw new IllegalArgumentException("CEP 模块必须包含 schemas 和 statements");
    String epl = eplOf(schemas, statements);
    Configuration configuration = new Configuration();
    EPCompiler compiler = EPCompilerProvider.getCompiler();
    EPCompiled compiled = compiler.compile(epl, new CompilerArguments(configuration));
    return new CompileResult(compiled, epl, statementSummaries(statements), schemaTypes(schemas));
  }

  private static String eplOf(JsonNode schemas, JsonNode statements) {
    StringBuilder builder = new StringBuilder();
    for (JsonNode schema : schemas) {
      String name = identifier(schema.path("name").asText(""), "schema name");
      builder.append("@public @buseventtype create schema ").append(name).append("(");
      List<String> fields = new ArrayList<>();
      for (JsonNode field : schema.path("fields")) {
        fields.add(identifier(field.path("key").asText(""), "field") + " " + esperType(field.path("type").asText("string")));
      }
      builder.append(String.join(", ", fields)).append(");\n");
    }
    for (JsonNode statement : statements) {
      if (statement.path("enabled").isBoolean() && !statement.path("enabled").asBoolean()) continue;
      String name = identifier(statement.path("name").asText(""), "statement name");
      String body = statement.path("epl").asText("").trim();
      if (body.isEmpty()) throw new IllegalArgumentException("EPL 内容不能为空");
      if (!body.toLowerCase(Locale.ROOT).contains("@name(")) builder.append("@name('").append(name).append("') ");
      builder.append(body);
      if (!body.endsWith(";")) builder.append(';');
      builder.append('\n');
    }
    return builder.toString();
  }

  private static Map<String, Map<String, String>> schemaTypes(JsonNode schemas) {
    Map<String, Map<String, String>> result = new LinkedHashMap<>();
    for (JsonNode schema : schemas) {
      Map<String, String> fields = new LinkedHashMap<>();
      for (JsonNode field : schema.path("fields")) fields.put(field.path("key").asText(), esperType(field.path("type").asText("string")));
      result.put(schema.path("name").asText(), fields);
    }
    return result;
  }

  private static Object coerceValue(Object value, String type) {
    if (value == null || type == null) return value;
    if (type.equals("double") && value instanceof Number number) return number.doubleValue();
    if (type.equals("int") && value instanceof Number number) return number.intValue();
    if (type.equals("boolean") && value instanceof Boolean) return value;
    if (type.equals("string")) return String.valueOf(value);
    return value;
  }

  private static List<Map<String, Object>> statementSummaries(JsonNode statements) {
    List<Map<String, Object>> result = new ArrayList<>();
    for (JsonNode statement : statements) {
      Map<String, Object> item = new LinkedHashMap<>();
      item.put("name", statement.path("name").asText());
      item.put("outputEventType", statement.path("outputEventType").asText(null));
      result.add(item);
    }
    return result;
  }

  private static String esperType(String type) {
    return switch (type) {
      case "int", "integer", "Integer" -> "int";
      case "double", "Double" -> "double";
      case "boolean", "Boolean" -> "boolean";
      case "string[]" -> "string[]";
      default -> "string";
    };
  }

  private static String identifier(String value, String label) {
    if (value == null || !value.matches("[A-Za-z][A-Za-z0-9_]{0,63}")) throw new IllegalArgumentException("Invalid " + label + ": " + value);
    return value;
  }

  private static List<Map<String, Object>> eventsOf(JsonNode input) {
    JsonNode node = input.path("events").isArray() ? input.path("events") : input.path("facts").path("events");
    if (!node.isArray()) throw new IllegalArgumentException("events 必须是数组");
    List<Map<String, Object>> events = new ArrayList<>();
    for (JsonNode event : node) {
      String type = identifier(event.path("type").asText(""), "event type");
      Map<String, Object> item = new LinkedHashMap<>();
      item.put("type", type);
      putJsonIfPresent(item, "id", event.get("id"));
      putJsonIfPresent(item, "eventId", event.get("eventId"));
      item.put("timestamp", event.path("timestamp").isMissingNode() ? null : JSON.convertValue(event.path("timestamp"), Object.class));
      putJsonIfPresent(item, "eventTime", event.get("eventTime"));
      putJsonIfPresent(item, "ingestTime", event.get("ingestTime"));
      putJsonIfPresent(item, "receivedAt", event.get("receivedAt"));
      putJsonIfPresent(item, "source", event.get("source"));
      putJsonIfPresent(item, "key", event.get("key"));
      putJsonIfPresent(item, "eventKey", event.get("eventKey"));
      putJsonIfPresent(item, "schemaVersion", event.get("schemaVersion"));
      putJsonIfPresent(item, "traceId", event.get("traceId"));
      putJsonIfPresent(item, "headers", event.get("headers"));
      item.put("data", JSON.convertValue(event.path("data"), Map.class));
      events.add(item);
    }
    return events;
  }

  private static long waitMsOf(JsonNode input) {
    JsonNode node = input.path("waitMs");
    if (node.isMissingNode() || node.isNull()) node = input.path("facts").path("waitMs");
    if (node.isMissingNode() || node.isNull()) return 0;
    if (!node.canConvertToLong()) throw new IllegalArgumentException("waitMs 必须是 0-300000 的整数");
    long waitMs = node.asLong();
    if (waitMs < 0 || waitMs > 300000) throw new IllegalArgumentException("waitMs 必须是 0-300000 的整数");
    return waitMs;
  }

  private static void putJsonIfPresent(Map<String, Object> map, String key, JsonNode value) {
    if (value != null && !value.isMissingNode() && !value.isNull()) map.put(key, JSON.convertValue(value, Object.class));
  }

  private static EPRuntime newRuntime(String id) {
    return EPRuntimeProvider.getRuntime("cep-" + id + "-" + UUID.randomUUID());
  }

  private static String validateRelease(JsonNode release) {
    if (!release.isObject()) return "发布包无效";
    if (!release.path("id").isTextual() || release.path("id").asText().isEmpty()) return "发布包 ID 无效";
    if (release.path("schemaVersion").asInt() != 2) return "CEP 发布包 schemaVersion 必须为 2";
    if (!"esper".equals(release.path("engine").path("type").asText())) return "CEP 发布包 engine 必须为 esper";
    if (!"event-stream".equals(release.path("target").path("type").asText())) return "CEP 发布包目标必须是 event-stream";
    if (!release.path("checksum").isTextual() || release.path("checksum").asText().isEmpty()) return "CEP 发布包 checksum 无效";
    return null;
  }

  private static void loadDeployments() throws IOException {
    if (!Files.isDirectory(DATA_DIR)) return;
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(DATA_DIR, "*.json")) {
      for (Path file : stream) {
        JsonNode release = JSON.readTree(Files.readString(file));
        try { DEPLOYMENTS.put(release.path("id").asText(), buildDeployment(release, Instant.now().toString())); }
        catch (Exception exception) { System.err.println("跳过无法加载的 CEP Release " + file + ": " + exception.getMessage()); }
      }
    }
  }

  private static void persist(JsonNode release) throws IOException {
    Path file = releaseFile(release.path("id").asText());
    Path temp = file.resolveSibling(file.getFileName() + ".tmp");
    Files.writeString(temp, JSON.writerWithDefaultPrettyPrinter().writeValueAsString(release));
    try { Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
    catch (AtomicMoveNotSupportedException exception) { Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING); }
  }

  private static Path releaseFile(String releaseId) {
    return DATA_DIR.resolve(releaseId.replaceAll("[^A-Za-z0-9._-]", "_") + ".json");
  }

  private static void shutdown() {
    SCHEDULER.shutdownNow();
    for (Deployment deployment : DEPLOYMENTS.values()) deployment.runtime().destroy();
  }

  private static Map<String, Object> deploymentResponse(JsonNode release, String deployedAt) {
    Map<String, Object> response = new LinkedHashMap<>();
    response.put("deploymentId", "local:" + release.path("id").asText());
    response.put("releaseId", release.path("id").asText());
    response.put("engine", "Esper");
    response.put("engineVersion", ESPER_VERSION);
    response.put("deployedAt", deployedAt);
    response.put("checksum", release.path("checksum").asText());
    response.put("modelVersion", release.path("model").path("version").isNumber() ? release.path("model").path("version").asInt() : null);
    response.put("statements", release.path("statements").size());
    return response;
  }

  private static JsonNode readBody(HttpExchange exchange) throws IOException {
    byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY + 1);
    if (body.length > MAX_BODY) throw new IllegalArgumentException("Request too large");
    if (body.length == 0) return JSON.createObjectNode();
    return JSON.readTree(body);
  }

  private static boolean method(HttpExchange exchange, String method) throws IOException {
    if (exchange.getRequestMethod().equals(method)) return true;
    send(exchange, 405, Map.of("error", "Method not allowed"));
    return false;
  }

  private static void send(HttpExchange exchange, int status, Object body) throws IOException {
    byte[] bytes = JSON.writeValueAsBytes(body);
    exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    exchange.sendResponseHeaders(status, bytes.length);
    try (var stream = exchange.getResponseBody()) { stream.write(bytes); }
  }
}
