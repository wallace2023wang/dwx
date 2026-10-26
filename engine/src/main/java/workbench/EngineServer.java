package workbench;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.kie.api.KieServices;
import org.kie.api.builder.Message;
import org.kie.api.builder.Results;
import org.kie.api.definition.type.FactField;
import org.kie.api.definition.type.FactType;
import org.kie.api.event.rule.AfterMatchFiredEvent;
import org.kie.api.event.rule.DefaultAgendaEventListener;
import org.kie.api.runtime.KieContainer;
import org.kie.api.runtime.KieSession;
import org.kie.internal.utils.KieHelper;
import org.kie.api.io.ResourceType;

public final class EngineServer {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final int MAX_BODY = boundedLimit("ENGINE_MAX_BODY_BYTES", 16 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024);
  private static final int MAX_DRL_CHARS = boundedLimit("ENGINE_MAX_DRL_CHARS", 12 * 1024 * 1024, 200000, 48 * 1024 * 1024);

  public static void main(String[] args) throws IOException {
    int port = Integer.parseInt(System.getenv().getOrDefault("ENGINE_PORT", "8788"));
    HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
    server.createContext("/health", exchange -> {
      if (!exchange.getRequestMethod().equals("GET")) { send(exchange, 405, Map.of("error", "Method not allowed")); return; }
      send(exchange, 200, Map.of("engine", "Drools", "version", "10.2.0"));
    });
    server.createContext("/compile", exchange -> handle(exchange, false));
    server.createContext("/test", exchange -> handle(exchange, true));
    server.start();
    System.out.println("Drools engine listening on " + port);
  }

  private static void handle(HttpExchange exchange, boolean execute) throws IOException {
    if (!exchange.getRequestMethod().equals("POST")) { send(exchange, 405, Map.of("error", "Method not allowed")); return; }
    try {
      byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY + 1);
      if (body.length > MAX_BODY) { send(exchange, 413, Map.of("error", "Request too large")); return; }
      JsonNode input = JSON.readTree(body);
      if (input == null || !input.path("drl").isTextual() || input.path("drl").asText().length() > MAX_DRL_CHARS) {
        send(exchange, 400, Map.of("error", "Invalid DRL")); return;
      }
      KieHelper helper = new KieHelper().addContent(input.path("drl").asText(), ResourceType.DRL);
      Results results = helper.verify();
      List<String> errors = results.getMessages(Message.Level.ERROR).stream().map(Message::getText).toList();
      if (!errors.isEmpty()) { send(exchange, 422, Map.of("ok", false, "errors", errors)); return; }
      if (!execute) { send(exchange, 200, Map.of("ok", true, "version", "10.2.0")); return; }
      JsonNode facts = input.path("facts");
      if (!facts.isObject()) { send(exchange, 400, Map.of("error", "Invalid facts")); return; }
      KieContainer container = helper.getKieContainer();
      KieSession session = container.newKieSession();
      try {
        FactType type = session.getKieBase().getFactType("workbench", "RuleInput");
        if (type == null) { send(exchange, 422, Map.of("ok", false, "errors", List.of("RuleInput fact type not found"))); return; }
        Object fact = type.newInstance();
        Map<String, Class<?>> fieldTypes = reflectFactTypes(type);
        Map<String, Object> parsedFacts = parseFacts(facts, fieldTypes);
        for (Map.Entry<String, Object> entry : parsedFacts.entrySet()) type.set(fact, entry.getKey(), entry.getValue());
        FactType contextType = session.getKieBase().getFactType("workbench", "RuleContext");
        Object context = null;
        Map<String, Class<?>> variableTypes = Map.of();
        if (contextType != null) {
          context = contextType.newInstance();
          variableTypes = reflectFactTypes(contextType);
          Map<String, Object> parsedVariables = parseFacts(input.path("variables"), variableTypes);
          for (Map.Entry<String, Object> entry : parsedVariables.entrySet()) contextType.set(context, entry.getKey(), entry.getValue());
          session.insert(context);
        }
        List<String> fired = new ArrayList<>();
        session.addEventListener(new DefaultAgendaEventListener() {
          @Override public void afterMatchFired(AfterMatchFiredEvent event) { fired.add(event.getMatch().getRule().getName()); }
        });
        session.insert(fact);
        int count = session.fireAllRules(100);
        Map<String, Object> output = new LinkedHashMap<>();
        for (String key : fieldTypes.keySet()) output.put(key, type.get(fact, key));
        Map<String, Object> variables = new LinkedHashMap<>();
        if (contextType != null) for (String key : variableTypes.keySet()) variables.put(key, contextType.get(context, key));
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", true);
        response.put("fired", fired);
        response.put("count", count);
        response.put("limitReached", count == 100);
        response.put("facts", output);
        response.put("variables", variables);
        response.put("decisionHits", collectDecisionHits(session));
        send(exchange, 200, response);
      } finally { session.dispose(); }
    } catch (IllegalArgumentException exception) {
      send(exchange, 400, Map.of("error", exception.getMessage()));
    } catch (Exception exception) {
      exception.printStackTrace();
      send(exchange, 500, Map.of("error", "Engine failed to process request"));
    }
  }

  private static int boundedLimit(String name, int fallback, int minimum, int maximum) {
    try {
      int value = Integer.parseInt(System.getenv().getOrDefault(name, String.valueOf(fallback)));
      return Math.max(minimum, Math.min(maximum, value));
    } catch (NumberFormatException exception) {
      return fallback;
    }
  }

  private static List<Map<String, Object>> collectDecisionHits(KieSession session) {
    FactType type = session.getKieBase().getFactType("workbench", "DecisionHit");
    List<Map<String, Object>> hits = new ArrayList<>();
    if (type == null) return hits;
    for (Object object : session.getObjects()) {
      if (!type.getFactClass().isInstance(object)) continue;
      Map<String, Object> hit = new LinkedHashMap<>();
      for (FactField field : type.getFields()) hit.put(field.getName(), type.get(object, field.getName()));
      hits.add(hit);
    }
    return hits;
  }

  private static Map<String, Class<?>> reflectFactTypes(FactType type) {
    Map<String, Class<?>> fieldTypes = new LinkedHashMap<>();
    for (FactField field : type.getFields()) fieldTypes.put(field.getName(), field.getType());
    return fieldTypes;
  }

  private static Map<String, Object> parseFacts(JsonNode input, Map<String, Class<?>> fieldTypes) {
    Map<String, Object> parsed = new LinkedHashMap<>();
    if (input == null || input.isMissingNode() || input.isNull()) return parsed;
    if (!input.isObject()) throw new IllegalArgumentException("Facts must be an object");
    Iterator<String> keys = input.fieldNames();
    while (keys.hasNext()) {
      String key = keys.next();
      Class<?> type = fieldTypes.get(key);
      if (type == null) throw new IllegalArgumentException("Unknown fact field: " + key);
      JsonNode value = input.get(key);
      if (value == null || value.isNull()) continue;
      Object typed = coerce(value, type);
      if (typed == null) throw new IllegalArgumentException("Invalid value for " + key);
      parsed.put(key, typed);
    }
    return parsed;
  }

  private static Object coerce(JsonNode value, Class<?> type) {
    if (type == Integer.class || type == int.class) {
      return value.isIntegralNumber() && value.canConvertToInt() ? value.intValue() : null;
    }
    if (type == Double.class || type == double.class) {
      return value.isNumber() && Double.isFinite(value.doubleValue()) ? value.doubleValue() : null;
    }
    if (type == Boolean.class || type == boolean.class) {
      return value.isBoolean() ? value.booleanValue() : null;
    }
    if (type == String.class) {
      return value.isTextual() && value.asText().length() <= 200 ? value.asText() : null;
    }
    return null;
  }

  private static void send(HttpExchange exchange, int status, Object body) throws IOException {
    byte[] bytes = JSON.writeValueAsBytes(body);
    exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    exchange.sendResponseHeaders(status, bytes.length);
    try (var stream = exchange.getResponseBody()) { stream.write(bytes); }
  }
}
